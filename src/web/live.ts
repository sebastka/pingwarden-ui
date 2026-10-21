// Live updates and per-browser settings: Pingwarden's event stream, saved views, pinned
// monitors and alert preferences.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Monitor, StreamEvent } from '../shared/pingwarden.ts';
import { newlyDown, statusOf } from './logic.ts';

/** Events after which the monitor list (and views showing more) should reload. */
const RELOAD_ON: StreamEvent[] = ['transition', 'monitor', 'maintenance', 'reload', 'resync', 'notification'];

/**
 * Follows Pingwarden's live stream through the dashboard. `onChange` runs (debounced) after
 * events that change what the UI shows. Returns whether the stream is connected; when it is not
 * (an older Pingwarden, or too many streams), the caller keeps polling, and the stream is tried
 * again after a minute.
 */
export function useStream(url: string, onChange: (kind: StreamEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let pending: StreamEvent | null = null;
    let stopped = false;

    const open = () => {
      source = new EventSource(url);
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        // EventSource reconnects by itself after a dropped stream; it gives up (CLOSED) on an
        // HTTP error such as 404 (no stream in this Pingwarden) or 503.
        if (source?.readyState === EventSource.CLOSED) {
          setConnected(false);
          if (!stopped) retry = setTimeout(open, 60_000);
        }
      };
      for (const kind of RELOAD_ON) {
        source.addEventListener(kind, () => {
          pending = kind;
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            if (pending) callback.current(pending);
            pending = null;
          }, 300);
        });
      }
    };
    // A page kept in the back/forward cache would keep its stream (and one of the browser's six
    // connections per host) open: close it when the page is hidden that way, reopen on return.
    const onHide = () => {
      clearTimeout(retry);
      source?.close();
      source = null;
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !source && !stopped) {
        // Changes may have been missed while away.
        callback.current('resync');
        open();
      }
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(debounce);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      source?.close();
    };
  }, [url]);
  return connected;
}

/** A value kept in this browser's localStorage (when available), as JSON. */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // storage unavailable: the setting lasts for this page only
      }
    },
    [key],
  );
  return [value, set];
}

/** A short two-tone alarm, made with WebAudio (no sound file to load). */
function beep(): void {
  try {
    const ctx = new AudioContext();
    const tone = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.32);
    };
    tone(880, 0);
    tone(660, 0.35);
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    // no audio
  }
}

export interface AlertSettings {
  notify: boolean;
  sound: boolean;
}

/**
 * Desktop notifications and a sound when a monitor goes down, while this page is open. Off by
 * default; the browser asks for permission when notifications are switched on.
 */
export function useAlerts(monitors: Monitor[], instanceName: string) {
  const [settings, setSettings] = useStored<AlertSettings>('alerts', { notify: false, sound: false });
  const previous = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(monitors.map((m) => [m.id, statusOf(m)]));
    if (!before || (!settings.notify && !settings.sound)) return;
    const down = newlyDown(before, monitors);
    if (!down.length) return;
    if (settings.sound) beep();
    if (settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const m of down.slice(0, 5)) {
        new Notification(`${m.name} is down`, {
          body: `${m.message ?? ''}\n${instanceName}`.trim(),
          tag: `pingwarden-${m.id}`,
        });
      }
    }
  }, [monitors, settings, instanceName]);

  const update = useCallback(
    async (next: AlertSettings) => {
      if (next.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (next.sound && !settings.sound) beep(); // lets the user hear it, and unlocks audio
      setSettings(next);
    },
    [setSettings, settings.sound],
  );
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  return { settings, update, permission };
}
