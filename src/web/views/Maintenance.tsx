import { api } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorBanner, MonitorLink, Spinner, StatusIcon } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { dateTime, duration, plural } from '../format.ts';
import { useNow, usePoll } from '../hooks.ts';
import { statusOf } from '../status.ts';

export function MaintenanceView() {
  const { byId, me } = useLive();
  const now = useNow(30);
  const windows = usePoll(() => api.maintenance(), [], me.refreshSeconds * 2);
  const list = [...(windows.data ?? [])].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id),
  );
  return (
    <>
      <div className="page-head">
        <h1>Maintenance windows</h1>
      </div>
      <p className="muted">
        During a window, checks keep running and their results count as maintenance: no notification is sent and uptime
        leaves them out. Windows are defined in Pingwarden&rsquo;s configuration.
      </p>
      {windows.error && <ErrorBanner>{windows.error.message}</ErrorBanner>}
      {!windows.data && !windows.error && <Spinner />}
      {windows.data && !list.length && <Empty>No maintenance window is configured.</Empty>}
      <div className="cards maintenance-cards">
        {list.map((w) => (
          <div key={w.id} className={`card maintenance${w.active ? ' active' : ''}`}>
            <div className="notifier-head">
              <span className={`status-icon tone-${w.active ? 'maintenance' : 'neutral'}`}>
                <Icon name="wrench" />
              </span>
              <div className="grow min0">
                <div className="card-title">{w.id}</div>
                {w.description && <div className="muted small">{w.description}</div>}
              </div>
              <span className={`status ${w.active ? 'status-maintenance' : 'status-neutral'} status-small`}>
                {w.active ? 'Active' : 'Inactive'}
              </span>
            </div>
            {w.active && w.active_until != null && (
              <p className="small">
                Until {dateTime(w.active_until)} ({duration(w.active_until - now)} left)
              </p>
            )}
            <div className="small muted">{plural(w.monitors.length, 'monitor')}</div>
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
          </div>
        ))}
      </div>
    </>
  );
}
