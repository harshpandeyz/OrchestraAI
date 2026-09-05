// Orchestra Intelligence — ONE reusable chart infrastructure.
// All charts share typography, spacing, interaction, accessibility,
// responsive behavior, tooltip behavior, loading, and data formatting.
// No chart library; dependency-free SVG/div (offline-safe, no fake telemetry).
import React, { useId, useMemo, useState } from 'react';
import type { Provenance } from './types';

export const PALETTE = ['#0C7A5C', '#2F7AC2', '#8A5A00', '#6D5BD0', '#0E9F6E', '#BE4444', '#64748B', '#0EA5A0'];

export function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const neg = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a !== 0 && a < 0.001) return `${neg}$${a.toFixed(6)}`;
  return `${neg}$${a.toFixed(3)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtPct01(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------- Provenance badge ----------
export function ProvenanceBadge({ value }: { value: Provenance | string | undefined }) {
  const v = String(value || 'UNKNOWN').toUpperCase();
  const cls =
    v === 'LIVE' || v === 'OBSERVED' || v === 'VERIFIED' ? 'ok'
    : v === 'DEMO' || v === 'ILLUSTRATIVE' ? 'warn'
    : v === 'INSUFFICIENT_DATA' ? 'neutral' : 'info';
  const label =
    v === 'LIVE' ? 'LIVE'
    : v === 'OBSERVED' ? 'OBSERVED'
    : v === 'VERIFIED' ? 'VERIFIED'
    : v === 'DEMO' ? 'DEMO'
    : v === 'ILLUSTRATIVE' ? 'ILLUSTRATIVE DEMO'
    : v === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA'
    : v;
  const title =
    v === 'LIVE' ? 'Metered live traffic from canonical run economics'
    : v === 'OBSERVED' ? 'Observed Orchestra usage in this workspace'
    : v === 'VERIFIED' ? 'Verified from explicitly recorded evidence'
    : v === 'DEMO' ? 'Demo traffic through the real pipeline — mock provider calls'
    : v === 'ILLUSTRATIVE' ? 'Hand-written story props for the marketing page — not measurements'
    : v === 'INSUFFICIENT_DATA' ? 'Not enough evidence — nothing is fabricated'
    : 'Provenance unknown';
  return <span className={`pill sm ${cls}`} title={title}>{label}</span>;
}

// ---------- States ----------
export function ChartEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="oi-empty" role="status">
      <b>{title}</b>
      <span>{hint || 'Not enough evidence in this slice — no metrics are invented.'}</span>
      <span className="oi-empty-tag">INSUFFICIENT DATA · COMING SOON WHEN OBSERVED</span>
    </div>
  );
}

export function ChartLoading({ lines = 4 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading chart">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skel" style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function ChartError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="oi-error" role="alert">
      <b>Could not load analytics</b>
      <span>{message}</span>
      {onRetry && <button className="icon-btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

// ---------- Shared chart frame ----------
export function ChartCard({
  title, subtitle, provenance, actions, children, footnote,
}: {
  title: string; subtitle?: string; provenance?: Provenance | string;
  actions?: React.ReactNode; children: React.ReactNode; footnote?: string;
}) {
  return (
    <section className="oi-card" aria-label={title}>
      <div className="oi-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="oi-card-side">
          {provenance && <ProvenanceBadge value={provenance} />}
          {actions}
        </div>
      </div>
      <div className="oi-card-body">{children}</div>
      {footnote && <p className="oi-footnote">{footnote}</p>}
    </section>
  );
}

// ---------- Tooltip (hover + focus, viewport-safe) ----------
function useHover() {
  const [hot, setHot] = useState<number | null>(null);
  return { hot, setHot };
}

// ---------- Line / Area chart ----------
export interface SeriesDef { key: string; label: string; color: string; values: (number | null)[]; dashed?: boolean }

export function LineChart({
  labels, series, height = 200, yLabel, logScale = false,
}: {
  labels: string[]; series: SeriesDef[]; height?: number; yLabel?: string; logScale?: boolean;
}) {
  const { hot, setHot } = useHover();
  const id = useId();
  const W = 640; const H = height; const PAD = { l: 44, r: 12, t: 10, b: 26 };
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const { min, max, scale } = useMemo(() => {
    if (!all.length) return { min: 0, max: 1, scale: (v: number) => v };
    if (logScale) {
      const pos = all.filter((v) => v > 0);
      if (!pos.length) return { min: 0, max: 1, scale: (v: number) => v };
      const lo = Math.log10(Math.min(...pos));
      const hi = Math.log10(Math.max(...pos));
      const span = hi - lo || 1;
      return { min: Math.min(...pos), max: Math.max(...pos), scale: (v: number) => (v <= 0 ? 0 : (Math.log10(v) - lo) / span) };
    }
    const lo = Math.min(...all, 0);
    const hi = Math.max(...all, 1);
    const span = hi - lo || 1;
    return { min: lo, max: hi, scale: (v: number) => (v - lo) / span };
  }, [all.join(','), logScale]); // eslint-disable-line react-hooks/exhaustive-deps
  void min; void max;
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => H - PAD.b - scale(v) * (H - PAD.t - PAD.b);
  const pathFor = (vals: (number | null)[]) => {
    let d = '';
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(logScale && v <= 0 ? 0.000001 : v).toFixed(1)} `;
    });
    return d.trim();
  };
  if (!all.length) return <ChartEmpty title="No series data" />;
  return (
    <div className="oi-chart" onMouseLeave={() => setHot(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.map((s) => s.label).join(', ')} over time${yLabel ? ` (${yLabel})` : ''}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={H * f} y2={H * f} className="oi-grid" />
        ))}
        {series.map((s) => (
          <path key={s.key} d={pathFor(s.values)} className="oi-line" stroke={s.color}
            strokeDasharray={s.dashed ? '6 4' : undefined} fill="none" strokeWidth={2.4} strokeLinecap="round" />
        ))}
        {series.flatMap((s, si) => s.values.map((v, i) => ({ v, i, si, s }))).filter((p) => p.v !== null).map((p, k) => (
          <circle key={k} cx={x(p.i)} cy={y(logScale && (p.v as number) <= 0 ? 0.000001 : (p.v as number))} r={hot === p.i ? 4.6 : 2.4}
            fill={p.s.color} stroke="var(--bg2)" strokeWidth={1.2}
            onMouseEnter={() => setHot(p.i)} onFocus={() => setHot(p.i)} tabIndex={0}
            aria-label={`${p.s.label} ${labels[p.i]}: ${p.v}`}>
            <title>{`${p.s.label} · ${labels[p.i]}: ${p.v}`}</title>
          </circle>
        ))}
        {hot !== null && hot < labels.length && (
          <g transform={`translate(${Math.min(x(hot), W - 190)},10)`}>
            <rect width="182" height={20 + series.length * 15} rx="8" className="oi-tipbox" />
            <text x="10" y="16" className="oi-tiphead">{labels[hot]}</text>
            {series.map((s, si) => (
              <text key={s.key} x="10" y={32 + si * 15} className="oi-tipline">
                {s.label}: {s.values[hot] === null ? '—' : s.values[hot]}
              </text>
            ))}
          </g>
        )}
        {labels.map((l, i) => (
          <text key={`${id}-${i}`} x={x(i)} y={H - 8} textAnchor="middle" className="oi-axis">{String(l).slice(5) || l}</text>
        ))}
      </svg>
      <div className="oi-legend" role="list" aria-label="Series legend">
        {series.map((s) => (
          <span key={s.key} role="listitem"><i style={{ background: s.color }} />{s.label}</span>
        ))}
        {yLabel && <span className="oi-yunit">{yLabel}{logScale ? ' · log scale' : ''}</span>}
      </div>
    </div>
  );
}

export function AreaChart({ labels, series, height = 200 }: { labels: string[]; series: SeriesDef[]; height?: number }) {
  const W = 640; const H = height; const PAD = { l: 44, r: 12, t: 10, b: 26 };
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!all.length) return <ChartEmpty title="No series data" />;
  const hi = Math.max(...all, 1);
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => H - PAD.b - (v / hi) * (H - PAD.t - PAD.b);
  // Stack values
  const stacked = labels.map((_, i) => {
    let acc = 0;
    return series.map((s) => {
      const v = s.values[i] ?? 0;
      const lo = acc; acc += (v || 0);
      return { key: s.key, color: s.color, lo, hi: acc, label: s.label, v };
    });
  });
  const top = stacked.map((col) => col.length ? col[col.length - 1].hi : 0);
  const topMax = Math.max(...top, 1);
  const yy = (v: number) => H - PAD.b - (v / topMax) * (H - PAD.t - PAD.b);
  return (
    <div className="oi-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked area: ${series.map((s) => s.label).join(', ')}`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={H * f} y2={H * f} className="oi-grid" />
        ))}
        {series.map((s, si) => {
          const topPath = stacked.map((col, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${yy(col[si].hi).toFixed(1)}`).join(' ');
          const botPath = stacked.map((col, i) => `L${x(col ? i : i).toFixed(1)} ${yy(col[si].lo).toFixed(1)}`).reverse().join(' ');
          void y;
          return <path key={s.key} d={`${topPath} ${botPath} Z`} fill={s.color} opacity={0.72} stroke="none" />;
        })}
        {labels.map((l, i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="oi-axis">{String(l).slice(5) || l}</text>
        ))}
      </svg>
      <div className="oi-legend" role="list" aria-label="Series legend">
        {series.map((s) => (
          <span key={s.key} role="listitem"><i style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </div>
  );
}

// ---------- Bar / stacked bar ----------
export interface BarRow { key: string; label: string; value: number; color?: string; hint?: string; selected?: boolean }

export function BarChart({ rows, unit, max }: { rows: BarRow[]; unit?: string; max?: number }) {
  const hi = max ?? Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <ChartEmpty title="No rows" />;
  return (
    <div className="oi-bars" role="img" aria-label={`Bar chart: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}${unit ? ` ${unit}` : ''}`}>
      {rows.map((r, i) => (
        <div key={r.key} className="oi-bar-row">
          <span className="oi-bar-label" title={r.hint || r.label}>{r.label}</span>
          <div className="oi-bar-track">
            <div className={`oi-bar-fill${r.selected ? ' sel' : ''}`} style={{ width: `${Math.max(1.5, (r.value / (hi || 1)) * 100)}%`, background: r.color || colorFor(i) }} />
          </div>
          <b className="oi-bar-val">{fmtNum(r.value)}{unit ? ` ${unit}` : ''}</b>
        </div>
      ))}
    </div>
  );
}

export function Donut({ slices, centerLabel, centerValue }: { slices: { key: string; label: string; value: number; color: string }[]; centerLabel: string; centerValue: string }) {
  const size = 150; const r = 58; const c = 2 * Math.PI * r;
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  let acc = 0;
  return (
    <div className="oi-donut-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="oi-donut" role="img" aria-label={`Donut: ${slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`}>
        {slices.map((s) => {
          const frac = s.value / total;
          const dash = `${(frac * c).toFixed(1)} ${(c - frac * c).toFixed(1)}`;
          const rot = (acc / total) * 360;
          acc += s.value;
          return (
            <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
              strokeWidth="20" strokeDasharray={dash} transform={`rotate(${rot - 90} ${size / 2} ${size / 2})`}>
              <title>{s.label}: {Math.round(frac * 100)}%</title>
            </circle>
          );
        })}
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="oi-donut-num">{centerValue}</text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="oi-donut-lab">{centerLabel}</text>
      </svg>
      <ul className="oi-donut-legend">
        {slices.map((s) => (
          <li key={s.key}><i style={{ background: s.color }} />{s.label} <b>{Math.round((s.value / total) * 100)}%</b></li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Scatter ----------
export interface ScatterPt { key: string; label: string; x: number; y: number; size?: number; color?: string; hint?: string }

export function ScatterPlot({ points, xLabel, yLabel, height = 240 }: { points: ScatterPt[]; xLabel: string; yLabel: string; height?: number }) {
  const { hot, setHot } = useHover();
  const W = 640; const H = height; const PAD = { l: 52, r: 16, t: 12, b: 34 };
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs, 0); const x1 = Math.max(...xs, 1);
  const y0 = Math.min(...ys, 0); const y1 = Math.max(...ys, 1);
  const X = (v: number) => PAD.l + ((v - x0) / ((x1 - x0) || 1)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => H - PAD.b - ((v - y0) / ((y1 - y0) || 1)) * (H - PAD.t - PAD.b);
  if (!points.length) return <ChartEmpty title="No points" />;
  return (
    <div className="oi-chart" onMouseLeave={() => setHot(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scatter: ${xLabel} vs ${yLabel}, ${points.length} models`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={H * f} y2={H * f} className="oi-grid" />
        ))}
        {points.map((p, i) => (
          <circle key={p.key} cx={X(p.x)} cy={Y(p.y)} r={hot === i ? 9 : 5 + Math.min(6, (p.size || 1) / 18)}
            fill={p.color || colorFor(i)} opacity={hot === null || hot === i ? 0.92 : 0.45}
            stroke="var(--bg2)" strokeWidth={1.4}
            onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} tabIndex={0}
            aria-label={`${p.label}: ${xLabel} ${p.x}, ${yLabel} ${p.y}`}>
            <title>{`${p.label} — ${xLabel}: ${p.x}, ${yLabel}: ${p.y}${p.hint ? ` — ${p.hint}` : ''}`}</title>
          </circle>
        ))}
        {hot !== null && points[hot] && (
          <g transform={`translate(${Math.min(X(points[hot].x) + 12, W - 210)},${Math.max(Y(points[hot].y) - 60, 4)})`}>
            <rect width="200" height="52" rx="8" className="oi-tipbox" />
            <text x="10" y="18" className="oi-tiphead">{points[hot].label}</text>
            <text x="10" y="34" className="oi-tipline">{xLabel}: {points[hot].x} · {yLabel}: {points[hot].y}</text>
            {points[hot].hint && <text x="10" y="47" className="oi-tipline dim">{points[hot].hint}</text>}
          </g>
        )}
        <text x={W / 2} y={H - 6} textAnchor="middle" className="oi-axis">{xLabel}</text>
        <text x={10} y={H / 2} textAnchor="middle" className="oi-axis" transform={`rotate(-90 10 ${H / 2})`}>{yLabel}</text>
      </svg>
      <div className="oi-legend" role="list" aria-label="Scatter legend">
        {points.map((p, i) => (
          <span key={p.key} role="listitem"><i style={{ background: p.color || colorFor(i) }} />{p.label}</span>
        ))}
      </div>
    </div>
  );
}

// ---------- Ranking table (becomes cards on mobile via CSS) ----------
export interface RankCol<T = never> { key: string; label: string; align?: 'left' | 'right'; render: (row: T) => React.ReactNode; sortValue?: (row: T) => number | string | null }

export type AnyRankCol = { key: string; label: string; align?: 'left' | 'right'; render: (row: never) => React.ReactNode; sortValue?: (row: never) => number | string | null };

export function RankingTable<T extends object>({
  rows, columns, defaultSort, ariaLabel, pageSize = 25,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: T[]; columns: { key: string; label: string; align?: 'left' | 'right'; render: (row: T) => React.ReactNode; sortValue?: (row: T) => number | string | null }[]; defaultSort?: string; ariaLabel: string; pageSize?: number;
}) {
  const [sortKey, setSortKey] = useState(defaultSort || columns[0]?.key || '');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [shown, setShown] = useState(pageSize);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = sv(a); const bv = sv(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, sortKey, dir]);
  const visible = sorted.slice(0, shown);
  return (
    <div className="oi-table-wrap">
      <table className="oi-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" aria-sort={sortKey === c.key ? (dir === 1 ? 'ascending' : 'descending') : 'none'} className={c.align === 'right' ? 'r' : ''}>
                <button className="oi-thbtn" onClick={() => {
                  if (sortKey === c.key) setDir(dir === 1 ? -1 : 1);
                  else { setSortKey(c.key); setDir(-1); }
                }} aria-label={`Sort by ${c.label}`}>
                  {c.label} {sortKey === c.key ? (dir === 1 ? '▲' : '▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={c.align === 'right' ? 'r mono' : ''}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > shown && (
        <button className="icon-btn sm" onClick={() => setShown(shown + pageSize)}>Show more ({sorted.length - shown} remaining)</button>
      )}
    </div>
  );
}

// ---------- Metric card ----------
export function MetricCard({ label, value, detail, tone }: { label: React.ReactNode; value: React.ReactNode; detail?: string; tone?: 'positive' | '' }) {
  return (
    <div className={`oi-metric${tone === 'positive' ? ' pos' : ''}`}>
      <span className="oi-metric-label">{label}</span>
      <strong className="oi-metric-value">{value}</strong>
      {detail && <small className="oi-metric-detail">{detail}</small>}
    </div>
  );
}

// ---------- Controls: time-range, filter, scale toggle ----------
export function TimeRangeSelector({ value, onChange }: { value: string; onChange: (v: '7d' | '30d' | '90d' | 'all') => void }) {
  const opts = [{ id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: '90d', label: '90D' }, { id: 'all', label: 'All' }] as const;
  return (
    <div className="oi-seg" role="group" aria-label="Time range">
      {opts.map((o) => (
        <button key={o.id} className="chip" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function GranularitySelector({ value, onChange }: { value: string; onChange: (v: 'daily' | 'weekly' | 'monthly') => void }) {
  const opts = [{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }] as const;
  return (
    <div className="oi-seg" role="group" aria-label="Aggregation">
      {opts.map((o) => (
        <button key={o.id} className="chip" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function ScaleToggle({ value, onChange }: { value: 'linear' | 'log'; onChange: (v: 'linear' | 'log') => void }) {
  return (
    <div className="oi-seg" role="group" aria-label="Scale">
      <button className="chip" aria-pressed={value === 'linear'} onClick={() => onChange('linear')}>Linear</button>
      <button className="chip" aria-pressed={value === 'log'} onClick={() => onChange('log')}>Log</button>
    </div>
  );
}

export function FilterSelect({ label, value, options, onChange }: { label: string; value: string | null; options: { id: string; label: string }[]; onChange: (v: string | null) => void }) {
  return (
    <label className="oi-filter">
      <span>{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">All</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}
