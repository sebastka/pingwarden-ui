import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Group, Notification } from '../src/shared/pingwarden.ts';
import {
  certDays,
  durations,
  groupPath,
  health,
  matches,
  slotsFromHeartbeats,
  slotsFromRollups,
  slotState,
  slotUptime,
  subtree,
} from '../src/web/logic.ts';
import { monitor } from './helpers.ts';

const H = 3600_000;
const rollup = (bucket: number, over: Record<string, number> = {}) => ({
  bucket,
  up: 0,
  degraded: 0,
  down: 0,
  maintenance: 0,
  latency_sum_us: 0,
  latency_count: 0,
  ...over,
});

test('slot state: down wins over up, maintenance alone is maintenance', () => {
  const s = (up: number, degraded: number, down: number, maintenance: number) =>
    slotState({ up, degraded, down, maintenance });
  assert.equal(s(0, 0, 0, 0), 'empty');
  assert.equal(s(5, 0, 0, 2), 'up');
  assert.equal(s(5, 1, 0, 0), 'degraded');
  assert.equal(s(5, 0, 1, 0), 'partial');
  assert.equal(s(0, 0, 3, 1), 'down');
  assert.equal(s(0, 0, 0, 4), 'maintenance');
  assert.equal(slotUptime({ up: 3, degraded: 1, down: 1 }), 80);
  assert.equal(slotUptime({ up: 0, degraded: 0, down: 0 }), null);
});

test('rollups fill fixed slots ending at `to`, merged and with gaps kept', () => {
  const to = 10 * H + 5; // in the 10th hour
  const slots = slotsFromRollups(
    [
      rollup(8 * H, { up: 2, latency_sum_us: 4000, latency_count: 2, latency_min_us: 1000, latency_max_us: 3000 }),
      rollup(9 * H, {
        up: 1,
        down: 1,
        latency_sum_us: 5000,
        latency_count: 1,
        latency_min_us: 5000,
        latency_max_us: 5000,
      }),
      rollup(2 * H, { up: 9 }), // before the window
    ],
    2 * H,
    2,
    to,
  );
  assert.deepEqual(
    slots.map((s) => [s.start / H, s.end / H]),
    [
      [8, 10],
      [10, 12],
    ],
  );
  assert.deepEqual(slots[0], {
    start: 8 * H,
    end: 10 * H,
    up: 3,
    degraded: 0,
    down: 1,
    maintenance: 0,
    avg: 3,
    min: 1,
    max: 5,
  });
  assert.equal(slotState(slots[1]!), 'empty');
});

test('heartbeats: pending counts as failed, latency only from successes', () => {
  const slots = slotsFromHeartbeats(
    [
      { ts: 100, status: 'up', latency_ms: 10 },
      { ts: 200, status: 'degraded', latency_ms: 30 },
      { ts: 300, status: 'pending', latency_ms: 999 },
      { ts: 400, status: 'down', latency_ms: null },
      { ts: 500, status: 'unknown' },
    ],
    1000,
    1,
    999,
  );
  assert.deepEqual(
    { ...slots[0] },
    { start: 0, end: 1000, up: 1, degraded: 1, down: 2, maintenance: 0, avg: 20, min: 10, max: 30 },
  );
});

test('certificate days use seconds since the epoch', () => {
  const now = Date.UTC(2026, 9, 21);
  assert.equal(certDays(monitor('c', { cert_expiry: now / 1000 + 10 * 86400 + 60 }) as never, now), 10);
  assert.equal(certDays(monitor('c', { cert_expiry: now / 1000 - 86400 * 2 }) as never, now), -2);
  assert.equal(certDays(monitor('c') as never, now), null);
});

test('filter words must all match id, name, target, type or tags', () => {
  const m = monitor('web-1', { name: 'Shop', tags: ['prod', 'team:web'] }) as never;
  assert.ok(matches(m, ''));
  assert.ok(matches(m, 'shop PROD'));
  assert.ok(matches(m, 'team:web http'));
  assert.ok(!matches(m, 'shop staging'));
});

test('group helpers walk the tree and survive cycles', () => {
  const g = (id: string, parent: string | null, groups: string[] = []) =>
    ({ id, name: id.toUpperCase(), parent, groups, tags: [], status: 'up', monitors: [] }) as Group;
  const groups = new Map(
    [g('infra', null, ['db']), g('db', 'infra', ['pg']), g('pg', 'db'), g('x', 'y', ['y']), g('y', 'x', ['x'])].map(
      (x) => [x.id, x],
    ),
  );
  assert.equal(groupPath(groups.get('pg')!, groups), 'INFRA › DB › PG');
  assert.deepEqual([...subtree('infra', groups)].sort(), ['db', 'infra', 'pg']);
  assert.deepEqual([...subtree('x', groups)].sort(), ['x', 'y']);
  assert.ok(groupPath(groups.get('x')!, groups).length < 200);
});

test('event durations: until the next change, or ongoing', () => {
  const e = (id: number, monitor_id: string, ts: number, to: Event['to']): Event => ({ id, monitor_id, ts, to });
  // Newest first, as Pingwarden sends them.
  const events = [e(4, 'a', 400, 'up'), e(3, 'b', 300, 'down'), e(2, 'a', 200, 'down'), e(1, 'b', 100, 'up')];
  const d = durations(
    events,
    new Map([
      ['a', 'up'],
      ['b', 'up'],
    ]),
    1000,
  );
  assert.deepEqual(d.get(4), { ms: 600, ongoing: true });
  assert.deepEqual(d.get(2), { ms: 200, ongoing: false });
  // b went down at 300 and is up again now, but its recovery is outside the loaded period.
  assert.deepEqual(d.get(3), { ms: null, ongoing: false });
  assert.deepEqual(d.get(1), { ms: 200, ongoing: false });
});

test('notifier health counts deliveries and keeps the latest result and error', () => {
  const n = (id: number, notifier: string, success: boolean, error: string | null = null): Notification => ({
    id,
    ts: id,
    notifier,
    event: 'down',
    success,
    error,
  });
  const h = health([
    n(5, 'mail', true),
    n(4, 'mail', false, 'timeout'),
    n(3, 'mail', false, 'refused'),
    n(2, 'hook', true),
  ]);
  assert.equal(h.get('mail')!.ok, 1);
  assert.equal(h.get('mail')!.failed, 2);
  assert.equal(h.get('mail')!.last!.id, 5);
  assert.equal(h.get('mail')!.lastError!.error, 'timeout');
  assert.equal(h.get('hook')!.lastError, null);
});
