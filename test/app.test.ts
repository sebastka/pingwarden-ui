import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, csp, forwardQuery, maintenanceBody, silenceBody } from '../src/server/app.ts';
import { Auth, PAGE_CSP } from '../src/server/auth.ts';
import { loadConfig } from '../src/server/config.ts';
import { Pingwarden } from '../src/server/pingwarden.ts';
import type { Session } from '../src/server/sessions.ts';
import { fakePingwarden, json, monitor } from './helpers.ts';

const W = { method: 'POST', headers: { 'x-pingwarden-ui': '1' } };
const base = 'http://localhost:3000';
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'x-pingwarden-ui': '1', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function tokenApp(pwUrl: string, env: Record<string, string> = {}) {
  const cfg = loadConfig({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: pwUrl,
    PINGWARDEN_TOKEN: 'read-token-0123456789',
    STATIC_DIR: '/nonexistent',
    PINGWARDEN_TIMEOUT_SECONDS: '1',
    ...env,
  });
  return createApp(cfg);
}

test('forwardQuery keeps the listed parameters and validates them', () => {
  assert.equal(forwardQuery({ from: '1', limit: '5', evil: 'x' }, { from: 'int', limit: 'int' }), '?from=1&limit=5');
  assert.equal(forwardQuery({}, { from: 'int' }), '');
  assert.equal(
    forwardQuery({ status: 'down', type: 'tls' }, { status: 'status', type: 'type' }),
    '?status=down&type=tls',
  );
  assert.equal(
    forwardQuery({ success: 'false', event: 'down' }, { success: 'bool', event: 'event' }),
    '?success=false&event=down',
  );
  assert.throws(() => forwardQuery({ from: '-1' }, { from: 'int' }), /invalid from/);
  assert.throws(() => forwardQuery({ resolution: 'week' }, { resolution: 'resolution' }), /invalid resolution/);
  assert.throws(() => forwardQuery({ status: 'on fire' }, { status: 'status' }), /invalid status/);
  assert.throws(() => forwardQuery({ monitor: '../x' }, { monitor: 'id' }), /invalid monitor/);
  assert.throws(() => forwardQuery({ success: 'yes' }, { success: 'bool' }), /invalid success/);
});

test('action bodies: only known fields, type-checked', () => {
  assert.deepEqual(silenceBody({ duration: '2h', evil: 1 }), { duration: '2h' });
  assert.deepEqual(silenceBody({ until: 1792580000000 }), { until: 1792580000000 });
  assert.throws(() => silenceBody({}), /either duration or until/);
  assert.throws(() => silenceBody({ duration: '2h', until: 5 }), /either duration or until/);
  assert.throws(() => silenceBody({ duration: 'two hours' }), /duration such as/);
  assert.deepEqual(maintenanceBody({ monitors: ['web', 'db'], duration: '1h30m', description: 'patch', junk: true }), {
    description: 'patch',
    monitors: ['web', 'db'],
    duration: '1h30m',
  });
  assert.deepEqual(maintenanceBody({ all: true, start: 1, end: 2, tags: ['team:web'] }), {
    tags: ['team:web'],
    all: true,
    start: 1,
    end: 2,
  });
  assert.throws(() => maintenanceBody({ monitors: ['../x'] }), /list of ids/);
  assert.throws(() => maintenanceBody({ id: 'bad id' }), /invalid id/);
  assert.throws(() => maintenanceBody({ start: -5 }), /time in ms/);
  assert.throws(() => maintenanceBody({ description: 'x'.repeat(501) }), /at most 500/);
});

test('token mode: reads are relayed with the token, bodies and statuses unchanged', async () => {
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/monitors/gone') return { status: 404, body: { error: 'monitor gone not found' } };
    if (url.pathname === '/api/v1/monitors') return { body: [monitor('a')] };
    if (url.pathname === '/api/v1/me') return { body: { name: 'ui', kind: 'token', scope: 'read' } };
    return { body: { path: url.pathname, query: url.search } };
  });
  try {
    const app = tokenApp(pw.url);
    const list = await app.request(`${base}/api/i/main/monitors?status=down&tag=prod&junk=1`);
    assert.equal(list.status, 200);
    assert.deepEqual(await json(list), [monitor('a')]);
    assert.deepEqual(pw.seen.at(-1), {
      method: 'GET',
      path: '/api/v1/monitors?tag=prod&status=down',
      authorization: 'Bearer read-token-0123456789',
      body: '',
    });

    const missing = await app.request(`${base}/api/i/main/monitors/gone`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(missing), { error: 'monitor gone not found' });

    await app.request(`${base}/api/i/main/monitors/web.site-1/rollups?resolution=day&from=5`);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/monitors/web.site-1/rollups?resolution=day&from=5');
    await app.request(`${base}/api/i/main/notifications?monitor=web&success=false&limit=10`);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/notifications?limit=10&monitor=web&success=false');
    await app.request(`${base}/api/i/main/monitors/web/config`);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/monitors/web/config');

    // Ids that are not Pingwarden ids, and unknown instances, never reach it.
    const before = pw.seen.length;
    assert.equal((await app.request(`${base}/api/i/main/monitors/..%2Fstatus`)).status, 404);
    assert.equal((await app.request(`${base}/api/i/main/events?limit=lots`)).status, 400);
    assert.equal((await app.request(`${base}/api/i/other/monitors`)).status, 404);
    assert.equal((await app.request(`${base}/api/unknown`)).status, 404);
    assert.equal(pw.seen.length, before);

    // Read-only: actions are not offered, whatever the token may do.
    const me = await json(await app.request(`${base}/api/me`));
    assert.deepEqual(me, {
      mode: 'token',
      user: null,
      instances: [
        { id: 'main', name: new URL(pw.url).host, canAct: false, actionsReason: 'This dashboard is read-only.' },
      ],
      refreshSeconds: 15,
    });
  } finally {
    await pw.close();
  }
});

test('READ_ONLY=false: what the token may do comes from Pingwarden’s /me', async () => {
  let scope = 'read';
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/me') return { body: { name: 'ui', kind: 'token', scope } };
    return { body: { ok: true } };
  });
  try {
    const app = tokenApp(pw.url, { READ_ONLY: 'false' });
    const me = await json(await app.request(`${base}/api/me`));
    assert.equal(me.instances[0].canAct, false);
    assert.match(me.instances[0].actionsReason, /gives this dashboard read access only/);
    scope = 'admin';
    // Cached for a few minutes; a fresh app asks again.
    const fresh = tokenApp(pw.url, { READ_ONLY: 'false' });
    assert.equal((await json(await fresh.request(`${base}/api/me`))).instances[0].canAct, true);
  } finally {
    await pw.close();
  }
});

test('an older Pingwarden without /me: unknown until an action answers', async () => {
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/me') return { status: 404, body: { error: 'not found' } };
    if (url.pathname.endsWith('/pause')) return { status: 403, body: { error: 'admin access required' } };
    return { body: { ok: true } };
  });
  try {
    const app = tokenApp(pw.url, { READ_ONLY: 'false' });
    assert.equal((await json(await app.request(`${base}/api/me`))).instances[0].canAct, null);
    assert.equal((await app.request(`${base}/api/i/main/monitors/a/pause`, W)).status, 403);
    assert.equal((await json(await app.request(`${base}/api/me`))).instances[0].canAct, false);
  } finally {
    await pw.close();
  }
});

test('actions: read-only refuses them; otherwise they are relayed with their bodies', async () => {
  const pw = await fakePingwarden(() => ({ body: { ok: true } }));
  try {
    const ro = tokenApp(pw.url);
    for (const path of ['/monitors/a/check', '/monitors/a/ack', '/monitors/a/silence', '/maintenance', '/reload']) {
      assert.equal((await ro.request(`${base}/api/i/main${path}`, post({ duration: '1h' }))).status, 403, path);
    }
    assert.equal(pw.seen.length, 0);

    const rw = tokenApp(pw.url, { READ_ONLY: 'false' });
    assert.equal((await rw.request(`${base}/api/i/main/monitors/a/resume`, W)).status, 200);
    assert.equal(`${pw.seen.at(-1)!.method} ${pw.seen.at(-1)!.path}`, 'POST /api/v1/monitors/a/resume');
    assert.equal((await rw.request(`${base}/api/i/main/monitors/a/resume`, { method: 'POST' })).status, 403, 'CSRF');

    assert.equal((await rw.request(`${base}/api/i/main/monitors/a/ack`, post({ comment: 'on it' }))).status, 200);
    assert.deepEqual(JSON.parse(pw.seen.at(-1)!.body), { comment: 'on it' });
    assert.equal((await rw.request(`${base}/api/i/main/monitors/a/ack`, W)).status, 200, 'no body');
    assert.deepEqual(JSON.parse(pw.seen.at(-1)!.body), {});

    assert.equal((await rw.request(`${base}/api/i/main/monitors/a/silence`, post({ duration: '4h' }))).status, 200);
    assert.deepEqual(JSON.parse(pw.seen.at(-1)!.body), { duration: '4h' });
    const bad = await rw.request(`${base}/api/i/main/monitors/a/silence`, post({ duration: 'forever' }));
    assert.equal(bad.status, 400);

    const mw = { monitors: ['a'], duration: '1h', description: 'upgrade' };
    assert.equal((await rw.request(`${base}/api/i/main/maintenance`, post(mw))).status, 200);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/maintenance');
    assert.deepEqual(JSON.parse(pw.seen.at(-1)!.body), { description: 'upgrade', monitors: ['a'], duration: '1h' });
    assert.equal((await rw.request(`${base}/api/i/main/maintenance/api-1/end`, W)).status, 200);
    assert.equal(pw.seen.at(-1)!.path, '/api/v1/maintenance/api-1/end');
    assert.equal((await rw.request(`${base}/api/i/main/maintenance`, post([1]))).status, 400);
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
    const app = tokenApp(pw.url, { PINGWARDEN_NAME: 'Home' });
    const refused = await app.request(`${base}/api/i/main/status`);
    assert.equal(refused.status, 502);
    assert.match((await json(refused)).error, /Home refused the dashboard's token: invalid token/);
    const html = await app.request(`${base}/api/i/main/groups`);
    assert.equal(html.status, 502);
    assert.match((await json(html)).error, /without JSON/);
    assert.equal((await app.request(`${base}/api/i/main/monitors`)).status, 503);
  } finally {
    await pw.close();
  }
  const down = tokenApp(pw.url);
  const r = await down.request(`${base}/api/i/main/status`);
  assert.equal(r.status, 502);
  assert.match((await json(r)).error, /unreachable/);
});

test('history: the bulk endpoint when Pingwarden has it, one request per monitor otherwise', async () => {
  let bulk = true;
  const pw = await fakePingwarden((_req, url) => {
    if (url.pathname === '/api/v1/rollups') {
      return bulk
        ? { body: { resolution: 3600, from: 0, to: 1, monitors: { a: [{ bucket: 1, up: 2 }], b: [] } } }
        : { status: 404, body: '', type: 'text/plain' };
    }
    if (url.pathname === '/api/v1/monitors') return { body: [monitor('a'), monitor('b')] };
    if (url.pathname === '/api/v1/monitors/b/rollups') return { status: 500, body: { error: 'db' } };
    return { body: { monitor: 'a', resolution: 3600, rollups: [{ bucket: 1, up: 1 }] } };
  });
  try {
    const app = tokenApp(pw.url);
    const one = await json(await app.request(`${base}/api/i/main/history?hours=6`));
    assert.deepEqual(one.monitors, { a: [{ bucket: 1, up: 2 }], b: [] });
    assert.equal(pw.seen.length, 1);
    const q = new URL(pw.seen[0]!.path, 'http://x').searchParams;
    assert.equal(q.get('resolution'), 'hour');
    assert.equal(Number(q.get('from')), one.from);
    assert.equal(one.from % 3600_000, 0);

    // An older Pingwarden: an empty 404 for the route it does not have.
    bulk = false;
    const h = await json(await app.request(`${base}/api/i/main/history?hours=6`));
    assert.deepEqual(h.monitors, { a: [{ bucket: 1, up: 1 }], b: [] });
    assert.deepEqual(h.failed, ['b']);
    assert.equal((await app.request(`${base}/api/i/main/history?hours=500`)).status, 400);
  } finally {
    await pw.close();
  }
});

test('the live stream is relayed as server-sent events; errors as JSON', async () => {
  let available = true;
  const pw = await fakePingwarden((req, url) => {
    if (url.pathname !== '/api/v1/stream') return { body: {} };
    if (!available) return { status: 404, body: { error: 'not found' } };
    return {
      raw: (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: transition\ndata: {"id":1,"monitor_id":"a","ts":1,"to":"down"}\n\n');
        setTimeout(() => res.end('event: reload\ndata: {}\n\n'), 20);
      },
    };
  });
  try {
    const app = tokenApp(pw.url);
    const r = await app.request(`${base}/api/i/main/stream`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /^text\/event-stream/);
    assert.equal(r.headers.get('x-accel-buffering'), 'no');
    const text = await r.text();
    assert.match(text, /event: transition\ndata: \{"id":1/);
    assert.match(text, /event: reload/);
    assert.equal(pw.seen.at(-1)!.authorization, 'Bearer read-token-0123456789');

    available = false;
    const old = await app.request(`${base}/api/i/main/stream`);
    assert.equal(old.status, 404);
  } finally {
    await pw.close();
  }
});

test('several instances: each with its own URL and token', async () => {
  const a = await fakePingwarden(() => ({ body: [monitor('in-a')] }));
  const b = await fakePingwarden(() => ({ body: [monitor('in-b')] }));
  try {
    const cfg = loadConfig({
      AUTH_MODE: 'token',
      PINGWARDEN_1_URL: a.url,
      PINGWARDEN_1_NAME: 'Home',
      PINGWARDEN_1_TOKEN: 'token-a-0123456789',
      PINGWARDEN_2_URL: b.url,
      PINGWARDEN_2_ID: 'office',
      PINGWARDEN_2_TOKEN: 'token-b-0123456789',
      STATIC_DIR: '/nonexistent',
    });
    const app = createApp(cfg);
    assert.equal((await json(await app.request(`${base}/api/i/1/monitors`)))[0].id, 'in-a');
    assert.equal((await json(await app.request(`${base}/api/i/office/monitors`)))[0].id, 'in-b');
    assert.equal(a.seen.at(-1)!.authorization, 'Bearer token-a-0123456789');
    assert.equal(b.seen.at(-1)!.authorization, 'Bearer token-b-0123456789');
    const me = await json(await app.request(`${base}/api/me`));
    assert.deepEqual(
      me.instances.map((i: { id: string; name: string }) => [i.id, i.name]),
      [
        ['1', 'Home'],
        ['office', new URL(b.url).host],
      ],
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test('FRAME_ANCESTORS opens framing to the listed origins only', async () => {
  assert.match(csp([]), /frame-ancestors 'none'/);
  const cfg = loadConfig({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: 'http://127.0.0.1:9',
    FRAME_ANCESTORS: 'https://ha.example.com http://wall.lan:8123',
    STATIC_DIR: '/nonexistent',
  });
  const r = await createApp(cfg).request(`${base}/api/health`);
  assert.match(
    r.headers.get('content-security-policy')!,
    /frame-ancestors https:\/\/ha.example.com http:\/\/wall.lan:8123;/,
  );
  assert.equal(r.headers.get('x-frame-options'), null);
  const closed = await tokenApp('http://127.0.0.1:9').request(`${base}/api/health`);
  assert.equal(closed.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('OIDC mode: sessions carry the user token; Pingwarden decides', async () => {
  let accept = true;
  const pw = await fakePingwarden((req, url) => {
    if (!accept) return { status: 401, body: { error: 'token expired' } };
    if (url.pathname === '/api/v1/me') return { body: { name: 'alice', kind: 'oidc', scope: 'read' } };
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
    const pws = cfg.instances.map((i) => new Pingwarden(i, cfg.pingwardenTimeoutMs));
    const auth = new Auth(cfg, pws);
    const app = createApp(cfg, pws, auth);

    // Without a session: 401 for the API (the UI then signs in), a redirect for pages.
    const anon = await app.request(`${base}/api/i/main/monitors`);
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

    const session: Session = {
      sub: 'u1',
      name: 'alice',
      accessToken: 'user-access-token',
      accessExpiresAt: Date.now() + 3600_000,
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 3600_000,
      access: {},
    };
    const cookie = { cookie: `pingwarden_ui_session=${auth.store.create(session)}` };
    const ok = await app.request(`${base}/api/i/main/status`, { headers: cookie });
    assert.deepEqual(await json(ok), { auth: 'Bearer user-access-token' });

    // Pingwarden's /me says read: actions are greyed out from the start.
    const me = await json(await app.request(`${base}/api/me`, { headers: cookie }));
    assert.deepEqual(me.user, { name: 'alice', sub: 'u1' });
    assert.equal(me.instances[0].canAct, false);
    assert.equal(me.instances[0].actionsReason, `${new URL(pw.url).host} gives you read access only.`);
    const refused = await app.request(`${base}/api/i/main/monitors/a/pause`, {
      ...W,
      headers: { ...W.headers, ...cookie },
    });
    assert.equal(refused.status, 403);

    // A token Pingwarden refuses shows the reason, and keeps the session: signing in again
    // would only come back to the same refusal.
    accept = false;
    const revoked = await app.request(`${base}/api/i/main/monitors`, { headers: cookie });
    assert.equal(revoked.status, 502);
    assert.match((await json(revoked)).error, /does not accept your sign-in: token expired/);
    assert.equal(auth.store.size, 1);

    // An access token past its expiry without a refresh token ends the session.
    session.accessExpiresAt = Date.now() - 1000;
    const expired = await app.request(`${base}/api/i/main/status`, { headers: cookie });
    assert.equal(expired.status, 401);
    assert.equal((await json(expired)).login, true);
    assert.equal(auth.store.size, 0);
  } finally {
    await pw.close();
  }
});
