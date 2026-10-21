// The monitors' depends_on as a graph: dependencies on the left, what depends on them to the
// right, coloured by status. A down dependency suppresses its dependents' down notifications.
import { useMemo, useState } from 'react';
import { Icon } from '../components/icons.tsx';
import { Empty } from '../components/ui.tsx';
import { useLive } from '../context.ts';
import { layoutDependencies } from '../logic.ts';
import { STATUS_META, statusOf } from '../status.ts';

const COL_W = 250;
const NODE_W = 200;
const NODE_H = 40;
const ROW_H = 56;
const PAD = 12;

export function DependenciesView() {
  const { monitors, byId, openMonitor } = useLive();
  const layout = useMemo(() => layoutDependencies(monitors), [monitors]);
  const [hover, setHover] = useState<string | null>(null);
  const pos = new Map(layout.nodes.map((n) => [n.id, { x: PAD + n.layer * COL_W, y: PAD + n.row * ROW_H }]));
  const width = PAD * 2 + Math.max(0, layout.layers - 1) * COL_W + NODE_W;
  const height = PAD * 2 + Math.max(0, layout.rows - 1) * ROW_H + NODE_H;
  // With a node hovered, its dependencies and dependents stand out.
  const related = useMemo(() => {
    if (!hover) return null;
    const out = new Set([hover]);
    for (const [a, b] of layout.edges) {
      if (a === hover) out.add(b);
      if (b === hover) out.add(a);
    }
    return out;
  }, [hover, layout.edges]);

  return (
    <>
      <div className="page-head">
        <h1>Dependencies</h1>
      </div>
      <p className="muted">
        Each monitor sits to the right of what it depends on (<span className="mono">depends_on</span>). While a
        dependency is down, the down notifications of what depends on it are suppressed. Monitors without dependencies
        are not shown.
      </p>
      {layout.nodes.length ? (
        <div className="graph-wrap">
          <svg width={width} height={height} role="img" aria-label="Dependency graph of the monitors">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" className="graph-arrow" />
              </marker>
            </defs>
            {layout.edges.map(([a, b]) => {
              const p = pos.get(a)!;
              const q = pos.get(b)!;
              const x1 = p.x + NODE_W;
              const y1 = p.y + NODE_H / 2;
              const x2 = q.x;
              const y2 = q.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const dim = related && !(related.has(a) && related.has(b));
              const down = statusOf(byId.get(a)!) === 'down';
              return (
                <path
                  key={`${a}>${b}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  className={`graph-edge${down ? ' graph-edge-down' : ''}`}
                  opacity={dim ? 0.15 : 1}
                  markerEnd="url(#arrow)"
                />
              );
            })}
            {layout.nodes.map((n) => {
              const m = byId.get(n.id)!;
              const meta = STATUS_META[statusOf(m)];
              const p = pos.get(n.id)!;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  className={`graph-node tone-${meta.tone}`}
                  opacity={related && !related.has(n.id) ? 0.3 : 1}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => openMonitor(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') openMonitor(n.id);
                  }}
                  onFocus={() => setHover(n.id)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${m.name}: ${meta.label}`}
                >
                  <rect width={NODE_W} height={NODE_H} rx={8} className="graph-box" />
                  <rect width={5} height={NODE_H} rx={2} className="graph-stripe" />
                  <foreignObject x={12} y={0} width={NODE_W - 18} height={NODE_H}>
                    <div className="graph-label">
                      <span className="graph-name">{m.name}</span>
                      <span className="graph-status">
                        <Icon name={meta.icon} size={11} />
                        {meta.label}
                      </span>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <Empty>
          No monitor depends on another. Set <span className="mono">depends_on</span> in Pingwarden&rsquo;s
          configuration to suppress downstream alerts while an upstream service is down.
        </Empty>
      )}
    </>
  );
}
