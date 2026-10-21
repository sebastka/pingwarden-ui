import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data whenever deps change. The previous value is kept while reloading, so lists can dim
 * instead of flashing empty; `loading` is derived rather than set inside the effect.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: Error | null } {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: Error | null }>({
    key: null,
    data: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    fn().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (e: Error) => !cancelled && setState((s) => ({ ...s, key, error: e })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data: state.data, loading: state.key !== key, error: state.key === key ? state.error : null };
}

/**
 * useAsync that also reloads every `seconds` while the page is visible, and at once when it
 * becomes visible again (a wall display waking up, a tab brought back). On a failed reload the
 * last data stays, with the error beside it.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  seconds: number | null,
): { data: T | null; loading: boolean; error: Error | null; reload: () => void; updatedAt: number | null } {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: Error | null; at: number | null }>({
    key: null,
    data: null,
    error: null,
    at: null,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    fn().then(
      (data) => !cancelled && setState({ key, data, error: null, at: Date.now() }),
      (e: Error) => !cancelled && setState((s) => ({ ...s, key, error: e })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  useEffect(() => {
    if (!seconds) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, seconds * 1000);
    const onVisible = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [seconds, reload]);
  // Refreshes of the same key happen in the background: only a new key counts as loading.
  return {
    data: state.data,
    loading: state.key !== key,
    error: state.key === key ? state.error : null,
    reload,
    updatedAt: state.at,
  };
}

/** The element's width, kept current (charts draw to it). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setWidth(el.clientWidth);
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.current.observe(el);
  }, []);
  return [ref, width];
}

/** The current time, updated every `seconds` ("3 min ago" labels). */
export function useNow(seconds = 30): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), seconds * 1000);
    return () => clearInterval(t);
  }, [seconds]);
  return now;
}
