// HTTP API, OIDC routes and (in production) the static UI. The API relays an explicit list of
// Pingwarden endpoints: parameters are validated here, and bodies pass through unchanged.
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { ID_RE, MONITOR_TYPES, type Monitor, type RollupsResponse, STATUSES } from '../shared/pingwarden.ts';
import type { HistoryResponse, Me } from '../shared/types.ts';
import { type AppEnv, Auth, SessionExpired } from './auth.ts';
import type { Config } from './config.ts';
import { hostGuard, sameOriginGuard } from './guard.ts';
import { errorMessage, type Pingwarden, PwError, type PwResponse, PwUnavailable } from './pingwarden.ts';

/** An error with an HTTP status and a message meant for the user. */
export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404;
  constructor(status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

type Param = 'int' | 'resolution' | 'text' | 'status' | 'type';

const PARAM_CHECKS: Record<Param, (v: string) => boolean> = {
  int: (v) => /^\d{1,16}$/.test(v),
  resolution: (v) => v === 'hour' || v === 'day',
  text: (v) => v.length > 0 && v.length <= 200,
  status: (v) => (STATUSES as readonly string[]).includes(v),
  type: (v) => (MONITOR_TYPES as readonly string[]).includes(v),
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

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function createApp(cfg: Config, pw: Pingwarden, auth: Auth | null = null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (cfg.auth.mode === 'oidc') auth ??= new Auth(cfg, pw);

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

  /** The bearer token to send to Pingwarden for this request. */
  const tokenFor = async (c: Context<AppEnv>): Promise<string | null> => {
    if (!auth) return cfg.pingwarden.token;
    return auth.accessToken(c.get('session')!);
  };

  /** Relays one Pingwarden call. A 401 for a signed-in user ends the session. */
  const relay = async (c: Context<AppEnv>, path: string, method: 'GET' | 'POST' = 'GET') => {
    const r = await pw.request(path, { method, token: await tokenFor(c) });
    if (r.status === 401) {
      if (auth) {
        auth.store.drop(c.get('session')!);
        return c.json({ error: `Pingwarden no longer accepts your sign-in (${errorMessage(r)})`, login: true }, 401);
      }
      console.warn(`[pingwarden] the API token was refused: ${errorMessage(r)}`);
      return c.json({ error: `Pingwarden refused the dashboard's token: ${errorMessage(r)}` }, 502);
    }
    return json(r);
  };

  const who = (c: Context<AppEnv>) => (auth ? `oidc:${c.get('session')!.name}` : 'token');

  /** A runtime action: refused when read-only, logged, and its outcome teaches canAct. */
  const action = async (c: Context<AppEnv>, path: string, what: string) => {
    if (cfg.readOnly) throw new HttpError(403, 'this dashboard is read-only (READ_ONLY=true)');
    const res = await relay(c, path, 'POST');
    const session = c.get('session');
    if (session && res.status === 403) session.canAct = false;
    else if (session && res.status < 300) session.canAct = true;
    console.log(`[action] ${who(c)}: ${what} → HTTP ${res.status}`);
    return res;
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/me', (c) => {
    const session = c.get('session');
    const canAct = cfg.readOnly ? false : (session?.canAct ?? null);
    return c.json<Me>({
      mode: cfg.auth.mode,
      user: session ? { name: session.name, sub: session.sub } : null,
      canAct,
      actionsReason: cfg.readOnly
        ? 'This dashboard is read-only.'
        : canAct === false
          ? 'Pingwarden gives you read access only.'
          : null,
      refreshSeconds: cfg.refreshSeconds,
    });
  });

  // --- Relayed reads ---------------------------------------------------------------------

  app.get('/api/status', (c) => relay(c, '/status'));
  app.get('/api/monitors', (c) =>
    relay(c, `/monitors${forwardQuery(c.req.query(), { tag: 'text', group: 'text', status: 'status', type: 'type' })}`),
  );
  app.get('/api/monitors/:id', (c) => relay(c, `/monitors/${id(c)}`));
  app.get('/api/monitors/:id/heartbeats', (c) =>
    relay(c, `/monitors/${id(c)}/heartbeats${forwardQuery(c.req.query(), RANGE)}`),
  );
  app.get('/api/monitors/:id/events', (c) =>
    relay(c, `/monitors/${id(c)}/events${forwardQuery(c.req.query(), RANGE)}`),
  );
  app.get('/api/monitors/:id/uptime', (c) => relay(c, `/monitors/${id(c)}/uptime`));
  app.get('/api/monitors/:id/rollups', (c) =>
    relay(
      c,
      `/monitors/${id(c)}/rollups${forwardQuery(c.req.query(), { resolution: 'resolution', from: 'int', to: 'int' })}`,
    ),
  );
  app.get('/api/groups', (c) => relay(c, '/groups'));
  app.get('/api/tags', (c) => relay(c, '/tags'));
  app.get('/api/maintenance', (c) => relay(c, '/maintenance'));
  app.get('/api/events', (c) => relay(c, `/events${forwardQuery(c.req.query(), RANGE)}`));
  app.get('/api/notifiers', (c) => relay(c, '/notifiers'));
  app.get('/api/notifications', (c) => relay(c, `/notifications${forwardQuery(c.req.query(), RANGE)}`));

  // --- Runtime actions ----------------------------------------------------------------------

  app.post('/api/monitors/:id/check', (c) => action(c, `/monitors/${id(c)}/check`, `run ${c.req.param('id')} now`));
  app.post('/api/monitors/:id/pause', (c) => action(c, `/monitors/${id(c)}/pause`, `pause ${c.req.param('id')}`));
  app.post('/api/monitors/:id/resume', (c) => action(c, `/monitors/${id(c)}/resume`, `resume ${c.req.param('id')}`));
  app.post('/api/notifiers/:id/test', (c) =>
    action(c, `/notifiers/${id(c)}/test`, `test notifier ${c.req.param('id')}`),
  );
  app.post('/api/reload', (c) => action(c, '/reload', 'reload the configuration'));

  // --- Composite ----------------------------------------------------------------------------

  /**
   * Hourly rollups of every monitor over the last `hours` (default 24, at most 168), for the
   * history bars of the monitor list: one request from the browser instead of one per monitor.
   */
  app.get('/api/history', async (c) => {
    const hours = Number(c.req.query('hours') ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'hours must be 1 to 168');
    const token = await tokenFor(c);
    const to = Date.now();
    const from = Math.floor(to / 3600_000) * 3600_000 - (hours - 1) * 3600_000;
    let monitors: Monitor[];
    try {
      monitors = await pw.json<Monitor[]>('/monitors', token);
    } catch (e) {
      if (e instanceof PwError && e.status === 401 && auth) throw new SessionExpired();
      throw e;
    }
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
