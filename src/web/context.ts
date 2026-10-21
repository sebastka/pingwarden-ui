import { createContext, useContext } from 'react';
import type { Monitor } from '../shared/pingwarden.ts';
import type { InstanceInfo, Me } from '../shared/types.ts';
import type { Api } from './api.ts';

export interface Live {
  me: Me;
  /** The Pingwarden instance shown. */
  instance: InstanceInfo;
  api: Api;
  /** Every monitor with its live state. */
  monitors: Monitor[];
  byId: Map<string, Monitor>;
  /** Whether Pingwarden's live stream is connected (otherwise the UI polls). */
  streaming: boolean;
  /** Bumped on every relevant stream event, for views that show more than the monitor list. */
  changes: number;
  /** Reloads the live data now (after an action). */
  refresh: () => void;
  /** Opens a monitor's details. */
  openMonitor: (id: string) => void;
  /** Opens the monitor list with these filters. */
  showMonitors: (filters: Record<string, string>) => void;
}

export const LiveContext = createContext<Live | null>(null);

export const useLive = () => useContext(LiveContext)!;
