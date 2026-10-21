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
import type { Monitor } from '../src/shared/pingwarden.ts';
import { json } from './helpers.ts';

const PW = process.env.TEST_PINGWARDEN_URL;
const ISSUER = process.env.TEST_OIDC_ISSUER ?? 'http://localhost:8090/default';
const skip = PW ? false : 'TEST_PINGWARDEN_URL is not set (npm run dev:pingwarden, see .env.example)';

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
    const app = createApp(c, new Pingwarden(c.pingwarden));
    const get = async <T>(path: string) => {
      const r = await app.request(`http://localhost${path}`);
      assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
      return (await json(r)) as T;
    };
    const monitors = await get<Monitor[]>('/api/monitors');
    assert.ok(monitors.some((m) => m.id === 'pingwarden-self'));
    const self = await get<Monitor>('/api/monitors/pingwarden-self');
    assert.equal(self.type, 'http');
    for (const path of [
      '/api/status',
      '/api/groups',
      '/api/tags',
      '/api/maintenance',
      '/api/notifiers',
      '/api/events?limit=5',
      '/api/notifications?limit=5',
      '/api/monitors/pingwarden-self/heartbeats?limit=5',
      '/api/monitors/pingwarden-self/events',
      '/api/monitors/pingwarden-self/uptime',
      '/api/monitors/pingwarden-self/rollups?resolution=day',
    ]) {
      await get(path);
    }
    const history = await get<HistoryResponse>('/api/history');
    assert.deepEqual(history.failed, []);
    assert.equal(Object.keys(history.monitors).length, monitors.length);
  });

  test('a read token cannot act, even with READ_ONLY=false', async () => {
    const c = cfg({ READ_ONLY: 'false' });
    const app = createApp(c, new Pingwarden(c.pingwarden));
    const r = await app.request('http://localhost/api/monitors/loopback/check', {
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
      OIDC_ROLES_CLAIM: 'roles',
      OIDC_ADMIN_ROLES: 'pingwarden-admin',
      STATIC_DIR: '/nonexistent',
    });
    const pw = new Pingwarden(cfg.pingwarden);
    auth = new Auth(cfg, pw);
    const app = createApp(cfg, pw, auth);
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
    assert.equal(m.canAct, true);
    const monitors = await b.fetch(`${base}/api/monitors`);
    assert.equal(monitors.status, 200);
    assert.equal((await act(b, '/api/monitors/loopback/check')).status, 200);
  });

  test('the access token is refreshed when it is about to expire', async () => {
    const b = new Browser();
    await signIn(b, 'bob', { roles: ['pingwarden-read'] });
    const session = auth.store.get(b.cookie(new URL(base).host, 'pingwarden_ui_session'))!;
    const first = session.accessToken;
    assert.ok(session.refreshToken, 'the mock issues refresh tokens');
    session.accessExpiresAt = Date.now();
    const r = await b.fetch(`${base}/api/status`);
    assert.equal(r.status, 200);
    assert.notEqual(session.accessToken, first);
    assert.ok(session.accessExpiresAt! > Date.now() + 60_000);
  });

  test('a reader may read, and actions are greyed out after Pingwarden refuses one', async () => {
    const b = new Browser();
    await signIn(b, 'carol', { roles: ['pingwarden-read'] });
    assert.equal((await me(b)).canAct, false, 'the roles hint knows already');
    assert.equal((await b.fetch(`${base}/api/groups`)).status, 200);
    const r = await act(b, '/api/monitors/loopback/pause');
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, 'admin access required');
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
