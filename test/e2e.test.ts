// End-to-end against the Pingwarden of compose.yaml (npm run dev:pingwarden): a real
// Pingwarden with PostgreSQL, and the mock OIDC provider it trusts. Skipped unless
// TEST_PINGWARDEN_URL is set (CI sets it). Tokens and monitors: dev/pingwarden/*.yaml.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from '../src/server/app.ts';
import { Auth } from '../src/server/auth.ts';
import { loadConfig } from '../src/server/config.ts';
import { Pingwarden } from '../src/server/pingwarden.ts';
import type { HistoryResponse, Me } from '../src/shared/types.ts';
import type { MaintenanceWindow, Monitor, MonitorConfig } from '../src/shared/pingwarden.ts';
import { json } from './helpers.ts';

const PW = process.env.TEST_PINGWARDEN_URL;
const ISSUER = process.env.TEST_OIDC_ISSUER ?? 'http://localhost:8090/default';
const skip = PW ? false : 'TEST_PINGWARDEN_URL is not set (npm run dev:pingwarden, see .env.example)';
const ADMIN = 'dev-admin-token-0123456789';

/** Whether the stack's Pingwarden has /me, the stream, acknowledge, silence and runtime maintenance. */
const newer = PW
  ? await fetch(`${PW}/api/v1/me`, { headers: { authorization: `Bearer ${ADMIN}` } }).then(
      (r) => r.ok,
      () => false,
    )
  : false;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe('token mode against Pingwarden', { skip }, () => {
  const cfg = (env: Record<string, string> = {}) =>
    loadConfig({
      AUTH_MODE: 'token',
      PINGWARDEN_URL: PW!,
      PINGWARDEN_TOKEN: 'dev-read-token-0123456789',
      STATIC_DIR: '/nonexistent',
      ...env,
    });

  test('reads every view’s data', async () => {
    const c = cfg();
    const app = createApp(c);
    const get = async <T>(path: string) => {
      const r = await app.request(`http://localhost${path}`);
      assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
      return (await json(r)) as T;
    };
    const monitors = await get<Monitor[]>('/api/i/main/monitors');
    assert.ok(monitors.some((m) => m.id === 'pingwarden-self'));
    const self = await get<Monitor>('/api/i/main/monitors/pingwarden-self');
    assert.equal(self.type, 'http');
    for (const path of [
      '/api/i/main/status',
      '/api/i/main/groups',
      '/api/i/main/tags',
      '/api/i/main/maintenance',
      '/api/i/main/notifiers',
      '/api/i/main/events?limit=5',
      '/api/i/main/notifications?limit=5',
      '/api/i/main/monitors/pingwarden-self/heartbeats?limit=5',
      '/api/i/main/monitors/pingwarden-self/events',
      '/api/i/main/monitors/pingwarden-self/uptime',
      '/api/i/main/monitors/pingwarden-self/rollups?resolution=day',
    ]) {
      await get(path);
    }
    const history = await get<HistoryResponse>('/api/i/main/history');
    assert.deepEqual(history.failed, []);
    assert.equal(Object.keys(history.monitors).length, monitors.length);
  });

  test('a read token cannot act, even with READ_ONLY=false', async () => {
    const c = cfg({ READ_ONLY: 'false' });
    const app = createApp(c);
    const r = await app.request('http://localhost/api/i/main/monitors/loopback/check', {
      method: 'POST',
      headers: { 'x-pingwarden-ui': '1' },
    });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, 'admin access required');
  });
});

/** A browser with a cookie jar that follows redirects by hand, so each hop can be checked. */
class Browser {
  private readonly jar = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const cookies = [...this.jar].filter(([k]) => k.startsWith(`${host} `)).map(([k, v]) => `${k.split(' ')[1]}=${v}`);
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...init.headers },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair!.split('=');
      if (/max-age=0/i.test(c)) this.jar.delete(`${host} ${name}`);
      else this.jar.set(`${host} ${name}`, value ?? '');
    }
    return res;
  }
  cookie(host: string, name: string) {
    return this.jar.get(`${host} ${name}`);
  }
}

describe('OIDC sign-in through the mock provider', { skip }, () => {
  let server: Server;
  let base: string;
  let auth: Auth;

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    const cfg = loadConfig({
      AUTH_MODE: 'oidc',
      PINGWARDEN_URL: PW!,
      PUBLIC_URL: base,
      OIDC_ISSUER: ISSUER,
      OIDC_ALLOW_INSECURE_ISSUER: 'true',
      OIDC_CLIENT_ID: 'pingwarden-ui',
      OIDC_CLIENT_SECRET: 'mock-accepts-any-secret',
      STATIC_DIR: '/nonexistent',
    });
    const pws = cfg.instances.map((i) => new Pingwarden(i, cfg.pingwardenTimeoutMs));
    auth = new Auth(cfg, pws);
    const app = createApp(cfg, pws, auth);
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }) as Server;
    await new Promise((r) => server.once('listening', r));
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  /** Signs in as `username` with these claims on the mock's login form; returns the last response. */
  async function signIn(b: Browser, username: string, claims: Record<string, unknown>) {
    const login = await b.fetch(`${base}/auth/login?returnTo=/%3Fview%3Devents`);
    assert.equal(login.status, 302);
    const authorize = login.headers.get('location')!;
    assert.ok(authorize.startsWith(`${ISSUER}/authorize?`), authorize);
    const form = await b.fetch(authorize, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, claims: JSON.stringify(claims) }).toString(),
    });
    const callback = form.headers.get('location')!;
    assert.ok(callback.startsWith(`${base}/auth/callback?`), callback);
    return b.fetch(callback);
  }

  const me = async (b: Browser) => (await json(await b.fetch(`${base}/api/me`))) as Me;
  const act = (b: Browser, path: string) =>
    b.fetch(`${base}${path}`, { method: 'POST', headers: { 'x-pingwarden-ui': '1' } });

  test('an admin signs in, reads and acts with their own token', async () => {
    const b = new Browser();
    const done = await signIn(b, 'alice', { roles: ['pingwarden-admin'], preferred_username: 'alice' });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/?view=events');
    const m = await me(b);
    assert.deepEqual(m.user, { name: 'alice', sub: 'alice' });
    assert.equal(m.instances[0]!.canAct, newer ? true : null);
    const monitors = await b.fetch(`${base}/api/i/main/monitors`);
    assert.equal(monitors.status, 200);
    assert.equal((await act(b, '/api/i/main/monitors/loopback/check')).status, 200);
  });

  test('the access token is refreshed when it is about to expire', async () => {
    const b = new Browser();
    await signIn(b, 'bob', { roles: ['pingwarden-read'] });
    const session = auth.store.get(b.cookie(new URL(base).host, 'pingwarden_ui_session'))!;
    const first = session.accessToken;
    assert.ok(session.refreshToken, 'the mock issues refresh tokens');
    session.accessExpiresAt = Date.now();
    const r = await b.fetch(`${base}/api/i/main/status`);
    assert.equal(r.status, 200);
    assert.notEqual(session.accessToken, first);
    assert.ok(session.accessExpiresAt! > Date.now() + 60_000);
  });

  test('a reader may read, and actions are greyed out after Pingwarden refuses one', async () => {
    const b = new Browser();
    await signIn(b, 'carol', { roles: ['pingwarden-read'] });
    assert.equal((await me(b)).instances[0]!.canAct, newer ? false : null, 'Pingwarden’s /me tells');
    assert.equal((await b.fetch(`${base}/api/i/main/groups`)).status, 200);
    const r = await act(b, '/api/i/main/monitors/loopback/pause');
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, 'admin access required');
    assert.equal((await me(b)).instances[0]!.canAct, false, 'learned from the refusal');
  });

  test('a user without a Pingwarden role gets no session', async () => {
    const b = new Browser();
    const r = await signIn(b, 'mallory', { roles: ['something-else'] });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /gives you no read access/);
    assert.equal(b.cookie(new URL(base).host, 'pingwarden_ui_session'), undefined);
    assert.equal((await b.fetch(`${base}/api/me`)).status, 401);
  });

  test('a replayed or foreign callback is refused', async () => {
    const b = new Browser();
    const login = await b.fetch(`${base}/auth/login`);
    const form = await b.fetch(login.headers.get('location')!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'eve', claims: '{"roles":["pingwarden-admin"]}' }).toString(),
    });
    // Another browser (no login cookie) cannot complete it.
    const stolen = await new Browser().fetch(form.headers.get('location')!);
    assert.equal(stolen.status, 401);
    assert.match(await stolen.text(), /expired or was started in another browser/);
  });

  test('logout ends the session here and at the provider', async () => {
    const b = new Browser();
    await signIn(b, 'dave', { roles: ['pingwarden-read'] });
    const out = await b.fetch(`${base}/auth/logout`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(out.status, 303);
    assert.ok(out.headers.get('location')!.startsWith(`${ISSUER}/endsession?`));
    assert.equal((await b.fetch(`${base}/api/me`)).status, 401);
  });
});

describe(
  'newer Pingwarden features through the dashboard',
  { skip: skip || (newer ? false : 'Pingwarden has no /api/v1/me') },
  () => {
    const app = () =>
      createApp(
        loadConfig({
          AUTH_MODE: 'token',
          PINGWARDEN_URL: PW!,
          PINGWARDEN_TOKEN: ADMIN,
          READ_ONLY: 'false',
          STATIC_DIR: '/nonexistent',
        }),
      );
    const call = (a: ReturnType<typeof app>, path: string, body?: unknown) =>
      a.request(`http://localhost/api/i/main${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-pingwarden-ui': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const monitor = async (a: ReturnType<typeof app>, id: string) =>
      (await json(await call(a, `/monitors/${id}`))) as Monitor;

    test('the admin token can act, and the history comes from the bulk endpoint', async () => {
      const a = app();
      assert.equal((await json(await a.request('http://localhost/api/me'))).instances[0].canAct, true);
      const h = (await json(await call(a, '/history'))) as HistoryResponse;
      assert.deepEqual(h.failed, []);
      assert.ok(Object.keys(h.monitors).includes('pingwarden-self'));
      const bulk = await json(await call(a, '/rollups?resolution=day'));
      assert.equal(bulk.resolution, 86400);
    });

    test('acknowledge and silence a down monitor, then undo both', async () => {
      const a = app();
      // ssh-bastion always fails in the development stack. On a fresh stack it may not have been
      // checked yet (unknown), which cannot be acknowledged: check it now and wait until it fails.
      await call(a, '/monitors/ssh-bastion/check', {});
      for (let i = 0; i < 50 && !['pending', 'down'].includes((await monitor(a, 'ssh-bastion')).status ?? ''); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal((await call(a, '/monitors/ssh-bastion/ack', { comment: 'looking into it' })).status, 200);
      const acked = await monitor(a, 'ssh-bastion');
      assert.equal(acked.acknowledged?.comment, 'looking into it');
      assert.match(acked.acknowledged!.by, /admin/);
      assert.equal(
        (await call(a, '/monitors/pingwarden-self/ack', {})).status,
        409,
        'an up monitor cannot be acknowledged',
      );
      assert.equal((await call(a, '/monitors/ssh-bastion/silence', { duration: '1h' })).status, 200);
      const silenced = await monitor(a, 'ssh-bastion');
      assert.ok(silenced.silenced_until! > Date.now() + 50 * 60_000);
      assert.equal((await call(a, '/monitors/ssh-bastion/unsilence', {})).status, 200);
      assert.equal((await call(a, '/monitors/ssh-bastion/unack', {})).status, 200);
      const back = await monitor(a, 'ssh-bastion');
      assert.equal(back.acknowledged, null);
      assert.equal(back.silenced_until ?? null, null);
    });

    test('a runtime maintenance window puts a monitor in maintenance until it is ended', async () => {
      const a = app();
      const id = `e2e-${Date.now()}`;
      const created = await call(a, '/maintenance', {
        id,
        monitors: ['loopback'],
        duration: '10m',
        description: 'e2e',
      });
      assert.equal(created.status, 201);
      try {
        const listed = (await json(await call(a, '/maintenance'))) as MaintenanceWindow[];
        const w = listed.find((x) => x.id === id)!;
        assert.equal(w.source, 'api');
        assert.equal(w.active, true);
        assert.deepEqual(w.monitors, ['loopback']);
        // The window applies at the monitor's next check: run it now. (With overlapping
        // windows, Pingwarden names one of them.)
        assert.equal((await call(a, '/monitors/loopback/check', {})).status, 200);
        let m: Monitor | null = null;
        for (let i = 0; i < 50 && m?.status !== 'maintenance'; i++) {
          await new Promise((r) => setTimeout(r, 100));
          m = await monitor(a, 'loopback');
        }
        assert.equal(m?.status, 'maintenance');
        assert.ok(m?.maintenance);
      } finally {
        assert.equal((await call(a, `/maintenance/${id}/end`, {})).status, 200);
      }
      const after = ((await json(await call(a, '/maintenance'))) as MaintenanceWindow[]).find((x) => x.id === id);
      assert.equal(after?.active ?? false, false);
    });

    test('the effective configuration has no secrets', async () => {
      const a = app();
      const cfg = (await json(await call(a, '/monitors/postgres-query/config'))) as MonitorConfig;
      assert.equal(cfg.check.type, 'postgres');
      assert.equal(cfg.settings.interval_seconds, 30);
      assert.doesNotMatch(JSON.stringify(cfg), /:pingwarden@|dev-push-token|dev-webhook-receiver/);
      const push = await json(await call(a, '/monitors/nightly-backup/config'));
      assert.doesNotMatch(JSON.stringify(push), /dev-push-token/);
    });

    test('changes arrive on the live stream', async () => {
      const a = app();
      const res = await call(a, '/stream');
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      // Something that emits an event: pausing and resuming a monitor.
      await call(a, '/monitors/loopback/pause', {});
      await call(a, '/monitors/loopback/resume', {});
      let text = '';
      const deadline = Date.now() + 5000;
      while (!/event: monitor\ndata: \{"id":"loopback"\}/.test(text) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      await reader.cancel();
      assert.match(text, /event: monitor\ndata: \{"id":"loopback"\}/);
    });
  },
);
