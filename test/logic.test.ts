import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Group, Notification } from '../src/shared/pingwarden.ts';
import {
  budgetUsed,
  certDays,
  certExpiresAt,
  durations,
  layoutDependencies,
  newlyDown,
  outages,
  reliability,
  toCsv,
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
  // The newer field, in milliseconds, wins.
  const both = monitor('c', { cert_expiry: 1, cert_expires_at: now + 3 * 86400_000 }) as never;
  assert.equal(certExpiresAt(both), now + 3 * 86400_000);
  assert.equal(certDays(both, now), 3);
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

const ev = (id: number, monitor_id: string, ts: number, from: Event['from'], to: Event['to']): Event => ({
  id,
  monitor_id,
  ts,
  from,
  to,
});

test('outages: clipped to the period, ongoing until its end, MTTR only from whole outages', () => {
  const from = 1000;
  const to = 2000;
  // Newest first, as Pingwarden sends them.
  const events = [
    ev(6, 'b', 1900, 'up', 'down'), // still down at `to`
    ev(5, 'a', 1700, 'down', 'up'),
    ev(4, 'a', 1500, 'pending', 'down'),
    ev(3, 'a', 1400, 'up', 'pending'),
    ev(2, 'c', 1200, 'down', 'up'), // down since before `from`
    ev(1, 'a', 500, 'up', 'down'), // before the period
  ];
  const o = outages(events, from, to);
  assert.deepEqual(o.get('a'), {
    count: 1,
    downtimeMs: 200,
    longestMs: 200,
    resolved: 1,
    resolvedMs: 200,
    ongoing: false,
  });
  assert.deepEqual(o.get('b'), {
    count: 1,
    downtimeMs: 100,
    longestMs: 100,
    resolved: 0,
    resolvedMs: 0,
    ongoing: true,
  });
  assert.deepEqual(o.get('c'), {
    count: 1,
    downtimeMs: 200,
    longestMs: 200,
    resolved: 0,
    resolvedMs: 0,
    ongoing: false,
  });
});

test('reliability rows: uptime from rollups, error budget against the SLO, MTTR and MTBF', () => {
  const rows = reliability(
    [monitor('a', { slo: 99 }), monitor('b')] as never,
    { a: [rollup(0, { up: 98, down: 1, degraded: 1 })] },
    [ev(2, 'a', 3000, 'down', 'up'), ev(1, 'a', 1000, 'up', 'down')],
    0,
    10_000,
  );
  const a = rows.find((r) => r.id === 'a')!;
  assert.equal(a.uptime, 99);
  assert.equal(a.checks, 100);
  assert.ok(Math.abs(a.budgetUsed! - 1) < 1e-9);
  assert.equal(a.outages, 1);
  assert.equal(a.downtimeMs, 2000);
  assert.equal(a.mttrMs, 2000);
  assert.equal(a.mtbfMs, 8000);
  const b = rows.find((r) => r.id === 'b')!;
  assert.equal(b.uptime, null);
  // Results only from 6000 on: MTBF over the 4000 ms observed, not the whole period.
  const young = reliability(
    [monitor('y')] as never,
    { y: [rollup(6000, { up: 9, down: 1 })] },
    [ev(2, 'y', 8000, 'down', 'up'), ev(1, 'y', 7000, 'up', 'down')],
    0,
    10_000,
  )[0]!;
  assert.equal(young.mtbfMs, 3000);
  assert.equal(b.budgetUsed, null);
  assert.equal(b.mttrMs, null);
  assert.ok(Math.abs(budgetUsed(99.95, 99.9)! - 0.5) < 1e-9);
  assert.equal(budgetUsed(100, 99.9), 0);
  assert.equal(budgetUsed(98, null), null);
});

test('CSV quotes what needs quoting', () => {
  assert.equal(
    toCsv(
      ['a', 'b'],
      [
        ['x,y', 'say "hi"'],
        [1, null],
      ],
    ),
    'a,b\r\n"x,y","say ""hi"""\r\n1,\r\n',
  );
});

test('dependency layout: dependencies to the left, unknown ids and cycles tolerated', () => {
  const m = (id: string, depends_on: string[] = []) => monitor(id, { depends_on }) as never;
  const l = layoutDependencies([
    m('router'),
    m('db', ['router']),
    m('web', ['db', 'router', 'ghost']),
    m('alone'),
    m('x', ['y']),
    m('y', ['x']),
  ]);
  const at = (id: string) => l.nodes.find((n) => n.id === id);
  assert.equal(at('router')!.layer, 0);
  assert.equal(at('db')!.layer, 1);
  assert.equal(at('web')!.layer, 2);
  assert.equal(at('alone'), undefined);
  assert.ok(at('x') && at('y'));
  assert.ok(l.layers >= 3);
  assert.deepEqual(
    l.edges.filter(([, b]) => b === 'web'),
    [
      ['db', 'web'],
      ['router', 'web'],
    ],
  );
});

test('alerts fire for monitors that went down, not for new or still-down ones', () => {
  const before = new Map([
    ['a', 'up'],
    ['b', 'down'],
    ['c', 'pending'],
  ]);
  const now = [
    monitor('a', { status: 'down' }),
    monitor('b', { status: 'down' }),
    monitor('c', { status: 'down' }),
    monitor('new', { status: 'down' }),
  ] as never[];
  assert.deepEqual(
    newlyDown(before, now).map((m: { id: string }) => m.id),
    ['a', 'c'],
  );
});
