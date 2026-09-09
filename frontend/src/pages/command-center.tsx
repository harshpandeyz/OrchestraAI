import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Empty, Skeleton, fmtInt, fmtPct, fmtSec, relTime, usd } from '../components/ui';
import { EconomicsLegend, CostBasisBadge } from '../components/economics';
import { PageError } from '../components/product-states';
import type { AnalyticsBreakdown, AnalyticsOverview, EconomicState, SavingsResult, SavingsRunRow, TrendPoint, WaterfallRow } from '../types';
import '../styles/command-center.css';

function Metric({ label, value, detail, tone = '' }: { label: React.ReactNode; value: React.ReactNode; detail?: string; tone?: string }) {
  return <div className={`econ-metric ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  if (!data?.length) return <Empty what="Trend" hint="Complete a run to see measured economics over time." />;
  const max = Math.max(...data.flatMap((d) => [Number(d.baseline) || 0, Number(d.optimized) || 0]), 0.000001);
  const width = 640; const height = 190; const x = (i: number) => 28 + i * ((width - 50) / Math.max(1, data.length - 1));
  const y = (v: number) => height - 24 - (v / max) * (height - 48);
  const line = (key: 'baseline' | 'optimized') => data.map((d, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(Number(d[key]) || 0).toFixed(1)}`).join(' ');
  return <div className="trend-chart" aria-label="Modeled baseline versus optimized provider cost chart"><svg viewBox={`0 0 ${width} ${height}`} role="img">
    <path d={line('baseline')} className="chart-line baseline" /><path d={line('optimized')} className="chart-line optimized" />
    {data.map((d, i) => <g key={d.period || i}><circle cx={x(i)} cy={y(Number(d.baseline) || 0)} r="3.5" className="chart-dot baseline" /><circle cx={x(i)} cy={y(Number(d.optimized) || 0)} r="3.5" className="chart-dot optimized" /><text x={x(i)} y={height - 5} textAnchor="middle">{String(d.period || '').slice(5)}</text></g>)}
  </svg><div className="chart-legend"><span><i className="legend-dot baseline" />Modeled baseline</span><span><i className="legend-dot optimized" />Optimized provider cost</span></div></div>;
}

function economicState(result?: Partial<Pick<SavingsResult, 'calculationStatus' | 'economicOutcome' | 'status' | 'customerNetSavings'>>, runStatus?: string): EconomicState {
  if (result?.calculationStatus === 'incomplete' || result?.status === 'incomplete_run' || ['running', 'planning', 'waiting', 'idle'].includes(String(runStatus))) return 'incomplete';
  if (result?.calculationStatus === 'insufficient_data' || result?.status === 'insufficient_pricing_data') return 'insufficient_data';
  if (result?.economicOutcome) return result.economicOutcome;
  const net = Number(result?.customerNetSavings);
  return net > 0 ? 'saved' : net < 0 ? 'cost_increase' : 'unchanged';
}

function stateLabel(state: EconomicState): string {
  return ({ saved: 'SAVED', unchanged: 'NO SAVINGS', cost_increase: 'COST INCREASE', insufficient_data: 'INSUFFICIENT DATA', incomplete: 'INCOMPLETE' })[state];
}

function aggregateState(summary: AnalyticsOverview['summary']): EconomicState {
  const quality = summary.dataQuality;
  if (quality?.incompleteCount) return 'incomplete';
  if (quality?.insufficientCount) return 'insufficient_data';
  if (!summary.runCount) return 'insufficient_data';
  return economicState({ calculationStatus: 'verified_modeled', customerNetSavings: summary.customerNetSavings });
}

function StatePill({ result, runStatus }: { result?: Partial<SavingsResult>; runStatus?: string }) {
  const state = economicState(result, runStatus);
  return <span className={`pill sm ${state === 'saved' ? 'ok' : state === 'cost_increase' ? 'err' : 'neutral'}`} title={state === 'saved' || state === 'unchanged' || state === 'cost_increase' ? 'Canonical usage × immutable pricing snapshot; not an invoice' : 'The run does not contain enough evidence for a modeled savings result'}>{stateLabel(state)}</span>;
}

function useOverview() {
  const [data, setData] = useState<AnalyticsOverview | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; api.getOverview().then((r) => !cancelled && setData(r.analytics)).catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Unable to load overview')); return () => { cancelled = true; }; }, []);
  return { data, error };
}

export function OverviewPage() {
  const { data, error } = useOverview();
  if (error) return <div className="page"><PageError message={error} /><p className="recon-note">No economics are shown without backend data.</p></div>;
  if (!data) return <div className="page"><Skeleton lines={7} /></div>;
  const s = data.summary;
  const state = aggregateState(s);
  const headline = state === 'saved' ? `${usd(s.customerNetSavings)} kept this period` : state === 'cost_increase' ? `${s.customerNetSavings === null ? '—' : usd(Math.abs(s.customerNetSavings))} cost increase this period` : stateLabel(state);
  const failedRuns = (data.recentRuns || []).filter((r) => String(r.status).toLowerCase() === 'failed');
  return <div className="page command-page">
    <div className="page-header"><div><div className="eyebrow">CONTROL CENTER</div><h2>Overview</h2><p className="lede">Money first. Execution detail when you need to explain it.</p></div><StatePill result={{ calculationStatus: state === 'incomplete' ? 'incomplete' : state === 'insufficient_data' ? 'insufficient_data' : 'verified_modeled', economicOutcome: state === 'saved' || state === 'unchanged' || state === 'cost_increase' ? state : null, customerNetSavings: s.customerNetSavings }} /></div>
    {failedRuns.length > 0 && (
      <div className="banner warn" role="alert" style={{ margin: '0 0 12px' }}>
        <span><b>{failedRuns.length} run{failedRuns.length === 1 ? '' : 's'} need{failedRuns.length === 1 ? 's' : ''} attention.</b> {failedRuns.slice(0, 2).map((r) => r.title).join(' · ')} — open Approvals & inbox to triage.</span>
      </div>
    )}
    <section className="economics-hero"><div><span className="eyebrow">CUSTOMER ECONOMICS · BYOK</span><h1>{headline}</h1><p>{s.runCount ? `${s.runCount} run${s.runCount === 1 ? '' : 's'} · modeled where pricing and usage are available, not invoice-reconciled` : 'Run real traffic to establish your baseline.'}</p></div><div className="economics-badge"><strong>{fmtPct(s.savingsRate || 0)}</strong><span>eligible savings rate</span></div></section>
    <div className="econ-grid"><Metric label={<span>Modeled baseline <CostBasisBadge basis="modeled" title="Counterfactual reference cost from the SavingsEngine" /></span>} value={usd(s.baselineCost)} detail="Counterfactual reference cost" /><Metric label={<span>Actual provider cost <CostBasisBadge basis="actual" title="Metered provider spend — backend authoritative" /></span>} value={usd(s.optimizedProviderCost)} detail="Paid directly by you" /><Metric label={<span>Orchestra platform fee <CostBasisBadge basis="modeled" title="Fee on positive modeled savings only" /></span>} value={usd(s.platformFee)} detail="Fee on positive modeled savings" /><Metric label="Customer final cost" value={usd(s.customerFinalCost)} detail="Provider cost + platform fee" tone={s.customerNetSavings !== null && s.customerNetSavings > 0 ? 'positive' : ''} /></div>
    <EconomicsLegend compact />
    <section className="surface-card"><div className="surface-head"><div><h3>Spend & savings</h3><p>Every point comes from persisted run economics.</p></div><span className="chart-key">{fmtPct(s.savingsRate || 0)} rate</span></div><TrendChart data={data.spendTrend} /></section>
    <div className="two-col"><section className="surface-card"><div className="surface-head"><div><h3>By provider</h3><p>Observed optimized provider spend.</p></div></div>{data.providerBreakdown?.length ? <div className="breakdown-list">{data.providerBreakdown.map((r: AnalyticsBreakdown) => <div className="breakdown-row" key={r.provider}><span>{r.provider}</span><b>{usd(r.cost)}</b><small>{r.runs} call{r.runs === 1 ? '' : 's'}</small></div>)}</div> : <Empty what="Providers" />}</section><section className="surface-card"><div className="surface-head"><div><h3>Token composition</h3><p>Provider-reported where available.</p></div></div><div className="token-summary">{Object.entries(data.tokenComposition || {}).map(([key, value]) => <div key={key}><b>{fmtInt(value)}</b><span>{key.replace('Tokens', '')}</span></div>)}</div><div className="cache-callout"><span>Cache impact</span><b>{fmtPct(data.cacheImpact?.hitRate || 0)}</b><small>{data.cacheImpact?.hits || 0} hits · {data.cacheImpact?.misses || 0} misses</small></div></section></div>
    <section className="surface-card"><div className="surface-head"><div><h3>Recent runs</h3><p>Open any run for routing, context, trace, and pricing snapshots.</p></div></div>{data.recentRuns?.length ? <div className="recent-table">{data.recentRuns.slice(0, 8).map((r) => <div className="recent-row" key={r.runId}><span><b>{r.title}</b><small className="mono">{r.runId.slice(0, 12)}…</small></span><StatePill result={{ calculationStatus: r.calculationStatus, economicOutcome: r.economicOutcome, status: r.status, customerNetSavings: r.customerNetSavings }} /><b className={r.customerNetSavings !== null && r.customerNetSavings > 0 ? 'positive-text' : ''}>{usd(r.customerNetSavings)}</b><small>{relTime(r.date)}</small></div>)}</div> : <Empty what="Recent runs" hint="Your first completed run will appear here." />}</section>
  </div>;
}

function Waterfall({ rows }: { rows: WaterfallRow[] }) {
  return <div className="waterfall" aria-label="Savings waterfall">{rows.map((row, i) => <React.Fragment key={row.key}><div className={`waterfall-step ${row.kind}`}><span>{row.label}</span><strong>{usd(row.amount)}</strong></div>{i < rows.length - 1 && <span className="waterfall-arrow">→</span>}</React.Fragment>)}</div>;
}

export function SavingsPage() {
  const [data, setData] = useState<{ summary: AnalyticsOverview['summary']; runs: SavingsRunRow[]; waterfall: WaterfallRow[]; note: string } | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; api.getSavings().then((r) => !cancelled && setData(r)).catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Unable to load savings')); return () => { cancelled = true; }; }, []);
  if (error) return <div className="page"><PageError message={error} /><p className="recon-note">No savings evidence is shown without backend data.</p></div>;
  if (!data) return <div className="page"><Skeleton lines={7} /></div>;
  const s = data.summary;
  const state = aggregateState(s);
  return <div className="page command-page">
    <div className="page-header"><div><div className="eyebrow">THE HERO METRIC</div><h2>Savings</h2><p className="lede">Minimize total task cost subject to quality, latency, and reliability constraints.</p></div><StatePill result={{ calculationStatus: state === 'incomplete' ? 'incomplete' : state === 'insufficient_data' ? 'insufficient_data' : 'verified_modeled', economicOutcome: state === 'saved' || state === 'unchanged' || state === 'cost_increase' ? state : null, customerNetSavings: s.customerNetSavings }} /></div>
    <section className="savings-hero"><div><span className="eyebrow">NET CUSTOMER SAVINGS · <CostBasisBadge basis={state === 'saved' ? 'verified' : state === 'incomplete' ? 'incomplete' : state === 'insufficient_data' ? 'insufficient' : 'modeled'} /></span><h1>{state === 'saved' ? usd(s.customerNetSavings) : stateLabel(state)}</h1><p>{state === 'saved' ? 'After the Orchestra platform fee.' : state === 'cost_increase' ? 'The selected data cost more after optimization and the platform fee.' : 'The selected data contains no positive verified modeled savings.'}</p></div><div className="hero-stat"><span>SAVINGS RATE</span><b>{fmtPct(s.savingsRate || 0)}</b></div><div className="hero-stat"><span>RUNS</span><b>{s.runCount || 0}</b></div></section>
    <section className="surface-card"><div className="surface-head"><div><h3>Economic proof</h3><p>{data.note}</p></div></div><Waterfall rows={data.waterfall || []} /></section>
    <EconomicsLegend compact />
    <div className="econ-grid"><Metric label="Baseline" value={usd(s.baselineCost)} /><Metric label="Provider cost" value={usd(s.optimizedProviderCost)} /><Metric label="Platform fee" value={usd(s.platformFee)} /><Metric label="Final cost" value={usd(s.customerFinalCost)} /></div>
    <section className="surface-card"><div className="surface-head"><div><h3>Run-by-run evidence</h3><p>Negative, unchanged, incomplete, and insufficient outcomes stay visible.</p></div></div>{data.runs?.length ? <div className="savings-table"><div className="savings-table-head"><span>Task</span><span>Outcome</span><span>Baseline</span><span>Final cost</span><span>Net savings</span></div>{data.runs.map((row) => { const e: SavingsResult = row.economics; const good = Number(e.customerNetSavings) > 0; return <div className="savings-table-row" key={row.runId}><span><b>{row.title}</b><small className="mono">{row.runId.slice(0, 12)}…</small></span><StatePill result={e} runStatus={row.status} /><span>{usd(e.baselineCost)}</span><span>{usd(e.customerFinalCost)}</span><b className={good ? 'positive-text' : ''}>{usd(e.customerNetSavings)}</b></div>; })}</div> : <Empty what="Savings evidence" hint="Complete a run with known provider and reference pricing to see proof." />}</section>
  </div>;
}
