// Types of the Pingwarden API (/api/v1), written from its OpenAPI spec. A copy of the spec is
// kept in test/fixtures/pingwarden-openapi.yaml; test/openapi.test.ts fails when the enums or
// required fields below drift from it. Timestamps are milliseconds since the epoch.
//
// Fields and endpoints marked "newer" came with Pingwarden's /me, stream, acknowledge, silence,
// runtime maintenance and SLO additions: the UI works without them against an older Pingwarden.

export const STATUSES = ['up', 'down', 'degraded', 'pending', 'maintenance', 'paused', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];

export const MONITOR_TYPES = ['icmp', 'tcp', 'udp', 'http', 'tls', 'dns', 'ntp', 'postgres', 'mysql', 'push'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const EVENT_KINDS = ['down', 'up', 'degraded', 'reminder', 'flapping', 'test'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const NOTIFIER_TYPES = [
  'webhook',
  'ntfy',
  'gotify',
  'matrix',
  'discord',
  'slack',
  'telegram',
  'pushover',
  'email',
] as const;
export type NotifierType = (typeof NOTIFIER_TYPES)[number];

export interface InstanceStatus {
  version: string;
  leader: boolean;
  database: 'postgres' | 'mysql';
  /** Number of monitors per status. */
  monitors: Partial<Record<Status, number>>;
}

export interface Monitor {
  id: string;
  name: string;
  description?: string | null;
  type: MonitorType;
  /** Host, URL or query, without credentials. */
  target: string;
  group?: string | null;
  /** Own and inherited tags. */
  tags: string[];
  enabled: boolean;
  interval_seconds: number;
  depends_on: string[];
  notify: string[];
  status?: Status;
  /** Since when the monitor is in `status`. */
  since?: number;
  /** Raw outcome of the last check. */
  outcome?: Status | null;
  last_check?: number | null;
  latency_ms?: number | null;
  message?: string | null;
  paused?: boolean;
  flapping?: boolean;
  /** Active maintenance window id. */
  maintenance?: string | null;
  /** Seconds (not milliseconds) since the epoch; TLS monitors. Deprecated: cert_expires_at. */
  cert_expiry?: number | null;
  consecutive_failures?: number;
  /** Newer: the certificate's expiry in milliseconds. */
  cert_expires_at?: number | null;
  /** Newer: the configured uptime target in percent. */
  slo?: number | null;
  /** Newer: the current problem was acknowledged (cleared when the monitor is up again). */
  acknowledged?: Acknowledgement | null;
  /** Newer: notifications are suppressed until then. */
  silenced_until?: number | null;
  silenced_by?: string | null;
}

export interface Acknowledgement {
  /** The caller, e.g. "oidc:alice" or "token:admin". */
  by: string;
  at: number;
  comment?: string | null;
}

export interface Heartbeat {
  ts: number;
  status: Status;
  latency_ms?: number | null;
  message?: string | null;
}

export interface HeartbeatsResponse {
  monitor: string;
  from: number;
  to: number;
  heartbeats: Heartbeat[];
}

export interface Event {
  id: number;
  monitor_id: string;
  ts: number;
  from?: Status | null;
  to: Status;
  message?: string | null;
  /** Why no notification was sent. */
  suppressed_reason?: string | null;
}

export interface EventsResponse {
  monitor?: string;
  from: number;
  to: number;
  events: Event[];
}

export const UPTIME_WINDOWS = ['24h', '7d', '30d', '365d'] as const;
export type UptimeWindowName = (typeof UPTIME_WINDOWS)[number];

export interface UptimeWindow {
  window: UptimeWindowName;
  /** Percentage of up or degraded results, maintenance excluded. */
  uptime?: number | null;
  avg_latency_ms?: number | null;
  checks: number;
  down: number;
  maintenance: number;
}

export interface UptimeResponse {
  monitor: string;
  windows: UptimeWindow[];
}

export interface Rollup {
  /** Start of the bucket. */
  bucket: number;
  up: number;
  degraded: number;
  down: number;
  maintenance: number;
  latency_sum_us: number;
  latency_count: number;
  latency_min_us?: number | null;
  latency_max_us?: number | null;
}

export interface RollupsResponse {
  monitor: string;
  /** Bucket size in seconds. */
  resolution: 3600 | 86400;
  rollups: Rollup[];
}

export interface Group {
  id: string;
  name: string;
  description?: string | null;
  parent?: string | null;
  tags: string[];
  status: Status;
  /** Direct members. */
  monitors: string[];
  /** Direct subgroups. */
  groups: string[];
}

export interface Tag {
  tag: string;
  monitors: string[];
  groups: string[];
}

export interface MaintenanceWindow {
  id: string;
  description?: string | null;
  active: boolean;
  active_until?: number | null;
  monitors: string[];
  /** Newer: "api" for windows created at runtime (they can be ended early). */
  source?: 'config' | 'api';
  /** Newer: one-off windows; null for recurring ones. */
  start?: number | null;
  end?: number | null;
  recurring?: boolean;
  created_by?: string | null;
}

/** Newer: the body of POST /maintenance. */
export interface MaintenanceRequest {
  id?: string;
  description?: string;
  monitors?: string[];
  groups?: string[];
  tags?: string[];
  all?: boolean;
  start?: number;
  end?: number;
  duration?: string;
}

export interface Notifier {
  id: string;
  type: NotifierType;
  /** null: every event. */
  events?: EventKind[] | null;
}

export interface Notification {
  id: number;
  ts: number;
  monitor_id?: string | null;
  notifier: string;
  event: EventKind;
  success: boolean;
  error?: string | null;
}

export interface NotificationsResponse {
  from: number;
  to: number;
  notifications: Notification[];
}

/** Newer: GET /me. */
export interface Principal {
  name: string;
  kind: 'oidc' | 'token' | 'anonymous';
  scope: 'read' | 'admin';
}

/** Newer: GET /rollups (every monitor at once). */
export interface BulkRollupsResponse {
  resolution: 3600 | 86400;
  from: number;
  to: number;
  monitors: Record<string, Rollup[]>;
}

/** Newer: GET /monitors/{id}/config, the effective settings without secrets. */
export interface MonitorConfig {
  monitor: string;
  settings: {
    enabled: boolean;
    interval_seconds: number;
    timeout_seconds: number;
    failure_threshold: number;
    recovery_threshold: number;
    renotify_every_seconds: number;
    notify_degraded: boolean;
    flapping?: { window_seconds: number; max_transitions: number } | null;
    degraded_latency_ms?: number | null;
    slo?: number | null;
    notify: string[];
    depends_on: string[];
    group?: string | null;
    tags: string[];
  };
  /** Type-specific settings; `type` plus whatever the check uses. */
  check: { type: MonitorType } & Record<string, unknown>;
}

/** Newer: the event names of GET /stream. */
export const STREAM_EVENTS = ['transition', 'notification', 'monitor', 'maintenance', 'reload', 'resync'] as const;
export type StreamEvent = (typeof STREAM_EVENTS)[number];

/** Ids of monitors, groups, notifiers and maintenance windows (Pingwarden's own rule). */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
