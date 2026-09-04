import React, { useCallback, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { Empty, StatusDot, fmtPct, fmtSec, relTime, usd } from '../components/ui';
import '../styles/pages.css';

type ModelSort = 'quality' | 'cost' | 'latency' | 'context' | 'reliability';
type ModelFilter = 'all' | 'healthy' | 'degraded' | 'down' | 'active';

function fmtCtx(window: number | undefined | null): string {
  if (!window) return 'UNKNOWN';
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(0)}M`;
  if (window >= 1000) return `${(window / 1000).toFixed(0)}k`;
  return String(window);
}

function pricePer1M(per1k: number | undefined | null): string {
  if (per1k === undefined || per1k === null || Number.isNaN(per1k)) return 'UNKNOWN';
  return `$${(per1k * 1000).toFixed(2)}`;
}

function statusLabel(s: string | undefined | null): string {
  const v = String(s || '').toLowerCase();
  if (v === 'healthy' || v === 'active') return 'HEALTHY';
  if (v === 'degraded') return 'DEGRADED';
  if (v === 'down' || v === 'unavailable') return 'UNAVAILABLE';
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

/* ───────────────── MODELS ───────────────── */

export function ModelsPage() {
  const { state, dispatch } = useRuntime();
  const [sort, setSort] = useState<ModelSort>('quality');
  const [filter, setFilter] = useState<ModelFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const activeId = state.server.snapshot?.activeModelId;
  const q = state.ui.modelQuery.toLowerCase();

  const rows = useMemo(() => {
    let r = state.server.models.filter(m => !q || (m.name + ' ' + m.provider + ' ' + m.id + ' ' + m.capabilities.join(' ')).toLowerCase().includes(q));
    if (filter === 'healthy') r = r.filter(m => m.status === 'healthy');
    else if (filter === 'degraded') r = r.filter(m => m.status === 'degraded');
    else if (filter === 'down') r = r.filter(m => m.status === 'down' || m.status === 'unavailable');
    else if (filter === 'active') r = r.filter(m => m.id === activeId);

    const score = {
      quality: (m: typeof r[number]) => -m.quality,
      cost: (m: typeof r[number]) => m.outputPer1k,
      latency: (m: typeof r[number]) => m.avgLatencyMs,
      context: (m: typeof r[number]) => -m.contextWindow,
      reliability: (m: typeof r[number]) => -m.reliability,
    }[sort];
    return [...r].sort((a, b) => score(a) - score(b));
  }, [state.server.models, q, sort, filter, activeId]);

  const toggleExpand = useCallback((id: string) => setExpanded(p => ({ ...p, [id]: !p[id] })), []);

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
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Models</h2>
          <p className="lede">Model intelligence and runtime capabilities. {state.server.models.length} registered.</p>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label="Model filters">
        <div className="search-wrap">
          <span className="search-icon" aria-hidden="true">&#x1F50D;</span>
          <input className="search" placeholder="Search models by name, provider…" aria-label="Search models" value={state.ui.modelQuery} onChange={e => dispatch({ type: 'ui/set', patch: { modelQuery: e.target.value } })} />
          {state.ui.modelQuery && <button className="search-clear" aria-label="Clear search" onClick={() => dispatch({ type: 'ui/set', patch: { modelQuery: '' } })}>&times;</button>}
        </div>
        <div className="toolbar-group">
          {filters.map(f => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="toolbar-sep" aria-hidden="true" />
        <div className="toolbar-group">
          {sorts.map(s => (
            <button key={s.id} className="chip" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty what="Models" hint={state.server.models.length ? 'No models match this filter.' : 'No model metadata is currently available.'} />
      ) : (
        <div className="model-grid">
          {rows.map(m => {
            const isActive = m.id === activeId;
            const isExpanded = !!expanded[m.id];
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
                    {m.capabilities.length ? m.capabilities.map(c => <span key={c} className="cap">{c}</span>) : <span className="cap dim">no capabilities</span>}
                  </div>
                  <div className="mc-stats">
                    <span title="Context window">{'\u25E7'} {fmtCtx(m.contextWindow)}</span>
                    <span title="Quality score">{'\u2605'} {m.quality.toFixed(2)}</span>
                    <span title="Average latency">{'\u23F1'} {fmtSec(m.avgLatencyMs)}</span>
                    <span title="Reliability">{'\u2665'} {fmtPct(m.reliability, 0)}</span>
                  </div>
                  <div className="mc-pricing">
                    <span title="Input price per 1M tokens">in {pricePer1M(m.inputPer1k)}</span>
                    <span title="Output price per 1M tokens">out {pricePer1M(m.outputPer1k)}</span>
                    <span title="Cached price per 1M tokens">cached {pricePer1M(m.cachedPer1k)}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="mc-details" role="region" aria-label={`${m.name} details`}>
                    <div className="mc-detail-grid">
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Model ID</span>
                        <span className="mc-detail-value mono">{m.id}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Provider</span>
                        <span className="mc-detail-value">{m.provider}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Status</span>
                        <span className="mc-detail-value"><span className={`pill sm ${statusPillClass(m.status)}`}>{statusLabel(m.status)}</span></span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Context Window</span>
                        <span className="mc-detail-value mono">{fmtCtx(m.contextWindow)} tokens</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Quality Score</span>
                        <span className="mc-detail-value mono">{m.quality.toFixed(3)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Reliability</span>
                        <span className="mc-detail-value mono">{fmtPct(m.reliability, 1)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Avg Latency</span>
                        <span className="mc-detail-value mono">{fmtSec(m.avgLatencyMs)}</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Input Price</span>
                        <span className="mc-detail-value mono">${(m.inputPer1k * 1000).toFixed(2)} / 1M tokens</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Output Price</span>
                        <span className="mc-detail-value mono">${(m.outputPer1k * 1000).toFixed(2)} / 1M tokens</span>
                      </div>
                      <div className="mc-detail-item">
                        <span className="mc-detail-label">Cached Price</span>
                        <span className="mc-detail-value mono">${(m.cachedPer1k * 1000).toFixed(2)} / 1M tokens</span>
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
          <span className="search-icon" aria-hidden="true">&#x1F50D;</span>
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
                    <span title="Total calls">{'\u00D7'}{t.calls} calls</span>
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
          <span className="search-icon" aria-hidden="true">&#x1F50D;</span>
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
                  <p className="mem-snippet">{m.snippet || 'No summary available.'}</p>
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
    let r = evals.filter((e: any) => !q || ((e.name || '') + ' ' + (e.category || '') + ' ' + (e.model || e.modelId || '')).toLowerCase().includes(q));
    return [...r].sort((a: any, b: any) => {
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
            <span className="search-icon" aria-hidden="true">&#x1F50D;</span>
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
          {filtered.map((e: any, i: number) => {
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

function ProviderStatus() {
  const [health, setHealth] = useState<any | null>(null);
  const [cfg, setCfg] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.config()]).then(([h, c]) => {
      if (!cancelled) { setHealth(h); setCfg(c); }
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'backend unavailable');
    });
    return () => { cancelled = true; };
  }, []);
  if (error) {
    return (
      <div className="settings-card" role="alert">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Backend unavailable</span>
            <span className="settings-row-desc">{error} — provider status is unknown, never assumed.</span>
          </div>
          <span className="pill err sm">UNKNOWN</span>
        </div>
      </div>
    );
  }
  if (!health || !cfg) {
    return (
      <div className="settings-card" role="status" aria-label="Loading provider status">
        <div className="settings-row"><span className="settings-row-desc">Checking provider status…</span></div>
      </div>
    );
  }
  const live = health.mode === 'live';
  const configured = !!health.providerConfigured;
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Runtime mode</span>
          <span className="settings-row-desc">{live ? 'Real provider calls with your configured credentials' : 'Labelled mock provider — no real model calls'}</span>
        </div>
        <span className={`pill sm ${live ? 'ok' : 'neutral'}`}>{live ? 'LIVE' : 'DEMO'}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Provider</span>
          <span className="settings-row-desc">First provider for new runs (keys stay server-side)</span>
        </div>
        <span className="pill info sm">{health.provider || cfg.provider || 'unknown'}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Credentials</span>
          <span className="settings-row-desc">Only presence is shown — values are never rendered</span>
        </div>
        <span className={`pill sm ${configured ? 'ok' : 'warn'}`}>{configured ? 'CONFIGURED' : 'MISSING'}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Model discovery</span>
          <span className="settings-row-desc">{health.discovery?.discovered !== undefined ? `Last refresh: ${health.discovery.discovered} new · ${health.discovery.updated || 0} updated` : 'Background catalog refresh from the provider'}</span>
        </div>
        <span className={`pill sm ${cfg.discoveryEnabled ? 'ok' : 'neutral'}`}>{cfg.discoveryEnabled ? 'ON' : 'OFF'}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Run guardrails</span>
          <span className="settings-row-desc">Defaults for new runs (per-run overrides apply at creation)</span>
        </div>
        <span className="pill neutral sm">{cfg.maxSteps} steps · ${cfg.defaultBudgetUsd} budget</span>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { state, dispatch } = useRuntime();

  React.useEffect(() => {
    if (state.ui.settingsAnchor) {
      const el = document.getElementById(`settings-${state.ui.settingsAnchor}`);
      if (el) el.scrollIntoView({ block: 'start' });
    } else {
      const scroller = document.querySelector('.page');
      if (scroller) scroller.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ui.settingsAnchor]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Settings</h2>
          <p className="lede">Console configuration and system preferences.</p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="settings-section" id="settings-providers" aria-label="Providers and runtime mode">
          <h3 className="settings-section-title">Providers &amp; runtime</h3>
          <ProviderStatus />
        </section>
        <section className="settings-section" aria-label="General">
          <h3 className="settings-section-title">General</h3>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Runtime API</span>
                <span className="settings-row-desc">Backend endpoint for runtime state and telemetry</span>
              </div>
              <span className="pill info sm">same-origin /api</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Event Transport</span>
                <span className="settings-row-desc">Server-Sent Events for real-time runtime updates</span>
              </div>
              <span className="pill ok sm">SSE</span>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Secrets</span>
                <span className="settings-row-desc">Provider API keys are never rendered in the console</span>
              </div>
              <span className="pill ok sm">REDACTED</span>
            </div>
          </div>
        </section>

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
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Left Panel</span>
                <span className="settings-row-desc">Toggle the navigation sidebar</span>
              </div>
              <button className="chip" aria-pressed={state.ui.leftOpen} onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: !state.ui.leftOpen } })}>{state.ui.leftOpen ? 'Open' : 'Closed'}</button>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Inspector Panel</span>
                <span className="settings-row-desc">Toggle the runtime inspector sidebar</span>
              </div>
              <button className="chip" aria-pressed={state.ui.rightOpen} onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } })}>{state.ui.rightOpen ? 'Open' : 'Closed'}</button>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-label="Composer">
          <h3 className="settings-section-title">Composer Defaults</h3>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Task Mode</span>
                <span className="settings-row-desc">Default mode for new conversations</span>
              </div>
              <div className="settings-row-controls">
                {(['debug', 'code', 'research', 'general'] as const).map(m => (
                  <button key={m} className="chip" aria-pressed={state.ui.taskMode === m} onClick={() => dispatch({ type: 'ui/set', patch: { taskMode: m } })}>{m}</button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Send Message</span>
                <span className="settings-row-desc">Keyboard shortcut for sending</span>
              </div>
              <span className="settings-shortcut"><kbd>Enter</kbd> send &middot; <kbd>Shift+Enter</kbd> newline</span>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-label="Keyboard Shortcuts">
          <h3 className="settings-section-title">Keyboard Shortcuts</h3>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Command Palette</span>
                <span className="settings-row-desc">Open the global command palette</span>
              </div>
              <span className="settings-shortcut"><kbd>{'\u2318'}K</kbd> / <kbd>Ctrl+K</kbd></span>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Focus Composer</span>
                <span className="settings-row-desc">Jump to the message composer</span>
              </div>
              <span className="settings-shortcut"><kbd>/</kbd></span>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Close Dialogs</span>
                <span className="settings-row-desc">Dismiss open panels and dialogs</span>
              </div>
              <span className="settings-shortcut"><kbd>Esc</kbd></span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
