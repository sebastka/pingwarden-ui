// Where we are, kept in the query string so that reload, back and shared links work.
import { useCallback, useEffect, useState } from 'react';

export const VIEWS = ['monitors', 'events', 'notifications', 'maintenance', 'system', 'board'] as const;
export type View = (typeof VIEWS)[number];

export type Params = Record<string, string>;

const read = (): Params => Object.fromEntries(new URLSearchParams(location.search));

export function href(p: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

export function useRoute() {
  const [params, setParams] = useState(read);
  useEffect(() => {
    const onPop = () => setParams(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  /** Changes some parameters (empty string removes one); `replace` for filter typing. */
  const update = useCallback((patch: Params, replace = false) => {
    const next = Object.fromEntries(Object.entries({ ...read(), ...patch }).filter(([, v]) => v));
    if (replace) history.replaceState(null, '', href(next));
    else history.pushState(null, '', href(next));
    setParams(next);
  }, []);
  /** Opens a view with only the given parameters. */
  const go = useCallback((view: View, p: Params = {}) => {
    const next = { ...(view === 'monitors' ? {} : { view }), ...p };
    history.pushState(null, '', href(next));
    setParams(next);
  }, []);
  const view: View = (VIEWS as readonly string[]).includes(params.view ?? '') ? (params.view as View) : 'monitors';
  return { params, view, update, go };
}
