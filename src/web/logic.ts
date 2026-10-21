// Pure helpers of the views, without React or JSX (unit-tested in test/logic.test.ts).
import type { Event, Group, Monitor, Notification, Rollup, Status } from '../shared/pingwarden.ts';

/** One bucket of results (a rollup, or heartbeats grouped by time). */
export interface Slot {
  start: number;
  end: number;
  up: number;
  degraded: number;
  down: number;
  maintenance: number;
  /** Latency in ms; null without successful checks. */
  avg: number | null;
  min: number | null;
  max: number | null;
}

export type SlotState = 'up' | 'degraded' | 'partial' | 'down' | 'maintenance' | 'empty';

export function slotState(s: Pick<Slot, 'up' | 'degraded' | 'down' | 'maintenance'>): SlotState {
  const ok = s.up + s.degraded;
  if (ok + s.down + s.maintenance === 0) return 'empty';
  if (ok + s.down === 0) return 'maintenance';
  if (s.down === 0) return s.degraded > 0 ? 'degraded' : 'up';
  return ok === 0 ? 'down' : 'partial';
}

/** Share of up or degraded results, maintenance excluded (as Pingwarden counts uptime). */
export function slotUptime(s: Pick<Slot, 'up' | 'degraded' | 'down'>): number | null {
  const n = s.up + s.degraded + s.down;
  return n ? ((s.up + s.degraded) / n) * 100 : null;
}

const emptySlot = (start: number, end: number): Slot => ({
  start,
  end,
  up: 0,
  degraded: 0,
  down: 0,
  maintenance: 0,
  avg: null,
  min: null,
  max: null,
});

/**
 * Rollups merged into `count` slots of `slotMs` each, ending with the slot that holds `to`.
 * Buckets without rollups become empty slots, so gaps stay visible.
 */
export function slotsFromRollups(rollups: Rollup[], slotMs: number, count: number, to: number): Slot[] {
  const first = Math.floor(to / slotMs) * slotMs - (count - 1) * slotMs;
  const slots = Array.from({ length: count }, (_, i) => emptySlot(first + i * slotMs, first + (i + 1) * slotMs));
  const sums = slots.map(() => ({ us: 0, n: 0 }));
  for (const r of rollups) {
    const i = Math.floor((r.bucket - first) / slotMs);
    const s = slots[i];
    if (!s) continue;
    s.up += r.up;
    s.degraded += r.degraded;
    s.down += r.down;
    s.maintenance += r.maintenance;
    sums[i]!.us += r.latency_sum_us;
    sums[i]!.n += r.latency_count;
    if (r.latency_min_us != null) s.min = Math.min(s.min ?? Infinity, r.latency_min_us / 1000);
    if (r.latency_max_us != null) s.max = Math.max(s.max ?? -Infinity, r.latency_max_us / 1000);
  }
  slots.forEach((s, i) => (s.avg = sums[i]!.n ? sums[i]!.us / sums[i]!.n / 1000 : null));
  return slots;
}

/** Heartbeats grouped into `count` slots of `slotMs`, the last one holding `to`. */
export function slotsFromHeartbeats(
  beats: { ts: number; status: Status; latency_ms?: number | null }[],
  slotMs: number,
  count: number,
  to: number,
): Slot[] {
  const first = Math.floor(to / slotMs) * slotMs - (count - 1) * slotMs;
  const slots = Array.from({ length: count }, (_, i) => emptySlot(first + i * slotMs, first + (i + 1) * slotMs));
  const sums = slots.map(() => ({ ms: 0, n: 0 }));
  for (const b of beats) {
    const i = Math.floor((b.ts - first) / slotMs);
    const s = slots[i];
    if (!s) continue;
    if (b.status === 'up') s.up++;
    else if (b.status === 'degraded') s.degraded++;
    else if (b.status === 'down' || b.status === 'pending') s.down++;
    else if (b.status === 'maintenance') s.maintenance++;
    else continue;
    if (b.latency_ms != null && b.status !== 'down' && b.status !== 'pending') {
      sums[i]!.ms += b.latency_ms;
      sums[i]!.n++;
      s.min = Math.min(s.min ?? Infinity, b.latency_ms);
      s.max = Math.max(s.max ?? -Infinity, b.latency_ms);
    }
  }
  slots.forEach((s, i) => (s.avg = sums[i]!.n ? sums[i]!.ms / sums[i]!.n : null));
  return slots;
}

/** Days until a TLS certificate expires (cert_expiry is in seconds), or null. */
export const certDays = (m: Monitor, now = Date.now()): number | null =>
  m.cert_expiry == null ? null : Math.floor((m.cert_expiry * 1000 - now) / 86_400_000);

// --- Monitors ---

export function matches(m: Monitor, q: string): boolean {
  if (!q) return true;
  const hay = [m.id, m.name, m.target, m.description ?? '', m.type, ...m.tags].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Every group below `id`, itself included. */
export function subtree(id: string, groups: Map<string, Group>): Set<string> {
  const out = new Set<string>();
  const walk = (g: string) => {
    if (out.has(g)) return;
    out.add(g);
    for (const c of groups.get(g)?.groups ?? []) walk(c);
  };
  walk(id);
  return out;
}

export function groupPath(g: Group, groups: Map<string, Group>): string {
  const names = [g.name];
  let p = g.parent;
  for (let i = 0; p && i < 16; i++) {
    const parent = groups.get(p);
    if (!parent) break;
    names.unshift(parent.name);
    p = parent.parent;
  }
  return names.join(' › ');
}

// --- Events ---

export const RANGES = [
  { id: '24h', label: '24 h', ms: 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { id: '90d', label: '90 days', ms: 90 * 86_400_000 },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];

export const rangeOf = (v: string | undefined, fallback: RangeId): (typeof RANGES)[number] =>
  RANGES.find((r) => r.id === v) ?? RANGES.find((r) => r.id === fallback)!;

export interface Lasted {
  /** null: unknown (the monitor is no longer in this status, but the next change is not loaded). */
  ms: number | null;
  /** The monitor is still in this status. */
  ongoing: boolean;
}

/**
 * How long each status lasted: until the monitor's next event, or until now for its latest
 * event when the monitor is still in that status. Events must be newest first.
 */
export function durations(events: Event[], current: Map<string, string>, now: number): Map<number, Lasted> {
  const out = new Map<number, Lasted>();
  const next = new Map<string, number>();
  for (const e of events) {
    const later = next.get(e.monitor_id);
    if (later !== undefined) out.set(e.id, { ms: later - e.ts, ongoing: false });
    else if (current.get(e.monitor_id) === e.to) out.set(e.id, { ms: now - e.ts, ongoing: true });
    else out.set(e.id, { ms: null, ongoing: false });
    next.set(e.monitor_id, e.ts);
  }
  return out;
}

// --- Notifications ---

export interface Health {
  ok: number;
  failed: number;
  last: Notification | null;
  lastError: Notification | null;
}

export function health(rows: Notification[]): Map<string, Health> {
  const out = new Map<string, Health>();
  // Newest first: the first row seen per notifier is its latest delivery.
  for (const n of rows) {
    const h = out.get(n.notifier) ?? { ok: 0, failed: 0, last: null, lastError: null };
    if (n.success) h.ok++;
    else h.failed++;
    h.last ??= n;
    if (!n.success) h.lastError ??= n;
    out.set(n.notifier, h);
  }
  return out;
}
