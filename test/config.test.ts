import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/server/config.ts';

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  return [];
};

const OIDC = {
  AUTH_MODE: 'oidc',
  PINGWARDEN_URL: 'http://pingwarden:8080',
  PUBLIC_URL: 'https://status.example.com/',
  OIDC_ISSUER: 'https://auth.example.com/realms/home',
  OIDC_CLIENT_ID: 'pingwarden-ui',
  OIDC_CLIENT_SECRET: 's3cret',
};

test('AUTH_MODE and PINGWARDEN_URL are required', () => {
  const p = problems({});
  assert.ok(p.some((x) => x.startsWith('AUTH_MODE must be')));
  assert.ok(p.includes('PINGWARDEN_URL is required'));
});

test('token mode: read-only by default, token optional, /api/v1 suffix tolerated', () => {
  const c = loadConfig({ AUTH_MODE: 'token', PINGWARDEN_URL: 'http://pw:8080/api/v1/' });
  assert.deepEqual(c.instances, [{ id: 'main', name: 'pw:8080', url: 'http://pw:8080', token: null }]);
  assert.equal(c.readOnly, true);
  assert.equal(c.auth.oidc, null);
  assert.equal(c.http.host, '127.0.0.1');
  assert.equal(c.refreshSeconds, 15);
  const rw = loadConfig({ AUTH_MODE: 'token', PINGWARDEN_URL: 'http://pw', PINGWARDEN_TOKEN: 't', READ_ONLY: 'false' });
  assert.equal(rw.readOnly, false);
  assert.equal(rw.instances[0]!.token, 't');
});

test('several instances as numbered blocks', () => {
  const c = loadConfig({
    AUTH_MODE: 'token',
    PINGWARDEN_2_URL: 'https://pw.office.example',
    PINGWARDEN_2_ID: 'Office',
    PINGWARDEN_1_URL: 'http://pw.home:8080',
    PINGWARDEN_1_NAME: 'Home',
    PINGWARDEN_1_TOKEN: 'a',
    PINGWARDEN_TIMEOUT_SECONDS: '5',
  });
  assert.deepEqual(c.instances, [
    { id: '1', name: 'Home', url: 'http://pw.home:8080', token: 'a' },
    { id: 'office', name: 'pw.office.example', url: 'https://pw.office.example', token: null },
  ]);
  assert.equal(c.pingwardenTimeoutMs, 5000);
  const p = problems({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: 'http://a',
    PINGWARDEN_1_URL: 'http://b',
    PINGWARDEN_1_ID: 'x y',
    PINGWARDEN_3_URL: 'http://c',
    PINGWARDEN_3_ID: 'x y',
  });
  assert.ok(p.some((x) => /either PINGWARDEN_URL or numbered/.test(x)));
  assert.ok(p.some((x) => /PINGWARDEN_1_ID must be lowercase/.test(x)));
  assert.ok(p.some((x) => /PINGWARDEN_3_ID "x y" is used by two instances/.test(x)));
});

test('FRAME_ANCESTORS takes origins only', () => {
  const ok = loadConfig({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: 'http://pw',
    FRAME_ANCESTORS: 'https://ha.example http://x:8123/',
  });
  assert.deepEqual(ok.http.frameAncestors, ['https://ha.example', 'http://x:8123']);
  const p = problems({ AUTH_MODE: 'token', PINGWARDEN_URL: 'http://pw', FRAME_ANCESTORS: 'https://ha.example/path *' });
  assert.equal(p.length, 2);
});

test('OIDC mode: defaults and normalisation', () => {
  const c = loadConfig(OIDC);
  assert.equal(c.readOnly, false);
  assert.equal(c.http.publicUrl, 'https://status.example.com');
  const o = c.auth.oidc!;
  assert.equal(o.tokenAuthMethod, 'client_secret_basic');
  assert.equal(o.scopes, 'openid profile email');
  assert.deepEqual(o.authParams, {});
  assert.equal(o.sessionTtlHours, 12);
  const pub = loadConfig({ ...OIDC, OIDC_CLIENT_SECRET: '', OIDC_AUTH_PARAMS: 'audience=pingwarden&prompt=login' });
  assert.equal(pub.auth.oidc!.tokenAuthMethod, 'none');
  assert.deepEqual(pub.auth.oidc!.authParams, { audience: 'pingwarden', prompt: 'login' });
});

test('OIDC mode: every problem is reported at once', () => {
  const p = problems({
    AUTH_MODE: 'oidc',
    PINGWARDEN_URL: 'ftp://x',
    PINGWARDEN_TOKEN: 'static',
    OIDC_ISSUER: 'http://idp.local',
    OIDC_TOKEN_AUTH_METHOD: 'client_secret_post',
    OIDC_AUTH_PARAMS: 'redirect_uri=https://evil.example',
    OIDC_ROLES_CLAIM: 'roles',
    SESSION_TTL_HOURS: '0',
  });
  for (const expected of [
    /PINGWARDEN_URL must be an http\(s\) URL/,
    /PINGWARDEN_TOKEN is only used with AUTH_MODE=token/,
    /PUBLIC_URL is required/,
    /OIDC_ISSUER must use https/,
    /OIDC_CLIENT_ID is required/,
    /client_secret_post needs OIDC_CLIENT_SECRET/,
    /OIDC_AUTH_PARAMS may not set redirect_uri/,
    /OIDC_ROLES_CLAIM is no longer used/,
    /SESSION_TTL_HOURS must be an integer ≥ 1/,
  ]) {
    assert.ok(
      p.some((x) => expected.test(x)),
      `${expected} not in:\n${p.join('\n')}`,
    );
  }
  assert.equal(
    problems({ ...OIDC, OIDC_ISSUER: 'http://localhost:8090/default', OIDC_ALLOW_INSECURE_ISSUER: 'true' }).length,
    0,
  );
});

test('invalid numbers and booleans are refused', () => {
  const p = problems({
    AUTH_MODE: 'token',
    PINGWARDEN_URL: 'http://pw',
    PORT: 'x',
    READ_ONLY: 'maybe',
    REFRESH_SECONDS: '1',
  });
  assert.equal(p.length, 3);
});
