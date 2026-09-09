// Orchestra Intelligence — full analytics suite.
// Distinctive Orchestra product surface. Backend-authoritative, honest
// provenance, reusable chart system, responsive, accessible.
import React, { useMemo, useState } from 'react';
import { Empty, Skeleton, fmtSec, usd } from '../components/ui';
import {
  AreaChart, BarChart, ChartCard, ChartEmpty, ChartError, ChartLoading,
  Donut, FilterSelect, GranularitySelector, LineChart, MetricCard,
  ProvenanceBadge, RankingTable, ScaleToggle, ScatterPlot,
  TimeRangeSelector, colorFor, fmtMs, fmtNum, fmtPct01, fmtUsd,
} from './charts';
import type { IntelligenceFilters, LeaderboardRow } from './types';
import { DEFAULT_FILTERS, useIntelligence } from './useIntelligence';
import './intelligence.css';

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'models', label: 'Top Models' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'tasks', label: 'Top Models by Task' },
  { id: 'cost', label: 'Cost per Session' },
  { id: 'share', label: 'Market Share' },
  { id: 'benchmarks', label: 'Benchmarks' },
  { id: 'fastest', label: 'Fastest Models' },
  { id: 'languages', label: 'Languages' },
  { id: 'programming', label: 'Programming' },
  { id: 'context', label: 'Context Length' },
  { id: 'tools', label: 'Tool Calls' },
  { id: 'images', label: 'Images' },
  { id: 'workloads', label: 'Top Workloads' },
] as const;

type NavId = (typeof NAV)[number]['id'];

function shortModel(id: string): string {
  if (!id) return '—';
  const parts = id.split('/');
  const last = parts[parts.length - 1];
  return last.length > 26 ? `${last.slice(0, 24)}…` : last;
}

export function IntelligencePage() {
  const [filters, setFilters] = useState<IntelligenceFilters>(DEFAULT_FILTERS);
  const [section, setSection] = useState<NavId>('overview');
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [benchA, setBenchA] = useState<string | null>(null);
  const [benchB, setBenchB] = useState<string | null>(null);
  const { data, error, loading, reload } = useIntelligence(filters);
  const set = (p: Partial<IntelligenceFilters>) => setFilters((f) => ({ ...f, ...p }));

  const modelOptions = useMemo(() => {
    const ids = new Set<string>();
    (data?.leaderboard.rows || []).forEach((r) => ids.add(r.model));
    (data?.topModels.models || []).forEach((m) => ids.add(m));
    return Array.from(ids).map((id) => ({ id, label: shortModel(id) }));
  }, [data]);
  const providerOptions = useMemo(() => {
    const ids = new Set<string>();
    (data?.marketShare.providers || []).forEach((p) => ids.add(p.provider));
    return Array.from(ids).filter((x) => x && x !== 'unknown').map((id) => ({ id, label: id }));
  }, [data]);
  const taskOptions = useMemo(() => {
    const ids = new Set<string>();
    (data?.tasks.categories || []).forEach((c) => (c.classifierCategories || []).forEach((x) => ids.add(x)));
    (data?.workloads.perWorkload || []).forEach((w) => ids.add(w.workload));
    return Array.from(ids).map((id) => ({ id, label: id }));
  }, [data]);

  return (
    <div className="page oi-page">
      <div className="page-header">
        <div>
          <div className="eyebrow">ORCHESTRA INTELLIGENCE</div>
          <h2>Model intelligence, measured</h2>
          <p className="lede">
            Cost, quality, latency, reliability, and context efficiency — from canonical run economics.
            {data?.meta && <> <ProvenanceBadge value={data.meta.provenance} /> <span className="oi-muted">{data.meta.runCount} runs · {data.meta.verifiedCount} verified</span></>}
          </p>
        </div>
      </div>

      {data?.meta?.note && <p className="oi-note" role="status">{data.meta.note}</p>}

      <div className="oi-filters" role="toolbar" aria-label="Intelligence filters">
        <TimeRangeSelector value={filters.range} onChange={(range) => set({ range })} />
        <GranularitySelector value={filters.granularity} onChange={(granularity) => set({ granularity })} />
        <ScaleToggle value={filters.scale} onChange={(scale) => set({ scale })} />
        <FilterSelect label="Model" value={filters.model} options={modelOptions} onChange={(model) => set({ model })} />
        <FilterSelect label="Provider" value={filters.provider} options={providerOptions} onChange={(provider) => set({ provider })} />
        <FilterSelect label="Task" value={filters.taskCategory} options={taskOptions} onChange={(taskCategory) => set({ taskCategory })} />
        {(filters.model || filters.provider || filters.taskCategory) && (
          <button className="icon-btn sm" onClick={() => set({ model: null, provider: null, taskCategory: null })}>Clear filters</button>
        )}
      </div>

      <div className="oi-layout">
        <nav className="oi-nav" aria-label="Intelligence sections">
          {NAV.map((n) => (
            <button key={n.id} className={`oi-navitem${section === n.id ? ' active' : ''}`}
              aria-current={section === n.id ? 'page' : undefined} onClick={() => setSection(n.id)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="oi-main">
          {loading && <div className="oi-stack"><ChartLoading lines={7} /></div>}
          {error && !loading && <ChartError message={error} onRetry={() => reload()} />}
          {!loading && !error && !data && <ChartEmpty title="Intelligence unavailable" />}
          {!loading && !error && data && (
            <>
              {section === 'overview' && <OverviewSection data={data} go={setSection} />}
              {section === 'models' && <TopModelsSection data={data} scale={filters.scale} onScale={(scale) => set({ scale })} hidden={hidden} setHidden={setHidden} />}
              {section === 'leaderboard' && <LeaderboardSectionView data={data} />}
              {section === 'tasks' && <TasksSectionView data={data} />}
              {section === 'cost' && <CostSectionView data={data} />}
              {section === 'share' && <ShareSectionView data={data} />}
              {section === 'benchmarks' && <BenchmarksSectionView data={data} benchA={benchA} setBenchA={setBenchA} benchB={benchB} setBenchB={setBenchB} />}
              {section === 'fastest' && <FastestSectionView data={data} />}
              {section === 'languages' && <LanguagesSectionView data={data} />}
              {section === 'programming' && <ProgrammingSectionView data={data} />}
              {section === 'context' && <ContextSectionView data={data} />}
              {section === 'tools' && <ToolsSectionView data={data} />}
              {section === 'images' && <ImagesSectionView data={data} />}
              {section === 'workloads' && <WorkloadsSectionView data={data} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Overview: differentiator hero + headline cards ----------
function Recommendations({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const rows = (data.leaderboard.rows || []).filter((r) => r.runs > 0);
  const recs: { delta: string; title: string; body: string }[] = [];
  const withCost = rows.filter((r) => r.costPerTask !== null && r.quality !== null) as (LeaderboardRow & { costPerTask: number; quality: number })[];
  if (withCost.length >= 2) {
    const sorted = [...withCost].sort((a, b) => a.costPerTask - b.costPerTask);
    const cheap = sorted[0]; const pricey = sorted[sorted.length - 1];
    if (pricey.costPerTask > cheap.costPerTask * 1.1 && cheap.quality >= 0.6) {
      const pct = Math.round((1 - cheap.costPerTask / pricey.costPerTask) * 100);
      recs.push({ delta: `↓ ${pct}% cost`, title: `Move simple tasks to ${shortModel(cheap.model)}`, body: `$${cheap.costPerTask.toFixed(4)}/task at quality ${cheap.quality.toFixed(2)} vs $${pricey.costPerTask.toFixed(4)} for ${shortModel(pricey.model)}. Measured in this slice — verify on your workload.` });
    }
  }
  const withRel = rows.filter((r) => r.reliability !== null) as (LeaderboardRow & { reliability: number })[];
  if (withRel.length >= 2) {
    const sorted = [...withRel].sort((a, b) => b.reliability - a.reliability);
    const best = sorted[0]; const worst = sorted[sorted.length - 1];
    if (best.reliability - worst.reliability >= 0.03) {
      recs.push({ delta: `↑ ${((best.reliability - worst.reliability) * 100).toFixed(1)}pts reliability`, title: `Prefer ${shortModel(best.model)} over ${shortModel(worst.model)} for critical tasks`, body: `${(best.reliability * 100).toFixed(0)}% vs ${(worst.reliability * 100).toFixed(0)}% observed reliability in this slice.` });
    }
  }
  const withLat = rows.filter((r) => r.avgLatencyMs !== null) as (LeaderboardRow & { avgLatencyMs: number })[];
  if (withLat.length >= 2) {
    const sorted = [...withLat].sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);
    const fast = sorted[0]; const slow = sorted[sorted.length - 1];
    if (slow.avgLatencyMs > fast.avgLatencyMs * 1.25) {
      recs.push({ delta: `↓ ${((slow.avgLatencyMs - fast.avgLatencyMs) / 1000).toFixed(1)}s latency`, title: `Reuse context with ${shortModel(fast.model)} for latency-sensitive tasks`, body: `${(fast.avgLatencyMs / 1000).toFixed(1)}s vs ${(slow.avgLatencyMs / 1000).toFixed(1)}s average in this slice.` });
    }
  }
  if (!recs.length) {
    return (
      <ChartCard title="What needs attention?" subtitle="Recommendations appear once runs with measured cost, reliability, and latency accumulate." provenance={data.leaderboard.provenance}>
        <ChartEmpty title="No recommendations yet" hint="Complete runs with known pricing to unlock optimization opportunities. Nothing is guessed." />
      </ChartCard>
    );
  }
  return (
    <ChartCard title={`${recs.length} optimization opportunit${recs.length === 1 ? 'y' : 'ies'}`} subtitle="What's wrong, what's changing, and what to do — computed from this slice only." provenance={data.leaderboard.provenance}>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {recs.slice(0, 3).map((r, i) => (
          <li key={i}><b>{r.delta}</b> — {r.title}<br /><span className="oi-muted">{r.body}</span></li>
        ))}
      </ol>
    </ChartCard>
  );
}

function OverviewSection({ data, go }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']>; go: (s: NavId) => void }) {
  const lb = data.leaderboard.rows.slice(0, 5);
  const flow = data.executionFlow;
  return (
    <div className="oi-stack">
      <Recommendations data={data} />
      <ChartCard title="Orchestra optimizes execution — not a model catalog"
        subtitle="Incoming task → verified savings. Every stage shows measured values from this slice."
        provenance={flow.provenance}
        footnote="Savings are modeled vs the reference snapshot — called verified only when calculationStatus is verified_modeled.">
        {flow.state === 'READY' ? (
          <ol className="oi-flow" aria-label="Optimal execution path">
            {flow.stages.map((s, i) => (
              <li key={s.key} className="oi-flow-step">
                <span className="oi-flow-dot" aria-hidden="true">{i + 1}</span>
                <div><b>{s.label}</b><span>{s.detail}</span></div>
                {i < flow.stages.length - 1 && <span className="oi-flow-arrow" aria-hidden="true">↓</span>}
              </li>
            ))}
          </ol>
        ) : <ChartEmpty title="Execution path — no data" hint={flow.note} />}
      </ChartCard>

      <div className="oi-grid-4">
        <MetricCard label="Runs observed" value={fmtNum(data.meta.runCount)} detail={`${data.meta.verifiedCount} verified modeled`} />
        <MetricCard label="Avg cost / run" value={fmtUsd(data.cost.stats?.average)} detail={data.cost.stats ? `median ${fmtUsd(data.cost.stats.median)} · p95 ${fmtUsd(data.cost.stats.p95)}` : 'No metered costs'} />
        <MetricCard label="Cache reuse saved" value={fmtUsd(data.context.stats?.cacheReuseSavedUsd)} detail={data.context.stats ? `${fmtNum(data.context.stats.totalItems)} context items` : 'No context evidence'} />
        <MetricCard label="Tool calls / run" value={data.tools.summary ? data.tools.summary.callsPerRun.toFixed(2) : '—'} detail={data.tools.summary ? `${fmtNum(data.tools.summary.totalCalls)} total calls` : 'No tool telemetry'} />
      </div>

      <ChartCard title="Cost vs quality — where value lives" subtitle="Each bubble is a model. Higher is better quality; left is cheaper."
        provenance={data.leaderboard.provenance}
        actions={<button className="icon-btn sm" onClick={() => go('leaderboard')}>Open leaderboard</button>}>
        {lb.length ? (
          <ScatterPlot
            xLabel="Cost per task ($)" yLabel="Quality (0–1)"
            points={lb.filter((r) => r.costPerTask !== null && r.quality !== null).map((r, i) => ({
              key: r.model, label: shortModel(r.model), x: Number(r.costPerTask), y: Number(r.quality),
              size: r.runs, color: colorFor(i), hint: r.explanation,
            }))}
          />
        ) : <ChartEmpty title="Cost vs quality — no data" hint="Complete runs with known pricing to populate this view." />}
      </ChartCard>

      <div className="oi-grid-2">
        <ChartCard title="Top models" subtitle="Share of model calls in this slice." provenance={data.topModels.provenance}
          actions={<button className="icon-btn sm" onClick={() => go('models')}>Open trend</button>}>
          {data.topModels.totals.length ? (
            <BarChart rows={data.topModels.totals.slice(0, 6).map((t, i) => ({ key: t.model, label: shortModel(t.model), value: t.calls, color: colorFor(i), hint: `${t.runs} runs · ${fmtUsd(t.cost)}` }))} unit="calls" />
          ) : <ChartEmpty title="Top models — no data" />}
        </ChartCard>
        <ChartCard title="Top workloads" subtitle="Where spend concentrates." provenance={data.workloads.provenance}
          actions={<button className="icon-btn sm" onClick={() => go('workloads')}>Open workloads</button>}>
          {data.workloads.perWorkload.length ? (
            <BarChart rows={data.workloads.perWorkload.slice(0, 6).map((w, i) => ({ key: w.workload, label: w.workload, value: w.runs, color: colorFor(i), hint: `avg ${fmtUsd(w.avgCost)}` }))} unit="runs" />
          ) : <Empty what="Workloads" hint="Run tasks to establish workload mix." />}
        </ChartCard>
      </div>
      <p className="oi-note">Value score formula: <code className="mono">{data.meta.valueScoreFormula}</code></p>
    </div>
  );
}

// ---------- Top Models ----------
function TopModelsSection({ data, scale, onScale, hidden, setHidden }: {
  data: NonNullable<ReturnType<typeof useIntelligence>['data']>; scale: 'linear' | 'log'; onScale: (v: 'linear' | 'log') => void;
  hidden: Record<string, boolean>; setHidden: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) {
  const s = data.topModels;
  const visibleModels = s.models.filter((m) => !hidden[m]);
  const labels = s.series.map((p) => p.period);
  const series = visibleModels.slice(0, 8).map((m) => ({
    key: m, label: shortModel(m), color: colorFor(s.models.indexOf(m)),
    values: s.series.map((p) => p.perModel[m] ?? 0),
  }));
  const total = s.series.reduce((a, p) => a + p.total, 0);
  if (s.state === 'INSUFFICIENT_DATA') return <ChartCard title="Top models" provenance={s.provenance} subtitle="Usage over time"><ChartEmpty title="Top models — no data" hint={s.note} /></ChartCard>;
  return (
    <div className="oi-stack">
      <ChartCard title="Top models — usage over time" subtitle={`${s.granularity} aggregation · ${total.toLocaleString()} calls in slice`}
        provenance={s.provenance} footnote={s.note}
        actions={<ScaleToggle value={scale} onChange={onScale} />}>
        <div className="oi-legend oi-toggles" role="group" aria-label="Model visibility">
          {s.models.slice(0, 12).map((m, mi) => (
            <button key={m} className={`chip${hidden[m] ? '' : ' on'}`} aria-pressed={!hidden[m]}
              onClick={() => setHidden((h) => ({ ...h, [m]: !h[m] }))}>
              <i style={{ background: colorFor(mi) }} />{shortModel(m)}
            </button>
          ))}
        </div>
        {scale === 'log' ? (
          <LineChart labels={labels} series={series} yLabel="calls" logScale />
        ) : (
          <AreaChart labels={labels} series={series} />
        )}
      </ChartCard>
      <ChartCard title="Model breakdown" subtitle="Exact values — calls, runs, metered cost." provenance={s.provenance}>
        <RankingTable
          ariaLabel="Model breakdown"
          rows={s.totals}
          defaultSort="calls"
          columns={[
            { key: 'model', label: 'Model', render: (r) => <span title={(r as unknown as { model: string }).model}>{shortModel((r as unknown as { model: string }).model)}</span>, sortValue: (r) => (r as unknown as { model: string }).model },
            { key: 'provider', label: 'Provider', render: (r) => (r as unknown as { provider: string }).provider, sortValue: (r) => (r as unknown as { provider: string }).provider },
            { key: 'calls', label: 'Calls', align: 'right', render: (r) => fmtNum((r as unknown as { calls: number }).calls), sortValue: (r) => (r as unknown as { calls: number }).calls },
            { key: 'runs', label: 'Runs', align: 'right', render: (r) => fmtNum((r as unknown as { runs: number }).runs), sortValue: (r) => (r as unknown as { runs: number }).runs },
            { key: 'cost', label: 'Cost', align: 'right', render: (r) => fmtUsd((r as unknown as { cost: number }).cost), sortValue: (r) => (r as unknown as { cost: number }).cost },
            { key: 'savings', label: 'Modeled savings', align: 'right', render: (r) => fmtUsd((r as unknown as { modeledSavings: number }).modeledSavings), sortValue: (r) => (r as unknown as { modeledSavings: number }).modeledSavings },
          ]}
        />
      </ChartCard>
    </div>
  );
}

// ---------- Leaderboard ----------
function LeaderboardSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const lb = data.leaderboard;
  const [q, setQ] = useState('');
  const [minRuns, setMinRuns] = useState(0);
  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    return lb.rows.filter((r) => (!needle || `${r.model} ${r.provider}`.toLowerCase().includes(needle)) && r.runs >= minRuns);
  }, [lb.rows, q, minRuns]);
  if (lb.state === 'INSUFFICIENT_DATA') {
    return <ChartCard title="Leaderboard" provenance={lb.provenance} subtitle="Ranked models"><ChartEmpty title="Leaderboard — no data" hint={lb.note} /></ChartCard>;
  }
  const cell = (v: number | null, fmt: (n: number) => string) => (v === null ? <span className="oi-na">—</span> : fmt(v));
  return (
    <div className="oi-stack">
      <ChartCard title="Leaderboard" subtitle="Sortable, filterable. No meaningless single score — the formula is defined below."
        provenance={lb.provenance} footnote={`Formula: ${lb.formula} — ${lb.note}`}>
        <div className="oi-filters oi-inline">
          <input className="search" placeholder="Filter models…" aria-label="Filter leaderboard" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="oi-filter"><span>Min runs</span>
            <select value={minRuns} onChange={(e) => setMinRuns(Number(e.target.value))} aria-label="Minimum runs">
              <option value={0}>Any</option><option value={1}>≥ 1</option><option value={3}>≥ 3</option><option value={10}>≥ 10</option>
            </select>
          </label>
        </div>
        <RankingTable<LeaderboardRow>
          ariaLabel="Model leaderboard"
          rows={rows}
          defaultSort="valueScore"
          columns={[
            { key: 'model', label: 'Model', render: (r) => <span><b>{shortModel(r.model)}</b><br /><small className="oi-muted">{r.provider}</small><br /><small className="oi-muted">{r.explanation}</small></span>, sortValue: (r) => r.model },
            { key: 'valueScore', label: 'Value', align: 'right', render: (r) => cell(r.valueScore, (n) => n.toFixed(3)), sortValue: (r) => r.valueScore },
            { key: 'quality', label: 'Quality', align: 'right', render: (r) => cell(r.quality, (n) => n.toFixed(2)), sortValue: (r) => r.quality },
            { key: 'successRate', label: 'Success', align: 'right', render: (r) => cell(r.successRate, (n) => fmtPct01(n)), sortValue: (r) => r.successRate },
            { key: 'reliability', label: 'Reliability', align: 'right', render: (r) => cell(r.reliability, (n) => n.toFixed(2)), sortValue: (r) => r.reliability },
            { key: 'p50', label: 'P50', align: 'right', render: (r) => cell(r.p50, fmtMs), sortValue: (r) => r.p50 },
            { key: 'costPerTask', label: 'Cost/task', align: 'right', render: (r) => cell(r.costPerTask, fmtUsd), sortValue: (r) => r.costPerTask },
            { key: 'costPerSuccessfulTask', label: '$/success', align: 'right', render: (r) => cell(r.costPerSuccessfulTask, fmtUsd), sortValue: (r) => r.costPerSuccessfulTask },
            { key: 'contextEfficiency', label: 'Ctx eff.', align: 'right', render: (r) => cell(r.contextEfficiency, (n) => fmtPct01(n)), sortValue: (r) => r.contextEfficiency },
            { key: 'cacheEfficiency', label: 'Cache', align: 'right', render: (r) => cell(r.cacheEfficiency, (n) => fmtPct01(n)), sortValue: (r) => r.cacheEfficiency },
          ]}
        />
      </ChartCard>
    </div>
  );
}

// ---------- Tasks ----------
function TasksSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const t = data.tasks;
  if (t.state === 'INSUFFICIENT_DATA') return <ChartCard title="Top models by task" provenance={t.provenance} subtitle="Task slices"><ChartEmpty title="Top models by task — no data" hint={t.note} /></ChartCard>;
  const pick = (m: string | null) => (m ? shortModel(m) : <span className="oi-na">—</span>);
  return (
    <ChartCard title="Top models by task" subtitle="Best quality · best value · lowest cost · fastest · most reliable per task." provenance={t.provenance} footnote={t.note}>
      <div className="oi-table-wrap">
        <table className="oi-table" aria-label="Top models by task">
          <thead><tr><th scope="col">Task</th><th scope="col">Best quality</th><th scope="col">Best value</th><th scope="col">Lowest cost</th><th scope="col">Fastest</th><th scope="col">Most reliable</th></tr></thead>
          <tbody>
            {t.categories.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                <td>{c.state === 'READY' ? pick(c.bestQuality) : <span className="oi-na">insufficient</span>}</td>
                <td>{c.state === 'READY' ? pick(c.bestValue) : <span className="oi-na">insufficient</span>}</td>
                <td>{c.state === 'READY' ? pick(c.lowestCost) : <span className="oi-na">insufficient</span>}</td>
                <td>{c.state === 'READY' ? pick(c.fastest) : <span className="oi-na">insufficient</span>}</td>
                <td>{c.state === 'READY' ? pick(c.mostReliable) : <span className="oi-na">insufficient</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

// ---------- Cost ----------
function CostSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const c = data.cost;
  if (c.state === 'INSUFFICIENT_DATA' || !c.stats) return <ChartCard title="Cost per session" provenance={c.provenance} subtitle="Spend distribution"><ChartEmpty title="Cost per session — no data" hint={c.note} /></ChartCard>;
  const labels = c.series.map((p) => p.period);
  return (
    <div className="oi-stack">
      <div className="oi-grid-4">
        <MetricCard label="Average" value={usd(c.stats.average)} detail={`${c.stats.count} sessions`} />
        <MetricCard label="Median" value={usd(c.stats.median)} detail="Typical session" />
        <MetricCard label="P95" value={usd(c.stats.p95)} detail="Tail spend" />
        <MetricCard label="Total" value={usd(c.stats.total)} detail={`baseline ${usd(c.stats.baselineCost)}`} />
      </div>
      <ChartCard title="Cost over time" subtitle="Average · median · p95 per period. Backend-authoritative — frontend never prices independently." provenance={c.provenance} footnote={c.note}>
        <LineChart
          labels={labels}
          series={[
            { key: 'avg', label: 'Average', color: '#0C7A5C', values: c.series.map((p) => p.average) },
            { key: 'med', label: 'Median', color: '#2F7AC2', values: c.series.map((p) => p.median) },
            { key: 'p95', label: 'P95', color: '#BE4444', values: c.series.map((p) => p.p95), dashed: true },
          ]}
          yLabel="$"
        />
      </ChartCard>
      <div className="oi-grid-2">
        <ChartCard title="Token composition" subtitle="Provider-reported where available." provenance={c.provenance}>
          <BarChart rows={[
            { key: 'in', label: 'Input', value: c.stats.inputTokens, color: '#2F7AC2' },
            { key: 'out', label: 'Output', value: c.stats.outputTokens, color: '#0C7A5C' },
            { key: 'cache', label: 'Cached', value: c.stats.cachedTokens, color: '#8A5A00' },
          ]} unit="tokens" />
        </ChartCard>
        <ChartCard title="Distribution" subtitle="Session-cost spread (min → max)." provenance={c.provenance}>
          <div className="oi-kv"><span>Min</span><b>{usd(c.stats.min)}</b></div>
          <div className="oi-kv"><span>Max</span><b>{usd(c.stats.max)}</b></div>
          <div className="oi-kv"><span>Sessions</span><b>{c.stats.count}</b></div>
          <p className="oi-note">Input / output / cache-savings splits come from canonical step usage × immutable pricing snapshots.</p>
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Market share ----------
function ShareSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const m = data.marketShare;
  if (m.state === 'INSUFFICIENT_DATA') return <ChartCard title="Usage share" provenance={m.provenance} subtitle="Provider · model · workload"><ChartEmpty title="Usage share — no data" hint={m.note} /></ChartCard>;
  return (
    <div className="oi-stack">
      <ChartCard title="Usage share — Orchestra observed" subtitle="Shares within this workspace. Never external market statistics." provenance={m.provenance} footnote={m.note}>
        <div className="oi-grid-2">
          <div>
            <h4 className="oi-h4">Provider share (by cost)</h4>
            <Donut centerLabel="providers" centerValue={String(m.providers.length)}
              slices={m.providers.map((p, i) => ({ key: p.provider, label: p.provider, value: p.cost, color: colorFor(i) }))} />
          </div>
          <div>
            <h4 className="oi-h4">Model share (by calls)</h4>
            <BarChart rows={m.models.slice(0, 8).map((x, i) => ({ key: x.model, label: shortModel(x.model), value: x.calls, color: colorFor(i), hint: `${fmtPct01(x.shareByCalls)} of calls` }))} unit="calls" />
          </div>
        </div>
      </ChartCard>
      <ChartCard title="Workload share" subtitle="Runs per workload category." provenance={m.provenance}>
        <BarChart rows={m.workloads.map((w, i) => ({ key: w.workload, label: w.workload, value: w.runs, color: colorFor(i), hint: `${fmtPct01(w.share)} of runs` }))} unit="runs" />
      </ChartCard>
    </div>
  );
}

// ---------- Benchmarks ----------
function BenchmarksSectionView({ data, benchA, setBenchA, benchB, setBenchB }: {
  data: NonNullable<ReturnType<typeof useIntelligence>['data']>;
  benchA: string | null; setBenchA: (v: string | null) => void;
  benchB: string | null; setBenchB: (v: string | null) => void;
}) {
  const b = data.benchmarks;
  const models = data.leaderboard.rows.map((r) => r.model);
  const table = useMemo(() => {
    if (!b.summaries.length) return [];
    const byModel = new Map<string, { passSum: number; passN: number; attempts: number }>();
    for (const s of b.summaries) {
      for (const r of s.results) {
        if (benchA && benchB && r.modelId !== benchA && r.modelId !== benchB) continue;
        const a = byModel.get(r.modelId) || { passSum: 0, passN: 0, attempts: 0 };
        a.attempts += r.attempts;
        if (r.passRate !== null) { a.passSum += r.passRate * r.attempts; a.passN += r.attempts; }
        byModel.set(r.modelId, a);
      }
    }
    return Array.from(byModel.entries()).map(([model, a]) => ({
      model, attempts: a.attempts, passRate: a.passN ? a.passSum / a.passN : null,
    }));
  }, [b.summaries, benchA, benchB]);
  if (b.state === 'INSUFFICIENT_DATA') {
    return <ChartCard title="Benchmarks" provenance={b.provenance} subtitle="Model comparison"><ChartEmpty title="No validated benchmark data" hint={b.note} /></ChartCard>;
  }
  return (
    <div className="oi-stack">
      <ChartCard title="Benchmarks" subtitle="Recorded attempts only — no synthetic scores. Compare model A vs B or all models." provenance={b.provenance} footnote={b.note}>
        <div className="oi-filters oi-inline">
          <FilterSelect label="Model A" value={benchA} options={models.map((m) => ({ id: m, label: shortModel(m) }))} onChange={setBenchA} />
          <FilterSelect label="Model B" value={benchB} options={models.map((m) => ({ id: m, label: shortModel(m) }))} onChange={setBenchB} />
          {(benchA || benchB) && <button className="icon-btn sm" onClick={() => { setBenchA(null); setBenchB(null); }}>Clear comparison</button>}
        </div>
        <RankingTable
          ariaLabel="Benchmark comparison"
          rows={table}
          defaultSort="passRate"
          columns={[
            { key: 'model', label: 'Model', render: (r) => shortModel((r as unknown as { model: string }).model), sortValue: (r) => (r as unknown as { model: string }).model },
            { key: 'passRate', label: 'Pass rate', align: 'right', render: (r) => { const v = (r as unknown as { passRate: number | null }).passRate; return v === null ? '—' : fmtPct01(v, 1); }, sortValue: (r) => (r as unknown as { passRate: number | null }).passRate },
            { key: 'attempts', label: 'Attempts', align: 'right', render: (r) => fmtNum((r as unknown as { attempts: number }).attempts), sortValue: (r) => (r as unknown as { attempts: number }).attempts },
          ]}
        />
      </ChartCard>
      {b.cases.map((c) => (
        <ChartCard key={c.id} title={c.id} subtitle={`${c.category} · ${c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}`} provenance={b.provenance}>
          <p className="oi-note">{c.prompt}</p>
        </ChartCard>
      ))}
    </div>
  );
}

// ---------- Fastest ----------
function FastestSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const l = data.latency;
  if (l.state === 'INSUFFICIENT_DATA') return <ChartCard title="Fastest models" provenance={l.provenance} subtitle="Latency"><ChartEmpty title="Fastest models — no data" hint={l.note} /></ChartCard>;
  return (
    <ChartCard title="Fastest models" subtitle="P50 · P95 · completion latency. Time-to-first-token appears when captured." provenance={l.provenance} footnote={l.note}>
      <RankingTable
        ariaLabel="Fastest models"
        rows={l.perModel}
        defaultSort="p50"
        columns={[
          { key: 'model', label: 'Model', render: (r) => <span><b>{shortModel((r as unknown as { model: string }).model)}</b><br /><small className="oi-muted">{(r as unknown as { provider: string }).provider}</small></span>, sortValue: (r) => (r as unknown as { model: string }).model },
          { key: 'p50', label: 'P50', align: 'right', render: (r) => fmtSec((r as unknown as { p50: number | null }).p50), sortValue: (r) => (r as unknown as { p50: number | null }).p50 },
          { key: 'p95', label: 'P95', align: 'right', render: (r) => fmtSec((r as unknown as { p95: number | null }).p95), sortValue: (r) => (r as unknown as { p95: number | null }).p95 },
          { key: 'mean', label: 'Mean', align: 'right', render: (r) => fmtSec((r as unknown as { mean: number | null }).mean), sortValue: (r) => (r as unknown as { mean: number | null }).mean },
          { key: 'ttft', label: 'TTFT', align: 'right', render: () => <span className="oi-na" title="Time-to-first-token is not captured by current telemetry.">not captured</span>, sortValue: () => null },
          { key: 'samples', label: 'Samples', align: 'right', render: (r) => fmtNum((r as unknown as { samples: number }).samples), sortValue: (r) => (r as unknown as { samples: number }).samples },
        ]}
      />
    </ChartCard>
  );
}

// ---------- Languages / Programming (honest empty) ----------
function LanguagesSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const l = data.languages;
  return (
    <ChartCard title="Languages" subtitle="Performance by natural language — only when language evidence exists." provenance={l.provenance}>
      <ChartEmpty title="Insufficient data" hint={l.note} />
    </ChartCard>
  );
}

function ProgrammingSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const l = data.languages;
  return (
    <ChartCard title="Programming languages" subtitle="Success · latency · cost · quality · model preference — only when observed." provenance={l.provenance}>
      <ChartEmpty title="Insufficient data" hint="No language-attributed telemetry is recorded. JavaScript, TypeScript, Python, Java, C++ and others appear only when runs carry language evidence — nothing is invented." />
    </ChartCard>
  );
}

// ---------- Context ----------
function ContextSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const c = data.context;
  if (c.state === 'INSUFFICIENT_DATA' || !c.stats) return <ChartCard title="Context efficiency" provenance={c.provenance} subtitle="Tokens · compression · cache"><ChartEmpty title="Context — no data" hint={c.note} /></ChartCard>;
  const st = c.stats;
  const utilPct = st.avgUtilization !== null ? Math.round(st.avgUtilization * 100) : 0;
  return (
    <div className="oi-stack">
      <ChartCard title="Context efficiency" subtitle="Raw vs optimized context with actual numbers." provenance={c.provenance} footnote={c.note}>
        <div className="oi-ctx">
          <div className="oi-ctx-row"><span>Raw context (avg used)</span><div className="oi-bar-track"><div className="oi-bar-fill" style={{ width: '100%', background: '#64748B' }} /></div><b>{fmtNum(st.avgUsedTokens)} tokens</b></div>
          <div className="oi-ctx-row"><span>Optimized (utilization {utilPct}%)</span><div className="oi-bar-track"><div className="oi-bar-fill sel" style={{ width: `${Math.max(2, utilPct)}%`, background: '#0C7A5C' }} /></div><b>{fmtNum(Math.round(st.avgUsedTokens * (st.avgUtilization || 0)))} tokens in window</b></div>
        </div>
        <div className="oi-grid-4">
          <MetricCard label="Avg window" value={`${fmtNum(st.avgWindowTokens)}`} detail="tokens" />
          <MetricCard label="Utilization" value={st.avgUtilization !== null ? fmtPct01(st.avgUtilization) : '—'} detail="used / window" />
          <MetricCard label="Compressed" value={st.compressionRatio !== null ? fmtPct01(st.compressionRatio) : '—'} detail={`${st.compressedItems}/${st.totalItems} items`} />
          <MetricCard label="Cache reuse saved" value={fmtUsd(st.cacheReuseSavedUsd)} detail="metered, not estimated" />
        </div>
      </ChartCard>
      <ChartCard title="Per-run context" subtitle="Utilization, cache reuse, and cost impact." provenance={c.provenance}>
        <RankingTable
          ariaLabel="Per-run context"
          rows={c.perRun.slice(0, 50)}
          defaultSort="utilization"
          columns={[
            { key: 'title', label: 'Run', render: (r) => <span title={(r as unknown as { runId: string }).runId}>{String((r as unknown as { title: string }).title).slice(0, 42)}</span>, sortValue: (r) => String((r as unknown as { title: string }).title) },
            { key: 'usedTokens', label: 'Used', align: 'right', render: (r) => fmtNum((r as unknown as { usedTokens: number | null }).usedTokens), sortValue: (r) => (r as unknown as { usedTokens: number | null }).usedTokens },
            { key: 'utilization', label: 'Util.', align: 'right', render: (r) => { const v = (r as unknown as { utilization: number | null }).utilization; return v === null ? '—' : fmtPct01(v); }, sortValue: (r) => (r as unknown as { utilization: number | null }).utilization },
            { key: 'savedUsd', label: 'Saved', align: 'right', render: (r) => fmtUsd((r as unknown as { savedUsd: number }).savedUsd), sortValue: (r) => (r as unknown as { savedUsd: number }).savedUsd },
          ]}
        />
      </ChartCard>
    </div>
  );
}

// ---------- Tools ----------
function ToolsSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const t = data.tools;
  if (t.state === 'INSUFFICIENT_DATA' || !t.summary) return <ChartCard title="Tool call analytics" provenance={t.provenance} subtitle="Calls · success · latency"><ChartEmpty title="Tool calls — no data" hint={t.note} /></ChartCard>;
  return (
    <div className="oi-stack">
      <div className="oi-grid-4">
        <MetricCard label="Total calls" value={fmtNum(t.summary.totalCalls)} detail={`${t.summary.runsWithTools}/${t.summary.totalRuns} runs use tools`} />
        <MetricCard label="Calls / run" value={t.summary.callsPerRun.toFixed(2)} detail="across slice" />
        <MetricCard label="Most-used" value={t.perTool[0] ? t.perTool[0].tool : '—'} detail={t.perTool[0] ? `${fmtNum(t.perTool[0].calls)} calls` : ''} />
        <MetricCard label="Best success" value={(() => { const best = [...t.perTool].filter((x) => x.successRate !== null).sort((a, b) => (b.successRate || 0) - (a.successRate || 0))[0]; return best ? fmtPct01(best.successRate) : '—'; })()} detail="per-tool rate" />
      </div>
      <ChartCard title="Most-used tools" subtitle="Calls, success rate, and latency. Retry attribution is null until step-level attempts exist." provenance={t.provenance} footnote={t.note}>
        <BarChart rows={t.perTool.slice(0, 10).map((x, i) => ({ key: x.tool, label: x.tool, value: x.calls, color: colorFor(i), hint: `${fmtPct01(x.successRate)} success · ${fmtMs(x.avgLatencyMs)} avg` }))} unit="calls" />
      </ChartCard>
      <ChartCard title="Tool detail" subtitle="Filter by project / workspace / time with the toolbar above." provenance={t.provenance}>
        <RankingTable
          ariaLabel="Tool detail"
          rows={t.perTool}
          defaultSort="calls"
          columns={[
            { key: 'tool', label: 'Tool', render: (r) => <b>{(r as unknown as { tool: string }).tool}</b>, sortValue: (r) => (r as unknown as { tool: string }).tool },
            { key: 'calls', label: 'Calls', align: 'right', render: (r) => fmtNum((r as unknown as { calls: number }).calls), sortValue: (r) => (r as unknown as { calls: number }).calls },
            { key: 'callsPerRun', label: 'Per run', align: 'right', render: (r) => Number((r as unknown as { callsPerRun: number }).callsPerRun).toFixed(2), sortValue: (r) => (r as unknown as { callsPerRun: number }).callsPerRun },
            { key: 'successRate', label: 'Success', align: 'right', render: (r) => { const v = (r as unknown as { successRate: number | null }).successRate; return v === null ? '—' : fmtPct01(v); }, sortValue: (r) => (r as unknown as { successRate: number | null }).successRate },
            { key: 'avgLatencyMs', label: 'Latency', align: 'right', render: (r) => fmtMs((r as unknown as { avgLatencyMs: number | null }).avgLatencyMs), sortValue: (r) => (r as unknown as { avgLatencyMs: number | null }).avgLatencyMs },
            { key: 'retryRate', label: 'Retry', align: 'right', render: () => <span className="oi-na">—</span>, sortValue: () => null },
          ]}
        />
        <p className="oi-note">{t.compatibilityNote}</p>
      </ChartCard>
    </div>
  );
}

// ---------- Images ----------
function ImagesSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const im = data.images;
  return (
    <ChartCard title="Image / multimodal analytics" subtitle="Image-capable models, volume, cost, latency, success." provenance={im.provenance}>
      {im.state === 'READY' ? (
        <RankingTable ariaLabel="Image capable models" rows={im.capableModels} defaultSort="model"
          columns={[
            { key: 'model', label: 'Model', render: (r) => shortModel((r as unknown as { model: string }).model), sortValue: (r) => (r as unknown as { model: string }).model },
            { key: 'provider', label: 'Provider', render: (r) => (r as unknown as { provider: string }).provider, sortValue: (r) => (r as unknown as { provider: string }).provider },
          ]} />
      ) : <ChartEmpty title={im.capableModels.length ? 'No image task volume observed' : 'No image telemetry'} hint={im.note} />}
    </ChartCard>
  );
}

// ---------- Workloads ----------
function WorkloadsSectionView({ data }: { data: NonNullable<ReturnType<typeof useIntelligence>['data']> }) {
  const w = data.workloads;
  if (w.state === 'INSUFFICIENT_DATA') return <ChartCard title="Top workloads" provenance={w.provenance} subtitle="Volume · cost · success"><ChartEmpty title="Top workloads — no data" hint={w.note} /></ChartCard>;
  return (
    <ChartCard title="Top workloads" subtitle="Volume · cost · success · latency · savings opportunity." provenance={w.provenance} footnote={w.note}>
      <RankingTable
        ariaLabel="Top workloads"
        rows={w.perWorkload}
        defaultSort="runs"
        columns={[
          { key: 'workload', label: 'Workload', render: (r) => <b style={{ textTransform: 'capitalize' }}>{(r as unknown as { workload: string }).workload}</b>, sortValue: (r) => (r as unknown as { workload: string }).workload },
          { key: 'runs', label: 'Runs', align: 'right', render: (r) => fmtNum((r as unknown as { runs: number }).runs), sortValue: (r) => (r as unknown as { runs: number }).runs },
          { key: 'totalCost', label: 'Cost', align: 'right', render: (r) => fmtUsd((r as unknown as { totalCost: number | null }).totalCost), sortValue: (r) => (r as unknown as { totalCost: number | null }).totalCost },
          { key: 'successRate', label: 'Success', align: 'right', render: (r) => { const v = (r as unknown as { successRate: number | null }).successRate; return v === null ? '—' : fmtPct01(v); }, sortValue: (r) => (r as unknown as { successRate: number | null }).successRate },
          { key: 'avgLatencyMs', label: 'Latency', align: 'right', render: (r) => fmtMs((r as unknown as { avgLatencyMs: number | null }).avgLatencyMs), sortValue: (r) => (r as unknown as { avgLatencyMs: number | null }).avgLatencyMs },
          { key: 'savingsOpportunity', label: 'Savings opp.', align: 'right', render: (r) => fmtUsd((r as unknown as { savingsOpportunity: number }).savingsOpportunity), sortValue: (r) => (r as unknown as { savingsOpportunity: number }).savingsOpportunity },
        ]}
      />
    </ChartCard>
  );
}

export default IntelligencePage;
