// What each status looks like, and how buckets of results are summarised. Status colours are
// reserved for status and always come with an icon and a label (never colour alone).
import type { Status } from '../shared/pingwarden.ts';
import type { IconName } from './components/icons.tsx';
import type { SlotState } from './logic.ts';

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'maintenance' | 'neutral';

export const STATUS_META: Record<Status, { label: string; tone: Tone; icon: IconName; help: string }> = {
  down: { label: 'Down', tone: 'critical', icon: 'down', help: 'Failed enough consecutive checks to count as down' },
  pending: {
    label: 'Pending',
    tone: 'serious',
    icon: 'clock',
    help: 'Failing, but not yet as often as its failure threshold',
  },
  degraded: { label: 'Degraded', tone: 'warning', icon: 'alert', help: 'Working, but slow or partly failing' },
  up: { label: 'Up', tone: 'good', icon: 'check', help: 'The last checks succeeded' },
  maintenance: {
    label: 'Maintenance',
    tone: 'maintenance',
    icon: 'wrench',
    help: 'In a maintenance window: checked, but never notified',
  },
  paused: { label: 'Paused', tone: 'neutral', icon: 'pause', help: 'Paused from the API; not checked' },
  unknown: { label: 'Unknown', tone: 'neutral', icon: 'dot', help: 'No result yet' },
};

/** Problems first: the order of the monitor list and the board. */
export const STATUS_ORDER: Status[] = ['down', 'pending', 'degraded', 'unknown', 'maintenance', 'paused', 'up'];

export const SLOT_META: Record<SlotState, { label: string; tone: Tone | 'empty' }> = {
  up: { label: 'All up', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warning' },
  partial: { label: 'Partly down', tone: 'serious' },
  down: { label: 'Down', tone: 'critical' },
  maintenance: { label: 'Maintenance', tone: 'maintenance' },
  empty: { label: 'No data', tone: 'empty' },
};

export {
  certDays,
  certExpiresAt,
  isProblem,
  isSilenced,
  statusOf,
  type Slot,
  type SlotState,
  slotsFromHeartbeats,
  slotsFromRollups,
  slotState,
  slotUptime,
} from './logic.ts';
