import type {
  EventsResponse,
  Group,
  HeartbeatsResponse,
  InstanceStatus,
  MaintenanceWindow,
  Monitor,
  Notifier,
  NotificationsResponse,
  RollupsResponse,
  Tag,
  UptimeResponse,
} from '../shared/pingwarden.ts';
import type { HistoryResponse, Me } from '../shared/types.ts';

/** An API error with its HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let signingIn = false;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'The dashboard server cannot be reached.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const b = body as { error?: string; login?: boolean } | null;
    // The session ended: sign in again, then come back here.
    if (res.status === 401 && b?.login && !signingIn) {
      signingIn = true;
      location.assign(`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
    }
    throw new ApiError(res.status, b?.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

/** Every state-changing request carries X-Pingwarden-UI (the server's CSRF guard). */
const post = <T>(path: string) => request<T>(path, { method: 'POST', headers: { 'x-pingwarden-ui': '1' } });

export function query(f: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export interface Range {
  from?: number;
  to?: number;
  limit?: number;
}

export const api = {
  me: () => request<Me>('/api/me'),
  status: () => request<InstanceStatus>('/api/status'),
  monitors: () => request<Monitor[]>('/api/monitors'),
  monitor: (id: string) => request<Monitor>(`/api/monitors/${enc(id)}`),
  heartbeats: (id: string, r: Range = {}) =>
    request<HeartbeatsResponse>(`/api/monitors/${enc(id)}/heartbeats${query({ ...r })}`),
  monitorEvents: (id: string, r: Range = {}) =>
    request<EventsResponse>(`/api/monitors/${enc(id)}/events${query({ ...r })}`),
  uptime: (id: string) => request<UptimeResponse>(`/api/monitors/${enc(id)}/uptime`),
  rollups: (id: string, resolution: 'hour' | 'day', r: Range = {}) =>
    request<RollupsResponse>(`/api/monitors/${enc(id)}/rollups${query({ resolution, from: r.from, to: r.to })}`),
  history: (hours = 24) => request<HistoryResponse>(`/api/history${query({ hours })}`),
  groups: () => request<Group[]>('/api/groups'),
  tags: () => request<Tag[]>('/api/tags'),
  maintenance: () => request<MaintenanceWindow[]>('/api/maintenance'),
  events: (r: Range = {}) => request<EventsResponse>(`/api/events${query({ ...r })}`),
  notifiers: () => request<Notifier[]>('/api/notifiers'),
  notifications: (r: Range = {}) => request<NotificationsResponse>(`/api/notifications${query({ ...r })}`),

  check: (id: string) => post<{ ok: boolean }>(`/api/monitors/${enc(id)}/check`),
  pause: (id: string) => post<{ ok: boolean }>(`/api/monitors/${enc(id)}/pause`),
  resume: (id: string) => post<{ ok: boolean }>(`/api/monitors/${enc(id)}/resume`),
  testNotifier: (id: string) => post<{ ok: boolean }>(`/api/notifiers/${enc(id)}/test`),
  reload: () => post<{ ok: boolean }>('/api/reload'),
};
