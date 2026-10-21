// Hand-drawn charts: a compact status history bar (monitor list, board) and a latency chart
// with a status strip (monitor details). One series each, so no legend box: the heading names
// it; status colours come with labels in the tooltip, and every chart has a table view.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { dateTime, latency, num, percent, shortDay, shortTime } from '../format.ts';
import { useWidth } from '../hooks.ts';
import { SLOT_META, type Slot, slotState, slotUptime } from '../status.ts';

function SlotDetails({ s }: { s: Slot }) {
  const state = slotState(s);
  const up = slotUptime(s);
  return (
    <>
      <div className="tt-title">
        {dateTime(s.start)} – {shortTime(s.end)}
      </div>
      <div className="tt-row">
        <span className="tt-key">
          <i className={`tone-bg-${SLOT_META[state].tone}`} />
          {SLOT_META[state].label}
        </span>
        <b>{up === null ? '' : percent(up)}</b>
      </div>
      {state !== 'empty' && (
        <div className="tt-row muted">
          {[
            s.up && `${num(s.up)} up`,
            s.degraded && `${num(s.degraded)} degraded`,
            s.down && `${num(s.down)} failed`,
            s.maintenance && `${num(s.maintenance)} in maintenance`,
          ]
            .filter(Boolean)
            .join(', ')}
        </div>
      )}
      {s.avg !== null && (
        <div className="tt-row">
          <span className="tt-key">Latency</span>
          <b>
            {latency(s.avg)}
            {s.min !== null && s.max !== null && s.max > s.min && (
              <span className="muted">
                {' '}
                ({latency(s.min)} – {latency(s.max)})
              </span>
            )}
          </b>
        </div>
      )}
    </>
  );
}

/** Keyboard reading of a series of slots: arrows move, Escape leaves. */
function useActive(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!count) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setActive((a) => Math.min(count - 1, Math.max(0, (a ?? (d > 0 ? -1 : count)) + d)));
    } else if (e.key === 'Escape') setActive(null);
  };
  return { active, setActive, onKeyDown };
}

function Tooltip({ x, width, top, children }: { x: number; width: number; top: number; children: ReactNode }) {
  const right = x > width / 2;
  return (
    <div
      className="tooltip"
      style={{ top, left: right ? undefined : x + 10, right: right ? width - x + 10 : undefined }}
      role="status"
    >
      {children}
    </div>
  );
}

/** One thin bar per slot, coloured by what happened in it. */
export function HistoryBar({ slots, label, tall }: { slots: Slot[]; label: string; tall?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { active, setActive, onKeyDown } = useActive(slots.length);
  const band = slots.length ? width / slots.length : 0;
  const cur = active !== null ? slots[active] : undefined;
  return (
    <div
      className={`hbar${tall ? ' hbar-tall' : ''}`}
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={`${label}. Use the arrow keys to read each slot.`}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
      onPointerMove={(e) => {
        const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / band);
        setActive(i >= 0 && i < slots.length ? i : null);
      }}
    >
      {slots.map((s, i) => (
        <span
          key={s.start}
          className={`hbar-slot tone-bg-${SLOT_META[slotState(s)].tone}${active === i ? ' active' : ''}`}
        />
      ))}
      {cur && (
        <Tooltip x={band * active! + band / 2} width={width} top={tall ? 34 : 24}>
          <SlotDetails s={cur} />
        </Tooltip>
      )}
    </div>
  );
}

const PLOT_H = 170;
const STRIP_H = 10;
const AXIS_H = 22;
const PAD_LEFT = 52;
const PAD_TOP = 8;
const HEIGHT = PAD_TOP + PLOT_H + 8 + STRIP_H + AXIS_H;

function niceMax(v: number): { max: number; step: number } {
  if (!(v > 0)) return { max: 4, step: 1 };
  const rough = v / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(v / step) * step, step };
}

/**
 * Average latency per slot (2px line) over its min–max range (a light band of the same hue),
 * with a status strip under the plot. Spikes beyond the scale are clipped at the top; the
 * tooltip still gives the exact maximum.
 */
export function LatencyChart({ slots, what }: { slots: Slot[]; what: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { active, setActive, onKeyDown } = useActive(slots.length);
  const plotW = Math.max(0, width - PAD_LEFT);
  const band = slots.length ? plotW / slots.length : 0;
  const avgs = slots.map((s) => s.avg).filter((v): v is number => v !== null);
  // Scale to the averages (with headroom) rather than to rare spikes, which would flatten the line.
  const { max, step } = niceMax(Math.max(...avgs, 0) * 1.25);
  const y = (v: number) => PAD_TOP + PLOT_H - (Math.min(v, max) / max) * PLOT_H;
  const x = (i: number) => PAD_LEFT + band * i + band / 2;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);

  let line = '';
  let area = '';
  let open = false;
  const upper: string[] = [];
  const lower: string[] = [];
  const flushArea = () => {
    if (upper.length) area += `M${upper.join('L')}L${lower.reverse().join('L')}Z`;
    upper.length = 0;
    lower.length = 0;
  };
  slots.forEach((s, i) => {
    if (s.avg === null) {
      open = false;
      flushArea();
      return;
    }
    line += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.avg).toFixed(1)}`;
    open = true;
    upper.push(`${x(i).toFixed(1)},${y(s.max ?? s.avg).toFixed(1)}`);
    lower.push(`${x(i).toFixed(1)},${y(s.min ?? s.avg).toFixed(1)}`);
  });
  flushArea();

  const span = slots.length ? slots[slots.length - 1]!.end - slots[0]!.start : 0;
  const fmt = span <= 2 * 86_400_000 ? shortTime : shortDay;
  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(band, 0.01)));
  const stripY = PAD_TOP + PLOT_H + 8;
  const gap = band >= 4 ? 1 : 0;
  const cur = active !== null ? slots[active] : undefined;

  return (
    <div className="chart" ref={ref} style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${what}. Use the arrow keys to read values; the table below lists them all.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          onPointerMove={(e) => {
            const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - PAD_LEFT) / band);
            setActive(i >= 0 && i < slots.length ? i : null);
          }}
        >
          <g className="axis">
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 && <line className="gridline" x1={PAD_LEFT} x2={width} y1={y(t)} y2={y(t)} />}
                <text x={PAD_LEFT - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {t === 0 ? '0' : latency(t)}
                </text>
              </g>
            ))}
          </g>
          {cur && <rect className="crosshair" x={x(active!) - band / 2} y={PAD_TOP} width={band} height={PLOT_H} />}
          <path className="latency-band" d={area} />
          <path className="latency-line" d={line} />
          {/* A lone point has no line: show it as a marker. */}
          {slots.map((s, i) =>
            s.avg !== null && slots[i - 1]?.avg == null && slots[i + 1]?.avg == null ? (
              <circle key={s.start} className="latency-dot" cx={x(i)} cy={y(s.avg)} r={3} />
            ) : null,
          )}
          {cur?.avg != null && <circle className="latency-dot active" cx={x(active!)} cy={y(cur.avg)} r={4} />}
          <line className="baseline" x1={PAD_LEFT} x2={width} y1={y(0)} y2={y(0)} />
          {slots.map((s, i) => (
            <rect
              key={s.start}
              className={`tone-fill-${SLOT_META[slotState(s)].tone}`}
              x={PAD_LEFT + band * i}
              y={stripY}
              width={Math.max(0.5, band - gap)}
              height={STRIP_H}
              rx={band >= 6 ? 2 : 0}
              opacity={active === null || active === i ? 1 : 0.55}
            />
          ))}
          <g className="axis">
            {slots.map((s, i) =>
              i % labelEvery === 0 ? (
                <text key={s.start} x={PAD_LEFT + band * i} y={HEIGHT - 6} textAnchor="start">
                  {fmt(s.start)}
                </text>
              ) : null,
            )}
          </g>
        </svg>
      )}
      {cur && (
        <Tooltip x={x(active!)} width={width} top={PAD_TOP}>
          <SlotDetails s={cur} />
        </Tooltip>
      )}
    </div>
  );
}

/** The table view of a chart's slots (empty slots left out). */
export function SlotTable({ slots }: { slots: Slot[] }) {
  const rows = slots.filter((s) => slotState(s) !== 'empty').reverse();
  return (
    <details className="chart-table">
      <summary>Data table ({rows.length} rows)</summary>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>From</th>
              <th>State</th>
              <th className="num">Uptime</th>
              <th className="num">Checks</th>
              <th className="num">Failed</th>
              <th className="num">Avg</th>
              <th className="num">Min</th>
              <th className="num">Max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.start}>
                <td>{dateTime(s.start)}</td>
                <td>{SLOT_META[slotState(s)].label}</td>
                <td className="num">{percent(slotUptime(s))}</td>
                <td className="num">{num(s.up + s.degraded + s.down + s.maintenance)}</td>
                <td className="num">{num(s.down)}</td>
                <td className="num">{latency(s.avg)}</td>
                <td className="num">{latency(s.min)}</td>
                <td className="num">{latency(s.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
