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

/** When a TLS certificate expires (ms): cert_expires_at, or the older cert_expiry in seconds. */
export const certExpiresAt = (m: Monitor): number | null =>
  m.cert_expires_at ?? (m.cert_expiry != null ? m.cert_expiry * 1000 : null);

/** Days until a TLS certificate expires, or null. */
export const certDays = (m: Monitor, now = Date.now()): number | null => {
  const at = certExpiresAt(m);
  return at === null ? null : Math.floor((at - now) / 86_400_000);
};

// --- Monitors ---

/** Pingwarden reports no status for a disabled monitor: it shows as paused. */
export const statusOf = (m: Monitor): Status => (m.enabled ? (m.status ?? 'unknown') : 'paused');

export const isProblem = (s: Status) => s === 'down' || s === 'pending' || s === 'degraded';

/** Monitors that went down since the previous list (monitors not seen before do not count). */
export function newlyDown(before: Map<string, string>, monitors: Monitor[]): Monitor[] {
  return monitors.filter((m) => statusOf(m) === 'down' && before.has(m.id) && before.get(m.id) !== 'down');
}

/** Whether notifications about the monitor are held back by a silence still running. */
export const isSilenced = (m: Monitor, now = Date.now()) => m.silenced_until != null && m.silenced_until > now;

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

// --- Reliability ---

export interface Outages {
  count: number;
  /** Down time inside the period. */
  downtimeMs: number;
  longestMs: number;
  /** Outages that ended inside the period, and their total length (for MTTR). */
  resolved: number;
  resolvedMs: number;
  ongoing: boolean;
}

/**
 * Outages per monitor in [from, to): from each change to down until the monitor's next change
 * to anything else. An outage running at `from` (its first change in the period leaves down) is
 * counted from `from`; one still running is counted until `to`. Events must be newest first.
 */
export function outages(events: Event[], from: number, to: number): Map<string, Outages> {
  const out = new Map<string, Outages>();
  const get = (id: string) => {
    let o = out.get(id);
    if (!o) out.set(id, (o = { count: 0, downtimeMs: 0, longestMs: 0, resolved: 0, resolvedMs: 0, ongoing: false }));
    return o;
  };
  const byMonitor = new Map<string, Event[]>();
  for (const e of [...events].reverse()) {
    if (e.ts < from || e.ts >= to) continue;
    byMonitor.set(e.monitor_id, [...(byMonitor.get(e.monitor_id) ?? []), e]);
  }
  for (const [id, list] of byMonitor) {
    let downSince: number | null = list[0]!.from === 'down' && list[0]!.to !== 'down' ? from : null;
    let startedBefore = downSince !== null;
    const close = (end: number, resolved: boolean) => {
      const o = get(id);
      const ms = end - downSince!;
      o.count++;
      o.downtimeMs += ms;
      o.longestMs = Math.max(o.longestMs, ms);
      if (resolved && !startedBefore) {
        o.resolved++;
        o.resolvedMs += ms;
      }
      downSince = null;
      startedBefore = false;
    };
    for (const e of list) {
      if (e.to === 'down' && downSince === null) downSince = e.ts;
      else if (e.to !== 'down' && downSince !== null) close(e.ts, true);
    }
    if (downSince !== null) {
      close(to, false);
      get(id).ongoing = true;
    }
  }
  return out;
}

export interface ReliabilityRow {
  id: string;
  name: string;
  group: string | null;
  /** Up or degraded share of the checks, maintenance excluded (percent). */
  uptime: number | null;
  checks: number;
  slo: number | null;
  /** Share of the error budget used: 1 = all of it; null without SLO or data. */
  budgetUsed: number | null;
  outages: number;
  downtimeMs: number;
  longestMs: number;
  /** Mean time to recovery, over outages that started and ended in the period. */
  mttrMs: number | null;
  /** Mean time between failures: the time up since the first data in the period, per outage. */
  mtbfMs: number | null;
  ongoing: boolean;
}

/** Share of the error budget used, for an uptime against an SLO (both in percent). */
export function budgetUsed(uptime: number | null, slo: number | null | undefined): number | null {
  if (uptime === null || slo == null || slo >= 100) return null;
  return Math.max(0, (100 - uptime) / (100 - slo));
}

export function reliability(
  monitors: Monitor[],
  rollups: Record<string, Rollup[]>,
  events: Event[],
  from: number,
  to: number,
): ReliabilityRow[] {
  const down = outages(events, from, to);
  return monitors.map((m) => {
    const rs = rollups[m.id] ?? [];
    // A monitor added during the period is measured from its first results, not from the start.
    const buckets = rs.filter((r) => r.up + r.degraded + r.down + r.maintenance > 0).map((r) => r.bucket);
    const span = to - (buckets.length ? Math.max(from, Math.min(...buckets)) : from);
    const ok = rs.reduce((n, r) => n + r.up + r.degraded, 0);
    const failed = rs.reduce((n, r) => n + r.down, 0);
    const uptime = ok + failed ? (ok / (ok + failed)) * 100 : null;
    const o = down.get(m.id);
    return {
      id: m.id,
      name: m.name,
      group: m.group ?? null,
      uptime,
      checks: ok + failed,
      slo: m.slo ?? null,
      budgetUsed: budgetUsed(uptime, m.slo),
      outages: o?.count ?? 0,
      downtimeMs: o?.downtimeMs ?? 0,
      longestMs: o?.longestMs ?? 0,
      mttrMs: o?.resolved ? o.resolvedMs / o.resolved : null,
      mtbfMs: o?.count ? (span - o.downtimeMs) / o.count : null,
      ongoing: o?.ongoing ?? false,
    };
  });
}

/** RFC 4180 CSV, with a header line. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// --- Dependencies ---

export interface DependencyLayout {
  /** Column (0: depends on nothing shown) and row of each monitor in the graph. */
  nodes: { id: string; layer: number; row: number }[];
  /** [dependency, dependent] */
  edges: [string, string][];
  layers: number;
  rows: number;
}

/**
 * Lays out the monitors that take part in a dependency: each one column to the right of its
 * deepest dependency, rows ordered by the mean row of the dependencies (fewer crossings).
 * Unknown ids and cycles are tolerated.
 */
export function layoutDependencies(monitors: Monitor[]): DependencyLayout {
  const known = new Map(monitors.map((m) => [m.id, m]));
  const edges: [string, string][] = [];
  for (const m of monitors) for (const d of m.depends_on) if (known.has(d) && d !== m.id) edges.push([d, m.id]);
  const involved = new Set(edges.flat());
  const layer = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = known.get(id)!.depends_on.filter((d) => known.has(d) && d !== id);
    const l = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0;
    seen.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const id of involved) depth(id, new Set());
  const layers = involved.size ? Math.max(...[...involved].map((id) => layer.get(id)!)) + 1 : 0;
  const row = new Map<string, number>();
  const columns: string[][] = Array.from({ length: layers }, () => []);
  for (const id of involved) columns[layer.get(id)!]!.push(id);
  const name = (id: string) => known.get(id)!.name;
  columns.forEach((col, l) => {
    const score = (id: string) => {
      if (l === 0) return 0;
      const rs = known
        .get(id)!
        .depends_on.filter((d) => row.has(d))
        .map((d) => row.get(d)!);
      return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    };
    col.sort((a, b) => score(a) - score(b) || name(a).localeCompare(name(b)));
    col.forEach((id, i) => row.set(id, i));
  });
  return {
    nodes: [...involved].map((id) => ({ id, layer: layer.get(id)!, row: row.get(id)! })),
    edges,
    layers,
    rows: Math.max(0, ...columns.map((c) => c.length)),
  };
}
