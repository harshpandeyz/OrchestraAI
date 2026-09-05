import React, { Suspense, lazy, useState } from 'react';
import {
  ANALYTICS_HEADLINE,
  COST_BARS,
  EFFICIENCY_SERIES,
  FAILOVER_BEATS,
  LATENCY_FAST,
  LATENCY_SLOW,
  ROUTE_MIX,
} from './data';
import { Reveal } from './hooks';

const LandingIntelligenceGrid = lazy(() =>
  import('../../analytics/LandingWidgets').then((m) => ({ default: m.LandingIntelligenceGrid }))
);

function linePath(values: number[], w: number, h: number, pad: number): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function EfficiencyChart() {
  const [hot, setHot] = useState<number | null>(null);
  const w = 560;
  const h = 190;
  const pad = 14;
  const d = linePath(EFFICIENCY_SERIES, w, h, pad);
  const min = Math.min(...EFFICIENCY_SERIES);
  const max = Math.max(...EFFICIENCY_SERIES);
  const xy = (i: number) => {
    const x = pad + (i / (EFFICIENCY_SERIES.length - 1)) * (w - pad * 2);
    const y = h - pad - ((EFFICIENCY_SERIES[i] - min) / (max - min || 1)) * (h - pad * 2);
    return { x, y };
  };
  return (
    <div className="lp-chart-card lp-span">
      <div className="lp-chart-head">
        <b>Routing efficiency</b>
        <span>quality ↑ cost ↓ latency ↓ reliability ↑</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="lp-chart"
        role="img"
        aria-label="Illustrative line chart showing routing efficiency trending upward over time."
        onMouseLeave={() => setHot(null)}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad} x2={w - pad} y1={h * f} y2={h * f} className="lp-grid" />
        ))}
        <path d={`${d} L${w - pad} ${h - pad} L${pad} ${h - pad} Z`} className="lp-area" />
        <path d={d} className="lp-line" />
        {EFFICIENCY_SERIES.map((v, i) => {
          const p = xy(i);
          return (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={hot === i ? 5 : 2.6}
              className={`lp-pt${hot === i ? ' hot' : ''}`}
              onMouseEnter={() => setHot(i)}
            >
              <title>
                window {i + 1}: index {v}
              </title>
            </circle>
          );
        })}
        {hot !== null && (
          <g className="lp-tip" transform={`translate(${Math.min(xy(hot).x, w - 130)},${Math.max(xy(hot).y - 44, 4)})`}>
            <rect width="122" height="36" rx="8" />
            <text x="10" y="15">
              window {hot + 1}
            </text>
            <text x="10" y="29">
              efficiency {EFFICIENCY_SERIES[hot]}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function CostChart() {
  return (
    <div className="lp-chart-card">
      <div className="lp-chart-head">
        <b>Cost by model</b>
        <span>per example task</span>
      </div>
      <div className="lp-bars" role="img" aria-label="Illustrative bar chart: Claude-class is the selected path at roughly two thirds of the most expensive option.">
        {COST_BARS.map((b) => (
          <div key={b.name} className="lp-bar-row">
            <span>{b.name}</span>
            <i>
              <b style={{ width: `${b.value}%` }} className={b.selected ? 'sel' : ''} />
            </i>
            {b.selected && <em>selected path</em>}
          </div>
        ))}
      </div>
    </div>
  );
}

function LatencyChart() {
  const w = 560;
  const h = 170;
  const pad = 14;
  const all = [...LATENCY_FAST, ...LATENCY_SLOW];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  return (
    <div className="lp-chart-card">
      <div className="lp-chart-head">
        <b>Latency, routed vs unrouted</b>
        <span>ms per request</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="lp-chart" role="img" aria-label="Illustrative chart: routed requests hold a flat low latency while unrouted requests climb.">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad} x2={w - pad} y1={h * f} y2={h * f} className="lp-grid" />
        ))}
        <path d={path(LATENCY_SLOW)} className="lp-line slow" />
        <path d={path(LATENCY_FAST)} className="lp-line" />
      </svg>
      <div className="lp-mini-legend">
        <span>
          <i className="b" /> routed
        </span>
        <span>
          <i className="r" /> single-model baseline
        </span>
      </div>
    </div>
  );
}

function MixDonut() {
  const size = 150;
  const r = 58;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="lp-chart-card">
      <div className="lp-chart-head">
        <b>Routing mix</b>
        <span>share of decisions</span>
      </div>
      <div className="lp-donut-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} className="lp-donut" role="img" aria-label="Illustrative donut chart of routing share across four model families.">
          {ROUTE_MIX.map((m) => {
            const frac = m.share / 100;
            const dash = `${(frac * c).toFixed(1)} ${(c - frac * c).toFixed(1)}`;
            const rot = (acc / 100) * 360;
            acc += m.share;
            return (
              <circle
                key={m.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={m.color}
                strokeWidth="20"
                strokeDasharray={dash}
                transform={`rotate(${rot - 90} ${size / 2} ${size / 2})`}
              >
                <title>
                  {m.name}: {m.share}%
                </title>
              </circle>
            );
          })}
          <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="lp-donut-num">
            4
          </text>
          <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="lp-donut-lab">
            families
          </text>
        </svg>
        <ul className="lp-donut-legend">
          {ROUTE_MIX.map((m) => (
            <li key={m.name}>
              <i style={{ background: m.color }} />
              {m.name} <b>{m.share}%</b>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FailoverStrip() {
  return (
    <div className="lp-chart-card lp-span">
      <div className="lp-chart-head">
        <b>Reliability timeline</b>
        <span>degrade → cooldown → failover → continue</span>
      </div>
      <ol className="lp-timeline" aria-label="Illustrative failover timeline: primary healthy, latency degrading, cooldown armed, failover to standby, execution continues.">
        {FAILOVER_BEATS.map((b) => (
          <li key={b.t} className={`lp-tl-${b.state}`}>
            <code>{b.t}</code>
            <span>{b.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Analytics() {
  return (
    <section className="lp-section" id="analytics" aria-labelledby="analytics-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">ORCHESTRA INTELLIGENCE</p>
          <h2 id="analytics-h">Every decision leaves a trail.</h2>
          <p className="lp-lede">
            Usage trends, cost vs quality, context optimization, and execution savings — interactive
            demonstrations of the Intelligence suite. The authenticated console exposes the complete
            backend-measured suite.
          </p>
        </Reveal>
        <Reveal>
          <Suspense fallback={<div role="status" aria-label="Loading demos">Loading interactive demos…</div>}>
            <LandingIntelligenceGrid />
          </Suspense>
          <p className="lp-lede" style={{ marginTop: 12 }}>
            <a href="/console?view=intelligence">Open Orchestra Intelligence →</a>
          </p>
        </Reveal>
        <Reveal>
          <p className="lp-kicker">ROUTING ANALYTICS</p>
          <h2>Request-level evidence.</h2>
          <p className="lp-lede">
            Requests, latency, mix, cost and failovers — the same evidence the console streams live, summarized for
            the people who own the budget.
          </p>
        </Reveal>
        <Reveal className="lp-analytics">
          <div className="lp-stats" role="list" aria-label="Illustrative headline metrics">
            {ANALYTICS_HEADLINE.map((s) => (
              <div key={s.k} role="listitem">
                <b>{s.v}</b>
                <span>{s.k}</span>
              </div>
            ))}
            <span className="lp-demo-tag">Illustrative demo data</span>
          </div>
          <div className="lp-charts">
            <EfficiencyChart />
            <CostChart />
            <LatencyChart />
            <MixDonut />
            <FailoverStrip />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
