// A wall display: every monitor as a tile, problems first, readable from across the room.
import { useMemo, type ReactNode } from 'react';
import type { Monitor, Rollup } from '../../shared/pingwarden.ts';
import type { Me } from '../../shared/types.ts';
import { instanceApi } from '../api.ts';
import { AlertMenu } from '../components/AlertMenu.tsx';
import { HistoryBar } from '../components/charts.tsx';
import { Icon } from '../components/icons.tsx';
import { StatusBadge } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, duration, latency } from '../format.ts';
import { useNow, usePoll } from '../hooks.ts';
import { useAlerts } from '../live.ts';
import logo from '../logo.svg';
import { href } from '../route.ts';
import { isProblem, slotsFromRollups, STATUS_META, STATUS_ORDER, statusOf } from '../status.ts';

const bySeverity = (a: Monitor, b: Monitor) =>
  STATUS_ORDER.indexOf(statusOf(a)) - STATUS_ORDER.indexOf(statusOf(b)) || a.name.localeCompare(b.name);

function Summary({ monitors }: { monitors: Monitor[] }) {
  const enabled = monitors.filter((m) => m.enabled);
  const problems = enabled.filter((m) => isProblem(statusOf(m)));
  const up = enabled.filter((m) => statusOf(m) === 'up').length;
  return (
    <div className={`board-summary ${problems.length ? 'tone-critical-text' : 'tone-good-text'}`}>
      <Icon name={problems.length ? 'alert' : 'check'} size={22} />
      {problems.length
        ? `${problems.length} of ${enabled.length} monitors need attention`
        : `All ${up} monitors are up`}
    </div>
  );
}

function Clock({ now }: { now: number }) {
  return (
    <span className="muted">{new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
  );
}

export function BoardView({
  onExit,
  onAll,
  error,
  alerts,
}: {
  onExit: () => void;
  /** Shows every instance; null with a single one. */
  onAll: (() => void) | null;
  error: string | null;
  alerts: ReactNode;
}) {
  const { monitors, api, changes, openMonitor, instance, me } = useLive();
  const now = useNow(5);
  const history = usePoll(() => api.history(24), [changes], 60);
  const sorted = useMemo(() => monitors.filter((m) => m.enabled).sort(bySeverity), [monitors]);

  return (
    <div className="board">
      <header className="board-head">
        <img src={logo} alt="" width="32" height="32" />
        {me.instances.length > 1 && <span className="board-instance">{instance.name}</span>}
        <Summary monitors={monitors} />
        <Clock now={now} />
        {alerts}
        {onAll && (
          <button type="button" className="btn" onClick={onAll}>
            All instances
          </button>
        )}
        <button type="button" className="btn" onClick={onExit}>
          Exit board
        </button>
      </header>
      {error && (
        <div className="board-error" role="alert">
          <Icon name="alert" /> Not updating: {error}
        </div>
      )}
      <div className="board-grid">
        {sorted.map((m) => (
          <Tile
            key={m.id}
            m={m}
            now={now}
            rollups={history.data?.monitors[m.id]}
            to={history.data?.to ?? now}
            onOpen={() => openMonitor(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Every instance on one board: one section each, the instances with problems first. */
export function AllBoards({ me, onExit }: { me: Me; onExit: () => void }) {
  const now = useNow(5);
  const data = usePoll(
    () =>
      Promise.all(
        me.instances.map(async (i) => {
          const api = instanceApi(i.id);
          const [monitors, history] = await Promise.all([
            api.monitors().catch((e: Error) => e),
            api.history(24).catch(() => null),
          ]);
          return { instance: i, monitors, history };
        }),
      ),
    [],
    me.refreshSeconds,
  );
  // Alerts across instances: ids are only unique within an instance.
  const all = useMemo(
    () =>
      (data.data ?? []).flatMap((d) =>
        Array.isArray(d.monitors) ? d.monitors.map((m) => ({ ...m, id: `${d.instance.id}/${m.id}` })) : [],
      ),
    [data.data],
  );
  const alerts = useAlerts(all, 'Pingwarden');
  const problems = (d: NonNullable<typeof data.data>[number]) =>
    Array.isArray(d.monitors) ? d.monitors.filter((m) => m.enabled && isProblem(statusOf(m))).length : 1e9;
  const sections = [...(data.data ?? [])].sort((a, b) => problems(b) - problems(a));

  return (
    <div className="board">
      <header className="board-head">
        <img src={logo} alt="" width="32" height="32" />
        <Summary monitors={all} />
        <Clock now={now} />
        <AlertMenu {...alerts} />
        <button type="button" className="btn" onClick={onExit}>
          Exit board
        </button>
      </header>
      {data.error && (
        <div className="board-error" role="alert">
          <Icon name="alert" /> Not updating: {data.error.message}
        </div>
      )}
      {sections.map(({ instance, monitors, history }) => (
        <section key={instance.id} className="board-section">
          <h2>{instance.name}</h2>
          {Array.isArray(monitors) ? (
            <div className="board-grid">
              {monitors
                .filter((m) => m.enabled)
                .sort(bySeverity)
                .map((m) => (
                  <Tile
                    key={m.id}
                    m={m}
                    now={now}
                    rollups={history?.monitors[m.id]}
                    to={history?.to ?? now}
                    onOpen={() => location.assign(href({ i: instance.id, view: 'board', m: m.id }))}
                  />
                ))}
            </div>
          ) : (
            <div className="board-error" role="alert">
              <Icon name="alert" /> {monitors.message}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Tile({
  m,
  now,
  rollups,
  to,
  onOpen,
}: {
  m: Monitor;
  now: number;
  rollups: Rollup[] | undefined;
  to: number;
  onOpen: () => void;
}) {
  const s = statusOf(m);
  const slots = rollups ? slotsFromRollups(rollups, 3600_000, 24, to) : null;
  return (
    <div className={`tile tone-border-${STATUS_META[s].tone}${isProblem(s) ? ' tile-problem' : ''}`}>
      <button type="button" className="tile-name" onClick={onOpen}>
        {m.name}
      </button>
      <div className="tile-state">
        <StatusBadge status={s} />
        <span className="muted small">
          {m.since != null && s !== 'up' ? `for ${duration(now - m.since)}` : latency(m.latency_ms)}
        </span>
      </div>
      {isProblem(s) && m.message && <div className="tile-message small">{m.message}</div>}
      {m.acknowledged && <div className="small muted">Acknowledged by {m.acknowledged.by}</div>}
      {slots && <HistoryBar slots={slots} label={`${m.name}, last 24 hours`} tall />}
      <div className="muted tiny">checked {ago(m.last_check, now)}</div>
    </div>
  );
}
