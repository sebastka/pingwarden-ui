import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Status } from '../../shared/pingwarden.ts';
import { useLive } from '../context.ts';
import { STATUS_META } from '../status.ts';
import { ToastContext, type ToastLevel, useToast } from '../toast.ts';
import { Icon, type IconName } from './icons.tsx';

/** Icon + label in the status colour: status is never shown by colour alone. */
export function StatusBadge({ status, small }: { status: Status; small?: boolean }) {
  const m = STATUS_META[status];
  return (
    <span className={`status status-${m.tone}${small ? ' status-small' : ''}`} title={m.help}>
      <Icon name={m.icon} size={small ? 12 : 14} />
      {m.label}
    </span>
  );
}

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const m = STATUS_META[status];
  return (
    <span className={`status-icon tone-${m.tone}`} title={m.label} role="img" aria-label={m.label}>
      <Icon name={m.icon} size={size} />
    </span>
  );
}

/**
 * A runtime action (run now, pause, test…). Shown disabled, with the reason, when the dashboard
 * is read-only or Pingwarden refused an action; otherwise Pingwarden decides.
 */
export function ActionButton({
  icon,
  label,
  run,
  done,
  primary,
  small,
}: {
  icon: IconName;
  label: string;
  run: () => Promise<unknown>;
  /** Toast text on success. */
  done: string;
  primary?: boolean;
  small?: boolean;
}) {
  const { me, refresh } = useLive();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const denied = me.canAct === false;
  const tip = denied ? (me.actionsReason ?? 'Not allowed') : undefined;
  const onClick = async () => {
    setBusy(true);
    try {
      await run();
      toast(done);
      refresh();
    } catch (e) {
      toast(`${label} failed: ${(e as Error).message}`, 'error');
      // A refusal teaches the server that this user may not act: show it at once.
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="cap-wrap" title={tip}>
      <button
        type="button"
        className={`btn${primary ? ' btn-primary' : ''}${small ? ' btn-small' : ''}`}
        onClick={() => void onClick()}
        disabled={denied || busy}
      >
        {busy ? <span className="spin" /> : <Icon name={icon} size={small ? 14 : 16} />}
        <span>{label}</span>
        {denied && <Icon name="lock" size={12} className="lock" />}
      </button>
      {denied && <span className="visually-hidden">{tip}</span>}
    </span>
  );
}

/** A side panel over the page; Escape or a click on the backdrop closes it. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="drawer-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="muted small wrap">{subtitle}</div>}
          </div>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close" autoFocus>
            <Icon name="x" />
          </button>
        </div>
        {actions && <div className="drawer-actions">{actions}</div>}
        {children}
      </aside>
    </>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner banner-error" role="alert">
      <Icon name="alert" />
      <div>{children}</div>
    </div>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner">
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number | null }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className="tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A small set of mutually exclusive options. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Definition list of label → value; empty values are left out. */
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Chip({ children, icon, onClick }: { children: ReactNode; icon?: IconName; onClick?: () => void }) {
  const body = (
    <>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className="chip chip-button" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="chip">{body}</span>
  );
}

/** A link-styled button that opens a monitor's details. */
export function MonitorLink({ id, name }: { id: string; name?: string }) {
  const { openMonitor, byId } = useLive();
  const m = byId.get(id);
  return (
    <button type="button" className="btn-link" onClick={() => openMonitor(id)} title={id}>
      {name ?? m?.name ?? id}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spin" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// --- Toasts -------------------------------------------------------------------------------

interface Toast {
  id: number;
  level: ToastLevel;
  text: ReactNode;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: ReactNode, level: ToastLevel = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 10_000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`}>
            <Icon name={t.level === 'error' ? 'alert' : t.level === 'ok' ? 'check' : 'info'} />
            <div className="grow">{t.text}</div>
            <button
              type="button"
              className="btn-link"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
