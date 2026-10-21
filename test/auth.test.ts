import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActHint, jwtClaims, readRoles, safeReturnTo } from '../src/server/auth.ts';
import { type Session, SessionStore } from '../src/server/sessions.ts';

const jwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('safeReturnTo only accepts local paths', () => {
  assert.equal(safeReturnTo('/?view=events&range=30d'), '/?view=events&range=30d');
  for (const bad of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/auth/login']) {
    assert.equal(safeReturnTo(bad), '/');
  }
});

test('roles are read the way Pingwarden reads its claim', () => {
  assert.deepEqual(readRoles({ scope: 'openid pingwarden:admin' }, 'scope'), ['openid', 'pingwarden:admin']);
  assert.deepEqual(readRoles({ realm_access: { roles: ['a', 'b'] } }, 'realm_access.roles'), ['a', 'b']);
  assert.deepEqual(
    readRoles({ resource_access: { pingwarden: { roles: ['admin'] } } }, 'resource_access.pingwarden.roles'),
    ['admin'],
  );
  assert.deepEqual(readRoles({ 'https://example.com/roles': ['x'] }, 'https://example.com/roles'), ['x']);
  assert.deepEqual(readRoles({ groups: [1, 'ok', null] }, 'groups'), ['ok']);
  assert.deepEqual(readRoles({}, 'realm_access.roles'), []);
  assert.deepEqual(readRoles({ roles: { admin: true } }, 'roles'), []);
});

test('the admin hint needs a configured claim and a JWT', () => {
  const cfg = { rolesClaim: 'roles', adminRoles: ['pingwarden-admin'] };
  assert.equal(canActHint(jwt({ roles: ['pingwarden-admin'] }), cfg), true);
  assert.equal(canActHint(jwt({ roles: ['pingwarden-read'] }), cfg), false);
  assert.equal(canActHint(jwt({}), cfg), false);
  assert.equal(canActHint('opaque-token', cfg), null);
  assert.equal(canActHint(jwt({ roles: ['pingwarden-admin'] }), { rolesClaim: null, adminRoles: [] }), null);
  assert.equal(jwtClaims('a.!!!.c'), null);
});

const session = (over: Partial<Session> = {}): Session => ({
  sub: 'u1',
  name: 'alice',
  accessToken: 'at',
  accessExpiresAt: null,
  refreshToken: null,
  idToken: null,
  expiresAt: Date.now() + 3600_000,
  canAct: null,
  ...over,
});

test('sessions: stored by hash, expire, and can be dropped by object', () => {
  let now = 1_000_000;
  const store = new SessionStore(() => now);
  const s = session({ expiresAt: now + 1000 });
  const token = store.create(s);
  assert.equal(store.get(token), s);
  assert.equal(store.get('forged'), null);
  assert.equal(store.get(undefined), null);
  now += 1000;
  assert.equal(store.get(token), null, 'expired');
  assert.equal(store.size, 0);

  const t2 = store.create(session({ expiresAt: now + 5000 }));
  const s2 = store.get(t2)!;
  store.drop(s2);
  assert.equal(store.get(t2), null);
  const t3 = store.create(session({ expiresAt: now + 5000 }));
  assert.ok(store.delete(t3));
  assert.equal(store.get(t3), null);
});

test('pending logins are single-use and expire after 10 minutes', () => {
  let now = 0;
  const store = new SessionStore(() => now);
  store.startLogin('state-1', { codeVerifier: 'v', nonce: 'n', returnTo: '/' });
  assert.equal(store.takeLogin('state-1')?.codeVerifier, 'v');
  assert.equal(store.takeLogin('state-1'), null);
  store.startLogin('state-2', { codeVerifier: 'v', nonce: 'n', returnTo: '/' });
  now += 10 * 60_000;
  assert.equal(store.takeLogin('state-2'), null);
});
