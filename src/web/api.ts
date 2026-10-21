import type {
  BulkRollupsResponse,
  EventsResponse,
  Group,
  HeartbeatsResponse,
  InstanceStatus,
  MaintenanceRequest,
  MaintenanceWindow,
  Monitor,
  MonitorConfig,
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

/** The endpoint does not exist on this Pingwarden (an older version). */
export const unsupported = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

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
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'x-pingwarden-ui': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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

export const me = () => request<Me>('/api/me');

/** The API of one Pingwarden instance. */
export function instanceApi(inst: string) {
  const base = `/api/i/${enc(inst)}`;
  return {
    instance: inst,
    /** URL of the live event stream (EventSource). */
    streamUrl: `${base}/stream`,
    status: () => request<InstanceStatus>(`${base}/status`),
    monitors: () => request<Monitor[]>(`${base}/monitors`),
    monitor: (id: string) => request<Monitor>(`${base}/monitors/${enc(id)}`),
    monitorConfig: (id: string) => request<MonitorConfig>(`${base}/monitors/${enc(id)}/config`),
    heartbeats: (id: string, r: Range = {}) =>
      request<HeartbeatsResponse>(`${base}/monitors/${enc(id)}/heartbeats${query({ ...r })}`),
    monitorEvents: (id: string, r: Range = {}) =>
      request<EventsResponse>(`${base}/monitors/${enc(id)}/events${query({ ...r })}`),
    uptime: (id: string) => request<UptimeResponse>(`${base}/monitors/${enc(id)}/uptime`),
    rollups: (id: string, resolution: 'hour' | 'day', r: Range = {}) =>
      request<RollupsResponse>(`${base}/monitors/${enc(id)}/rollups${query({ resolution, from: r.from, to: r.to })}`),
    bulkRollups: (resolution: 'hour' | 'day', r: Range = {}) =>
      request<BulkRollupsResponse>(`${base}/rollups${query({ resolution, from: r.from, to: r.to })}`),
    history: (hours = 24) => request<HistoryResponse>(`${base}/history${query({ hours })}`),
    groups: () => request<Group[]>(`${base}/groups`),
    tags: () => request<Tag[]>(`${base}/tags`),
    maintenance: () => request<MaintenanceWindow[]>(`${base}/maintenance`),
    events: (r: Range = {}) => request<EventsResponse>(`${base}/events${query({ ...r })}`),
    notifiers: () => request<Notifier[]>(`${base}/notifiers`),
    notifications: (r: Range & { monitor?: string } = {}) =>
      request<NotificationsResponse>(`${base}/notifications${query({ ...r })}`),

    check: (id: string) => post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/check`),
    pause: (id: string) => post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/pause`),
    resume: (id: string) => post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/resume`),
    ack: (id: string, comment?: string) =>
      post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/ack`, comment ? { comment } : {}),
    unack: (id: string) => post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/unack`),
    silence: (id: string, duration: string) =>
      post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/silence`, { duration }),
    unsilence: (id: string) => post<{ ok: boolean }>(`${base}/monitors/${enc(id)}/unsilence`),
    startMaintenance: (req: MaintenanceRequest) => post<MaintenanceWindow>(`${base}/maintenance`, req),
    endMaintenance: (id: string) => post<{ ok: boolean }>(`${base}/maintenance/${enc(id)}/end`),
    testNotifier: (id: string) => post<{ ok: boolean }>(`${base}/notifiers/${enc(id)}/test`),
    reload: () => post<{ ok: boolean }>(`${base}/reload`),
  };
}

export type Api = ReturnType<typeof instanceApi>;
