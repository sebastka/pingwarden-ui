// The UI's Pingwarden types (src/shared/pingwarden.ts) are written by hand; this compares them
// with the spec they were written from. Refresh test/fixtures/pingwarden-openapi.yaml from
// Pingwarden's docs/openapi.yaml when the API changes, then fix what fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { EVENT_KINDS, MONITOR_TYPES, NOTIFIER_TYPES, STATUSES, UPTIME_WINDOWS } from '../src/shared/pingwarden.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec: any = parse(readFileSync(new URL('./fixtures/pingwarden-openapi.yaml', import.meta.url), 'utf8'));
const schemas = spec.components.schemas;
const sorted = (xs: readonly string[]) => [...xs].sort();

test('enums match the spec', () => {
  assert.deepEqual(sorted(STATUSES), sorted(schemas.Status.enum));
  assert.deepEqual(sorted(MONITOR_TYPES), sorted(schemas.MonitorType.enum));
  assert.deepEqual(sorted(EVENT_KINDS), sorted(schemas.EventKind.enum));
  assert.deepEqual(sorted(UPTIME_WINDOWS), sorted(schemas.UptimeWindow.properties.window.enum));
  const notifier = spec.paths['/api/v1/notifiers'].get.responses['200'].content['application/json'].schema.items;
  assert.deepEqual(sorted(NOTIFIER_TYPES), sorted(notifier.properties.type.enum));
});

test('every endpoint the UI relays exists in the spec', () => {
  const app = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  // relay(c, `/monitors/${id(c)}/events${forwardQuery(…)}`) → /api/v1/monitors/{}/events
  const relayed = [...app.matchAll(/(?:relay|action)\(\s*c,\s*[`']([^`']+)/g)].map((m) =>
    m[1]!.replace(/\$\{forwardQuery.*$/, '').replaceAll('${id(c)}', '{}'),
  );
  assert.ok(relayed.length >= 18, `found only ${relayed.length} relayed paths`);
  const paths = Object.keys(spec.paths).map((p) => p.replace(/\{[^}]+\}/g, '{}'));
  for (const r of relayed) assert.ok(paths.includes(`/api/v1${r}`), `/api/v1${r} is not in the spec`);
});

test('fields the UI relies on are still there', () => {
  const props = (name: string) => Object.keys(schemas[name].properties);
  for (const f of ['id', 'name', 'type', 'target', 'group', 'tags', 'enabled', 'interval_seconds', 'depends_on']) {
    assert.ok(props('Monitor').includes(f), `Monitor.${f}`);
  }
  for (const f of ['notify', 'status', 'since', 'last_check', 'latency_ms', 'message', 'paused', 'flapping']) {
    assert.ok(props('Monitor').includes(f), `Monitor.${f}`);
  }
  for (const f of ['maintenance', 'cert_expiry', 'consecutive_failures', 'outcome']) {
    assert.ok(props('Monitor').includes(f), `Monitor.${f}`);
  }
  for (const f of ['bucket', 'up', 'degraded', 'down', 'maintenance', 'latency_sum_us', 'latency_count']) {
    assert.ok(props('Rollup').includes(f), `Rollup.${f}`);
  }
  for (const f of ['id', 'monitor_id', 'ts', 'from', 'to', 'message', 'suppressed_reason']) {
    assert.ok(props('Event').includes(f), `Event.${f}`);
  }
  assert.match(schemas.Monitor.properties.cert_expiry.description, /Seconds/);
});
