import { useMemo, useState } from 'react';
import type { MaintenanceRequest, MaintenanceWindow } from '../../shared/pingwarden.ts';
import { unsupported } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import {
  ActionButton,
  Empty,
  ErrorBanner,
  InfoBanner,
  MonitorLink,
  Segmented,
  Spinner,
  StatusIcon,
} from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { dateTime, duration, plural } from '../format.ts';
import { useAsync, useNow, usePoll } from '../hooks.ts';
import { matches } from '../logic.ts';
import { statusOf } from '../status.ts';
import { useToast } from '../toast.ts';

const DURATIONS = ['30m', '1h', '2h', '4h', '8h', '1d', '3d', '7d'];

export function MaintenanceView() {
  const { byId, me, api, changes, streaming, instance } = useLive();
  const now = useNow(30);
  const windows = usePoll(() => api.maintenance(), [changes], streaming ? null : me.refreshSeconds * 2);
  const [creating, setCreating] = useState(false);
  const list = [...(windows.data ?? [])].sort(
    (a, b) => Number(b.active) - Number(a.active) || (b.start ?? 0) - (a.start ?? 0) || a.id.localeCompare(b.id),
  );
  // Windows created at runtime need a newer Pingwarden: any window saying where it comes from.
  const runtime = list.some((w) => w.source !== undefined);
  return (
    <>
      <div className="page-head">
        <h1>Maintenance windows</h1>
        {instance.canAct !== false && !creating && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="wrench" /> Start a window
          </button>
        )}
      </div>
      <p className="muted">
        During a window, checks keep running and their results count as maintenance: no notification is sent and uptime
        leaves them out. Windows come from Pingwarden&rsquo;s configuration, or are started here for a while (at most 30
        days); those can be ended early.
      </p>
      {creating && <NewWindow onDone={() => setCreating(false)} />}
      {windows.error && <ErrorBanner>{windows.error.message}</ErrorBanner>}
      {!windows.data && !windows.error && <Spinner />}
      {windows.data && !list.length && <Empty>No maintenance window.</Empty>}
      {windows.data && list.length > 0 && !runtime && (
        <p className="muted small">This Pingwarden only has windows from its configuration.</p>
      )}
      <div className="cards maintenance-cards">
        {list.map((w) => (
          <WindowCard key={w.id} w={w} now={now} byId={byId} />
        ))}
      </div>
    </>
  );
}

function WindowCard({ w, now, byId }: { w: MaintenanceWindow; now: number; byId: ReturnType<typeof useLive>['byId'] }) {
  const { api } = useLive();
  const ended = w.source === 'api' && !w.active && w.end != null && w.end <= now;
  return (
    <div className={`card maintenance${w.active ? ' active' : ''}${ended ? ' ended' : ''}`}>
      <div className="notifier-head">
        <span className={`status-icon tone-${w.active ? 'maintenance' : 'neutral'}`}>
          <Icon name="wrench" />
        </span>
        <div className="grow min0">
          <div className="card-title">{w.id}</div>
          {w.description && <div className="muted small">{w.description}</div>}
        </div>
        <span className={`status ${w.active ? 'status-maintenance' : 'status-neutral'} status-small`}>
          {w.active ? 'Active' : ended ? 'Ended' : w.start != null && w.start > now ? 'Planned' : 'Inactive'}
        </span>
      </div>
      <p className="small">
        {w.active && w.active_until != null ? (
          <>
            Until {dateTime(w.active_until)} ({duration(w.active_until - now)} left)
          </>
        ) : w.start != null && w.end != null ? (
          <>
            {dateTime(w.start)} – {dateTime(w.end)}
          </>
        ) : w.recurring ? (
          'Recurring, from the configuration'
        ) : null}
      </p>
      <div className="small muted">
        {w.source === 'api'
          ? `Started from the API${w.created_by ? ` by ${w.created_by}` : ''}`
          : 'From the configuration'}
        {' · '}
        {plural(w.monitors.length, 'monitor')}
      </div>
      <ul className="plain monitor-list">
        {w.monitors.map((id) => {
          const m = byId.get(id);
          return (
            <li key={id} className="inline-item">
              {m && <StatusIcon status={statusOf(m)} size={12} />}
              <MonitorLink id={id} />
            </li>
          );
        })}
      </ul>
      {w.source === 'api' && (w.active || (w.start != null && w.start > now)) && (
        <div>
          <ActionButton
            small
            icon="x"
            label="End now"
            run={() => api.endMaintenance(w.id)}
            done={`Maintenance ${w.id} ended`}
          />
        </div>
      )}
    </div>
  );
}

type Scope = 'monitors' | 'groups' | 'tags' | 'all';

/** A form for an ad-hoc window: what, how long, why. */
function NewWindow({ onDone }: { onDone: () => void }) {
  const { api, monitors, refresh, changes } = useLive();
  const toast = useToast();
  const groups = useAsync(() => api.groups(), [changes]);
  const tags = useMemo(() => [...new Set(monitors.flatMap((m) => m.tags))].sort(), [monitors]);
  const [scope, setScope] = useState<Scope>('monitors');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [length, setLength] = useState('1h');
  const [start, setStart] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { id: string; label: string }[] =
    scope === 'monitors'
      ? monitors.filter((m) => matches(m, filter)).map((m) => ({ id: m.id, label: m.name }))
      : scope === 'groups'
        ? (groups.data ?? []).map((g) => ({ id: g.id, label: g.name }))
        : scope === 'tags'
          ? tags.map((t) => ({ id: t, label: t }))
          : [];
  const toggle = (id: string) =>
    setChosen((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async () => {
    setError(null);
    if (scope !== 'all' && !chosen.size) {
      setError(`Choose at least one of the ${scope}.`);
      return;
    }
    const req: MaintenanceRequest = {
      duration: length,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(start ? { start: new Date(start).getTime() } : {}),
      ...(scope === 'all' ? { all: true } : { [scope]: [...chosen] }),
    };
    setBusy(true);
    try {
      const w = await api.startMaintenance(req);
      toast(`Maintenance ${w.id ?? ''} started`);
      refresh();
      onDone();
    } catch (e) {
      setError(
        unsupported(e)
          ? 'This Pingwarden cannot start maintenance windows: that needs a newer version.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card form-card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Start a maintenance window</h2>
      <div className="form-row">
        <span>Covers</span>
        <Segmented
          label="Covers"
          value={scope}
          onChange={(v) => {
            setScope(v);
            setChosen(new Set());
          }}
          options={[
            { id: 'monitors', label: 'Monitors' },
            { id: 'groups', label: 'Groups' },
            { id: 'tags', label: 'Tags' },
            { id: 'all', label: 'Everything' },
          ]}
        />
      </div>
      {scope !== 'all' && (
        <div className="form-row form-row-top">
          <span>
            {chosen.size ? `${chosen.size} chosen` : 'Choose'}
            {scope === 'monitors' && (
              <input
                type="search"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter monitors"
                className="picker-filter"
              />
            )}
          </span>
          <div className="picker">
            {options.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" checked={chosen.has(o.id)} onChange={() => toggle(o.id)} />
                {o.label}
                {o.label !== o.id && <span className="muted small mono">{o.id}</span>}
              </label>
            ))}
            {!options.length && <span className="muted small">Nothing to choose.</span>}
          </div>
        </div>
      )}
      <label className="form-row">
        <span>For</span>
        <select value={length} onChange={(e) => setLength(e.target.value)}>
          {DURATIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label className="form-row">
        <span>Starting</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="form-row">
        <span>Why</span>
        <input
          type="text"
          value={description}
          maxLength={500}
          placeholder="e.g. firmware upgrade"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {!start && <p className="muted small">Leave “Starting” empty to start now.</p>}
      {error && <InfoBanner>{error}</InfoBanner>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <span className="spin" />} Start
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
