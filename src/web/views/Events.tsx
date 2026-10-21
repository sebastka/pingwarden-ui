import { useMemo } from 'react';
import { type Event, STATUSES } from '../../shared/pingwarden.ts';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorBanner, MonitorLink, Segmented, Spinner, StatusBadge } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { dateTime, duration, plural } from '../format.ts';
import { useNow, usePoll } from '../hooks.ts';
import type { Params } from '../route.ts';
import { durations, type Lasted, rangeOf, RANGES } from '../logic.ts';
import { STATUS_META, statusOf } from '../status.ts';

/** Events are capped by Pingwarden's `limit`; a full page means older ones were left out. */
const LIMIT = 10_000;

export function EventsView({ params, update }: { params: Params; update: (p: Params, replace?: boolean) => void }) {
  const { byId, me, api, changes, streaming } = useLive();
  const now = useNow(30);
  const range = rangeOf(params.range, '7d');
  const events = usePoll(
    () => {
      const to = Date.now();
      return api.events({ from: to - range.ms, to, limit: LIMIT });
    },
    [range.id, changes],
    streaming ? null : me.refreshSeconds * 2,
  );
  const q = (params.q ?? '').toLowerCase();
  const to = params.to ?? '';
  const onlySuppressed = params.suppressed === '1';

  const all = useMemo(() => events.data?.events ?? [], [events.data]);
  const current = useMemo(() => new Map([...byId].map(([id, m]) => [id, statusOf(m) as string])), [byId]);
  const lasted = useMemo(() => durations(all, current, now), [all, current, now]);
  const shown = all.filter(
    (e) =>
      (!q ||
        e.monitor_id.toLowerCase().includes(q) ||
        (byId.get(e.monitor_id)?.name ?? '').toLowerCase().includes(q)) &&
      (!to || e.to === to) &&
      (!onlySuppressed || e.suppressed_reason),
  );

  const outages = all.filter((e) => e.to === 'down');
  const downtime = outages.reduce((s, e) => s + (lasted.get(e.id)?.ms ?? 0), 0);
  const affected = new Set(outages.map((e) => e.monitor_id)).size;
  const ongoing = outages.filter((e) => lasted.get(e.id)?.ongoing).length;

  return (
    <>
      <div className="page-head">
        <h1>Events</h1>
        <Segmented
          label="Period"
          value={range.id}
          onChange={(v) => update({ range: v === '7d' ? '' : v })}
          options={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        />
      </div>
      <div className="kpis kpis-4">
        <div className="card stat">
          <div className="label">Status changes</div>
          <div className="value">{all.length}</div>
        </div>
        <div className="card stat">
          <div className="label">Outages</div>
          <div className="value">{outages.length}</div>
          <div className="foot">{ongoing ? `${ongoing} ongoing` : 'none ongoing'}</div>
        </div>
        <div className="card stat">
          <div className="label">Downtime</div>
          <div className="value">{outages.length ? duration(downtime) : '0'}</div>
          <div className="foot">summed over all monitors</div>
        </div>
        <div className="card stat">
          <div className="label">Monitors with outages</div>
          <div className="value">{affected}</div>
        </div>
      </div>
      <div className="toolbar">
        <label className="toolbar-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Filter by monitor"
            value={params.q ?? ''}
            onChange={(e) => update({ q: e.target.value }, true)}
            aria-label="Filter by monitor"
          />
        </label>
        <div className="toolbar-filters">
          <select value={to} onChange={(e) => update({ to: e.target.value })} aria-label="New status">
            <option value="">Any new status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                to {STATUS_META[s].label.toLowerCase()}
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={onlySuppressed}
              onChange={(e) => update({ suppressed: e.target.checked ? '1' : '' })}
            />
            Not notified only
          </label>
        </div>
      </div>
      {events.error && <ErrorBanner>{events.error.message}</ErrorBanner>}
      {all.length >= LIMIT && (
        <ErrorBanner>Only the latest {plural(LIMIT, 'event')} are shown; choose a shorter period.</ErrorBanner>
      )}
      {!events.data && !events.error ? (
        <Spinner />
      ) : shown.length ? (
        <div className={events.loading ? 'dim' : undefined}>
          <EventTable events={shown} durationsById={lasted} />
        </div>
      ) : (
        events.data && <Empty>No status change in this period{q || to || onlySuppressed ? ' matches' : ''}.</Empty>
      )}
    </>
  );
}

export function EventTable({
  events,
  showMonitor = true,
  durationsById,
}: {
  events: Event[];
  showMonitor?: boolean;
  durationsById?: Map<number, Lasted>;
}) {
  const { byId } = useLive();
  const now = useNow(30);
  const current = new Map([...byId].map(([id, m]) => [id, statusOf(m) as string]));
  const lasted = durationsById ?? durations(events, current, now);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            {showMonitor && <th>Monitor</th>}
            <th>Change</th>
            <th>Lasted</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const d = lasted.get(e.id);
            return (
              <tr key={e.id}>
                <td className="nowrap">{dateTime(e.ts)}</td>
                {showMonitor && (
                  <td>
                    <MonitorLink id={e.monitor_id} />
                  </td>
                )}
                <td className="nowrap">
                  {e.from ? <StatusBadge status={e.from} small /> : <span className="muted small">new</span>}
                  <Icon name="chevronRight" size={12} className="muted inline-icon" />
                  <StatusBadge status={e.to} small />
                </td>
                <td className="nowrap small">
                  {d?.ms == null ? '–' : duration(d.ms)}
                  {d?.ongoing && <span className="muted"> (ongoing)</span>}
                </td>
                <td className="small wrap">
                  {e.message}
                  {e.suppressed_reason && (
                    <div className="muted">
                      <Icon name="bell" size={12} className="inline-icon" /> Not notified: {e.suppressed_reason}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
