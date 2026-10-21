import { useMemo, useState } from 'react';
import type { Heartbeat, Monitor, UptimeWindow } from '../../shared/pingwarden.ts';
import { unsupported } from '../api.ts';
import { LatencyChart, SlotTable } from '../components/charts.tsx';
import { Icon } from '../components/icons.tsx';
import { Menu } from '../components/Menu.tsx';
import {
  ActionButton,
  Chip,
  Drawer,
  Empty,
  ErrorBanner,
  InfoBanner,
  KV,
  MonitorLink,
  Segmented,
  Spinner,
  StatusBadge,
  StatusIcon,
  Tabs,
} from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, dateTime, dateTimeSeconds, duration, interval, latency, num, percent, plural } from '../format.ts';
import { useAsync, useNow, usePoll } from '../hooks.ts';
import { budgetUsed } from '../logic.ts';
import {
  certDays,
  certExpiresAt,
  isProblem,
  isSilenced,
  slotsFromHeartbeats,
  slotsFromRollups,
  statusOf,
} from '../status.ts';
import { EventTable } from './Events.tsx';
import { DeliveryTable } from './Notifications.tsx';

type Tab = 'overview' | 'heartbeats' | 'events' | 'notifications' | 'config';
type RangeId = '24h' | '7d' | '30d' | '365d';

const RANGES: { id: RangeId; label: string }[] = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '365d', label: '1 year' },
];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const SILENCE_FOR = [
  { duration: '15m', label: '15 minutes' },
  { duration: '1h', label: '1 hour' },
  { duration: '4h', label: '4 hours' },
  { duration: '1d', label: '1 day' },
  { duration: '7d', label: '7 days' },
];

/** Acknowledge, silence and ad-hoc maintenance need a newer Pingwarden; its monitors say so. */
const hasRuntimeControls = (m: Monitor) => m.acknowledged !== undefined;

function Actions({ m }: { m: Monitor }) {
  const { api, instance } = useLive();
  const now = useNow(30);
  if (instance.canAct === false) return null;
  const silenced = isSilenced(m, now);
  return (
    <>
      {m.enabled && (
        <ActionButton icon="zap" label="Check now" run={() => api.check(m.id)} done={`${m.name}: check started`} />
      )}
      {m.paused ? (
        <ActionButton icon="play" label="Resume" run={() => api.resume(m.id)} done={`${m.name} resumed`} />
      ) : (
        <ActionButton icon="pause" label="Pause" run={() => api.pause(m.id)} done={`${m.name} paused`} />
      )}
      {hasRuntimeControls(m) && (
        <>
          {m.acknowledged ? (
            <ActionButton
              icon="x"
              label="Unacknowledge"
              run={() => api.unack(m.id)}
              done={`${m.name}: acknowledgement removed`}
            />
          ) : (
            isProblem(statusOf(m)) && (
              <ActionButton
                icon="check"
                label="Acknowledge"
                run={async () => {
                  const comment = window.prompt(
                    `Acknowledge ${m.name}: reminders stop until it recovers. Comment:`,
                    '',
                  );
                  if (comment === null) return false;
                  return api.ack(m.id, comment.trim() || undefined);
                }}
                done={`${m.name} acknowledged`}
              />
            )
          )}
          {silenced ? (
            <ActionButton
              icon="bell"
              label="Unsilence"
              run={() => api.unsilence(m.id)}
              done={`${m.name}: notifications resumed`}
            />
          ) : (
            <Menu
              closeOnClick
              summary={
                <>
                  <Icon name="bellOff" /> Silence
                </>
              }
            >
              <div className="menu-title">No notification about {m.name} for</div>
              {SILENCE_FOR.map((o) => (
                <ActionButton
                  key={o.duration}
                  small
                  icon="bellOff"
                  label={o.label}
                  run={() => api.silence(m.id, o.duration)}
                  done={`${m.name} silenced for ${o.label}`}
                />
              ))}
            </Menu>
          )}
          {!m.maintenance && (
            <ActionButton
              icon="wrench"
              label="Maintenance 1 h"
              run={() =>
                api.startMaintenance({
                  monitors: [m.id],
                  duration: '1h',
                  description: `${m.name}, started from the dashboard`,
                })
              }
              done={`${m.name} is in maintenance for an hour`}
            />
          )}
        </>
      )}
    </>
  );
}

export function MonitorDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { byId, api } = useLive();
  const listed = byId.get(id);
  // Also works for a monitor that is not in the list (removed from the configuration).
  const one = useAsync(() => (listed ? Promise.resolve(listed) : api.monitor(id)), [id, listed]);
  const [tab, setTab] = useState<Tab>('overview');
  const m = listed ?? one.data;

  return (
    <Drawer
      title={m ? m.name : id}
      subtitle={m && <span className="mono">{m.id === m.name ? m.target : `${m.id} · ${m.target}`}</span>}
      onClose={onClose}
      actions={m && <Actions m={m} />}
    >
      {one.error && !m && <ErrorBanner>{one.error.message}</ErrorBanner>}
      {!m && !one.error && <Spinner />}
      {m && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'heartbeats', label: 'Checks' },
              { id: 'events', label: 'Events' },
              { id: 'notifications', label: 'Notifications' },
              { id: 'config', label: 'Configuration' },
            ]}
          />
          {tab === 'overview' && <Overview m={m} />}
          {tab === 'heartbeats' && <Heartbeats id={m.id} />}
          {tab === 'events' && <MonitorEvents m={m} />}
          {tab === 'notifications' && <MonitorNotifications id={m.id} />}
          {tab === 'config' && <MonitorConfiguration id={m.id} />}
        </>
      )}
    </Drawer>
  );
}

function Overview({ m }: { m: Monitor }) {
  const { byId, instance, api, changes } = useLive();
  const now = useNow(15);
  const uptime = usePoll(() => api.uptime(m.id), [m.id, changes], 60);
  const s = statusOf(m);
  const days = certDays(m, now);
  const expires = certExpiresAt(m);
  const month = uptime.data?.windows.find((w) => w.window === '30d');
  const used = budgetUsed(month?.uptime ?? null, m.slo);
  return (
    <>
      <KV
        rows={[
          [
            'Status',
            <span className="inline" key="s">
              <StatusBadge status={s} />
              {m.since != null && (
                <span className="muted small" title={dateTime(m.since)}>
                  for {duration(now - m.since)}
                </span>
              )}
            </span>,
          ],
          ['Message', m.message && <span className={s === 'down' ? 'error-text' : undefined}>{m.message}</span>],
          [
            'Last check',
            m.last_check != null && (
              <span title={dateTimeSeconds(m.last_check)}>
                {ago(m.last_check, now)}
                {m.outcome && m.outcome !== s && (
                  <span className="muted">
                    {' '}
                    · result <StatusBadge status={m.outcome} small />
                  </span>
                )}
                {m.latency_ms != null && <span className="muted"> · {latency(m.latency_ms)}</span>}
              </span>
            ),
          ],
          ['Consecutive failures', m.consecutive_failures ? num(m.consecutive_failures) : null],
          [
            'Acknowledged',
            m.acknowledged && (
              <span>
                by {m.acknowledged.by} {ago(m.acknowledged.at, now)}
                {m.acknowledged.comment && <span className="muted"> · “{m.acknowledged.comment}”</span>}
                <span className="muted small"> (no reminders until it recovers)</span>
              </span>
            ),
          ],
          [
            'Silenced',
            isSilenced(m, now) && (
              <span className="warn-text">
                until {dateTime(m.silenced_until)}
                {m.silenced_by && ` by ${m.silenced_by}`}: no notification is sent
              </span>
            ),
          ],
          ['Flapping', m.flapping && <span className="warn-text">Yes: notifications are held back</span>],
          ['Maintenance', m.maintenance && <Chip icon="wrench">{m.maintenance}</Chip>],
          ['Enabled', !m.enabled && 'No: disabled in the configuration'],
          ['Paused', m.paused && 'Yes, from the API: not checked until resumed'],
          [
            'Certificate',
            expires !== null && (
              <span
                className={days !== null && days <= 7 ? 'error-text' : days !== null && days <= 30 ? 'warn-text' : ''}
              >
                expires {dateTime(expires)} ({days! < 0 ? `${-days!} days ago` : `in ${days} days`})
              </span>
            ),
          ],
          [
            'SLO',
            m.slo != null && (
              <span>
                {percent(m.slo)} uptime
                {used !== null && (
                  <span className={used >= 1 ? 'error-text' : used >= 0.75 ? 'warn-text' : 'muted'}>
                    {' '}
                    · last 30 days: {percent(month!.uptime)},{' '}
                    {used >= 1 ? 'the error budget is used up' : `${Math.round(used * 100)} % of the error budget used`}
                  </span>
                )}
              </span>
            ),
          ],
          ['Description', m.description],
          [
            'Type',
            <span key="t" className="mono">
              {m.type}
            </span>,
          ],
          [
            'Target',
            <span key="target" className="mono wrap">
              {m.target}
            </span>,
          ],
          ['Interval', interval(m.interval_seconds)],
          ['Group', m.group && <Chip icon="folder">{m.group}</Chip>],
          [
            'Tags',
            m.tags.length > 0 && (
              <span className="inline">
                {m.tags.map((t) => (
                  <Chip key={t} icon="tag">
                    {t}
                  </Chip>
                ))}
              </span>
            ),
          ],
          [
            'Depends on',
            m.depends_on.length > 0 && (
              <span className="inline">
                {m.depends_on.map((d) => {
                  const dep = byId.get(d);
                  return (
                    <span key={d} className="inline-item">
                      {dep && <StatusIcon status={statusOf(dep)} />}
                      <MonitorLink id={d} />
                    </span>
                  );
                })}
              </span>
            ),
          ],
          [
            'Notifies',
            m.notify.length ? (
              <span className="inline">
                {m.notify.map((n) => (
                  <Chip key={n} icon="bell">
                    {n}
                  </Chip>
                ))}
              </span>
            ) : (
              <span className="warn-text">Nobody: no notifier is configured for this monitor</span>
            ),
          ],
        ]}
      />
      {instance.canAct === false && instance.actionsReason && <p className="muted small">{instance.actionsReason}</p>}

      <h3>Uptime</h3>
      {uptime.error && <ErrorBanner>{uptime.error.message}</ErrorBanner>}
      <div className="uptime-tiles">
        {(uptime.data?.windows ?? []).map((w) => (
          <UptimeTile key={w.window} w={w} />
        ))}
        {!uptime.data && !uptime.error && <Spinner />}
      </div>

      <History m={m} />
    </>
  );
}

const WINDOW_LABEL: Record<UptimeWindow['window'], string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '365d': '1 year',
};

function UptimeTile({ w }: { w: UptimeWindow }) {
  return (
    <div className="card stat stat-small">
      <div className="label">{WINDOW_LABEL[w.window]}</div>
      <div className="value">{percent(w.uptime)}</div>
      <div className="foot">
        {w.checks ? (
          <>
            {plural(w.checks, 'check')}
            {w.down > 0 && <span className="error-text">, {num(w.down)} failed</span>}
            {w.avg_latency_ms != null && <>, avg {latency(w.avg_latency_ms)}</>}
          </>
        ) : (
          'no checks'
        )}
      </div>
    </div>
  );
}

function History({ m }: { m: Monitor }) {
  const [range, setRange] = useState<RangeId>('24h');
  const { me, api, changes } = useLive();
  const data = usePoll(
    async () => {
      const to = Date.now();
      // 24 h from raw results (15-minute slots); longer ranges from Pingwarden's rollups.
      if (range === '24h') {
        const r = await api.heartbeats(m.id, { from: to - DAY, to, limit: 10_000 });
        return slotsFromHeartbeats(r.heartbeats, 15 * 60_000, 96, to);
      }
      if (range === '365d') {
        const r = await api.rollups(m.id, 'day', { from: to - 365 * DAY, to });
        return slotsFromRollups(r.rollups, DAY, 365, to);
      }
      const days = range === '7d' ? 7 : 30;
      const slotHours = range === '7d' ? 1 : 4;
      const r = await api.rollups(m.id, 'hour', { from: to - days * DAY, to });
      return slotsFromRollups(r.rollups, slotHours * HOUR, (days * 24) / slotHours, to);
    },
    [m.id, range, changes],
    Math.max(60, me.refreshSeconds),
  );
  const what = { '24h': '15 minutes', '7d': 'hour', '30d': '4 hours', '365d': 'day' }[range];
  return (
    <>
      <div className="section-head">
        <h3>Latency and status</h3>
        <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
      </div>
      {data.error && <ErrorBanner>{data.error.message}</ErrorBanner>}
      <div className={data.loading ? 'dim' : undefined}>
        {data.data ? (
          <>
            <LatencyChart slots={data.data} what={`${m.name}: average latency per ${what}, with its range`} />
            {!data.data.some((s) => s.avg !== null) && (
              <p className="muted small">No successful check in this period, so there is no latency to show.</p>
            )}
            <p className="muted small">
              Average latency per {what} (line) with the fastest and slowest check (band); the strip shows the status of
              each {what}.
            </p>
            <SlotTable slots={data.data} />
          </>
        ) : (
          !data.error && <Spinner />
        )}
      </div>
    </>
  );
}

const PAGE = 200;

function Heartbeats({ id }: { id: string }) {
  const { api } = useLive();
  const [pages, setPages] = useState<Heartbeat[][]>([]);
  const first = useAsync(() => api.heartbeats(id, { limit: PAGE }), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => [...(first.data?.heartbeats ?? []), ...pages.flat()], [first.data, pages]);
  // Older results: before the oldest shown, as far back as Pingwarden keeps them.
  const more = async () => {
    const oldest = rows.at(-1);
    if (!oldest) return;
    setBusy(true);
    try {
      const r = await api.heartbeats(id, { from: 0, to: oldest.ts, limit: PAGE });
      setPages((p) => [...p, r.heartbeats]);
      if (!r.heartbeats.length) setError('No older results.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (first.error) return <ErrorBanner>{first.error.message}</ErrorBanner>;
  if (!first.data) return <Spinner />;
  if (!rows.length) return <Empty>No checks in the last 24 hours.</Empty>;
  const last = pages.at(-1);
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th className="num">Latency</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h, i) => (
              <tr key={`${h.ts}-${i}`}>
                <td className="nowrap">{dateTimeSeconds(h.ts)}</td>
                <td>
                  <StatusBadge status={h.status} small />
                </td>
                <td className="num">{latency(h.latency_ms)}</td>
                <td className="small wrap">{h.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        {error ? (
          <span className="muted small">{error}</span>
        ) : (
          (last === undefined ? first.data.heartbeats.length === PAGE : last.length === PAGE) && (
            <button type="button" className="btn" onClick={() => void more()} disabled={busy}>
              {busy ? <span className="spin" /> : null} Older checks
            </button>
          )
        )}
      </div>
    </>
  );
}

function MonitorEvents({ m }: { m: Monitor }) {
  const { api, changes } = useLive();
  const events = useAsync(() => {
    const to = Date.now();
    return api.monitorEvents(m.id, { from: to - 90 * DAY, to, limit: 1000 });
  }, [m.id, changes]);
  if (events.error) return <ErrorBanner>{events.error.message}</ErrorBanner>;
  if (!events.data) return <Spinner />;
  if (!events.data.events.length) return <Empty>No status change in the last 90 days.</Empty>;
  return (
    <>
      <p className="muted small">Status changes of the last 90 days.</p>
      <EventTable events={events.data.events} showMonitor={false} />
    </>
  );
}

function MonitorNotifications({ id }: { id: string }) {
  const { api, changes } = useLive();
  // Filtered by Pingwarden; also here, for an older Pingwarden that ignores `monitor`.
  const log = useAsync(() => {
    const to = Date.now();
    return api.notifications({ from: to - 30 * DAY, to, limit: 10_000, monitor: id });
  }, [id, changes]);
  if (log.error) return <ErrorBanner>{log.error.message}</ErrorBanner>;
  if (!log.data) return <Spinner />;
  const rows = log.data.notifications.filter((n) => n.monitor_id === id);
  if (!rows.length) return <Empty>No notification about this monitor in the last 30 days.</Empty>;
  return (
    <>
      <p className="muted small">Deliveries of the last 30 days, retries included.</p>
      <DeliveryTable rows={rows} showMonitor={false} />
    </>
  );
}

/** A configuration value for display: durations, lists and flags in words. */
function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && key.endsWith('_seconds')) return v ? duration(v * 1000) : '0 (never)';
  if (typeof v === 'number' && key.endsWith('_ms')) return latency(v);
  if (Array.isArray(v))
    return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '–';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const label = (key: string) => {
  const k = key.replace(/_(seconds|ms)$/, '').replaceAll('_', ' ');
  return k[0]!.toUpperCase() + k.slice(1);
};

function MonitorConfiguration({ id }: { id: string }) {
  const { api, changes } = useLive();
  const cfg = useAsync(() => api.monitorConfig(id), [id, changes]);
  if (cfg.error) {
    return unsupported(cfg.error) ? (
      <InfoBanner>This Pingwarden does not show monitor configurations: that needs a newer version.</InfoBanner>
    ) : (
      <ErrorBanner>{cfg.error.message}</ErrorBanner>
    );
  }
  if (!cfg.data) return <Spinner />;
  const { settings, check } = cfg.data;
  const flapping = settings.flapping;
  return (
    <>
      <p className="muted small">
        The effective settings, after group and global defaults, as Pingwarden runs them. Secrets are never shown.
      </p>
      <h3>Alerting</h3>
      <KV
        rows={[
          ['Enabled', show('enabled', settings.enabled)],
          ['Interval', interval(settings.interval_seconds)],
          ['Timeout', duration(settings.timeout_seconds * 1000)],
          ['Down after', plural(settings.failure_threshold, 'failed check')],
          ['Up again after', plural(settings.recovery_threshold, 'successful check')],
          ['Reminders', settings.renotify_every_seconds ? interval(settings.renotify_every_seconds) : 'none'],
          ['Notify degraded', show('notify_degraded', settings.notify_degraded)],
          [
            'Flap detection',
            flapping
              ? `more than ${flapping.max_transitions} changes in ${duration(flapping.window_seconds * 1000)}`
              : 'off',
          ],
          ['Degraded above', settings.degraded_latency_ms != null ? latency(settings.degraded_latency_ms) : null],
          ['SLO', settings.slo != null ? percent(settings.slo) : null],
          ['Notifies', show('notify', settings.notify)],
          ['Depends on', show('depends_on', settings.depends_on)],
          ['Group', settings.group],
          ['Tags', show('tags', settings.tags)],
        ]}
      />
      <h3>Check ({check.type})</h3>
      <KV
        rows={Object.entries(check)
          .filter(([k]) => k !== 'type')
          .map(([k, v]) => [
            label(k),
            <span key={k} className="mono wrap">
              {show(k, v)}
            </span>,
          ])}
      />
    </>
  );
}
