import { useMemo } from 'react';
import { EVENT_KINDS, type Notification, type Notifier, type NotifierType } from '../../shared/pingwarden.ts';
import { api } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import {
  ActionButton,
  Chip,
  Empty,
  ErrorBanner,
  InfoBanner,
  MonitorLink,
  Segmented,
  Spinner,
} from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { ago, dateTimeSeconds, percent, plural } from '../format.ts';
import { useAsync, useNow, usePoll } from '../hooks.ts';
import type { Params } from '../route.ts';
import { type Health, health, RANGES, rangeOf } from '../logic.ts';

const TYPE_LABEL: Record<NotifierType, string> = {
  webhook: 'Webhook',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  matrix: 'Matrix',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  pushover: 'Pushover',
  email: 'E-mail',
};

const LIMIT = 10_000;

export function NotificationsView({
  params,
  update,
}: {
  params: Params;
  update: (p: Params, replace?: boolean) => void;
}) {
  const { monitors, me } = useLive();
  const now = useNow(30);
  const range = rangeOf(params.range, '7d');
  const notifiers = useAsync(() => api.notifiers(), []);
  const log = usePoll(
    () => {
      const to = Date.now();
      return api.notifications({ from: to - range.ms, to, limit: LIMIT });
    },
    [range.id],
    me.refreshSeconds * 2,
  );
  const rows = useMemo(() => log.data?.notifications ?? [], [log.data]);
  const byNotifier = useMemo(() => health(rows), [rows]);

  const notifier = params.notifier ?? '';
  const result = params.result ?? '';
  const kind = params.kind ?? '';
  const shown = rows.filter(
    (n) =>
      (!notifier || n.notifier === notifier) &&
      (!result || (result === 'failed' ? !n.success : n.success)) &&
      (!kind || n.event === kind),
  );

  const known = new Set((notifiers.data ?? []).map((n) => n.id));
  const silent = monitors.filter((m) => m.enabled && !m.notify.length);
  const users = (id: string) => monitors.filter((m) => m.notify.includes(id));

  return (
    <>
      <div className="page-head">
        <h1>Notifications</h1>
        <Segmented
          label="Period"
          value={range.id}
          onChange={(v) => update({ range: v === '7d' ? '' : v })}
          options={RANGES.map((r) => ({ id: r.id, label: r.label }))}
        />
      </div>
      {notifiers.error && <ErrorBanner>{notifiers.error.message}</ErrorBanner>}
      {silent.length > 0 && (
        <InfoBanner>
          <strong>{plural(silent.length, 'monitor')} notify nobody</strong> when they go down:{' '}
          {silent.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <MonitorLink id={m.id} />
            </span>
          ))}
          . Give them <span className="mono">notify</span> (or a group or global default) in the configuration.
        </InfoBanner>
      )}

      <div className="cards notifier-cards">
        {(notifiers.data ?? []).map((n) => (
          <NotifierCard
            key={n.id}
            n={n}
            h={byNotifier.get(n.id)}
            users={users(n.id).length}
            now={now}
            active={notifier === n.id}
            onSelect={() => update({ notifier: notifier === n.id ? '' : n.id })}
          />
        ))}
        {notifiers.data && !notifiers.data.length && <Empty>No notifier is configured.</Empty>}
        {!notifiers.data && !notifiers.error && <Spinner />}
      </div>

      <div className="section-head">
        <h2>Delivery log</h2>
        <div className="toolbar-filters">
          <select value={notifier} onChange={(e) => update({ notifier: e.target.value })} aria-label="Notifier">
            <option value="">Every notifier</option>
            {[...new Set([...known, ...byNotifier.keys()])].sort().map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => update({ kind: e.target.value })} aria-label="Event">
            <option value="">Every event</option>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <Segmented
            label="Result"
            value={result || 'all'}
            onChange={(v) => update({ result: v === 'all' ? '' : v })}
            options={[
              { id: 'all', label: 'All' },
              { id: 'failed', label: 'Failed' },
              { id: 'ok', label: 'Delivered' },
            ]}
          />
        </div>
      </div>
      {log.error && <ErrorBanner>{log.error.message}</ErrorBanner>}
      {rows.length >= LIMIT && (
        <ErrorBanner>Only the latest {plural(LIMIT, 'delivery')} are shown; choose a shorter period.</ErrorBanner>
      )}
      {!log.data && !log.error ? (
        <Spinner />
      ) : shown.length ? (
        <DeliveryTable rows={shown} />
      ) : (
        log.data && <Empty>No delivery in this period{notifier || result || kind ? ' matches' : ''}.</Empty>
      )}
    </>
  );
}

function NotifierCard({
  n,
  h,
  users,
  now,
  active,
  onSelect,
}: {
  n: Notifier;
  h: Health | undefined;
  users: number;
  now: number;
  active: boolean;
  onSelect: () => void;
}) {
  const total = h ? h.ok + h.failed : 0;
  const failing = h?.last && !h.last.success;
  return (
    <div className={`card notifier${active ? ' active' : ''}`}>
      <div className="notifier-head">
        <span className={`status-icon tone-${failing ? 'critical' : total ? 'good' : 'neutral'}`}>
          <Icon name={failing ? 'alert' : total ? 'check' : 'bell'} />
        </span>
        <div className="grow min0">
          <div className="card-title ellipsis">{n.id}</div>
          <div className="muted small">{TYPE_LABEL[n.type] ?? n.type}</div>
        </div>
        <ActionButton
          small
          icon="send"
          label="Test"
          run={() => api.testNotifier(n.id)}
          done={`Test notification sent through ${n.id}`}
        />
      </div>
      <div className="notifier-body small">
        <div>
          {n.events?.length ? (
            <span className="inline">
              Sends{' '}
              {n.events.map((e) => (
                <Chip key={e}>{e}</Chip>
              ))}
            </span>
          ) : (
            'Sends every event'
          )}
        </div>
        <div className={users ? undefined : 'warn-text'}>
          {users ? `Used by ${plural(users, 'monitor')}` : 'Used by no monitor'}
        </div>
        <div>
          {total ? (
            <>
              {plural(total, 'delivery', 'deliveries')}, {percent((h!.ok / total) * 100)} delivered
              {h!.failed > 0 && <span className="error-text"> · {h!.failed} failed</span>}
            </>
          ) : (
            <span className="muted">No delivery in this period</span>
          )}
        </div>
        {h?.last && (
          <div className="muted" title={dateTimeSeconds(h.last.ts)}>
            Last: {h.last.success ? 'delivered' : 'failed'} {ago(h.last.ts, now)}
          </div>
        )}
        {h?.lastError?.error && (
          <div className="error-text wrap" title={dateTimeSeconds(h.lastError.ts)}>
            {h.lastError.error}
          </div>
        )}
      </div>
      <button type="button" className="btn-link small" onClick={onSelect}>
        {active ? 'Show every notifier' : 'Show its deliveries'}
      </button>
    </div>
  );
}

export function DeliveryTable({ rows, showMonitor = true }: { rows: Notification[]; showMonitor?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Notifier</th>
            <th>Event</th>
            {showMonitor && <th>Monitor</th>}
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id}>
              <td className="nowrap">{dateTimeSeconds(n.ts)}</td>
              <td className="mono small">{n.notifier}</td>
              <td>
                <Chip>{n.event}</Chip>
              </td>
              {showMonitor && (
                <td>{n.monitor_id ? <MonitorLink id={n.monitor_id} /> : <span className="muted">–</span>}</td>
              )}
              <td className="small wrap">
                {n.success ? (
                  <span className="ok">
                    <Icon name="check" size={12} className="inline-icon" /> Delivered
                  </span>
                ) : (
                  <span className="error-text">
                    <Icon name="alert" size={12} className="inline-icon" /> Failed{n.error ? `: ${n.error}` : ''}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
