// Orchestra Intelligence — landing-page interactive demos (lighter, visual).
// 4 widgets: usage trend, cost vs quality scatter, context optimization,
// execution savings flow. All ILLUSTRATIVE demo data, clearly labelled.
// Lazy-loadable: no backend fetch, tiny hand-written datasets.
import React, { useState } from 'react';
import { LineChart, ProvenanceBadge, ScatterPlot } from './charts';
import { DEMO_CONTEXT, DEMO_FLOW, DEMO_SCATTER, DEMO_TREND } from './demo';
import './intelligence.css';

export function LandingTrend() {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const visible = DEMO_TREND.series.filter((s) => !hidden[s.model]);
  return (
    <div className="oi-mini" aria-label="Demo: usage trend">
      <h4>Top models — usage trend</h4>
      <p>Illustrative product demonstration. <ProvenanceBadge value="ILLUSTRATIVE" /></p>
      <div className="oi-legend" role="group" aria-label="Toggle models">
        {DEMO_TREND.series.map((s) => (
          <button key={s.model} className="chip" aria-pressed={!hidden[s.model]} onClick={() => setHidden((h) => ({ ...h, [s.model]: !h[s.model] }))}>
            <i style={{ background: s.color }} />{s.model}
          </button>
        ))}
      </div>
      <LineChart labels={DEMO_TREND.periods} series={visible.map((s) => ({ key: s.model, label: s.model, color: s.color, values: s.values }))} height={170} yLabel="calls" />
      <p><a href="/console?view=intelligence" className="link-btn">Open live Intelligence →</a></p>
    </div>
  );
}

export function LandingScatter() {
  return (
    <div className="oi-mini" aria-label="Demo: cost versus quality">
      <h4>Cost vs quality — where value lives</h4>
      <p>Illustrative demo data. <ProvenanceBadge value="ILLUSTRATIVE" /></p>
      <ScatterPlot
        xLabel="Cost per task ($)" yLabel="Quality"
        points={DEMO_SCATTER.points.map((p, i) => ({
          key: p.model, label: p.model, x: p.cost, y: p.quality, size: p.runs,
          color: ['#0C7A5C', '#2F7AC2', '#8A5A00', '#6D5BD0', '#0E9F6E'][i % 5],
          hint: `${p.runs} runs · ${p.latencyMs}ms`,
        }))}
        height={200}
      />
    </div>
  );
}

export function LandingContext() {
  const c = DEMO_CONTEXT;
  const pct = Math.round((c.optimizedTokens / c.rawTokens) * 100);
  return (
    <div className="oi-mini" aria-label="Demo: context optimization">
      <h4>Context optimization</h4>
      <p>Illustrative demo data. <ProvenanceBadge value="ILLUSTRATIVE" /></p>
      <div className="oi-ctx">
        <div className="oi-ctx-row"><span>Raw context</span><div className="oi-bar-track"><div className="oi-bar-fill" style={{ width: '100%', background: '#64748B' }} /></div><b>{c.rawTokens.toLocaleString()}</b></div>
        <div className="oi-ctx-row"><span>Optimized ({pct}%)</span><div className="oi-bar-track"><div className="oi-bar-fill sel" style={{ width: `${pct}%`, background: '#0C7A5C' }} /></div><b>{c.optimizedTokens.toLocaleString()}</b></div>
      </div>
      <p className="oi-note">Cache reuse {c.cachedTokens.toLocaleString()} tokens · saved ${c.savedUsd} · latency {c.latencyBeforeMs}ms → {c.latencyAfterMs}ms.</p>
    </div>
  );
}

export function LandingFlow() {
  return (
    <div className="oi-mini" aria-label="Demo: execution optimization">
      <h4>Orchestra execution optimization</h4>
      <p>Illustrative demo data — optimizing execution, not listing models. <ProvenanceBadge value="ILLUSTRATIVE" /></p>
      <ol className="oi-flow">
        {DEMO_FLOW.stages.map((s, i) => (
          <li key={s.key} className="oi-flow-step">
            <span className="oi-flow-dot" aria-hidden="true">{i + 1}</span>
            <div><b>{s.label}</b><span>{s.detail}</span></div>
            {i < DEMO_FLOW.stages.length - 1 && <span className="oi-flow-arrow" aria-hidden="true">↓</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function LandingIntelligenceGrid() {
  return (
    <div className="oi-landing-grid" aria-label="Orchestra Intelligence demos">
      <LandingTrend />
      <LandingScatter />
      <LandingContext />
      <LandingFlow />
    </div>
  );
}
