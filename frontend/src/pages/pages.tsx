import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { resetOnboarding } from '../components/Onboarding';
import { ProvidersSection } from '../components/Providers';
import { Empty, StatusDot, displaySnippet, fmtPct, fmtSec, relTime, usd } from '../components/ui';
import { ParetoChart, useModelProfiles, ModelWhy } from '../components/models/ModelIntelligence';
import type { EvaluationRecord, HealthResponse, PrincipalInfo, RuntimeConfigResponse, RuntimePreset, RuntimeSettings } from '../types';
import '../styles/pages.css';

/* ───────────────── MODELS ───────────────── */

type ModelSort = 'quality' | 'cost' | 'latency' | 'context' | 'reliability';
type ModelFilter = 'all' | 'healthy' | 'degraded' | 'down' | 'unknown' | 'active';

function fmtCtx(window: number | undefined | null): string {
  if (!window) return '—';
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(0)}M`;
  if (window >= 1000) return `${(window / 1000).toFixed(0)}k`;
  return String(window);
}

function statusLabel(s: string | undefined | null): string {
  const v = String(s || '').toLowerCase();
  if (v === 'healthy' || v === 'active') return 'HEALTHY';
  if (v === 'degraded') return 'DEGRADED';
  if (v === 'down' || v === 'unavailable') return 'UNAVAILABLE';
  if (v === 'unknown') return 'UNKNOWN';
  if (v === 'enabled') return 'ENABLED';
  if (v === 'blocked') return 'BLOCKED';
  if (v === 'running') return 'RUNNING';
  if (v === 'failed') return 'FAILED';
  return (v || 'UNKNOWN').toUpperCase();
}

function statusPillClass(s: string | undefined | null): string {
  const v = String(s || '').toLowerCase();
  if (v === 'healthy' || v === 'active' || v === 'enabled') return 'ok';
  if (v === 'degraded' || v === 'running') return 'warn';
  if (v === 'down' || v === 'unavailable' || v === 'blocked' || v === 'failed') return 'err';
  return 'neutral';
}

/** Provenance badge: provider-reported vs observed vs demo vs unknown. */
function Prov({ source, demoLabel }: { source: string | undefined; demoLabel?: string }) {
  const s = String(source || 'unknown').toLowerCase();
  if (s === 'observed') return <span className="prov-badge observed" title="Measured from real runs">OBSERVED</span>;
  if (s === 'provider') return <span className="prov-badge" title="Reported by the provider">PROVIDER</span>;
  if (s === 'demo') return <span className="prov-badge demo" title="Demo sample data — not a real measurement">{demoLabel || 'DEMO'}</span>;
  return <span className="prov-badge demo" title="No data yet — appears after real usage">NOT MEASURED</span>;
}

function measuredOrDash(v: number | null | undefined, fmt: (n: number) => string): React.ReactNode {
  if (v === null || v === undefined || Number.isNaN(v)) return <span className="na">—</span>;
  return <>{fmt(v)}</>;
}

export function ModelsPage() {
  const { state, dispatch } = useRuntime();
  const [sort, setSort] = useState<ModelSort>('quality');
  const [filter, setFilter] = useState<ModelFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ ts: string; kind: string; label: string }[]>([]);
  const [catalogMeta, setCatalogMeta] = useState<{ updatedAt: string | null } | null>(null);

  const activeId = state.server.snapshot?.activeModelId;
  const q = state.ui.modelQuery.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    api.getModels().then(({ meta }) => { if (!cancelled && meta) setCatalogMeta({ updatedAt: meta.updatedAt }); }).catch(() => {});
    api.getModelChanges(8).then(({ changes: c }) => { if (!cancelled) setChanges(c || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    let r = state.server.models.filter((m) => !q || (`${m.name} ${m.provider} ${m.id} ${(m.capabilities || []).join(' ')}`).toLowerCase().includes(q));
    if (filter === 'healthy') r = r.filter((m) => m.status === 'healthy');
    else if (filter === 'degraded') r = r.filter((m) => m.status === 'degraded');
    else if (filter === 'down') r = r.filter((m) => m.status === 'down' || m.status === 'unavailable');
    else if (filter === 'unknown') r = r.filter((m) => m.status === 'unknown');
    else if (filter === 'active') r = r.filter((m) => m.id === activeId);
    // Unknowns sort last — never pose as best/worst.
    const num = (v: number | null | undefined, fallback: number) => (v === null || v === undefined || Number.isNaN(v) ? fallback : v);
    const score = {
      quality: (m: (typeof r)[number]) => -(num(m.quality, -1)),
      cost: (m: (typeof r)[number]) => num(m.outputPer1k, Infinity),
      latency: (m: (typeof r)[number]) => num(m.avgLatencyMs, Infinity),
      context: (m: (typeof r)[number]) => -(num(m.contextWindow, -1)),
      reliability: (m: (typeof r)[number]) => -(num(m.reliability, -1)),
    }[sort];
    return [...r].sort((a, b) => score(a) - score(b));
  }, [state.server.models, q, sort, filter, activeId]);

  const toggleExpand = useCallback((id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] })), []);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [prev[1], id] : [...prev, id]));
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await api.refreshModels();
      if (res.skipped) {
        setRefreshMsg(`Refresh skipped — ${res.skipped}`);
      } else if (res.ok) {
        setRefreshMsg(`Catalog updated — ${res.discovered || 0} new · ${res.updated || 0} updated · ${res.prices || 0} price changes`);
        const { models, meta } = await api.getModels();
        dispatch({ type: 'models/set', models });
        if (meta) setCatalogMeta({ updatedAt: meta.updatedAt });
        api.getModelChanges(8).then(({ changes: c }) => setChanges(c || [])).catch(() => {});
      } else {
        setRefreshMsg(res.error || 'Refresh failed');
      }
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, dispatch]);

  const sorts: { id: ModelSort; label: string }[] = [
    { id: 'quality', label: 'Best quality' },
    { id: 'cost', label: 'Lowest cost' },
    { id: 'latency', label: 'Fastest' },
    { id: 'context', label: 'Largest context' },
    { id: 'reliability', label: 'Most reliable' },
  ];

  const filters: { id: ModelFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'healthy', label: 'Healthy' },
    { id: 'degraded', label: 'Degraded' },
    { id: 'down', label: 'Unavailable' },
    { id: 'unknown', label: 'Unmeasured' },
  ];

  const compareModels = compareIds
    .map((id) => state.server.models.find((m) => m.id === id))
    .filter((m): m is (typeof state.server.models)[number] => !!m);
  const profiles = useModelProfiles();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Model Intelligence</h2>
          <p className="lede">What each model is good at, how it performs in this workspace, what it costs, and how reliable it is. {state.server.models.length} registered.</p>
        </div>
        <button className="icon-btn sm" onClick={refresh} disabled={refreshing} aria-label="Refresh model catalog from provider">
          {refreshing ? 'Refreshing…' : 'Refresh catalog'}
        </button>
      </div>
      {(refreshMsg || catalogMeta?.updatedAt) && (
        <p className="note" role="status">
          {refreshMsg || ''}{refreshMsg && catalogMeta?.updatedAt ? ' · ' : ''}{catalogMeta?.updatedAt ? `Last updated ${relTime(catalogMeta.updatedAt)}` : ''}
        </p>
      )}
      {changes.length > 0 && (
        <div className="note" role="status" aria-label="Recent catalog changes">
          Recent changes: {changes.slice(0, 3).map((c) => c.label).join(' · ')}
        </div>
      )}
      <div className="toolbar" role="toolbar" aria-label="Model filters">
        <div className="search-wrap">
          <input className="search" placeholder="Search models by name, provider…" aria-label="Search models" value={state.ui.modelQuery} onChange={(e) => dispatch({ type: 'ui/set', patch: { modelQuery: e.target.value } })} />
          {state.ui.modelQuery && <button className="search-clear" aria-label="Clear search" onClick={() => dispatch({ type: 'ui/set', patch: { modelQuery: '' } })}>×</button>}
        </div>
        <div className="toolbar-group">
          {filters.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="toolbar-sep" aria-hidden="true" />
        <div className="toolbar-group">
          {sorts.map((s) => (
            <button key={s.id} className="chip" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      {state.server.models.length > 0 && (
        <section aria-label="Quality versus cost frontier" style={{ marginTop: 4 }}>
          <ParetoChart models={state.server.models} />
        </section>
      )}
      {rows.length === 0 ? (
        <Empty what="Models" hint={state.server.models.length ? 'No models match this filter.' : 'No model metadata is currently available.'}
          action={!state.server.models.length ? <button className="icon-btn sm" onClick={refresh} disabled={refreshing}>Refresh catalog</button> : undefined} />
      ) : (
        <div className="model-grid">
          {rows.map((m) => {
            const isActive = m.id === activeId;
            const isExpanded = !!expanded[m.id];
            const inCompare = compareIds.includes(m.id);
            return (
              <article key={m.id} className={`model-card${isActive ? ' active' : ''}${isExpanded ? ' expanded' : ''}`} aria-label={`${m.name} model card`}>
                <button className="model-card-header" onClick={() => toggleExpand(m.id)} aria-expanded={isExpanded} aria-label={`Expand details for ${m.name}`}>
                  <div className="mc-top">
                    <StatusDot status={m.status} />
                    <b title={m.id}>{m.name}</b>
                    {isActive && <span className="pill info sm">ACTIVE</span>}
                    <span className={`pill sm ${statusPillClass(m.status)}`}>{statusLabel(m.status)}</span>
                  </div>
                  <div className="mc-prov">{m.provider}</div>
                  <div className="mc-caps">
                    {(m.capabilities || []).length ? m.capabilities.map((c) => <span key={c} className="cap">{c}</span>) : <span className="cap dim">no capabilities</span>}
                  </div>
                  <div className="mc-stats">
                    <span title="Context window">{fmtCtx(m.contextWindow)} ctx</span>
                    <span title="Quality — observed or not measured">q {m.quality !== null && m.quality !== undefined ? m.quality.toFixed(2) : <span className="na">not measured</span>}</span>
                    <span title="Average latency — observed or not measured">{m.avgLatencyMs !== null && m.avgLatencyMs !== undefined ? fmtSec(m.avgLatencyMs) : <span className="na">not measured</span>}</span>
                    <span title="Reliability — observed or not measured">{m.reliability !== null && m.reliability !== undefined ? fmtPct(m.reliability, 0) : <span className="na">not measured</span>}</span>
                  </div>
                  <div className="mc-pricing">
                    {m.pricingSource === 'unknown' || m.inputPer1k === null ? (
                      <span title="No pricing reported">price unavailable</span>
                    ) : (
                      <>
                        <span title="Input price per 1M tokens">in ${(m.inputPer1k * 1000).toFixed(2)}</span>
                        <span title="Output price per 1M tokens">out ${((m.outputPer1k ?? 0) * 1000).toFixed(2)}</span>
                        <Prov source={m.pricingSource} />
                      </>
                    )}
                  </div>
                </button>
                {isExpanded && (
                  <div className="mc-details" role="region" aria-label={`${m.name} details`}>
                    <div className="mc-detail-grid">
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Quality</span>
                        <span className="mc-detail-value mono">{m.quality !== null && m.quality !== undefined ? m.quality.toFixed(3) : 'Not measured'} <Prov source={m.qualitySource} /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Latency</span>
                        <span className="mc-detail-value mono">{m.avgLatencyMs !== null && m.avgLatencyMs !== undefined ? fmtSec(m.avgLatencyMs) : 'Not measured'} <Prov source={m.latencySource} /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Reliability</span>
                        <span className="mc-detail-value mono">{m.reliability !== null && m.reliability !== undefined ? fmtPct(m.reliability, 1) : 'Not measured'} <Prov source={m.reliabilitySource} /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Context</span>
                        <span className="mc-detail-value mono">{m.contextWindow ? `${fmtCtx(m.contextWindow)} tokens` : 'Unavailable'} <Prov source={m.contextSource} /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Health</span>
                        <span className="mc-detail-value"><span className={`pill sm ${statusPillClass(m.status)}`}>{statusLabel(m.status)}</span> <Prov source={m.healthSource === 'unlisted' ? 'unknown' : m.healthSource} demoLabel="SAMPLE" /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Observed usage</span>
                        <span className="mc-detail-value mono">{m.observed && m.observed.samples > 0 ? `${m.observed.samples} runs${m.observed.lastObservedAt ? ` · last ${relTime(m.observed.lastObservedAt)}` : ''}` : 'No runs yet'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Routing eligibility</span>
                        <span className="mc-detail-value">{m.status === 'unavailable' || m.status === 'down' ? 'Excluded from routing' : 'Eligible for routing'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Provider</span>
                        <span className="mc-detail-value">{m.provider}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Lifecycle</span>
                        <span className="mc-detail-value"><ModelWhy model={m} profile={profiles[m.id]} /></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Good at</span>
                        <span className="mc-detail-value">{profiles[m.id]?.strengths?.length ? profiles[m.id].strengths!.slice(0, 3).join(' · ') : (m.capabilities || []).length ? (m.capabilities || []).join(' · ') : 'Unknown — no capability signal recorded'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">In this workspace</span>
                        <span className="mc-detail-value mono">{(() => {
                          const tp = profiles[m.id]?.taskPerformance || {};
                          const entries = Object.entries(tp).slice(0, 3);
                          if (!entries.length) return m.observed?.samples ? `${m.observed.samples} observed runs` : 'No workspace runs yet';
                          return entries.map(([k, v]) => `${k}: ${v.successRate != null ? fmtPct(v.successRate, 0) : '—'}${v.samples ? ` (${v.samples})` : ''}`).join(' · ');
                        })()}</span>
                      </div>
                    </div>
                    <details className="oa-details">
                      <summary>Raw provider metadata</summary>
                      <pre className="oa-tool-output">{JSON.stringify({ id: m.id, name: m.name, provider: m.provider, source: m.source }, null, 1)}</pre>
                    </details>
                    <div className="nr-actions" style={{ justifyContent: 'flex-start' }}>
                      <button className="icon-btn sm" aria-pressed={inCompare} disabled={!inCompare && compareIds.length >= 2}
                        title={inCompare ? 'Remove from comparison' : compareIds.length >= 2 ? 'Comparison holds 2 models' : 'Add to comparison'}
                        onClick={(e) => { e.stopPropagation(); toggleCompare(m.id); }}>
                        {inCompare ? 'Remove from compare' : 'Compare'}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {compareModels.length > 0 && (
        <CompareTable models={compareModels} onRemove={(id) => toggleCompare(id)} onClear={() => setCompareIds([])} />
      )}
    </div>
  );
}

function CompareTable({ models, onRemove, onClear }: { models: { id: string; name: string; provider: string; status?: string; contextWindow: number | null; quality: number | null; avgLatencyMs: number | null; reliability: number | null; inputPer1k: number | null; outputPer1k: number | null; capabilities: string[] }[]; onRemove: (id: string) => void; onClear: () => void }) {
  const num = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? null : v);
  const best = {
    cost: (() => { const vs = models.map((m) => num(m.outputPer1k)); return vs.every((v) => v !== null) ? (models.reduce((a, b) => ((a.outputPer1k ?? Infinity) <= (b.outputPer1k ?? Infinity) ? a : b)).id) : null; })(),
    latency: (() => { const vs = models.map((m) => num(m.avgLatencyMs)); return vs.every((v) => v !== null) ? (models.reduce((a, b) => ((a.avgLatencyMs ?? Infinity) <= (b.avgLatencyMs ?? Infinity) ? a : b)).id) : null; })(),
    context: (() => { const vs = models.map((m) => num(m.contextWindow)); return vs.every((v) => v !== null) ? (models.reduce((a, b) => ((a.contextWindow ?? -1) >= (b.contextWindow ?? -1) ? a : b)).id) : null; })(),
    reliability: (() => { const vs = models.map((m) => num(m.reliability)); return vs.every((v) => v !== null) ? (models.reduce((a, b) => ((a.reliability ?? -1) >= (b.reliability ?? -1) ? a : b)).id) : null; })(),
  };
  const cell = (id: string, kind: keyof typeof best) => (best[kind] === id ? 'win' : '');
  const money = (per1k: number | null | undefined) => (per1k === null || per1k === undefined ? '—' : `$${(per1k * 1000).toFixed(2)} / 1M`);
  return (
    <div className="compare-table-wrap" role="region" aria-label="Model comparison">
      <table className="compare-table">
        <thead>
          <tr>
            <th scope="col">Trade-off</th>
            {models.map((m) => (
              <th key={m.id} scope="col">{m.name} <button className="link-btn" onClick={() => onRemove(m.id)} aria-label={`Remove ${m.name} from comparison`}>remove</button></th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr><th scope="row">Provider</th>{models.map((m) => <td key={m.id}>{m.provider}</td>)}</tr>
          <tr><th scope="row">Cheapest output</th>{models.map((m) => <td key={m.id} className={`mono ${cell(m.id, 'cost')}`}>{money(m.outputPer1k)}</td>)}</tr>
          <tr><th scope="row">Fastest observed</th>{models.map((m) => <td key={m.id} className={`mono ${cell(m.id, 'latency')}`}>{m.avgLatencyMs !== null && m.avgLatencyMs !== undefined ? fmtSec(m.avgLatencyMs) : 'Not measured'}</td>)}</tr>
          <tr><th scope="row">Largest context</th>{models.map((m) => <td key={m.id} className={`mono ${cell(m.id, 'context')}`}>{m.contextWindow ? `${fmtCtx(m.contextWindow)} tokens` : 'Unavailable'}</td>)}</tr>
          <tr><th scope="row">Most reliable</th>{models.map((m) => <td key={m.id} className={`mono ${cell(m.id, 'reliability')}`}>{m.reliability !== null && m.reliability !== undefined ? fmtPct(m.reliability, 1) : 'Not measured'}</td>)}</tr>
          <tr><th scope="row">Quality</th>{models.map((m) => <td key={m.id} className="mono">{m.quality !== null && m.quality !== undefined ? m.quality.toFixed(2) : 'Not measured'}</td>)}</tr>
          <tr><th scope="row">Capabilities</th>{models.map((m) => <td key={m.id}>{(m.capabilities || []).join(', ') || '—'}</td>)}</tr>
        </tbody>
      </table>
      <div className="nr-actions" style={{ justifyContent: 'flex-start', padding: '8px 12px' }}>
        <button className="link-btn" onClick={onClear}>Clear comparison</button>
      </div>
    </div>
  );
}

/* ───────────────── TOOLS ───────────────── */

export function ToolsPage() {
  const { state, dispatch } = useRuntime();
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'blocked'>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = state.ui.toolQuery.toLowerCase();

  const rows = useMemo(() => {
    let r = state.server.tools.filter(t => !q || (t.name + ' ' + t.description).toLowerCase().includes(q));
    if (statusFilter === 'enabled') r = r.filter(t => t.status === 'enabled');
    else if (statusFilter === 'blocked') r = r.filter(t => t.status !== 'enabled');
    return r;
  }, [state.server.tools, q, statusFilter]);

  const toggleExpand = useCallback((name: string) => setExpanded(p => ({ ...p, [name]: !p[name] })), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Tools</h2>
          <p className="lede">{rows.length} registered. Tool registry and execution capabilities.</p>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label="Tool filters">
        <div className="search-wrap">

          <input className="search" placeholder="Search tools by name or description…" aria-label="Search tools" value={state.ui.toolQuery} onChange={e => dispatch({ type: 'ui/set', patch: { toolQuery: e.target.value } })} />
          {state.ui.toolQuery && <button className="search-clear" aria-label="Clear search" onClick={() => dispatch({ type: 'ui/set', patch: { toolQuery: '' } })}>&times;</button>}
        </div>
        <div className="toolbar-group">
          {(['all', 'enabled', 'blocked'] as const).map(s => (
            <button key={s} className="chip" aria-pressed={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {s === 'all' ? 'All' : s === 'enabled' ? 'Enabled' : 'Blocked'}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty what="Tools" hint={state.server.tools.length ? 'No tools match this filter.' : 'No tools are registered.'} />
      ) : (
        <div className="tool-grid">
          {rows.map(t => {
            const blocked = t.status !== 'enabled';
            const isExpanded = !!expanded[t.name];
            const authStatus = blocked ? 'BLOCKED' : 'AUTHORIZED';
            return (
              <article key={t.name} className={`tool-card${blocked ? ' blocked' : ''}${t.lastStatus === 'running' ? ' running' : ''}${isExpanded ? ' expanded' : ''}`}>
                <button className="tool-card-header" onClick={() => toggleExpand(t.name)} aria-expanded={isExpanded} aria-label={`Expand details for ${t.name}`}>
                  <div className="mc-top">
                    {t.lastStatus === 'running' ? <span className="livedot" aria-hidden="true" /> : <StatusDot status={blocked ? 'down' : t.lastStatus === 'failed' ? 'failed' : 'idle'} />}
                    <b style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{t.name}</b>
                    <span className={`pill sm ${blocked ? 'err' : 'ok'}`}>{authStatus}</span>
                    {t.lastStatus === 'running' && <span className="pill warn sm">RUNNING</span>}
                  </div>
                  <p className="tool-desc">{t.description || 'No description provided.'}</p>
                  <div className="mc-stats">
                    <span title="Total calls">{t.calls} calls</span>
                    <span title="Average latency">{fmtSec(t.avgLatencyMs)} avg</span>
                    <span title="Success rate">{fmtPct(t.successRate, 0)} success</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="tool-details" role="region" aria-label={`${t.name} details`}>
                    <div className="mc-detail-grid">
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Tool Name</span>
                        <span className="mc-detail-value mono">{t.name}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Status</span>
                        <span className="mc-detail-value"><span className={`pill sm ${blocked ? 'err' : 'ok'}`}>{authStatus}</span></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Last Status</span>
                        <span className="mc-detail-value">{t.lastStatus ? statusLabel(t.lastStatus) : 'UNKNOWN'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Total Calls</span>
                        <span className="mc-detail-value mono">{t.calls}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Avg Latency</span>
                        <span className="mc-detail-value mono">{fmtSec(t.avgLatencyMs)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Success Rate</span>
                        <span className="mc-detail-value mono">{fmtPct(t.successRate, 1)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Purpose</span>
                        <span className="mc-detail-value">{t.description || 'Unknown — no purpose recorded.'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Schema</span>
                        <span className="mc-detail-value mono">Unknown — parameter schema not exposed by /api/tools.</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Side effects</span>
                        <span className="mc-detail-value">Unknown — not classified by the backend; approvals gate risky calls.</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Permissions</span>
                        <span className="mc-detail-value">{blocked ? 'BLOCKED by registry status' : 'Allowed subject to run toolPolicy'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Risk</span>
                        <span className="mc-detail-value">{blocked ? 'Blocked — cannot execute' : t.lastStatus === 'failed' ? 'Elevated — last call failed (observed)' : 'Unknown — no risk metadata exposed'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Last used</span>
                        <span className="mc-detail-value mono">{t.calls > 0 ? `${t.calls} calls observed` : 'Never observed in this session'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────── MEMORY ───────────────── */

export function MemoryPage() {
  const { state, dispatch } = useRuntime();
  const [scope, setScope] = useState<'all' | 'working' | 'longterm'>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = state.ui.memQuery.toLowerCase();

  const rows = useMemo(() => {
    let r = state.server.memItems.filter(m => !q || (m.title + ' ' + m.snippet + ' ' + m.source).toLowerCase().includes(q));
    if (scope !== 'all') r = r.filter(m => m.scope === scope);
    return [...r].sort((a, b) => (b.importance - a.importance) || (new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()));
  }, [state.server.memItems, q, scope]);

  const toggleExpand = useCallback((id: string) => setExpanded(p => ({ ...p, [id]: !p[id] })), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Memory</h2>
          <p className="lede">{rows.length} records. Working and long-term agent knowledge.</p>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label="Memory filters">
        <div className="search-wrap">

          <input className="search" placeholder="Search memory by title, content, source…" aria-label="Search memory" value={state.ui.memQuery} onChange={e => dispatch({ type: 'ui/set', patch: { memQuery: e.target.value } })} />
          {state.ui.memQuery && <button className="search-clear" aria-label="Clear search" onClick={() => dispatch({ type: 'ui/set', patch: { memQuery: '' } })}>&times;</button>}
        </div>
        <div className="toolbar-group">
          {(['all', 'working', 'longterm'] as const).map(s => (
            <button key={s} className="chip" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === 'all' ? 'All' : s === 'working' ? 'Working' : 'Long-term'}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty what="Memory" hint={state.server.memItems.length ? 'No records match this search.' : 'No memory has been recorded.'} />
      ) : (
        <div className="mem-grid">
          {rows.map(m => {
            const isExpanded = !!expanded[m.id];
            return (
              <article key={m.id} className={`mem-card${isExpanded ? ' expanded' : ''}`}>
                <button className="mem-card-header" onClick={() => toggleExpand(m.id)} aria-expanded={isExpanded} aria-label={`Expand details for ${m.title}`}>
                  <div className="mc-top">
                    <span className={`pill sm ${m.scope === 'working' ? 'info' : 'neutral'}`}>{m.scope}</span>
                    <span className={`pill sm ${statusPillClass(m.status)}`}>{statusLabel(m.status)}</span>
                    <span className="mem-rel">{relTime(m.lastUsedAt)}</span>
                  </div>
                  <b>{m.title}</b>
                  <p className="mem-snippet">{displaySnippet(m.snippet) || 'No summary available.'}</p>
                  <div className="mc-stats">
                    <span title="Source">{m.source || 'unknown'}</span>
                    <span title="Importance">imp {m.importance.toFixed(2)}</span>
                    <span title="Confidence">conf {m.confidence.toFixed(2)}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="mem-details" role="region" aria-label={`${m.title} details`}>
                    <div className="mc-detail-grid">
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Memory ID</span>
                        <span className="mc-detail-value mono">{m.id}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Scope</span>
                        <span className="mc-detail-value"><span className={`pill sm ${m.scope === 'working' ? 'info' : 'neutral'}`}>{m.scope}</span></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Status</span>
                        <span className="mc-detail-value">{statusLabel(m.status)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Source</span>
                        <span className="mc-detail-value">{m.source || 'unknown'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Importance</span>
                        <span className="mc-detail-value mono">{m.importance.toFixed(3)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Confidence</span>
                        <span className="mc-detail-value mono">{m.confidence.toFixed(3)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Created</span>
                        <span className="mc-detail-value mono">{m.createdAt ? relTime(m.createdAt) : 'UNKNOWN'}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Last Used</span>
                        <span className="mc-detail-value mono">{m.lastUsedAt ? relTime(m.lastUsedAt) : 'UNKNOWN'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────── EVALUATIONS ───────────────── */

export function EvalsPage() {
  const { state } = useRuntime();
  const [evalQuery, setEvalQuery] = useState('');
  const [evalSort, setEvalSort] = useState<'score' | 'cost' | 'latency' | 'name'>('score');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const evals = state.server.evals;
  const q = evalQuery.toLowerCase();

  const filtered = useMemo(() => {
    let r = evals.filter((e: EvaluationRecord) => !q || ((e.name || '') + ' ' + (e.category || '') + ' ' + (e.model || e.modelId || '')).toLowerCase().includes(q));
    return [...r].sort((a: EvaluationRecord, b: EvaluationRecord) => {
      if (evalSort === 'score') return (b.score ?? -1) - (a.score ?? -1);
      if (evalSort === 'cost') return (a.cost ?? Infinity) - (b.cost ?? Infinity);
      if (evalSort === 'latency') return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
      return ((a.name || a.id || '') as string).localeCompare((b.name || b.id || '') as string);
    });
  }, [evals, q, evalSort]);

  const toggleExpand = useCallback((i: number) => setExpanded(p => ({ ...p, [i]: !p[i] })), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Evaluations</h2>
          <p className="lede">Runtime quality metrics. {evals.length} evaluation{evals.length !== 1 ? 's' : ''}.</p>
        </div>
      </div>
      {evals.length > 0 && (
        <div className="toolbar" role="toolbar" aria-label="Evaluation filters">
          <div className="search-wrap">

            <input className="search" placeholder="Search evaluations by name, category, model…" aria-label="Search evaluations" value={evalQuery} onChange={e => setEvalQuery(e.target.value)} />
            {evalQuery && <button className="search-clear" aria-label="Clear search" onClick={() => setEvalQuery('')}>&times;</button>}
          </div>
          <div className="toolbar-group">
            {(['score', 'cost', 'latency', 'name'] as const).map(s => (
              <button key={s} className="chip" aria-pressed={evalSort === s} onClick={() => setEvalSort(s)}>
                {s === 'score' ? 'Best score' : s === 'cost' ? 'Lowest cost' : s === 'latency' ? 'Fastest' : 'Name'}
              </button>
            ))}
          </div>
        </div>
      )}
      {evals.length === 0 ? (
        <Empty what="Evaluations" hint="No evaluations have been completed. Run an evaluation to start measuring runtime behavior." />
      ) : filtered.length === 0 ? (
        <Empty what="Results" hint="No evaluations match this search." />
      ) : (
        <div className="evals-list">
          {filtered.map((e: EvaluationRecord, i: number) => {
            const isExpanded = !!expanded[i];
            return (
              <article key={e.id || i} className={`eval-card${isExpanded ? ' expanded' : ''}`}>
                <button className="eval-card-header" onClick={() => toggleExpand(i)} aria-expanded={isExpanded} aria-label={`Expand evaluation ${e.name || e.id || i}`}>
                  <div className="eval-main">
                    <b className="eval-name">{e.name || e.id || `eval-${i}`}</b>
                    <span className="eval-category">{e.category || 'general'}</span>
                  </div>
                  <div className="eval-metrics">
                    <span className="eval-metric" title="Score">
                      <span className="eval-metric-label">Score</span>
                      <span className="eval-metric-value mono">{typeof e.score === 'number' ? e.score.toFixed(3) : '—'}</span>
                    </span>
                    <span className="eval-metric" title="Result">
                      <span className="eval-metric-label">Result</span>
                      {e.pass === undefined && e.passed === undefined ? (
                        <span className="eval-metric-value">—</span>
                      ) : (e.pass ?? e.passed) ? (
                        <span className="pill ok sm">PASS</span>
                      ) : (
                        <span className="pill err sm">FAIL</span>
                      )}
                    </span>
                    <span className="eval-metric" title="Model">
                      <span className="eval-metric-label">Model</span>
                      <span className="eval-metric-value mono">{e.model || e.modelId || '—'}</span>
                    </span>
                    <span className="eval-metric" title="Cost">
                      <span className="eval-metric-label">Cost</span>
                      <span className="eval-metric-value mono">{typeof e.cost === 'number' ? usd(e.cost) : '—'}</span>
                    </span>
                    <span className="eval-metric" title="Latency">
                      <span className="eval-metric-label">Latency</span>
                      <span className="eval-metric-value mono">{typeof e.latencyMs === 'number' ? fmtSec(e.latencyMs) : '—'}</span>
                    </span>
                    <span className="eval-metric" title="Time">
                      <span className="eval-metric-label">Time</span>
                      <span className="eval-metric-value mono">{e.ts ? relTime(e.ts) : '—'}</span>
                    </span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="eval-details" role="region" aria-label={`Evaluation ${e.name || e.id} details`}>
                    <div className="mc-detail-grid">
                      {Object.entries(e).filter(([k]) => !['id', 'name', 'category', 'score', 'pass', 'passed', 'model', 'modelId', 'cost', 'latencyMs', 'ts'].includes(k)).map(([k, v]) => (
                        <div key={k} className="mc-detail-item">
                          <span className="mc-detail-label">{k}</span>
                          <span className="mc-detail-value mono">{typeof v === 'number' ? v.toString() : String(v ?? '—')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {state.server.evalNote && <p className="note">{state.server.evalNote}</p>}
    </div>
  );
}

/* ───────────────── SETTINGS ───────────────── */

type SettingsTab = 'general' | 'appearance' | 'runtime' | 'providers' | 'advanced';

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'providers', label: 'Providers' },
  { id: 'advanced', label: 'Advanced' },
];

function anchorToTab(anchor: string | null): SettingsTab | null {
  if (!anchor) return null;
  const a = anchor.toLowerCase();
  if (a.includes('provider')) return 'providers';
  if (a.includes('runtime') || a.includes('composer') || a.includes('preset') || a.includes('budget')) return 'runtime';
  if (a.includes('appear') || a.includes('theme')) return 'appearance';
  if (a.includes('advanc') || a.includes('diagnos') || a.includes('shortcut') || a.includes('keyboard')) return 'advanced';
  if (a.includes('general')) return 'general';
  return null;
}

function RuntimeTab() {
  const { state, dispatch } = useRuntime();
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [presets, setPresets] = useState<RuntimePreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getRuntimeSettings()
      .then(({ settings: s, presets: p }) => {
        if (!cancelled) { setSettings(s); setPresets(p); }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load runtime settings'); });
    return () => { cancelled = true; };
  }, []);

  const save = async (patch: Partial<RuntimeSettings>) => {
    setSaving(true);
    setError(null);
    try {
      const { settings: next } = await api.saveRuntimeSettings(patch);
      setSettings(next);
      dispatch({ type: 'toast/push', toast: { kind: 'ok', title: 'Runtime defaults saved', body: 'Applies to new runs.' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  if (error && !settings) {
    return (
      <div className="settings-card" role="alert">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Runtime settings unavailable</span>
            <span className="settings-row-desc">{error}</span>
          </div>
        </div>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="settings-card" role="status" aria-label="Loading runtime settings">
        <div className="settings-row"><span className="settings-row-desc">Loading runtime defaults…</span></div>
      </div>
    );
  }

  const activePreset = presets.find((p) => p.id === settings.defaultPreset);

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-label="Default runtime preset">
        <h3 className="settings-section-title">Default preset for new runs</h3>
        <div className="settings-card">
          <div className="preset-list" role="radiogroup" aria-label="Default runtime preset">
            {presets.map((p) => (
              <button key={p.id} role="radio" aria-checked={settings.defaultPreset === p.id}
                className={`preset-option${settings.defaultPreset === p.id ? ' on' : ''}`}
                disabled={saving} onClick={() => void save({ defaultPreset: p.id })}>
                <b>{p.label}</b>
                <span>{p.blurb}</span>
              </button>
            ))}
          </div>
          {activePreset && <div className="settings-row"><span className="settings-row-desc">{activePreset.consequence}</span></div>}
        </div>
      </section>
      <section className="settings-section" aria-label="Run defaults">
        <h3 className="settings-section-title">Defaults</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Budget per run</span>
              <span className="settings-row-desc">The runtime stops safely when this is exhausted</span>
            </div>
            <div className="settings-row-controls">
              {[0.1, 0.5, 2].map((b) => (
                <button key={b} className="chip" aria-pressed={settings.defaultBudgetUsd === b}
                  disabled={saving} onClick={() => void save({ defaultBudgetUsd: b })}>${b.toFixed(2)}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Maximum steps</span>
              <span className="settings-row-desc">Hard stop on runaway executions</span>
            </div>
            <div className="settings-row-controls">
              {[8, 12, 20].map((n) => (
                <button key={n} className="chip" aria-pressed={settings.maxSteps === n}
                  disabled={saving} onClick={() => void save({ maxSteps: n })}>{n}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Allow model switching</span>
              <span className="settings-row-desc">Let the runtime switch models mid-run when worth the cost</span>
            </div>
            <button className="chip" role="switch" aria-checked={settings.allowSwitching}
              disabled={saving} onClick={() => void save({ allowSwitching: !settings.allowSwitching })}>
              {settings.allowSwitching ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Allow context optimization</span>
              <span className="settings-row-desc">Reclaim tokens automatically when context fills</span>
            </div>
            <button className="chip" role="switch" aria-checked={settings.allowCompaction}
              disabled={saving} onClick={() => void save({ allowCompaction: !settings.allowCompaction })}>
              {settings.allowCompaction ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Tool policy</span>
              <span className="settings-row-desc">Read-only blocks file edits and deploys</span>
            </div>
            <div className="settings-row-controls">
              {(['auto', 'readonly'] as const).map((t) => (
                <button key={t} className="chip" aria-pressed={settings.toolPolicy === t}
                  disabled={saving} onClick={() => void save({ toolPolicy: t })}>
                  {t === 'auto' ? 'Auto' : 'Read-only'}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Quality floor</span>
              <span className="settings-row-desc">Reject models without measured quality at or above this threshold.</span>
            </div>
            <div className="settings-row-controls">
              {[null, 0.7, 0.8, 0.9].map((floor) => (
                <button key={floor === null ? 'none' : floor} className="chip" aria-pressed={(settings.qualityFloor ?? null) === floor}
                  disabled={saving} onClick={() => void save({ qualityFloor: floor })}>{floor === null ? 'None' : `${Math.round(floor * 100)}%`}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Latency target</span>
              <span className="settings-row-desc">Exclude models without observed latency within this target.</span>
            </div>
            <div className="settings-row-controls">
              {[null, 2000, 5000, 10000].map((target) => (
                <button key={target === null ? 'none' : target} className="chip" aria-pressed={(settings.latencyTargetMs ?? null) === target}
                  disabled={saving} onClick={() => void save({ latencyTargetMs: target })}>{target === null ? 'None' : `${target / 1000}s`}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Hard budget constraint</span>
              <span className="settings-row-desc">Exclude candidates whose expected cost exceeds the remaining run budget.</span>
            </div>
            <button className="chip" role="switch" aria-checked={settings.hardBudget === true}
              disabled={saving} onClick={() => void save({ hardBudget: settings.hardBudget !== true })}>
              {settings.hardBudget ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-label="Composer">
        <h3 className="settings-section-title">Composer defaults</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Task mode</span>
              <span className="settings-row-desc">Default mode for new conversations</span>
            </div>
            <div className="settings-row-controls">
              {(['auto', 'code', 'research', 'debug', 'general'] as const).map((m) => (
                <button key={m} className="chip" aria-pressed={state.ui.taskMode === m} onClick={() => dispatch({ type: 'ui/set', patch: { taskMode: m } })}>{m}</button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function AdvancedTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [cfg, setCfg] = useState<RuntimeConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dispatch } = useRuntime();

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.health(), api.config()]).then(([h, c]) => {
      setHealth(h); setCfg(c);
    }).catch((e) => setError(e instanceof Error ? e.message : 'backend unavailable'));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-label="Diagnostics">
        <h3 className="settings-section-title">Diagnostics</h3>
        <div className="settings-card">
          {error ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Backend unavailable</span>
                <span className="settings-row-desc">{error} — nothing below is assumed.</span>
              </div>
              <button className="icon-btn sm" onClick={load}>Retry</button>
            </div>
          ) : !health || !cfg ? (
            <div className="settings-row"><span className="settings-row-desc">Collecting diagnostics…</span></div>
          ) : (
            <>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Runtime endpoint</span>
                  <span className="settings-row-desc">Backend serving state, telemetry and SSE</span>
                </div>
                <span className="pill info sm">same-origin /api</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Runtime mode</span>
                  <span className="settings-row-desc">live = real provider calls · demo = labelled mock</span>
                </div>
                <span className={`pill sm ${health.mode === 'live' ? 'ok' : 'neutral'}`}>{String(health.mode || 'unknown').toUpperCase()}</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Event transport</span>
                  <span className="settings-row-desc">Server-Sent Events for real-time runtime updates</span>
                </div>
                <span className="pill ok sm">SSE</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Model discovery</span>
                  <span className="settings-row-desc">{health.discovery?.at ? `Last refresh ${relTime(health.discovery.at)}` : 'Background catalog refresh from the provider'}</span>
                </div>
                <span className={`pill sm ${cfg.discoveryEnabled ? 'ok' : 'neutral'}`}>{cfg.discoveryEnabled ? 'ON' : 'OFF'}</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Run guardrails</span>
                  <span className="settings-row-desc">Server-enforced defaults for new runs</span>
                </div>
                <span className="pill neutral sm">{cfg.maxSteps} steps · ${cfg.defaultBudgetUsd} budget · {health.runs ?? 0} active</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Secrets</span>
                  <span className="settings-row-desc">Provider API keys are never rendered in the console</span>
                </div>
                <span className="pill ok sm">REDACTED</span>
              </div>
            </>
          )}
        </div>
      </section>
      <section className="settings-section" aria-label="Keyboard">
        <h3 className="settings-section-title">Keyboard</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Command palette</span>
              <span className="settings-row-desc">All commands and navigation live here</span>
            </div>
            <span className="settings-shortcut"><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></span>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Focus composer</span>
              <span className="settings-row-desc">Jump to the message composer</span>
            </div>
            <span className="settings-shortcut"><kbd>/</kbd></span>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Close dialogs</span>
              <span className="settings-row-desc">Dismiss open panels and dialogs</span>
            </div>
            <span className="settings-shortcut"><kbd>Esc</kbd></span>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-label="Workspace">
        <h3 className="settings-section-title">Workspace</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Panel layout</span>
              <span className="settings-row-desc">Widths persist automatically as you drag dividers</span>
            </div>
            <span className="pill neutral sm">AUTO-SAVED</span>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Replay setup guide</span>
              <span className="settings-row-desc">Show the welcome flow again on next launch</span>
            </div>
            <button className="chip" aria-pressed="false" onClick={() => {
              resetOnboarding();
              dispatch({ type: 'toast/push', toast: { kind: 'info', title: 'Setup guide will replay', body: 'Reload to see it.' } });
            }}>Replay</button>
          </div>
        </div>
      </section>
    </div>
  );
}
export function SettingsPage() {
  const { state, dispatch } = useRuntime();
  const [tab, setTab] = useState<SettingsTab>(() => anchorToTab(state.ui.settingsAnchor) || 'general');

  React.useEffect(() => {
    const t = anchorToTab(state.ui.settingsAnchor);
    if (t) setTab(t);
    const scroller = document.querySelector('.page');
    if (scroller) scroller.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ui.settingsAnchor]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Settings</h2>
          <p className="lede">Providers, runtime defaults and workspace preferences.</p>
        </div>
      </div>
      <div className="toolbar" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="chip" aria-pressed={tab === t.id}
            onClick={() => { setTab(t.id); dispatch({ type: 'ui/set', patch: { settingsAnchor: null } }); }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' && (
        <div className="settings-stack">
          <GeneralTab />
        </div>
      )}
      {tab === 'appearance' && (
        <div className="settings-stack">
          <section className="settings-section" aria-label="Appearance">
            <h3 className="settings-section-title">Appearance</h3>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Theme</span>
                  <span className="settings-row-desc">Switch between dark and light appearance</span>
                </div>
                <div className="settings-row-controls">
                  <button className="chip" aria-pressed={state.ui.theme === 'dark'} onClick={() => dispatch({ type: 'ui/set', patch: { theme: 'dark' } })}>Dark</button>
                  <button className="chip" aria-pressed={state.ui.theme === 'light'} onClick={() => dispatch({ type: 'ui/set', patch: { theme: 'light' } })}>Light</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
      {tab === 'runtime' && <RuntimeTab />}
      {tab === 'providers' && <ProvidersSection />}
      {tab === 'advanced' && <AdvancedTab />}
    </div>
  );
}

// Account / session status. There is no privileged token in this browser:
// authentication is an HttpOnly session cookie managed by the server, so the
// credential is never readable by JavaScript and survives XSS-style reads.
function ApiAccessRow() {
  const [session, setSession] = useState<PrincipalInfo | null | undefined>(undefined);
  React.useEffect(() => {
    let cancelled = false;
    api.me().then((r) => { if (!cancelled) setSession(r.authenticated ? r.principal : null); })
      .catch(() => { if (!cancelled) setSession(undefined); });
    return () => { cancelled = true; };
  }, []);
  const state = session === undefined ? '…' : session ? `${session.role || 'authenticated'}` : 'Not signed in';
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">Account session</span>
        <span className="settings-row-desc">Signed in via a server-managed HttpOnly session cookie. No bearer token is stored in this browser. Use environment-configured API tokens for non-browser (scripts/CI) callers.</span>
      </div>
      <div className="settings-row-controls">
        <span className={`pill sm ${session ? 'ok' : 'neutral'}`}>{state}</span>
      </div>
    </div>
  );
}

function GeneralTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    api.health().then((h) => { if (!cancelled) setHealth(h); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'backend unavailable'); });
    return () => { cancelled = true; };
  }, []);
  const { state, dispatch } = useRuntime();
  return (
    <>
      <section className="settings-section" aria-label="Installation">
        <h3 className="settings-section-title">Installation</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">OrchestraAI runtime</span>
              <span className="settings-row-desc">Adaptive agent runtime — this console plus the local orchestrator</span>
            </div>
            <span className={`pill sm ${health?.mode === 'live' ? 'ok' : 'neutral'}`}>{health ? String(health.mode || 'unknown').toUpperCase() : '…'}</span>
          </div>
          {error && (
            <div className="settings-row">
              <span className="settings-row-desc" role="alert">Backend unavailable ({error}) — status unknown, never assumed.</span>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Default provider</span>
              <span className="settings-row-desc">First provider for new runs; credentials live in Settings → Providers</span>
            </div>
            <span className="pill info sm">{health?.provider || 'unknown'}</span>
          </div>
          <ApiAccessRow />
        </div>
      </section>
      <section className="settings-section" aria-label="Composer">
        <h3 className="settings-section-title">Composer defaults</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Task mode</span>
              <span className="settings-row-desc">Default mode for new conversations</span>
            </div>
            <div className="settings-row-controls">
              {(['auto', 'code', 'research', 'debug', 'general'] as const).map((m) => (
                <button key={m} className="chip" aria-pressed={state.ui.taskMode === m} onClick={() => dispatch({ type: 'ui/set', patch: { taskMode: m } })}>{m}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Send message</span>
              <span className="settings-row-desc">Keyboard shortcut for sending</span>
            </div>
            <span className="settings-shortcut"><kbd>Enter</kbd> send &middot; <kbd>Shift+Enter</kbd> newline</span>
          </div>
        </div>
      </section>
    </>
  );
}
