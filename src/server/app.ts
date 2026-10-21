// HTTP API, OIDC routes and (in production) the static UI. The API relays an explicit list of
// Pingwarden endpoints of each configured instance (/api/i/:inst/…): parameters and bodies are
// validated here, and answers pass through unchanged.
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import {
  type BulkRollupsResponse,
  EVENT_KINDS,
  ID_RE,
  MONITOR_TYPES,
  type Monitor,
  type Principal,
  type RollupsResponse,
  STATUSES,
} from '../shared/pingwarden.ts';
import type { HistoryResponse, InstanceInfo, Me } from '../shared/types.ts';
import { type AppEnv, Auth, SessionExpired } from './auth.ts';
import type { Config } from './config.ts';
import { hostGuard, sameOriginGuard } from './guard.ts';
import { errorMessage, Pingwarden, PwError, type PwResponse, PwUnavailable } from './pingwarden.ts';
import type { Access } from './sessions.ts';

/** An error with an HTTP status and a message meant for the user. */
export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404;
  constructor(status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

type Param = 'int' | 'resolution' | 'text' | 'status' | 'type' | 'id' | 'bool' | 'event';

const PARAM_CHECKS: Record<Param, (v: string) => boolean> = {
  int: (v) => /^\d{1,16}$/.test(v),
  resolution: (v) => v === 'hour' || v === 'day',
  text: (v) => v.length > 0 && v.length <= 200,
  status: (v) => (STATUSES as readonly string[]).includes(v),
  type: (v) => (MONITOR_TYPES as readonly string[]).includes(v),
  id: (v) => ID_RE.test(v),
  bool: (v) => v === 'true' || v === 'false',
  event: (v) => (EVENT_KINDS as readonly string[]).includes(v),
};

const RANGE = { from: 'int', to: 'int', limit: 'int' } as const;

/** The query string to forward: only the listed parameters, each validated. */
export function forwardQuery(q: Record<string, string>, allowed: Record<string, Param>): string {
  const out = new URLSearchParams();
  for (const [k, kind] of Object.entries(allowed)) {
    const v = q[k];
    if (v === undefined || v === '') continue;
    if (!PARAM_CHECKS[kind](v)) throw new HttpError(400, `invalid ${k}: "${v.slice(0, 50)}"`);
    out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

function id(c: Context, name = 'id'): string {
  const v = c.req.param(name) ?? '';
  if (!ID_RE.test(v)) throw new HttpError(404, 'not found');
  return encodeURIComponent(v);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The request's JSON object (an empty body counts as {}). */
async function body(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'expected a JSON object');
  }
  if (!isObject(b)) throw new HttpError(400, 'expected a JSON object');
  return b;
}

const TAG_RE = /^[^\s,]{1,64}$/;
const DURATION_RE = /^[0-9]+(ms|s|m|h|d|w)([0-9]+(ms|s|m|h|d|w))*$|^[0-9]+$/;

function optString(b: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = b[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max)
    throw new HttpError(400, `${key} must be a text of at most ${max} characters`);
  return v;
}

function optTime(b: Record<string, unknown>, key: string): number | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new HttpError(400, `${key} must be a time in ms`);
  return v;
}

function optDuration(b: Record<string, unknown>, key: string): string | undefined {
  const v = optString(b, key, 20);
  if (v !== undefined && !DURATION_RE.test(v)) throw new HttpError(400, `${key} must be a duration such as 30m or 2h`);
  return v;
}

function optList(b: Record<string, unknown>, key: string, re: RegExp): string[] | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 1000 || !v.every((x) => typeof x === 'string' && re.test(x))) {
    throw new HttpError(400, `${key} must be a list of ids`);
  }
  return v as string[];
}

/** Only the fields Pingwarden knows, each type-checked; Pingwarden validates the rest. */
export function silenceBody(b: Record<string, unknown>) {
  const duration = optDuration(b, 'duration');
  const until = optTime(b, 'until');
  if ((duration === undefined) === (until === undefined)) throw new HttpError(400, 'give either duration or until');
  return duration !== undefined ? { duration } : { until };
}

export function maintenanceBody(b: Record<string, unknown>) {
  const out = {
    id: optString(b, 'id', 128),
    description: optString(b, 'description', 500),
    monitors: optList(b, 'monitors', ID_RE),
    groups: optList(b, 'groups', ID_RE),
    tags: optList(b, 'tags', TAG_RE),
    all: b.all === undefined ? undefined : b.all === true,
    start: optTime(b, 'start'),
    end: optTime(b, 'end'),
    duration: optDuration(b, 'duration'),
  };
  if (out.id !== undefined && !ID_RE.test(out.id)) throw new HttpError(400, 'invalid id');
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

const json = (r: PwResponse) =>
  new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function csp(frameAncestors: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** How long Pingwarden's answer to /me is trusted before it is asked again. */
const ACCESS_TTL_MS = 5 * 60_000;
/** A relayed stream is closed after this long (the browser reconnects with a fresh token). */
const STREAM_MAX_MS = 15 * 60_000;
/** Instance path prefix. */
const I = '/api/i/:inst';

export function createApp(
  cfg: Config,
  instances: Pingwarden[] = cfg.instances.map((i) => new Pingwarden(i, cfg.pingwardenTimeoutMs)),
  auth: Auth | null = null,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (cfg.auth.mode === 'oidc') auth ??= new Auth(cfg, instances);
  const byId = new Map(instances.map((p) => [p.id, p]));
  /** Token mode: what each instance's token may do (no session to keep it in). */
  const tokenAccess = new Map<string, Access>();
  const CSP = csp(cfg.http.frameAncestors);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof SessionExpired) return c.json({ error: err.message, login: true }, 401);
    if (err instanceof PwUnavailable) {
      console.warn(`[pingwarden] ${err.message}`);
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof PwError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('*', hostGuard(cfg.http));
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: undefined,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: 'same-origin',
      // CSP frame-ancestors decides; X-Frame-Options cannot name other origins.
      xFrameOptions: cfg.http.frameAncestors.length ? false : 'SAMEORIGIN',
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    // The sign-in pages of auth.ts set their own, stricter one.
    if (!c.res.headers.has('content-security-policy')) c.res.headers.set('content-security-policy', CSP);
  });
  app.use('*', sameOriginGuard());
  if (auth) {
    app.use('*', auth.middleware());
    auth.routes(app);
  }

  app.use(`${I}/*`, async (c, next) => {
    const pw = byId.get(c.req.param('inst') ?? '');
    if (!pw) return c.json({ error: 'unknown Pingwarden instance' }, 404);
    c.set('pw', pw);
    return next();
  });

  /** The bearer token to send to this request's instance. */
  const tokenFor = async (c: Context<AppEnv>, force = false): Promise<string | null> => {
    if (!auth) return c.get('pw').token;
    return auth.accessToken(c.get('session')!, force);
  };

  /** Where what this caller may do on `pw` is remembered. */
  const accessOf = (c: Context<AppEnv>, pw: Pingwarden): Access | undefined =>
    auth ? c.get('session')!.access[pw.id] : tokenAccess.get(pw.id);
  const remember = (c: Context<AppEnv>, pw: Pingwarden, canAct: boolean | null) => {
    const a = { canAct, checkedAt: Date.now() };
    if (auth) c.get('session')!.access[pw.id] = a;
    else tokenAccess.set(pw.id, a);
  };

  /**
   * Relays one Pingwarden call. A 401 for a signed-in user is retried once with a refreshed
   * token; if Pingwarden still refuses it, the error is shown rather than ending the session
   * (signing in again would only loop through the provider back to the same refusal).
   */
  const relay = async (c: Context<AppEnv>, path: string, method: 'GET' | 'POST' = 'GET', payload?: unknown) => {
    const pw = c.get('pw');
    let r = await pw.request(path, { method, token: await tokenFor(c), body: payload });
    if (r.status === 401 && auth && c.get('session')!.refreshToken) {
      r = await pw.request(path, { method, token: await tokenFor(c, true), body: payload });
    }
    if (r.status === 401) {
      const why = errorMessage(r);
      if (auth) return c.json({ error: `${pw.name} does not accept your sign-in: ${why}` }, 502);
      console.warn(`[pingwarden] ${pw.name} refused the API token: ${why}`);
      return c.json({ error: `${pw.name} refused the dashboard's token: ${why}` }, 502);
    }
    return json(r);
  };

  const who = (c: Context<AppEnv>) => (auth ? `oidc:${c.get('session')!.name}` : 'token');

  /** A runtime action: refused when read-only, logged, and its outcome teaches canAct. */
  const action = async (c: Context<AppEnv>, path: string, what: string, payload?: unknown) => {
    if (cfg.readOnly) throw new HttpError(403, 'this dashboard is read-only (READ_ONLY=true)');
    const pw = c.get('pw');
    const res = await relay(c, path, 'POST', payload);
    if (res.status === 403) remember(c, pw, false);
    else if (res.status < 300) remember(c, pw, true);
    console.log(`[action] ${who(c)} on ${pw.id}: ${what} → HTTP ${res.status}`);
    return res;
  };

  /** What the caller may do on one instance: Pingwarden's /me, cached, else what was learned. */
  const instanceInfo = async (c: Context<AppEnv>, pw: Pingwarden): Promise<InstanceInfo> => {
    const base = { id: pw.id, name: pw.name };
    if (cfg.readOnly) return { ...base, canAct: false, actionsReason: 'This dashboard is read-only.' };
    const known = accessOf(c, pw);
    let canAct = known?.canAct ?? null;
    if (!known || Date.now() - known.checkedAt > ACCESS_TTL_MS) {
      try {
        const token = auth ? await auth.accessToken(c.get('session')!) : pw.token;
        const r = await pw.request('/me', { token });
        // An older Pingwarden has no /me: keep what was learned from actions.
        if (r.status === 200) canAct = (JSON.parse(r.text) as Principal).scope === 'admin';
        remember(c, pw, canAct);
      } catch (e) {
        if (!(e instanceof PwUnavailable)) throw e;
      }
    }
    return {
      ...base,
      canAct,
      actionsReason: canAct === false ? `${pw.name} gives ${auth ? 'you' : 'this dashboard'} read access only.` : null,
    };
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/me', async (c) => {
    const session = c.get('session');
    return c.json<Me>({
      mode: cfg.auth.mode,
      user: session ? { name: session.name, sub: session.sub } : null,
      instances: await Promise.all(instances.map((pw) => instanceInfo(c, pw))),
      refreshSeconds: cfg.refreshSeconds,
    });
  });

  // --- Relayed reads ---------------------------------------------------------------------

  app.get(`${I}/status`, (c) => relay(c, '/status'));
  app.get(`${I}/monitors`, (c) =>
    relay(c, `/monitors${forwardQuery(c.req.query(), { tag: 'text', group: 'text', status: 'status', type: 'type' })}`),
  );
  app.get(`${I}/monitors/:id`, (c) => relay(c, `/monitors/${id(c)}`));
  app.get(`${I}/monitors/:id/heartbeats`, (c) =>
    relay(c, `/monitors/${id(c)}/heartbeats${forwardQuery(c.req.query(), RANGE)}`),
  );
  app.get(`${I}/monitors/:id/events`, (c) =>
    relay(c, `/monitors/${id(c)}/events${forwardQuery(c.req.query(), RANGE)}`),
  );
  app.get(`${I}/monitors/:id/uptime`, (c) => relay(c, `/monitors/${id(c)}/uptime`));
  app.get(`${I}/monitors/:id/rollups`, (c) =>
    relay(
      c,
      `/monitors/${id(c)}/rollups${forwardQuery(c.req.query(), { resolution: 'resolution', from: 'int', to: 'int' })}`,
    ),
  );
  app.get(`${I}/monitors/:id/config`, (c) => relay(c, `/monitors/${id(c)}/config`));
  app.get(`${I}/rollups`, (c) =>
    relay(
      c,
      `/rollups${forwardQuery(c.req.query(), { resolution: 'resolution', from: 'int', to: 'int', tag: 'text', group: 'id' })}`,
    ),
  );
  app.get(`${I}/groups`, (c) => relay(c, '/groups'));
  app.get(`${I}/tags`, (c) => relay(c, '/tags'));
  app.get(`${I}/maintenance`, (c) => relay(c, '/maintenance'));
  app.get(`${I}/events`, (c) => relay(c, `/events${forwardQuery(c.req.query(), RANGE)}`));
  app.get(`${I}/notifiers`, (c) => relay(c, '/notifiers'));
  app.get(`${I}/notifications`, (c) =>
    relay(
      c,
      `/notifications${forwardQuery(c.req.query(), { ...RANGE, monitor: 'id', notifier: 'id', success: 'bool', event: 'event' })}`,
    ),
  );

  // --- Runtime actions ----------------------------------------------------------------------

  const mid = (c: Context) => c.req.param('id');
  app.post(`${I}/monitors/:id/check`, (c) => action(c, `/monitors/${id(c)}/check`, `run ${mid(c)} now`));
  app.post(`${I}/monitors/:id/pause`, (c) => action(c, `/monitors/${id(c)}/pause`, `pause ${mid(c)}`));
  app.post(`${I}/monitors/:id/resume`, (c) => action(c, `/monitors/${id(c)}/resume`, `resume ${mid(c)}`));
  app.post(`${I}/monitors/:id/ack`, async (c) => {
    const comment = optString(await body(c), 'comment', 512);
    return action(c, `/monitors/${id(c)}/ack`, `acknowledge ${mid(c)}`, comment ? { comment } : {});
  });
  app.post(`${I}/monitors/:id/unack`, (c) => action(c, `/monitors/${id(c)}/unack`, `unacknowledge ${mid(c)}`));
  app.post(`${I}/monitors/:id/silence`, async (c) => {
    const b = silenceBody(await body(c));
    return action(c, `/monitors/${id(c)}/silence`, `silence ${mid(c)} (${b.duration ?? `until ${b.until}`})`, b);
  });
  app.post(`${I}/monitors/:id/unsilence`, (c) => action(c, `/monitors/${id(c)}/unsilence`, `unsilence ${mid(c)}`));
  app.post(`${I}/maintenance`, async (c) => {
    const b = maintenanceBody(await body(c));
    return action(c, '/maintenance', `start maintenance ${JSON.stringify(b)}`, b);
  });
  app.post(`${I}/maintenance/:id/end`, (c) => action(c, `/maintenance/${id(c)}/end`, `end maintenance ${mid(c)}`));
  app.post(`${I}/notifiers/:id/test`, (c) => action(c, `/notifiers/${id(c)}/test`, `test notifier ${mid(c)}`));
  app.post(`${I}/reload`, (c) => action(c, '/reload', 'reload the configuration'));

  // --- Live stream ----------------------------------------------------------------------------

  /**
   * Relays Pingwarden's server-sent events. The relay ends after 15 minutes, or when the
   * user's access token expires, whichever comes first: the browser's EventSource reconnects,
   * and the new stream is opened with a fresh token.
   */
  app.get(`${I}/stream`, async (c) => {
    const pw = c.get('pw');
    const token = await tokenFor(c);
    const session = c.get('session');
    const until = Math.min(
      Date.now() + STREAM_MAX_MS,
      session?.accessExpiresAt != null ? session.accessExpiresAt - 30_000 : Infinity,
    );
    const ctl = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    // The request signal does not always fire when the browser goes away: the Node response's
    // close event does (@hono/node-server passes it as env.outgoing).
    (c.env as { outgoing?: { once(e: 'close', f: () => void): void } } | undefined)?.outgoing?.once('close', () =>
      ctl.abort(),
    );
    const timer = setTimeout(() => ctl.abort(), Math.max(30_000, until - Date.now()));
    timer.unref();
    const r = await pw.stream(token, ctl.signal);
    if (!('ok' in r)) {
      clearTimeout(timer);
      return json(r);
    }
    // Ends the response quietly when the relay is stopped (client gone, time limit).
    const reader = r.body.getReader();
    const out = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            ctrl.close();
          } else ctrl.enqueue(value);
        } catch {
          clearTimeout(timer);
          ctrl.close();
        }
      },
      cancel() {
        clearTimeout(timer);
        ctl.abort();
      },
    });
    return new Response(out, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // nginx and similar proxies must not buffer the stream.
        'x-accel-buffering': 'no',
      },
    });
  });

  // --- Composite ----------------------------------------------------------------------------

  /**
   * Hourly rollups of every monitor over the last `hours` (default 24, at most 168), for the
   * history bars: Pingwarden's bulk /rollups, or one request per monitor with an older one.
   */
  app.get(`${I}/history`, async (c) => {
    const hours = Number(c.req.query('hours') ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'hours must be 1 to 168');
    const pw = c.get('pw');
    const token = await tokenFor(c);
    const to = Date.now();
    const from = Math.floor(to / 3600_000) * 3600_000 - (hours - 1) * 3600_000;
    const unauthorised = (e: unknown) => {
      if (e instanceof PwError && e.status === 401 && auth) throw new SessionExpired();
      throw e;
    };

    try {
      const bulk = await pw.json<BulkRollupsResponse>(`/rollups?resolution=hour&from=${from}&to=${to}`, token);
      return c.json<HistoryResponse>({ from, to, resolution: 3600, monitors: bulk.monitors, failed: [] });
    } catch (e) {
      if (!(e instanceof PwError && (e.status === 404 || e.status === 405))) unauthorised(e);
    }

    const monitors = await pw.json<Monitor[]>('/monitors', token).catch(unauthorised);
    const failed: string[] = [];
    const rows = await pool(monitors, 8, async (m) => {
      try {
        const r = await pw.json<RollupsResponse>(
          `/monitors/${encodeURIComponent(m.id)}/rollups?resolution=hour&from=${from}&to=${to}`,
          token,
        );
        return [m.id, r.rollups] as const;
      } catch (e) {
        if (!(e instanceof PwError)) throw e;
        failed.push(m.id);
        return [m.id, []] as const;
      }
    });
    return c.json<HistoryResponse>({ from, to, resolution: 3600, monitors: Object.fromEntries(rows), failed });
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (existsSync(cfg.staticDir)) {
    // serveStatic resolves paths relative to the working directory.
    const root = relative(process.cwd(), cfg.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  } else {
    app.get('/', (c) =>
      c.text('UI not built. Run "npm run build", or use "npm run dev" and open the Vite dev server.', 404),
    );
  }

  return app;
}
