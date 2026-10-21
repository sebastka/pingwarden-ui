import { useMemo, useState, type ReactNode } from 'react';
import { type Group, type Monitor, MONITOR_TYPES, type Status } from '../../shared/pingwarden.ts';
import { api } from '../api.ts';
import { HistoryBar } from '../components/charts.tsx';
import { Icon } from '../components/icons.tsx';
import { Chip, Empty, ErrorBanner, InfoBanner, Segmented, StatusBadge, StatusIcon } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, dateTime, interval, latency, percent, plural } from '../format.ts';
import { useAsync, useNow, usePoll } from '../hooks.ts';
import { groupPath, matches, subtree } from '../logic.ts';
import type { Params } from '../route.ts';
import {
  certDays,
  isProblem,
  type Slot,
  slotsFromRollups,
  slotUptime,
  STATUS_META,
  STATUS_ORDER,
  statusOf,
} from '../status.ts';

const HOURS = 24;
/** TLS certificates expiring within this many days are listed above the monitors. */
const CERT_NOTICE_DAYS = 30;

const bySeverity = (a: Monitor, b: Monitor) =>
  STATUS_ORDER.indexOf(statusOf(a)) - STATUS_ORDER.indexOf(statusOf(b)) || a.name.localeCompare(b.name);

function Stat({
  label,
  value,
  status,
  active,
  onClick,
  foot,
}: {
  label: string;
  value: number;
  status?: Status;
  active?: boolean;
  onClick?: () => void;
  foot?: ReactNode;
}) {
  return (
    <button type="button" className={`card stat${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
      <div className="label">
        {status && <StatusIcon status={status} size={13} />}
        {label}
      </div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </button>
  );
}

export function MonitorsView({ params, update }: { params: Params; update: (p: Params, replace?: boolean) => void }) {
  const { monitors, openMonitor } = useLive();
  const groups = useAsync(() => api.groups(), [monitors.length]);
  const history = usePoll(() => api.history(HOURS), [], 60);
  const now = useNow(30);

  const q = params.q ?? '';
  const status = params.status ?? '';
  const type = params.type ?? '';
  const tag = params.tag ?? '';
  const group = params.group ?? '';
  const by = params.by === 'flat' ? 'flat' : 'groups';

  const groupMap = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g])), [groups.data]);
  const tags = useMemo(() => [...new Set(monitors.flatMap((m) => m.tags))].sort(), [monitors]);
  const types = MONITOR_TYPES.filter((t) => monitors.some((m) => m.type === t));

  const slots = useMemo(() => {
    const out = new Map<string, Slot[]>();
    if (!history.data) return out;
    for (const [id, rollups] of Object.entries(history.data.monitors)) {
      out.set(id, slotsFromRollups(rollups, 3600_000, HOURS, history.data.to));
    }
    return out;
  }, [history.data]);

  const inGroup = useMemo(() => (group ? subtree(group, groupMap) : null), [group, groupMap]);
  const shown = monitors
    .filter((m) => matches(m, q))
    .filter((m) => !status || (status === 'problems' ? isProblem(statusOf(m)) : statusOf(m) === status))
    .filter((m) => !type || m.type === type)
    .filter((m) => !tag || m.tags.includes(tag))
    .filter((m) => !inGroup || (m.group != null && inGroup.has(m.group)))
    .sort(bySeverity);

  const count = (s: Status) => monitors.filter((m) => statusOf(m) === s).length;
  const problems = monitors.filter((m) => isProblem(statusOf(m))).length;
  const certs = monitors
    .map((m) => ({ m, days: certDays(m, now) }))
    .filter((c): c is { m: Monitor; days: number } => c.days !== null && c.days <= CERT_NOTICE_DAYS)
    .sort((a, b) => a.days - b.days);
  const filtered = Boolean(q || status || type || tag || group);
  const setStatus = (s: string) => update({ status: status === s ? '' : s });

  return (
    <>
      <div className="kpis">
        <Stat label="Monitors" value={monitors.length} active={!status} onClick={() => update({ status: '' })} />
        <Stat
          label="Down"
          value={count('down')}
          status="down"
          active={status === 'down'}
          onClick={() => setStatus('down')}
        />
        <Stat
          label="Pending or degraded"
          value={count('pending') + count('degraded')}
          status={count('pending') ? 'pending' : 'degraded'}
          active={status === 'problems'}
          onClick={() => setStatus('problems')}
          foot={problems ? `${plural(problems, 'problem')} in all` : null}
        />
        <Stat label="Up" value={count('up')} status="up" active={status === 'up'} onClick={() => setStatus('up')} />
        <Stat
          label="Maintenance"
          value={count('maintenance')}
          status="maintenance"
          active={status === 'maintenance'}
          onClick={() => setStatus('maintenance')}
        />
        <Stat
          label="Paused or disabled"
          value={count('paused')}
          status="paused"
          active={status === 'paused'}
          onClick={() => setStatus('paused')}
        />
      </div>

      {certs.length > 0 && (
        <InfoBanner>
          <strong>
            {plural(certs.length, 'certificate')} expiring within {CERT_NOTICE_DAYS} days:
          </strong>{' '}
          {certs.map(({ m, days }, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <button type="button" className="btn-link" onClick={() => openMonitor(m.id)}>
                {m.name}
              </button>{' '}
              <span className={days <= 7 ? 'error-text' : 'warn-text'}>
                ({days < 0 ? `expired ${-days} d ago` : `${days} d`})
              </span>
            </span>
          ))}
        </InfoBanner>
      )}

      <div className="toolbar">
        <label className="toolbar-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Filter by name, target, tag…"
            value={q}
            onChange={(e) => update({ q: e.target.value }, true)}
            aria-label="Filter monitors"
          />
        </label>
        <div className="toolbar-filters">
          <select value={status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            <option value="problems">Problems</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => update({ type: e.target.value })} aria-label="Type">
            <option value="">Any type</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {tags.length > 0 && (
            <select value={tag} onChange={(e) => update({ tag: e.target.value })} aria-label="Tag">
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {groupMap.size > 0 && (
            <select value={group} onChange={(e) => update({ group: e.target.value })} aria-label="Group">
              <option value="">Any group</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {groupPath(g, groupMap)}
                </option>
              ))}
            </select>
          )}
          {filtered && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => update({ q: '', status: '', type: '', tag: '', group: '' })}
            >
              Clear
            </button>
          )}
          <Segmented
            label="Layout"
            value={by}
            onChange={(v) => update({ by: v === 'flat' ? 'flat' : '' })}
            options={[
              { id: 'groups', label: 'By group' },
              { id: 'flat', label: 'By status' },
            ]}
          />
        </div>
      </div>

      {groups.error && <ErrorBanner>Groups could not be read: {groups.error.message}</ErrorBanner>}
      {history.error && <ErrorBanner>The 24-hour history could not be read: {history.error.message}</ErrorBanner>}
      {!monitors.length ? (
        <Empty>Pingwarden has no monitors. Add some to its configuration and reload it.</Empty>
      ) : !shown.length ? (
        <Empty>No monitor matches these filters.</Empty>
      ) : (
        <MonitorTable
          monitors={shown}
          groups={by === 'groups' && !status ? (groups.data ?? []) : []}
          slots={slots}
          now={now}
          showGroupColumn={by === 'flat' || Boolean(status)}
        />
      )}
      <p className="muted small footnote">
        History bars: the last {HOURS} hours, one bar per hour. Uptime counts up and degraded results, as Pingwarden
        does; maintenance is left out.
      </p>
    </>
  );
}

function MonitorTable({
  monitors,
  groups,
  slots,
  now,
  showGroupColumn,
}: {
  monitors: Monitor[];
  /** Empty: a flat list. */
  groups: Group[];
  slots: Map<string, Slot[]>;
  now: number;
  showGroupColumn: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const rows: ReactNode[] = [];
  const row = (m: Monitor, depth: number) => (
    <MonitorRow key={m.id} m={m} slots={slots.get(m.id)} now={now} depth={depth} showGroup={showGroupColumn} />
  );

  if (!groups.length) {
    for (const m of monitors) rows.push(row(m, 0));
  } else {
    const members = new Map<string, Monitor[]>();
    for (const m of monitors) {
      const key = m.group && groupMap.has(m.group) ? m.group : '';
      members.set(key, [...(members.get(key) ?? []), m]);
    }
    // Groups with no shown monitor anywhere below them are left out.
    const visible = new Map<string, number>();
    const total = (id: string, seen = new Set<string>()): number => {
      if (visible.has(id)) return visible.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const g = groupMap.get(id)!;
      const n =
        (members.get(id)?.length ?? 0) + g.groups.reduce((s, c) => s + (groupMap.has(c) ? total(c, seen) : 0), 0);
      visible.set(id, n);
      return n;
    };
    const walk = (g: Group, depth: number) => {
      if (!total(g.id)) return;
      const open = !collapsed.has(g.id);
      rows.push(
        <tr key={`g:${g.id}`} className="group-row">
          <td colSpan={7} style={{ paddingLeft: 8 + depth * 18 }}>
            <button
              type="button"
              className="group-toggle"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((c) => {
                  const n = new Set(c);
                  if (open) n.add(g.id);
                  else n.delete(g.id);
                  return n;
                })
              }
            >
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
              <Icon name="folder" size={14} className="muted" />
              <span className="group-name">{g.name}</span>
              <StatusBadge status={g.status} small />
              <span className="muted small">{plural(total(g.id), 'monitor')}</span>
              {g.description && <span className="muted small ellipsis">· {g.description}</span>}
            </button>
          </td>
        </tr>,
      );
      if (!open) return;
      for (const m of members.get(g.id) ?? []) rows.push(row(m, depth + 1));
      for (const c of g.groups) {
        const child = groupMap.get(c);
        if (child) walk(child, depth + 1);
      }
    };
    for (const g of groups) if (!g.parent || !groupMap.has(g.parent)) walk(g, 0);
    const loose = members.get('') ?? [];
    if (loose.length) {
      rows.push(
        <tr key="g:" className="group-row">
          <td colSpan={7}>
            <span className="group-toggle static">
              <span className="group-name">Not in a group</span>
              <span className="muted small">{plural(loose.length, 'monitor')}</span>
            </span>
          </td>
        </tr>,
      );
      for (const m of loose) rows.push(row(m, 0));
    }
  }

  return (
    <div className="table-wrap">
      <table className="table monitors">
        <thead>
          <tr>
            <th className="col-status">Status</th>
            <th className="col-name">Monitor</th>
            <th className="col-type">Type</th>
            <th className="col-history">Last 24 h</th>
            <th className="num col-uptime">Uptime</th>
            <th className="num col-latency">Latency</th>
            <th className="col-checked">Checked</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function MonitorRow({
  m,
  slots,
  now,
  depth,
  showGroup,
}: {
  m: Monitor;
  slots: Slot[] | undefined;
  now: number;
  depth: number;
  showGroup: boolean;
}) {
  const { openMonitor } = useLive();
  const s = statusOf(m);
  const days = certDays(m, now);
  const sum = slots?.reduce((a, x) => ({ up: a.up + x.up, degraded: a.degraded + x.degraded, down: a.down + x.down }), {
    up: 0,
    degraded: 0,
    down: 0,
  });
  const uptime = sum ? slotUptime(sum) : null;
  return (
    <tr className={`monitor-row tone-row-${STATUS_META[s].tone}`}>
      <td className="col-status">
        <StatusBadge status={s} small />
      </td>
      <td className="col-name" style={{ paddingLeft: 8 + depth * 18 }}>
        <button type="button" className="name-btn" onClick={() => openMonitor(m.id)}>
          <span className="ellipsis monitor-name">{m.name}</span>
        </button>
        <div className="monitor-sub">
          <span className="muted small ellipsis mono" title={m.target}>
            {m.target}
          </span>
          {showGroup && m.group && <Chip icon="folder">{m.group}</Chip>}
          {!m.enabled && <Chip>disabled</Chip>}
          {m.enabled && m.paused && <Chip icon="pause">paused</Chip>}
          {m.flapping && <Chip icon="flap">flapping</Chip>}
          {m.maintenance && <Chip icon="wrench">{m.maintenance}</Chip>}
          {days !== null && days <= CERT_NOTICE_DAYS && (
            <span className={`chip ${days <= 7 ? 'chip-critical' : 'chip-warning'}`}>
              <Icon name="certificate" size={12} />
              {days < 0 ? 'expired' : `${days} d`}
            </span>
          )}
        </div>
        {isProblem(s) && m.message && <div className="small row-message">{m.message}</div>}
      </td>
      <td className="col-type">
        <span className="mono small">{m.type}</span>
      </td>
      <td className="col-history">
        {slots ? <HistoryBar slots={slots} label={`${m.name}, last 24 hours`} /> : <span className="muted">–</span>}
      </td>
      <td className="num col-uptime">{percent(uptime)}</td>
      <td className="num col-latency">{latency(m.latency_ms)}</td>
      <td className="col-checked small" title={`${dateTime(m.last_check)}, ${interval(m.interval_seconds)}`}>
        {m.enabled ? ago(m.last_check, now) : '–'}
      </td>
    </tr>
  );
}
