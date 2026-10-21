import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, forwardQuery } from '../src/server/app.ts';
import { Auth, PAGE_CSP } from '../src/server/auth.ts';
import { loadConfig } from '../src/server/config.ts';
import { Pingwarden } from '../src/server/pingwarden.ts';
import type { Session } from '../src/server/sessions.ts';
import { fakePingwarden, json, monitor } from './helpers.ts';

const W = { method: 'POST', headers: { 'x-pingwarden-ui': '1' } };
const base = 'http://localhost:3000';

function tokenApp(pwUrl: string, env: Record<string, string> = {}) {
  const cfg = loadConfig({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: pwUrl,
    PINGWARDEN_TOKEN: 'read-token-0123456789',
    STATIC_DIR: '/nonexistent',
    PINGWARDEN_TIMEOUT_SECONDS: '1',
    ...env,
  });
  return createApp(cfg, new Pingwarden(cfg.pingwarden));
}

test('forwardQuery keeps the listed parameters and validates them', () => {
  assert.equal(forwardQuery({ from: '1', limit: '5', evil: 'x' }, { from: 'int', limit: 'int' }), '?from=1&limit=5');
  assert.equal(forwardQuery({}, { from: 'int' }), '');
  assert.equal(
    forwardQuery({ status: 'down', type: 'tls' }, { status: 'status', type: 'type' }),
    '?status=down&type=tls',
  );
  assert.throws(() => forwardQuery({ from: '-1' }, { from: 'int' }), /invalid from/);
  assert.throws(() => forwardQuery({ resolution: 'week' }, { resolution: 'resolution' }), /invalid resolution/);
  assert.throws(() => forwardQuery({ status: 'on fire' }, { status: 'status' }), /invalid status/);
});

test('token mode: reads are relayed with the token, bodies and statuses unchanged', async () => {
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/monitors/gone') return { status: 404, body: { error: 'monitor gone not found' } };
    if (url.pathname === '/api/v1/monitors') return { body: [monitor('a')] };
    return { body: { path: url.pathname, query: url.search } };
  });
  try {
    const app = tokenApp(pw.url);
    const list = await app.request(`${base}/api/monitors?status=down&tag=prod&junk=1`);
    assert.equal(list.status, 200);
    assert.deepEqual(await json(list), [monitor('a')]);
    assert.deepEqual(pw.seen.at(-1), {
      method: 'GET',
      path: '/api/v1/monitors?tag=prod&status=down',
      authorization: 'Bearer read-token-0123456789',
    });

    const missing = await app.request(`${base}/api/monitors/gone`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(missing), { error: 'monitor gone not found' });

    await app.request(`${base}/api/monitors/web.site-1/rollups?resolution=day&from=5`);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/monitors/web.site-1/rollups?resolution=day&from=5');

    // Ids that are not Pingwarden ids never reach it.
    const before = pw.seen.length;
    assert.equal((await app.request(`${base}/api/monitors/..%2Fstatus`)).status, 404);
    assert.equal((await app.request(`${base}/api/events?limit=lots`)).status, 400);
    assert.equal((await app.request(`${base}/api/unknown`)).status, 404);
    assert.equal(pw.seen.length, before);

    const me = await json(await app.request(`${base}/api/me`));
    assert.deepEqual(me, {
      mode: 'token',
      user: null,
      canAct: false,
      actionsReason: 'This dashboard is read-only.',
      refreshSeconds: 15,
    });
  } finally {
    await pw.close();
  }
});

test('token mode is read-only by default; READ_ONLY=false relays actions', async () => {
  const pw = await fakePingwarden(() => ({ body: { ok: true } }));
  try {
    const ro = tokenApp(pw.url);
    for (const path of ['/api/monitors/a/check', '/api/monitors/a/pause', '/api/notifiers/n/test', '/api/reload']) {
      assert.equal((await ro.request(`${base}${path}`, W)).status, 403, path);
    }
    assert.equal(pw.seen.length, 0);

    const rw = tokenApp(pw.url, { READ_ONLY: 'false' });
    assert.equal((await rw.request(`${base}/api/monitors/a/resume`, W)).status, 200);
    assert.deepEqual(pw.seen.at(-1)!.method + ' ' + pw.seen.at(-1)!.path, 'POST /api/v1/monitors/a/resume');
    assert.equal((await rw.request(`${base}/api/monitors/a/resume`, { method: 'POST' })).status, 403, 'CSRF header');
    assert.equal((await json(await rw.request(`${base}/api/me`))).canAct, null);
  } finally {
    await pw.close();
  }
});

test('Pingwarden failures become clear errors', async () => {
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/status') return { status: 401, body: { error: 'invalid token' } };
    if (url.pathname === '/api/v1/groups') return { status: 200, body: '<html>proxy</html>', type: 'text/html' };
    return { status: 503, body: { error: 'this instance is on standby' } };
  });
  try {
    const app = tokenApp(pw.url);
    const refused = await app.request(`${base}/api/status`);
    assert.equal(refused.status, 502);
    assert.match((await json(refused)).error, /refused the dashboard's token: invalid token/);
    const html = await app.request(`${base}/api/groups`);
    assert.equal(html.status, 502);
    assert.match((await json(html)).error, /without JSON/);
    assert.equal((await app.request(`${base}/api/monitors`)).status, 503);
  } finally {
    await pw.close();
  }
  const down = tokenApp(pw.url);
  const r = await down.request(`${base}/api/status`);
  assert.equal(r.status, 502);
  assert.match((await json(r)).error, /unreachable/);
});

test('history: hourly rollups of every monitor in one response', async () => {
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/monitors') return { body: [monitor('a'), monitor('b')] };
    if (url.pathname === '/api/v1/monitors/b/rollups') return { status: 500, body: { error: 'db' } };
    return { body: { monitor: 'a', resolution: 3600, rollups: [{ bucket: 1, up: 1 }] } };
  });
  try {
    const app = tokenApp(pw.url);
    const r = await app.request(`${base}/api/history?hours=6`);
    assert.equal(r.status, 200);
    const h = await json(r);
    assert.deepEqual(h.monitors, { a: [{ bucket: 1, up: 1 }], b: [] });
    assert.deepEqual(h.failed, ['b']);
    assert.equal(h.from % 3600_000, 0);
    assert.ok(h.to - h.from <= 6 * 3600_000);
    const q = new URL(pw.seen.find((s) => s.path.includes('/a/rollups'))!.path, 'http://x').searchParams;
    assert.equal(q.get('resolution'), 'hour');
    assert.equal(Number(q.get('from')), h.from);
    assert.equal((await app.request(`${base}/api/history?hours=500`)).status, 400);
  } finally {
    await pw.close();
  }
});

test('OIDC mode: sessions carry the user token; Pingwarden decides', async () => {
  let accept = true;
  const pw = await fakePingwarden((req, url) => {
    if (!accept) return { status: 401, body: { error: 'token expired' } };
    if (url.pathname.endsWith('/pause')) return { status: 403, body: { error: 'admin access required' } };
    return { body: { auth: req.headers.authorization } };
  });
  try {
    const cfg = loadConfig({
      AUTH_MODE: 'oidc',
      PINGWARDEN_URL: pw.url,
      PUBLIC_URL: 'http://localhost:3000',
      OIDC_ISSUER: 'http://127.0.0.1:9/never-contacted',
      OIDC_ALLOW_INSECURE_ISSUER: 'true',
      OIDC_CLIENT_ID: 'ui',
      STATIC_DIR: '/nonexistent',
    });
    const p = new Pingwarden(cfg.pingwarden);
    const auth = new Auth(cfg, p);
    const app = createApp(cfg, p, auth);

    // Without a session: 401 for the API (the UI then signs in), a redirect for pages.
    const anon = await app.request(`${base}/api/monitors`);
    assert.equal(anon.status, 401);
    assert.equal((await json(anon)).login, true);
    const page = await app.request(`${base}/?view=events`);
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/auth/login?returnTo=%2F%3Fview%3Devents');
    assert.equal((await app.request(`${base}/api/health`)).status, 200);
    // The script-less sign-in pages carry their own CSP, which allows their inline style.
    const out = await app.request(`${base}/auth/logged-out`);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('content-security-policy'), PAGE_CSP);
    assert.match((await app.request(`${base}/api/health`)).headers.get('content-security-policy')!, /style-src 'self'/);

    const session: Session = {
      sub: 'u1',
      name: 'alice',
      accessToken: 'user-access-token',
      accessExpiresAt: Date.now() + 3600_000,
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 3600_000,
      canAct: null,
    };
    const cookie = { cookie: `pingwarden_ui_session=${auth.store.create(session)}` };
    const ok = await app.request(`${base}/api/status`, { headers: cookie });
    assert.deepEqual(await json(ok), { auth: 'Bearer user-access-token' });

    const me = await json(await app.request(`${base}/api/me`, { headers: cookie }));
    assert.deepEqual(me.user, { name: 'alice', sub: 'u1' });
    assert.equal(me.canAct, null);

    // A refused action teaches the UI to grey actions out for this user.
    const refused = await app.request(`${base}/api/monitors/a/pause`, { ...W, headers: { ...W.headers, ...cookie } });
    assert.equal(refused.status, 403);
    const after = await json(await app.request(`${base}/api/me`, { headers: cookie }));
    assert.equal(after.canAct, false);
    assert.equal(after.actionsReason, 'Pingwarden gives you read access only.');

    // An access token past its expiry without a refresh token ends the session.
    session.accessExpiresAt = Date.now() - 1000;
    const expired = await app.request(`${base}/api/status`, { headers: cookie });
    assert.equal(expired.status, 401);
    assert.equal((await json(expired)).login, true);
    assert.equal(auth.store.size, 0);

    // A token Pingwarden stops accepting ends the session too.
    const s2 = { ...session, accessExpiresAt: null };
    const cookie2 = { cookie: `pingwarden_ui_session=${auth.store.create(s2)}` };
    accept = false;
    const revoked = await app.request(`${base}/api/monitors`, { headers: cookie2 });
    assert.equal(revoked.status, 401);
    assert.match((await json(revoked)).error, /no longer accepts your sign-in \(token expired\)/);
    assert.equal(auth.store.size, 0);
  } finally {
    await pw.close();
  }
});
