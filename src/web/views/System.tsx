import type { Group } from '../../shared/pingwarden.ts';
import { ActionButton, ErrorBanner, KV, Spinner, StatusBadge } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { plural } from '../format.ts';
import { useAsync, usePoll } from '../hooks.ts';
import { STATUS_ORDER } from '../status.ts';

export function SystemView() {
  const { me, instance, monitors, showMonitors, api, changes, streaming } = useLive();
  const status = usePoll(() => api.status(), [changes], streaming ? null : me.refreshSeconds);
  const groups = useAsync(() => api.groups(), [monitors.length, changes]);
  const tags = useAsync(() => api.tags(), [monitors.length, changes]);
  const s = status.data;

  return (
    <>
      <div className="page-head">
        <h1>System</h1>
        <ActionButton
          icon="refresh"
          label="Reload configuration"
          run={() => api.reload()}
          done="Pingwarden reloaded its configuration"
        />
      </div>
      <div className="two-col">
        <section className="card">
          <h2>{instance.name}</h2>
          {status.error && <ErrorBanner>{status.error.message}</ErrorBanner>}
          {s ? (
            <KV
              rows={[
                ['Version', s.version],
                [
                  'Role',
                  s.leader ? (
                    'Leader: runs the checks'
                  ) : (
                    <span className="warn-text">Standby: another instance leads</span>
                  ),
                ],
                ['Database', s.database === 'mysql' ? 'MariaDB / MySQL' : 'PostgreSQL'],
                [
                  'Monitors',
                  <span className="inline" key="m">
                    {STATUS_ORDER.filter((st) => s.monitors[st]).map((st) => (
                      <span key={st} className="inline-item">
                        <StatusBadge status={st} small /> {s.monitors[st]}
                      </span>
                    ))}
                  </span>,
                ],
              ]}
            />
          ) : (
            !status.error && <Spinner />
          )}
        </section>
        <section className="card">
          <h2>This dashboard</h2>
          <KV
            rows={[
              ['Access', me.mode === 'oidc' ? 'Signed in with OpenID Connect' : 'No sign-in (API token)'],
              ['User', me.user?.name],
              [
                'Actions',
                instance.canAct === false
                  ? (instance.actionsReason ?? 'Not allowed')
                  : instance.canAct
                    ? 'Allowed'
                    : 'Offered; Pingwarden decides on each one',
              ],
              ['Updates', streaming ? 'Live (Pingwarden pushes changes)' : `Polled every ${me.refreshSeconds} s`],
              ['Instances', me.instances.length > 1 && me.instances.map((i) => i.name).join(', ')],
            ]}
          />
        </section>
      </div>

      <h2>Groups</h2>
      {groups.error && <ErrorBanner>{groups.error.message}</ErrorBanner>}
      {groups.data && <GroupTable groups={groups.data} />}

      <h2>Tags</h2>
      {tags.error && <ErrorBanner>{tags.error.message}</ErrorBanner>}
      {tags.data &&
        (tags.data.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th className="num">Monitors</th>
                  <th>Groups</th>
                </tr>
              </thead>
              <tbody>
                {tags.data.map((t) => (
                  <tr key={t.tag}>
                    <td>
                      <button type="button" className="btn-link mono" onClick={() => showMonitors({ tag: t.tag })}>
                        {t.tag}
                      </button>
                    </td>
                    <td className="num">{t.monitors.length}</td>
                    <td className="small">{t.groups.join(', ') || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No tags.</p>
        ))}
    </>
  );
}

function GroupTable({ groups }: { groups: Group[] }) {
  const { showMonitors } = useLive();
  if (!groups.length) return <p className="muted">No groups.</p>;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows: { g: Group; depth: number }[] = [];
  const walk = (g: Group, depth: number, seen: Set<string>) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    rows.push({ g, depth });
    for (const c of g.groups) if (byId.has(c)) walk(byId.get(c)!, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const g of groups) if (!g.parent || !byId.has(g.parent)) walk(g, 0, seen);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Status</th>
            <th>Tags</th>
            <th className="num">Members</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ g, depth }) => (
            <tr key={g.id}>
              <td style={{ paddingLeft: 8 + depth * 18 }}>
                <button type="button" className="btn-link" onClick={() => showMonitors({ group: g.id })}>
                  {g.name}
                </button>
                {g.name !== g.id && <span className="muted small mono"> {g.id}</span>}
                {g.description && <div className="muted small">{g.description}</div>}
              </td>
              <td>
                <StatusBadge status={g.status} small />
              </td>
              <td className="small mono">{g.tags.join(', ') || '–'}</td>
              <td className="num small">
                {plural(g.monitors.length, 'monitor')}
                {g.groups.length > 0 && `, ${plural(g.groups.length, 'group')}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
