// Lightweight SVG chart primitives for the Live Intelligence panel.
// No charting dependencies: crisp SVG, bounded points, accessible summaries,
// touch-friendly (no hover-only information), reduced-motion aware.
import React, { memo, useId, useMemo, useState } from 'react';

export const CHART_MAX = 60;

function bound(values: number[]): number[] {
  const clean = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return clean.length > CHART_MAX ? clean.slice(clean.length - CHART_MAX) : clean;
}

export interface LineChartProps {
  values: number[];
  height?: number;
  format: (v: number) => string;
  label: string;
  threshold?: number;
  tone?: 'accent' | 'amber' | 'coral' | 'sky' | 'teal';
  minPoints?: number;
}

/** Responsive SVG line + area chart with hover/touch readout + a11y summary. */
export const LineChart = memo(function LineChart({
  values, height = 64, format, label, threshold, tone = 'accent', minPoints = 2,
}: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const vals = useMemo(() => bound(values), [values]);
  const W = 320;
  const H = height;
  const PAD = 6;

  if (!vals.length || vals.length < minPoints) {
    return (
      <div className="cx-chart-empty" role="status" aria-label={`${label}: waiting for telemetry`}>
        <span className="cx-chart-empty-dot" aria-hidden="true" />
        <span>Waiting for telemetry…</span>
      </div>
    );
  }

  const max = Math.max(...vals, threshold ?? -Infinity, 1e-9);
  const min = Math.min(...vals, 0);
  const span = Math.max(max - min, 1e-9);
  const X = (i: number) => PAD + (i / Math.max(1, vals.length - 1)) * (W - PAD * 2);
  const Y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${H - PAD} L${pts.split(' ').join(' L')} L${X(vals.length - 1).toFixed(1)},${H - PAD} Z`;
  const ty = threshold !== undefined && Number.isFinite(threshold) ? Y(threshold) : null;
  const latest = vals[vals.length - 1];
  const summary = `${label} chart. Current ${format(latest)}. Average ${format(vals.reduce((a, b) => a + b, 0) / vals.length)} across ${vals.length} samples.`;

  return (
    <div className={`cx-chart cx-tone-${tone}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={summary}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          if (!r.width) return;
          const idx = Math.round(((e.clientX - r.left) / r.width) * (vals.length - 1));
          setHover(Math.max(0, Math.min(vals.length - 1, idx)));
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          if (!t || !r.width) return;
          const idx = Math.round(((t.clientX - r.left) / r.width) * (vals.length - 1));
          setHover(Math.max(0, Math.min(vals.length - 1, idx)));
        }}
      >
        <defs>
          <linearGradient id={`ag${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="cx-area-top" />
            <stop offset="100%" className="cx-area-bottom" />
          </linearGradient>
        </defs>
        {ty !== null && <line x1={PAD} x2={W - PAD} y1={ty} y2={ty} className="cx-thresh" strokeDasharray="4 3" />}
        <path d={area} className="cx-area" fill={`url(#ag${gid})`} />
        <polyline points={pts} className="cx-line" />
        {hover !== null && <circle cx={X(hover)} cy={Y(vals[hover])} r="3.5" className="cx-hoverdot" />}
        <circle cx={X(vals.length - 1)} cy={Y(latest)} r="3" className="cx-livedot-svg" />
      </svg>
      <div className="cx-chart-foot" aria-hidden={hover !== null ? undefined : true}>
        <span>{format(Math.min(...vals))}</span>
        {hover !== null ? (
          <b>{format(vals[hover])} · step {hover + 1}</b>
        ) : (
          <span>latest {format(latest)}</span>
        )}
        <span>{format(max)}</span>
      </div>
      <span className="sr-only" role="status">{summary}</span>
    </div>
  );
});

export const AreaChart = LineChart;

/** Horizontal meter bar with threshold + accessible label. */
export const BarMeter = memo(function BarMeter({
  value, max, label, format, hotAt = 0.8, critAt = 0.95,
}: {
  value: number | null;
  max: number | null;
  label: string;
  format: (v: number) => string;
  hotAt?: number;
  critAt?: number;
}) {
  const pct = value !== null && max ? Math.min(1, Math.max(0, value / max)) : 0;
  const cls = pct >= critAt ? 'crit' : pct >= hotAt ? 'hot' : '';
  const text = value !== null && max !== null ? `${format(value)} of ${format(max)}` : 'unknown';
  return (
    <div className="cx-meter" role="img" aria-label={`${label}: ${text}`}>
      <div className={`cx-meter-track ${cls}`}>
        <i className="cx-meter-fill" style={{ width: `${pct * 100}%` }} />
        <span className="cx-meter-threshold" style={{ left: `${hotAt * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  );
});

/** Compact sparkline for dense metric tiles. */
export const Sparkline = memo(function Sparkline({ values, label }: { values: number[]; label: string }) {
  const vals = useMemo(() => bound(values).slice(-28), [values]);
  if (vals.length < 2) return null;
  const max = Math.max(1e-9, ...vals);
  const min = Math.min(...vals, 0);
  const span = Math.max(max - min, 1e-9);
  const W = 120;
  const H = 26;
  const pts = vals.map((v, i) => `${((i / Math.max(1, vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="cx-spark" role="img" aria-label={`${label} trend`}>
      <polyline points={pts} className="cx-spark-line" />
    </svg>
  );
});

/** Live metric tile: label, big value, sub, optional spark. */
export function MetricCard({
  label, value, sub, tone = '', spark, sparkLabel, live,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  spark?: number[];
  sparkLabel?: string;
  live?: boolean;
}) {
  return (
    <div className={`cx-metric ${tone}`} role="status" aria-label={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <span className="cx-metric-label">{label}{live && <i className="cx-pulse" aria-hidden="true" />}</span>
      <span className="cx-metric-value">{value}</span>
      {sub && <span className="cx-metric-sub">{sub}</span>}
      {spark && spark.length >= 2 && <Sparkline values={spark} label={sparkLabel || label} />}
    </div>
  );
}
