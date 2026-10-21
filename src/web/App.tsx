import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { InstanceInfo, Me } from '../shared/types.ts';
import { instanceApi, me as loadMe } from './api.ts';
import { AlertMenu } from './components/AlertMenu.tsx';
import { Icon } from './components/icons.tsx';
import { ErrorBanner, Spinner, ToastProvider } from './components/ui.tsx';
import { LiveContext, type Live } from './context.ts';
import { ago } from './format.ts';
import { useNow, usePoll } from './hooks.ts';
import { useAlerts, useStream } from './live.ts';
import logo from './logo.svg';
import { href, type Params, useRoute, type View } from './route.ts';
import { statusOf } from './status.ts';
import { AllBoards, BoardView } from './views/Board.tsx';
import { CertificatesView } from './views/Certificates.tsx';
import { DependenciesView } from './views/Dependencies.tsx';
import { EventsView } from './views/Events.tsx';
import { MaintenanceView } from './views/Maintenance.tsx';
import { MonitorDrawer } from './views/MonitorDrawer.tsx';
import { MonitorsView } from './views/Monitors.tsx';
import { NotificationsView } from './views/Notifications.tsx';
import { ReliabilityView } from './views/Reliability.tsx';
import { SystemView } from './views/System.tsx';

const NAV: { view: View; label: string }[] = [
  { view: 'monitors', label: 'Monitors' },
  { view: 'events', label: 'Events' },
  { view: 'reliability', label: 'Reliability' },
  { view: 'certificates', label: 'Certificates' },
  { view: 'dependencies', label: 'Dependencies' },
  { view: 'notifications', label: 'Notifications' },
  { view: 'maintenance', label: 'Maintenance' },
  { view: 'system', label: 'System' },
];

/** A plain click on an in-app link: handled by the router, not the browser. */
const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.getAttribute('data-theme') ?? 'auto');
  const set = (t: string) => {
    setTheme(t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      // storage unavailable
    }
  };
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {['auto', 'light', 'dark'].map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => set(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

/** Picks the Pingwarden instance; shows how many monitors are down on each. */
function InstanceSwitcher({ me, current, onChange }: { me: Me; current: string; onChange: (id: string) => void }) {
  const counts = usePoll(
    () =>
      Promise.all(
        me.instances.map((i) =>
          instanceApi(i.id)
            .status()
            .then(
              (s) => s.monitors.down ?? 0,
              () => null,
            ),
        ),
      ),
    [],
    60,
  );
  return (
    <select
      className="instance-switch"
      value={current}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Pingwarden instance"
    >
      {me.instances.map((i, n) => {
        const down = counts.data?.[n];
        return (
          <option key={i.id} value={i.id}>
            {i.name}
            {down === null ? ' (unreachable)' : down ? ` (${down} down)` : ''}
          </option>
        );
      })}
    </select>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const me = usePoll(() => loadMe(), [], null);
  const { params, view, update, go } = useRoute();
  if (!me.data) {
    return (
      <main className="boot">
        {me.error ? (
          <ErrorBanner>The dashboard could not start: {me.error.message}</ErrorBanner>
        ) : (
          <Spinner label="Loading…" />
        )}
      </main>
    );
  }
  if (view === 'board' && params.i === 'all' && me.data.instances.length > 1) {
    return <AllBoards me={me.data} onExit={() => go('monitors', { i: '' })} />;
  }
  const instance = me.data.instances.find((i) => i.id === params.i) ?? me.data.instances[0]!;
  return (
    <Dashboard
      key={instance.id}
      me={me.data}
      instance={instance}
      reloadMe={me.reload}
      params={params}
      view={view}
      update={update}
      go={go}
    />
  );
}

function Dashboard({
  me,
  instance,
  reloadMe,
  params,
  view,
  update,
  go,
}: {
  me: Me;
  instance: InstanceInfo;
  reloadMe: () => void;
  params: Params;
  view: View;
  update: (p: Params, replace?: boolean) => void;
  go: (view: View, p?: Params) => void;
}) {
  const api = useMemo(() => instanceApi(instance.id), [instance.id]);
  const [changes, setChanges] = useState(0);
  const reloadMonitors = useRef<() => void>(() => {});
  const onStream = useCallback(() => {
    reloadMonitors.current();
    setChanges((n) => n + 1);
  }, []);
  const connected = useStream(api.streamUrl, onStream);
  // With the live stream, polling is only a safety net.
  const monitors = usePoll(() => api.monitors(), [], connected ? 120 : me.refreshSeconds);
  useEffect(() => {
    reloadMonitors.current = monitors.reload;
  }, [monitors.reload]);
  const [navOpen, setNavOpen] = useState(false);
  const now = useNow(5);

  const list = useMemo(() => monitors.data ?? [], [monitors.data]);
  const alerts = useAlerts(list, instance.name);
  const multi = me.instances.length > 1;
  const reload = monitors.reload;
  const live = useMemo<Live>(
    () => ({
      me,
      instance,
      api,
      monitors: list,
      byId: new Map(list.map((m) => [m.id, m])),
      streaming: connected,
      changes,
      refresh: () => {
        reload();
        reloadMe();
        setChanges((n) => n + 1);
      },
      openMonitor: (id: string) => update({ m: id }),
      showMonitors: (filters: Record<string, string>) => go('monitors', filters),
    }),
    [me, instance, api, list, connected, changes, reload, reloadMe, update, go],
  );

  // The tab title counts problems, so a background tab shows them too.
  const down = list.filter((m) => statusOf(m) === 'down').length;
  useEffect(() => {
    const label = NAV.find((n) => n.view === view)?.label ?? 'Board';
    document.title = `${down ? `(${down} down) ` : ''}${label} · ${multi ? instance.name : 'Pingwarden'}`;
  }, [down, view, multi, instance.name]);

  const closeDrawer = useCallback(() => update({ m: '' }), [update]);
  const stale =
    monitors.error && monitors.updatedAt !== null
      ? `Showing data from ${ago(monitors.updatedAt, now)}: ${monitors.error.message}`
      : null;
  const viewHref = (v: View) =>
    href({ ...(params.i ? { i: params.i } : {}), ...(v === 'monitors' ? {} : { view: v }) });

  if (view === 'board') {
    return (
      <LiveContext.Provider value={live}>
        <BoardView
          onExit={() => go('monitors')}
          onAll={multi ? () => update({ i: 'all' }) : null}
          error={monitors.error?.message ?? null}
          alerts={<AlertMenu {...alerts} />}
        />
        {params.m && <MonitorDrawer id={params.m} onClose={closeDrawer} />}
      </LiveContext.Provider>
    );
  }

  return (
    <LiveContext.Provider value={live}>
      <div className="app">
        <header className="header">
          <button
            type="button"
            className="btn btn-icon nav-toggle"
            aria-label="Show navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            <Icon name="list" />
          </button>
          <a
            href={viewHref('monitors')}
            className="brand"
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              go('monitors');
            }}
          >
            <img src={logo} alt="" width="28" height="28" />
            <span className="brand-name">Pingwarden</span>
          </a>
          {multi && <InstanceSwitcher me={me} current={instance.id} onChange={(id) => go(view, { i: id })} />}
          <nav className={`nav${navOpen ? ' open' : ''}`} aria-label="Views">
            {NAV.map((n) => (
              <a
                key={n.view}
                href={viewHref(n.view)}
                className="nav-item"
                aria-current={view === n.view ? 'page' : undefined}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  e.preventDefault();
                  setNavOpen(false);
                  go(n.view);
                }}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <span
              className="muted small updated"
              title={connected ? 'Live: Pingwarden pushes changes' : 'Refreshes automatically'}
            >
              {monitors.error ? (
                <span className="error-text">
                  <Icon name="alert" size={12} /> not updating
                </span>
              ) : connected ? (
                <span className="live-dot">live</span>
              ) : monitors.updatedAt ? (
                `updated ${ago(monitors.updatedAt, now)}`
              ) : null}
            </span>
            <AlertMenu {...alerts} />
            <a
              className="btn btn-icon"
              href={href({ ...(params.i ? { i: params.i } : {}), view: 'board' })}
              title="Board: every monitor as a tile, for a wall display"
              aria-label="Board"
              onClick={(e) => {
                if (!plainClick(e)) return;
                e.preventDefault();
                go('board');
              }}
            >
              <Icon name="grid" />
            </a>
            <ThemeToggle />
            {me.user && (
              <form method="post" action="/auth/logout" className="user">
                <span className="muted small ellipsis" title={me.user.sub}>
                  {me.user.name}
                </span>
                <button type="submit" className="btn btn-icon" title="Sign out" aria-label="Sign out">
                  <Icon name="logout" />
                </button>
              </form>
            )}
          </div>
        </header>
        <main className="main">
          {stale && <ErrorBanner>{stale}</ErrorBanner>}
          {!monitors.data && monitors.error && (
            <ErrorBanner>
              {instance.name} could not be read: {monitors.error.message}
            </ErrorBanner>
          )}
          {!monitors.data && !monitors.error ? (
            <Spinner label="Loading monitors…" />
          ) : view === 'events' ? (
            <EventsView params={params} update={update} />
          ) : view === 'reliability' ? (
            <ReliabilityView params={params} update={update} />
          ) : view === 'certificates' ? (
            <CertificatesView />
          ) : view === 'dependencies' ? (
            <DependenciesView />
          ) : view === 'notifications' ? (
            <NotificationsView params={params} update={update} />
          ) : view === 'maintenance' ? (
            <MaintenanceView />
          ) : view === 'system' ? (
            <SystemView />
          ) : (
            <MonitorsView params={params} update={update} />
          )}
        </main>
      </div>
      {params.m && <MonitorDrawer id={params.m} onClose={closeDrawer} />}
    </LiveContext.Provider>
  );
}
