// The UI's own API (/api), besides the Pingwarden endpoints it relays unchanged.
import type { Rollup } from './pingwarden.ts';

export type AuthMode = 'oidc' | 'token';

export interface InstanceInfo {
  /** Used in /api/i/{id}/… and in the UI's URLs. */
  id: string;
  name: string;
  /**
   * Whether runtime actions are offered: false when the UI is read-only or Pingwarden gives
   * read access only, null when unknown (an older Pingwarden; shown, Pingwarden decides).
   */
  canAct: boolean | null;
  /** Why actions are not offered, when canAct is false. */
  actionsReason: string | null;
}

export interface Me {
  mode: AuthMode;
  /** The signed-in user; null with AUTH_MODE=token. */
  user: { name: string; sub: string } | null;
  /** At least one; the first is the default. */
  instances: InstanceInfo[];
  /** How often the UI refreshes live data (without a live stream). */
  refreshSeconds: number;
}

/** Hourly rollups of every monitor, for the history bars of the monitor list. */
export interface HistoryResponse {
  from: number;
  to: number;
  resolution: 3600;
  monitors: Record<string, Rollup[]>;
  /** Monitors whose rollups could not be read. */
  failed: string[];
}
