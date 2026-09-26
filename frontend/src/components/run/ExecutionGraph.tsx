// Interactive execution graph — data-driven from actual run state.
// Nodes from execution.plan.steps when present, else derived from the
// trace milestone stages (honest fallback, never faked parallelism).
// Interactions: click→inspect, hover→summary, keyboard nav, zoom, pan,
// fit-to-view, minimap. Reduced-motion respected. Small screens render a
// semantic vertical timeline instead of a shrunk graph.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './graph.css';
import type { RuntimeSnapshot } from '../../types';

export interface GraphNode {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'waiting' | 'blocked' | 'failed' | 'verified' | 'unknown';
  detail?: string;
  deps: string[];
}

export function snapshotToGraph(snap: RuntimeSnapshot): GraphNode[] {
  const plan = snap.execution?.plan?.steps;
  if (plan && plan.length) {
    return plan.map((s) => ({
      id: s.id,
      label: s.description.slice(0, 48),
      status: mapPlanStatus(s.status),
      detail: `deps: ${(s.dependencies || []).join(', ') || 'none'}`,
      deps: s.dependencies || [],
    }));
  }
  // Honest fallback: linear stage chain observed in the trace.
  const seen: string[] = [];
  for (const t of snap.trace) {
    const stage = stageOf(t.type);
    if (stage && !seen.includes(stage)) seen.push(stage);
  }
  const stages = seen.length ? seen : ['plan'];
  return stages.map((st, i) => ({
    id: st,
    label: st.toUpperCase(),
    status: i < stages.length - 1 ? 'verified' : mapRunStatus(snap.status),
    detail: snap.trace.filter((t) => stageOf(t.type) === st).length + ' events observed',
    deps: i === 0 ? [] : [stages[i - 1]],
  }));
}

function stageOf(type: string): string | null {
  if (/task|planning|plan/.test(type)) return 'plan';
  if (/context|memory|cache/.test(type)) return 'context';
  if (/model|routing|price/.test(type)) return 'model';
  if (/tool|execution\.step/.test(type)) return 'execute';
  if (/verif|optim|budget|cost/.test(type)) return 'verify';
  if (/run\.|response\.done|episode/.test(type)) return 'result';
  return null;
}

function mapPlanStatus(s: string): GraphNode['status'] {
  const v = String(s || '').toLowerCase();
  if (v.includes('complete') || v.includes('done') || v.includes('verif')) return 'verified';
  if (v.includes('run') || v.includes('progress') || v.includes('execut')) return 'running';
  if (v.includes('wait') || v.includes('paus') || v.includes('pend')) return 'waiting';
  if (v.includes('block')) return 'blocked';
  if (v.includes('fail') || v.includes('error')) return 'failed';
  return 'queued';
}

function mapRunStatus(s: string): GraphNode['status'] {
  const v = String(s || '').toLowerCase();
  if (v === 'completed') return 'verified';
  if (v === 'failed') return 'failed';
  if (v === 'cancelled') return 'blocked';
  if (v === 'running' || v === 'planning') return 'running';
  if (v === 'waiting') return 'waiting';
  return 'unknown';
}

interface LayoutNode extends GraphNode { x: number; y: number; layer: number }

function layout(nodes: GraphNode[]): { positioned: LayoutNode[]; width: number; height: number } {
  // Layer by dependency depth; spread within layer.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: string[]): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.includes(id)) return 0;
    const n = byId.get(id);
    if (!n || !n.deps.length) { depth.set(id, 0); return 0; }
    const d = 1 + Math.max(...n.deps.map((dep) => (byId.has(dep) ? visit(dep, [...stack, id]) : 0)));
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => visit(n.id, []));
  const layers = new Map<number, GraphNode[]>();
  nodes.forEach((n) => {
    const l = depth.get(n.id) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  });
  const NW = 200; const NH = 64; const GX = 56; const GY = 40;
  const maxLayer = Math.max(...[...layers.keys()], 0);
  const positioned: LayoutNode[] = [];
  layers.forEach((list, layer) => {
    const totalH = list.length * (NH + GY) - GY;
    list.forEach((n, i) => {
      positioned.push({ ...n, layer, x: 24 + layer * (NW + GX), y: 24 + i * (NH + GY) + Math.max(0, (maxLayerCount(layers) * (NH + GY) - totalH) / 2) });
    });
  });
  const width = 24 * 2 + (maxLayer + 1) * NW + maxLayer * GX;
  const height = Math.max(120, maxLayerCount(layers) * (NH + GY) + 24);
  void NH;
  return { positioned, width, height };
}

function maxLayerCount(layers: Map<number, GraphNode[]>): number {
  return Math.max(...[...layers.values()].map((l) => l.length), 1);
}

export function ExecutionGraph({ snap, selectedId, onSelect }: {
  snap: RuntimeSnapshot;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const nodes = useMemo(() => snapshotToGraph(snap), [snap]);
  const { positioned, width, height } = useMemo(() => layout(nodes), [nodes]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [sel, setSel] = useState<string | null>(selectedId || null);
  const [narrow, setNarrow] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const mq = window.matchMedia('(max-width: 640px)');
      const update = () => setNarrow(mq.matches);
      update();
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    } catch { /* jsdom / older engines */ }
  }, []);

  useEffect(() => { if (selectedId !== undefined) setSel(selectedId); }, [selectedId]);

  const pick = useCallback((id: string) => {
    setSel(id);
    onSelect?.(id);
  }, [onSelect]);

  const onKeyNav = useCallback((e: React.KeyboardEvent) => {
    if (!positioned.length) return;
    const idx = positioned.findIndex((n) => n.id === sel);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); pick(positioned[Math.min(positioned.length - 1, idx + 1)].id); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); pick(positioned[Math.max(0, idx - 1)].id); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2))); }
    else if (e.key === '-') { e.preventDefault(); setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2))); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); }
  }, [positioned, sel, pick]);

  const fit = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  if (!nodes.length) {
    return <div className="v2-empty" role="status"><b>No execution graph</b><span>No plan or trace stages observed yet.</span></div>;
  }

  // Mobile: semantic vertical timeline, not a shrunk graph.
  if (narrow) {
    return (
      <ol className="v2-graph-timeline" aria-label="Execution timeline" data-testid="execution-graph-timeline">
        {positioned.map((n) => (
          <li key={n.id}>
            <button type="button" className="v2-tl-row" data-status={n.status} aria-current={sel === n.id ? 'step' : undefined} onClick={() => pick(n.id)}>
              <span className="v2-tl-rail" aria-hidden="true"><span className="v2-tl-dot">{n.status === 'verified' ? '✓' : n.status === 'failed' ? '✕' : n.status === 'running' ? '●' : ''}</span></span>
              <span><b>{n.label}</b><br /><span className="v2-meta">{n.status.toUpperCase()}{n.detail ? ` · ${n.detail}` : ''}</span></span>
            </button>
          </li>
        ))}
      </ol>
    );
  }

  const byId = new Map(positioned.map((n) => [n.id, n]));
  return (
    <div className="v2-graph" data-testid="execution-graph">
      <div className="v2-graph-toolbar" role="toolbar" aria-label="Graph controls">
        <button type="button" className="icon-btn sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
        <button type="button" className="icon-btn sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
        <button type="button" className="icon-btn sm" onClick={fit} aria-label="Fit to view">Fit</button>
        <span className="v2-meta" role="status">{nodes.length} steps · {Math.round(zoom * 100)}%</span>
      </div>
      <div
        className="v2-graph-canvas"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; }}
        onMouseMove={(e) => { if (drag.current) setPan({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) }); }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; }}
      >
        <svg
          ref={svgRef}
          viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${Math.max(width, 400) / zoom} ${Math.max(height, 160) / zoom}`}
          role="tree"
          aria-label="Execution graph. Use arrow keys to move between steps."
          tabIndex={0}
          onKeyDown={onKeyNav}
          style={{ minHeight: 180 }}
        >
          {positioned.flatMap((n) => n.deps.filter((d) => byId.has(d)).map((d) => {
            const a = byId.get(d)!; const b = n;
            const x1 = a.x + 200; const y1 = a.y + 28;
            const x2 = b.x; const y2 = b.y + 28;
            const mx = (x1 + x2) / 2;
            const done = a.status === 'verified' && (b.status === 'verified' || b.status === 'running');
            return <path key={`${d}->${n.id}`} className={`v2-gedge${done ? ' done' : ''}`} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />;
          }))}
          {positioned.map((n) => (
            <g
              key={n.id}
              className="v2-gnode"
              data-status={n.status}
              data-selected={sel === n.id ? 'true' : 'false'}
              role="treeitem"
              aria-selected={sel === n.id}
              aria-label={`${n.label}, ${n.status}${n.detail ? `, ${n.detail}` : ''}`}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={() => pick(n.id)}
              tabIndex={-1}
            >
              <title>{`${n.label} — ${n.status}${n.detail ? ` — ${n.detail}` : ''}`}</title>
              <rect width={200} height={56} rx={10} />
              <text x={12} y={22}>{n.label.slice(0, 24)}</text>
              <text x={12} y={40} className="sub">{n.status.toUpperCase()}{n.detail ? ` · ${n.detail.slice(0, 22)}` : ''}</text>
            </g>
          ))}
        </svg>
        <svg className="v2-minimap" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
          {positioned.flatMap((n) => n.deps.filter((d) => byId.has(d)).map((d) => {
            const a = byId.get(d)!; const b = n;
            return <line key={`${d}->${n.id}-mini`} x1={a.x + 100} y1={a.y + 28} x2={b.x + 100} y2={b.y + 28} stroke="var(--border-strong)" strokeWidth={2} />;
          }))}
          {positioned.map((n) => (
            <rect key={n.id} x={n.x} y={n.y} width={200} height={56} rx={6} fill={n.status === 'verified' ? 'var(--verified)' : n.status === 'running' ? 'var(--running)' : n.status === 'failed' ? 'var(--failed)' : 'var(--border-strong)'} opacity={sel === n.id ? 1 : 0.55} />
          ))}
        </svg>
      </div>
    </div>
  );
}
