import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Me } from '../shared/types.ts';
import { api } from './api.ts';
import { Icon } from './components/icons.tsx';
import { ErrorBanner, Spinner, ToastProvider } from './components/ui.tsx';
import { LiveContext, type Live } from './context.ts';
import { ago } from './format.ts';
import { useNow, usePoll } from './hooks.ts';
import logo from './logo.svg';
import { href, useRoute, type View } from './route.ts';
import { statusOf } from './status.ts';
import { BoardView } from './views/Board.tsx';
import { EventsView } from './views/Events.tsx';
import { MaintenanceView } from './views/Maintenance.tsx';
import { MonitorDrawer } from './views/MonitorDrawer.tsx';
import { MonitorsView } from './views/Monitors.tsx';
import { NotificationsView } from './views/Notifications.tsx';
import { SystemView } from './views/System.tsx';

const NAV: { view: View; label: string }[] = [
  { view: 'monitors', label: 'Monitors' },
  { view: 'events', label: 'Events' },
  { view: 'notifications', label: 'Notifications' },
  { view: 'maintenance', label: 'Maintenance' },
  { view: 'system', label: 'System' },
];

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

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const me = usePoll(() => api.me(), [], null);
  if (me.data) return <Dashboard me={me.data} reloadMe={me.reload} />;
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

function Dashboard({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const { params, view, update, go } = useRoute();
  const monitors = usePoll(() => api.monitors(), [], me.refreshSeconds);
  const [navOpen, setNavOpen] = useState(false);
  const now = useNow(5);

  const list = useMemo(() => monitors.data ?? [], [monitors.data]);
  const reloadMonitors = monitors.reload;
  const live = useMemo<Live>(
    () => ({
      me,
      monitors: list,
      byId: new Map(list.map((m) => [m.id, m])),
      refresh: () => {
        reloadMonitors();
        reloadMe();
      },
      openMonitor: (id: string) => update({ m: id }),
      showMonitors: (filters: Record<string, string>) => go('monitors', filters),
    }),
    [me, list, reloadMonitors, reloadMe, update, go],
  );

  // The tab title counts problems, so a background tab shows them too.
  const down = list.filter((m) => statusOf(m) === 'down').length;
  useEffect(() => {
    const label = NAV.find((n) => n.view === view)?.label ?? 'Board';
    document.title = `${down ? `(${down} down) ` : ''}${label} · Pingwarden`;
  }, [down, view]);

  const closeDrawer = useCallback(() => update({ m: '' }), [update]);
  const stale =
    monitors.error && monitors.updatedAt !== null
      ? `Showing data from ${ago(monitors.updatedAt, now)}: ${monitors.error.message}`
      : null;

  if (view === 'board') {
    return (
      <LiveContext.Provider value={live}>
        <BoardView onExit={() => go('monitors')} error={monitors.error?.message ?? null} />
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
            href="/"
            className="brand"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              go('monitors');
            }}
          >
            <img src={logo} alt="" width="28" height="28" />
            <span className="brand-name">Pingwarden</span>
          </a>
          <nav className={`nav${navOpen ? ' open' : ''}`} aria-label="Views">
            {NAV.map((n) => (
              <a
                key={n.view}
                href={href(n.view === 'monitors' ? {} : { view: n.view })}
                className="nav-item"
                aria-current={view === n.view ? 'page' : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
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
            <span className="muted small updated" title="Live data refreshes automatically">
              {monitors.error ? (
                <span className="error-text">
                  <Icon name="alert" size={12} /> not updating
                </span>
              ) : monitors.updatedAt ? (
                `updated ${ago(monitors.updatedAt, now)}`
              ) : null}
            </span>
            <a
              className="btn btn-icon"
              href={href({ view: 'board' })}
              title="Board: every monitor as a tile, for a wall display"
              aria-label="Board"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
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
            <ErrorBanner>Pingwarden could not be read: {monitors.error.message}</ErrorBanner>
          )}
          {!monitors.data && !monitors.error ? (
            <Spinner label="Loading monitors…" />
          ) : view === 'events' ? (
            <EventsView params={params} update={update} />
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
