import { createContext, useContext } from 'react';
import type { Monitor } from '../shared/pingwarden.ts';
import type { Me } from '../shared/types.ts';

export interface Live {
  me: Me;
  /** Every monitor with its live state, refreshed every me.refreshSeconds. */
  monitors: Monitor[];
  byId: Map<string, Monitor>;
  /** Reloads the live data now (after an action). */
  refresh: () => void;
  /** Opens a monitor's details. */
  openMonitor: (id: string) => void;
  /** Opens the monitor list with these filters. */
  showMonitors: (filters: Record<string, string>) => void;
}

export const LiveContext = createContext<Live | null>(null);

export const useLive = () => useContext(LiveContext)!;
