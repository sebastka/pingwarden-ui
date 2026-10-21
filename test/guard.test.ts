import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { allowedHosts, hostGuard, hostName, sameOriginGuard } from '../src/server/guard.ts';

const http = (over: Partial<{ host: string; publicUrl: string | null; allowedHosts: string[] }> = {}) => ({
  host: '0.0.0.0',
  port: 3000,
  publicUrl: null,
  allowedHosts: [],
  ...over,
});

test('hostName strips the port and keeps IPv6 brackets', () => {
  assert.equal(hostName('Example.COM:3000'), 'example.com');
  assert.equal(hostName('[::1]:3000'), '[::1]');
  assert.equal(hostName('localhost'), 'localhost');
});

test('allowed hosts: loopback, PUBLIC_URL, ALLOWED_HOSTS, the listen address; * disables the guard', () => {
  const hosts = allowedHosts(
    http({ host: '10.0.0.5', publicUrl: 'https://status.example.com', allowedHosts: ['wall'] }),
  );
  assert.deepEqual([...hosts!].sort(), ['10.0.0.5', '127.0.0.1', '[::1]', 'localhost', 'status.example.com', 'wall']);
  assert.equal(allowedHosts(http({ allowedHosts: ['*'] })), null);
});

function app(cfg = http()) {
  const a = new Hono();
  a.use('*', hostGuard(cfg));
  a.use('*', sameOriginGuard());
  a.get('/api/health', (c) => c.text('ok'));
  a.get('/api/x', (c) => c.text('read'));
  a.post('/api/x', (c) => c.text('written'));
  a.post('/auth/logout', (c) => c.text('bye'));
  return a;
}

test('host guard refuses rebinding names, except for the health check', async () => {
  const a = app();
  assert.equal((await a.request('http://localhost:3000/api/x')).status, 200);
  assert.equal((await a.request('http://evil.example/api/x')).status, 403);
  assert.equal((await a.request('http://10.1.2.3:3000/api/health')).status, 200);
});

test('writes need same-origin and the custom header; logout only same-origin', async () => {
  const a = app();
  const post = (headers: Record<string, string>, path = '/api/x') =>
    a.request(`http://localhost:3000${path}`, { method: 'POST', headers });
  assert.equal((await post({})).status, 403, 'no header');
  assert.equal((await post({ 'x-pingwarden-ui': '1' })).status, 200);
  assert.equal((await post({ 'x-pingwarden-ui': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'x-pingwarden-ui': '1', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'x-pingwarden-ui': '1', origin: 'http://localhost:3000' })).status, 200);
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' }, '/auth/logout')).status, 200);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' }, '/auth/logout')).status, 403);
});
