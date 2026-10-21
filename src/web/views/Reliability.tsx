// Reliability over a month: uptime against the SLO, outages, MTTR and MTBF per monitor. The
// report can be exported as CSV or printed (to PDF).
import { useMemo, useState } from 'react';
import type { Rollup } from '../../shared/pingwarden.ts';
import { type Api, unsupported } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorBanner, MonitorLink, Spinner } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { duration, percent, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { reliability, type ReliabilityRow, toCsv } from '../logic.ts';
import type { Params } from '../route.ts';

const DAY = 86_400_000;

interface Period {
  id: string;
  label: string;
  from: number;
  to: number;
}

/** The last 30 days, then the last 12 calendar months (UTC, as Pingwarden's daily rollups). */
function periods(now: number): Period[] {
  const today = Math.floor(now / DAY) * DAY;
  const out: Period[] = [{ id: '30d', label: 'Last 30 days', from: today - 29 * DAY, to: now }];
  const d = new Date(now);
  for (let i = 0; i < 12; i++) {
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1);
    const to = Math.min(now, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1));
    const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(from);
    out.push({ id: new Date(from).toISOString().slice(0, 7), label: i === 0 ? `${label} (so far)` : label, from, to });
  }
  return out;
}

/** Daily rollups of every monitor: one request, or one per monitor with an older Pingwarden. */
async function dailyRollups(api: Api, ids: string[], from: number, to: number): Promise<Record<string, Rollup[]>> {
  try {
    return (await api.bulkRollups('day', { from, to })).monitors;
  } catch (e) {
    if (!unsupported(e)) throw e;
  }
  const out: Record<string, Rollup[]> = {};
  for (let i = 0; i < ids.length; i += 6) {
    await Promise.all(
      ids.slice(i, i + 6).map(async (id) => {
        out[id] = (await api.rollups(id, 'day', { from, to })).rollups;
      }),
    );
  }
  return out;
}

const pct = (p: number | null) => (p === null ? '' : p.toFixed(3));

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BudgetBar({ used }: { used: number | null }) {
  if (used === null) return <span className="muted">–</span>;
  const tone = used >= 1 ? 'critical' : used >= 0.75 ? 'warning' : 'good';
  return (
    <span className="budget" title={`${Math.round(used * 100)} % of the error budget used`}>
      <span className="budget-track">
        <span className={`budget-fill tone-bg-${tone}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
      </span>
      <span className={used >= 1 ? 'error-text' : undefined}>{used > 9.99 ? '> 999' : Math.round(used * 100)} %</span>
    </span>
  );
}

export function ReliabilityView({
  params,
  update,
}: {
  params: Params;
  update: (p: Params, replace?: boolean) => void;
}) {
  const { api, monitors, instance } = useLive();
  // Periods are computed once per page: "now" moving would reload the report all the time.
  const [all] = useState(() => periods(Date.now()));
  const period = all.find((p) => p.id === params.period) ?? all[0]!;
  const group = params.group ?? '';
  const ids = useMemo(() => monitors.map((m) => m.id), [monitors]);
  const data = useAsync(async () => {
    const [rollups, events] = await Promise.all([
      dailyRollups(api, ids, period.from, period.to),
      api.events({ from: period.from, to: period.to, limit: 10_000 }),
    ]);
    return { rollups, events: events.events };
  }, [period.id, ids.join(',')]);

  const rows = useMemo(() => {
    if (!data.data) return [];
    const shown = monitors.filter((m) => m.enabled && (!group || m.group === group));
    return reliability(shown, data.data.rollups, data.data.events, period.from, period.to).sort(
      (a, b) => (a.uptime ?? 101) - (b.uptime ?? 101) || a.name.localeCompare(b.name),
    );
  }, [data.data, monitors, group, period]);
  const groups = [...new Set(monitors.map((m) => m.group).filter((g): g is string => Boolean(g)))].sort();

  const checks = rows.reduce((n, r) => n + r.checks, 0);
  const overall = checks ? rows.reduce((n, r) => n + (r.uptime ?? 0) * r.checks, 0) / checks : null;
  const withSlo = rows.filter((r) => r.budgetUsed !== null);
  const met = withSlo.filter((r) => r.budgetUsed! <= 1).length;
  const outages = rows.reduce((n, r) => n + r.outages, 0);
  const downtime = rows.reduce((n, r) => n + r.downtimeMs, 0);

  const exportCsv = () =>
    download(
      `pingwarden-${instance.id}-${period.id}.csv`,
      toCsv(
        [
          'monitor',
          'name',
          'group',
          'uptime_percent',
          'checks',
          'slo_percent',
          'error_budget_used_percent',
          'outages',
          'downtime_seconds',
          'longest_outage_seconds',
          'mttr_seconds',
          'mtbf_seconds',
        ],
        rows.map((r: ReliabilityRow) => [
          r.id,
          r.name,
          r.group,
          pct(r.uptime),
          r.checks,
          r.slo,
          r.budgetUsed === null ? null : Math.round(r.budgetUsed * 1000) / 10,
          r.outages,
          Math.round(r.downtimeMs / 1000),
          Math.round(r.longestMs / 1000),
          r.mttrMs === null ? null : Math.round(r.mttrMs / 1000),
          r.mtbfMs === null ? null : Math.round(r.mtbfMs / 1000),
        ]),
      ),
    );

  return (
    <div className="report">
      <div className="page-head">
        <h1>
          Reliability <span className="muted print-only">· {instance.name}</span>
        </h1>
        <div className="toolbar-filters no-print">
          <select value={period.id} onChange={(e) => update({ period: e.target.value })} aria-label="Period">
            {all.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {groups.length > 0 && (
            <select value={group} onChange={(e) => update({ group: e.target.value })} aria-label="Group">
              <option value="">Every group</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}>
            <Icon name="download" /> CSV
          </button>
          <button type="button" className="btn" onClick={() => window.print()} disabled={!rows.length}>
            <Icon name="printer" /> Print
          </button>
        </div>
      </div>
      <p className="muted small">
        {period.label}
        {group && `, group ${group}`}. Uptime counts up and degraded checks, maintenance excluded. An outage lasts from
        a change to down until the next change; MTTR averages outages that started and ended in the period, MTBF is the
        time up per outage. The error budget is the downtime the SLO allows.
      </p>
      {data.error && <ErrorBanner>{data.error.message}</ErrorBanner>}
      {!data.data && !data.error && <Spinner label="Reading the period…" />}
      {data.data && (
        <>
          <div className="kpis kpis-4">
            <div className="card stat">
              <div className="label">Uptime</div>
              <div className="value">{percent(overall)}</div>
              <div className="foot">{plural(rows.length, 'monitor')}, weighted by checks</div>
            </div>
            <div className="card stat">
              <div className="label">Within their SLO</div>
              <div className="value">{withSlo.length ? `${met} / ${withSlo.length}` : '–'}</div>
              <div className="foot">{withSlo.length ? 'monitors with an SLO' : 'no monitor has an slo setting'}</div>
            </div>
            <div className="card stat">
              <div className="label">Outages</div>
              <div className="value">{outages}</div>
            </div>
            <div className="card stat">
              <div className="label">Downtime</div>
              <div className="value">{outages ? duration(downtime) : '0'}</div>
              <div className="foot">summed over the monitors</div>
            </div>
          </div>
          {data.data.events.length >= 10_000 && (
            <ErrorBanner>The period has more than 10,000 status changes; outages are incomplete.</ErrorBanner>
          )}
          {rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Monitor</th>
                    <th className="num">Uptime</th>
                    <th className="num">SLO</th>
                    <th>Error budget used</th>
                    <th className="num">Outages</th>
                    <th className="num">Downtime</th>
                    <th className="num">Longest</th>
                    <th className="num" title="Mean time to recovery">
                      MTTR
                    </th>
                    <th className="num" title="Mean time between failures">
                      MTBF
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <MonitorLink id={r.id} name={r.name} />
                        {r.group && <span className="muted small"> · {r.group}</span>}
                        {r.ongoing && <span className="error-text small"> · down now</span>}
                      </td>
                      <td className="num">{r.checks ? percent(r.uptime) : '–'}</td>
                      <td className="num">{r.slo != null ? percent(r.slo) : '–'}</td>
                      <td>
                        <BudgetBar used={r.budgetUsed} />
                      </td>
                      <td className="num">{r.outages || '–'}</td>
                      <td className="num">{r.downtimeMs ? duration(r.downtimeMs) : '–'}</td>
                      <td className="num">{r.longestMs ? duration(r.longestMs) : '–'}</td>
                      <td className="num">{r.mttrMs !== null ? duration(r.mttrMs) : '–'}</td>
                      <td className="num">{r.mtbfMs !== null ? duration(r.mtbfMs) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No monitor in this selection.</Empty>
          )}
        </>
      )}
    </div>
  );
}
