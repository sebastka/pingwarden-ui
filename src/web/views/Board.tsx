// A wall display: every monitor as a tile, problems first, readable from across the room.
import { useMemo } from 'react';
import type { Monitor } from '../../shared/pingwarden.ts';
import { api } from '../api.ts';
import { HistoryBar } from '../components/charts.tsx';
import { Icon } from '../components/icons.tsx';
import { StatusBadge } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, duration, latency } from '../format.ts';
import { useNow, usePoll } from '../hooks.ts';
import logo from '../logo.svg';
import { isProblem, slotsFromRollups, STATUS_META, STATUS_ORDER, statusOf } from '../status.ts';

export function BoardView({ onExit, error }: { onExit: () => void; error: string | null }) {
  const { monitors } = useLive();
  const now = useNow(5);
  const history = usePoll(() => api.history(24), [], 60);
  const sorted = useMemo(
    () =>
      [...monitors]
        .filter((m) => m.enabled)
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(statusOf(a)) - STATUS_ORDER.indexOf(statusOf(b)) || a.name.localeCompare(b.name),
        ),
    [monitors],
  );
  const problems = sorted.filter((m) => isProblem(statusOf(m)));
  const up = sorted.filter((m) => statusOf(m) === 'up').length;

  return (
    <div className="board">
      <header className="board-head">
        <img src={logo} alt="" width="32" height="32" />
        <div className={`board-summary ${problems.length ? 'tone-critical-text' : 'tone-good-text'}`}>
          <Icon name={problems.length ? 'alert' : 'check'} size={22} />
          {problems.length
            ? `${problems.length} of ${sorted.length} monitors need attention`
            : `All ${up} monitors are up`}
        </div>
        <span className="muted">
          {new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </span>
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
          <Tile key={m.id} m={m} now={now} rollups={history.data?.monitors[m.id]} to={history.data?.to ?? now} />
        ))}
      </div>
    </div>
  );
}

function Tile({
  m,
  now,
  rollups,
  to,
}: {
  m: Monitor;
  now: number;
  rollups: Parameters<typeof slotsFromRollups>[0] | undefined;
  to: number;
}) {
  const { openMonitor } = useLive();
  const s = statusOf(m);
  const slots = rollups ? slotsFromRollups(rollups, 3600_000, 24, to) : null;
  return (
    <div className={`tile tone-border-${STATUS_META[s].tone}${isProblem(s) ? ' tile-problem' : ''}`}>
      <button type="button" className="tile-name" onClick={() => openMonitor(m.id)}>
        {m.name}
      </button>
      <div className="tile-state">
        <StatusBadge status={s} />
        <span className="muted small">
          {m.since != null && s !== 'up' ? `for ${duration(now - m.since)}` : latency(m.latency_ms)}
        </span>
      </div>
      {isProblem(s) && m.message && <div className="tile-message small">{m.message}</div>}
      {slots && <HistoryBar slots={slots} label={`${m.name}, last 24 hours`} tall />}
      <div className="muted tiny">checked {ago(m.last_check, now)}</div>
    </div>
  );
}
