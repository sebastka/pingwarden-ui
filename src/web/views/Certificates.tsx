// Every certificate Pingwarden checks, by expiry date.
import { Empty, MonitorLink, StatusBadge } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, dateTime } from '../format.ts';
import { useNow } from '../hooks.ts';
import { certDays, certExpiresAt, statusOf } from '../status.ts';

export function CertificatesView() {
  const { monitors } = useLive();
  const now = useNow(60);
  const rows = monitors
    .filter((m) => m.type === 'tls' || certExpiresAt(m) !== null)
    .map((m) => ({ m, at: certExpiresAt(m), days: certDays(m, now) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.m.name.localeCompare(b.m.name));
  const soon = rows.filter((r) => r.days !== null && r.days <= 30).length;
  return (
    <>
      <div className="page-head">
        <h1>Certificates</h1>
      </div>
      <p className="muted">
        The certificates of TLS monitors, the first to expire first. Expiry is the earliest of the chain, so an expiring
        intermediate shows too. {soon > 0 && <strong className="warn-text">{soon} expire within 30 days.</strong>}
      </p>
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Monitor</th>
                <th>Target</th>
                <th>Expires</th>
                <th className="num">Days left</th>
                <th>Status</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, at, days }) => (
                <tr key={m.id}>
                  <td>
                    <MonitorLink id={m.id} />
                  </td>
                  <td className="mono small">{m.target}</td>
                  <td className="nowrap">
                    {at !== null ? dateTime(at) : <span className="muted">not checked yet</span>}
                  </td>
                  <td
                    className={`num ${days !== null && days <= 7 ? 'error-text' : days !== null && days <= 30 ? 'warn-text' : ''}`}
                  >
                    {days === null ? '–' : days < 0 ? `expired ${-days} d ago` : days}
                  </td>
                  <td>
                    <StatusBadge status={statusOf(m)} small />
                  </td>
                  <td className="small wrap" title={m.message ?? undefined}>
                    {ago(m.last_check, now)}
                    {m.message && <div className="muted">{m.message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No TLS monitor. Add a monitor of type tls to Pingwarden to follow a certificate.</Empty>
      )}
    </>
  );
}
