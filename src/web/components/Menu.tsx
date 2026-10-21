import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A drop-down on <details>: opens with its summary, closes on a click outside, on Escape, and
 * (with `closeOnClick`) once something inside it is clicked.
 */
export function Menu({
  summary,
  summaryClass = 'btn',
  label,
  title,
  closeOnClick = false,
  children,
}: {
  summary: ReactNode;
  summaryClass?: string;
  label?: string;
  title?: string;
  closeOnClick?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className={summaryClass} aria-label={label} title={title}>
        {summary}
      </summary>
      <div
        className="menu-body"
        onClick={
          closeOnClick
            ? (e) => {
                if ((e.target as HTMLElement).closest('button') && ref.current) ref.current.open = false;
              }
            : undefined
        }
      >
        {children}
      </div>
    </details>
  );
}
