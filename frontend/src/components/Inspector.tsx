import React, { memo, useMemo, useState } from 'react';
import { useRuntime } from '../state/store';
import { Empty, KV, Section, StatusDot, fmtK, fmtPct, fmtSec, fmtTime, relTime, usd } from './ui';
import type { RuntimeSnapshot } from '../types';

const SEG_COLORS = ['#5aa9ff', '#3fce8f', '#b48cff', '#f0b429', '#6b7a90', '#e06c9f'];
const NAV = [['model', 'Model'], ['why', 'Why?'], ['switch', 'Switch'], ['context', 'Context'], ['cache', 'Cache'], ['memory', 'Memory'], ['tools', 'Tools'], ['cost', 'Cost'], ['latency', 'Latency'], ['routing', 'Routing'], ['trace', 'Trace'], ['decisions', 'Decisions'], ['changes', 'Changes']];

export function RuntimeInspector() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  if (!snap) return <aside className="right" aria-label="Runtime inspector"><Empty what="Runtime state" hint="Select a run to inspect live runtime telemetry." /></aside>;
  const open = state.ui.rightOpen;
  return (
    <aside className={`right ${open ? 'open' : ''}`} aria-label="Runtime inspector">
      {!open && (
        <button className="inspector-fab" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: true } })} aria-label="Open runtime inspector">◀ Inspector</button>
      )}
      <div className="inspector-head">
        <span className="inspector-title">Runtime Inspector</span>
        <button className="icon-btn sm" aria-label="Close inspector" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: false } })}>▶</button>
      </div>
      <nav className="inspector-nav" aria-label="Inspector sections">
        {NAV.map(([id, label]) => <a key={id} href={`#sec-${id}`}>{label}</a>)}
      </nav>
      <CurrentModel snap={snap} />
      <WhyModel snap={snap} />
      <ModelSwitch snap={snap} />
      <ContextPanel snap={snap} />
      <CachePanel snap={snap} />
      <MemoryPanel snap={snap} />
      <ToolsPanel snap={snap} />
      <CostPanel snap={snap} />
      <LatencyPanel snap={snap} />
      <RoutingPanel snap={snap} />
      <HistoryPanel snap={snap} />
      <TracePanel />
      <DecisionsPanel snap={snap} />
      <ChangesPanel snap={snap} />
    </aside>
  );
}

// ---------- 1. Current model ----------
function CurrentModel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const model = state.server.models.find(m => m.id === snap.activeModelId);
  const util = snap.context.windowTokens ? snap.context.usedTokens / snap.context.windowTokens : null;
  if (!model && !snap.activeModelId) {
    return <Section id="model" title="Current model"><Empty what="Active model" hint="No model selected yet for this run." /></Section>;
  }
  return (
    <Section id="model" title="Current model" flashKey={snap.activeModelId || ''}>
      <div className="model-hero">
        <div className="eyebrow">ACTIVE {snap.meta?.mode === 'live' ? `· LIVE ${snap.meta.provider || ''}` : '· DEMO'}</div>
        <div className="name">
          <StatusDot status={model?.status || 'active'} />
          <span title={snap.activeModelId || ''}>{model?.name || snap.activeModelId}</span>
        </div>
        <div className="prov">{model ? `${model.provider} · ${model.status}` : 'provider unknown'}</div>
        <div className="grid">
          <div className="stat"><div className="l">Context</div><div className="n">{util === null ? '—' : `${fmtK(snap.context.usedTokens, 1)} / ${fmtK(snap.context.windowTokens, 0)}`}</div><div className="s">{util === null ? 'window unknown' : fmtPct(util, 1)}</div></div>
          <div className="stat"><div className="l">Health</div><div className="n">{model ? fmtPct(model.reliability, 1) : '—'}</div><div className="s">{model?.status || 'unknown'}</div></div>
          <div className="stat"><div className="l">Latency</div><div className="n">{model ? fmtSec(model.avgLatencyMs) : fmtSec(snap.latency.modelMs)}</div><div className="s">avg model</div></div>
          <div className="stat"><div className="l">Quality</div><div className="n">{model ? model.quality.toFixed(2) : '—'}</div><div className="s">registry score</div></div>
        </div>
      </div>
    </Section>
  );
}

// ---------- 2. Why this model? ----------
function WhyModel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const d = snap.routing.decision;
  const cands = snap.routing.candidates;
  const current = cands.find(c => c.modelId === (snap.routing.currentId || snap.activeModelId));
  const alts = cands.filter(c => c.modelId !== (snap.routing.currentId || snap.activeModelId)).slice(0, 3);
  const nameOf = (id: string) => state.server.models.find(m => m.id === id)?.name || id;
  if (!d && !cands.length) {
    return <Section id="why" title="Why this model?"><Empty what="Routing decision" hint="No routing evaluation recorded yet. It appears after the first model selection." /></Section>;
  }
  return (
    <Section id="why" title="Why this model?" flashKey={d?.timestamp || ''}>
      {current && (
        <div className="why-current">
          <div className="eyebrow">CURRENT</div>
          <div className="why-name">{nameOf(current.modelId)}</div>
          <div className="why-score">SCORE <b>{current.score.toFixed(2)}</b></div>
        </div>
      )}
      {d && d.factors.length > 0 && (
        <>
          <div className="eyebrow">FACTORS</div>
          {d.factors.map(f => (
            <div key={f.key} className="factor">
              <span className={`mk ${f.status}`}>{f.status === 'pass' ? '✓' : f.status === 'warn' ? '!' : '✕'}</span>
              <span>{f.label}{f.detail ? <span className="fd"> — {f.detail}</span> : null}</span>
            </div>
          ))}
        </>
      )}
      {(alts.length > 0 || (d?.alternatives && d.alternatives.length > 0)) && (
        <>
          <div className="eyebrow">ALTERNATIVES</div>
          {alts.map(a => {
            const saving = current ? current.costUsd - a.costUsd : 0;
            return (
              <div key={a.modelId} className="cand alt">
                <div className="kv"><span className="k"><b style={{ color: 'var(--text)' }}>{nameOf(a.modelId)}</b></span><span className="v">score {a.score.toFixed(2)}</span></div>
                <div className="kv"><span className="k">{usd(a.costUsd)} · {fmtSec(a.latencyMs)}</span>
                  <span className="v">{saving > 0.0000005 ? `saves ${usd(saving)}` : saving < -0.0000005 ? `+${usd(-saving).slice(1)}` : ''}</span></div>
                <div className="scorebar" role="img" aria-label={`${a.modelId} score ${a.score}`}><i style={{ width: `${Math.min(100, a.score * 100)}%` }} /></div>
              </div>
            );
          })}
          {(d?.alternatives || []).filter(a => !cands.some(c => c.modelId === a.id)).slice(0, 2).map(a => (
            <div key={a.id} className="kv"><span className="k">Alternative: {nameOf(a.id)}</span><span className="v">{a.note || (a.score !== undefined ? `score ${a.score}` : '')}</span></div>
          ))}
        </>
      )}
      {d && (
        <div className="decision-box">
          <b>{d.decision}</b>
          <div className="reason">{d.kind} · {relTime(d.timestamp)}</div>
        </div>
      )}
    </Section>
  );
}

// ---------- 3. Model switch visualization ----------
function ModelSwitch({ snap }: { snap: RuntimeSnapshot }) {
  const switches = useMemo(() => {
    const out: { ts: string; from: string; to: string; reason: string; cost?: number; rejected?: boolean }[] = [];
    for (const dec of snap.decisions) {
      const m = /^SWITCH\s+(.+?)\s+→\s+(.+?)\s+—\s+(.*?)(\s+\(switch cost.*)?$/.exec(dec.decision);
      if (dec.kind === 'model_switch' && m) {
        const costM = /switch cost \$([0-9.]+)/.exec(dec.decision);
        out.push({ ts: dec.timestamp, from: m[1], to: m[2], reason: m[3], cost: costM ? Number(costM[1]) : undefined });
      } else if (/SWITCH REJECTED/.test(dec.decision)) {
        out.push({ ts: dec.timestamp, from: '', to: '', reason: dec.decision.replace('SWITCH REJECTED — ', ''), rejected: true });
      }
    }
    return out.slice(-3).reverse();
  }, [snap.decisions]);
  if (!switches.length) {
    return <Section id="switch" title="Model switches"><Empty what="Model switches" hint="No switches recorded — the runtime kept its initial model." /></Section>;
  }
  return (
    <Section id="switch" title="Model switches" count={switches.length}>
      {switches.map((s, i) => s.rejected ? (
        <div key={i} className="switch-banner rejected" role="status">
          <b>MODEL SWITCH REJECTED</b>
          <div className="reason">{s.reason || 'Switch cost exceeded benefit.'}</div>
          <div className="meta">{fmtTime(s.ts)} · kept current model</div>
        </div>
      ) : (
        <div key={i} className="switch-banner" role="status">
          <b>MODEL SWITCH</b>
          <div className="switch-flow"><span className="old">{shortModel(s.from)}</span><span className="arrow" aria-hidden="true">↓</span><span className="new">{shortModel(s.to)}</span></div>
          <KV k="Trigger" v={s.reason || '—'} />
          {s.cost !== undefined && <KV k="Switching cost" v={usd(s.cost)} />}
          <div className="meta">{fmtTime(s.ts)}</div>
        </div>
      ))}
    </Section>
  );
}
function shortModel(id: string): string {
  if (!id) return '—';
  const parts = id.split('/');
  return parts[parts.length - 1].slice(0, 28);
}

// ---------- 4. Context ----------
function ContextPanel({ snap }: { snap: RuntimeSnapshot }) {
  const util = snap.context.windowTokens ? snap.context.usedTokens / snap.context.windowTokens : null;
  const total = snap.context.segments.reduce((a, s) => a + s.tokensPct, 0) || 1;
  const [showAll, setShowAll] = useState(false);
  const items = showAll ? snap.context.items : snap.context.items.slice(0, 6);
  return (
    <Section id="context" title="Context" count={snap.context.items.length} flashKey={snap.context.usedTokens}>
      <div className="ctx-top">
        <span className="ctx-num">{fmtK(snap.context.usedTokens, 1)} / {fmtK(snap.context.windowTokens, 0)}</span>
        <span className={`pill ${util !== null && util >= 0.95 ? 'err' : util !== null && util >= 0.8 ? 'warn' : 'neutral'}`}>
          {util === null ? 'UNKNOWN' : fmtPct(util, 1)}
        </span>
      </div>
      <div className="bar ctxbar" role="img" aria-label={util === null ? 'Context usage unknown' : `Context ${fmtPct(util, 1)} used`}>
        <i className={util !== null && util >= 0.95 ? 'crit' : util !== null && util >= 0.8 ? 'hot' : ''} style={{ width: `${util === null ? 0 : Math.min(100, util * 100)}%` }} />
        <span className="threshold" style={{ left: '80%' }} aria-hidden="true" />
      </div>
      {snap.context.segments.length > 0 && (
        <>
          <div className="segbar" role="img" aria-label={`Context composition: ${snap.context.segments.map(s => `${s.label} ${s.tokensPct}%`).join(', ')}`}>
            {snap.context.segments.map((s, i) => <i key={s.key} title={`${s.label} ${s.tokensPct}%`} style={{ width: `${(s.tokensPct / total) * 100}%`, background: SEG_COLORS[i % SEG_COLORS.length] }} />)}
          </div>
          <div className="legend">
            {snap.context.segments.map((s, i) => (
              <React.Fragment key={s.key}>
                <span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SEG_COLORS[i % SEG_COLORS.length], marginRight: 6 }} />{s.label}</span>
                <b>{s.tokensPct}%</b>
              </React.Fragment>
            ))}
          </div>
        </>
      )}
      {snap.context.items.length === 0 ? <Empty what="Context items" hint="No itemized context yet." /> : items.map(it => (
        <div key={it.id} className="ctx-item">
          <span className={`tag ${it.status}`}>{it.status}</span>{' '}<b>{it.title}</b>
          <div className="kv"><span className="k">{it.kind} · {it.source}</span><span className="v">{fmtK(it.tokens)} · rel {Number(it.relevance).toFixed(2)}</span></div>
        </div>
      ))}
      {snap.context.items.length > 6 && (
        <button className="link-btn" onClick={() => setShowAll(v => !v)} aria-expanded={showAll}>
          {showAll ? 'Show fewer' : `Show all ${snap.context.items.length} items`}
        </button>
      )}
      <div className="chart-block">
        <div className="chead"><span>Context over time</span><b>{util === null ? '—' : fmtPct(util, 0)}</b></div>
        <SeriesLine kind="context" snap={snap} height={44} />
      </div>
    </Section>
  );
}

// ---------- 5. Cache ----------
function CachePanel({ snap }: { snap: RuntimeSnapshot }) {
  const c = snap.cache;
  const pill = c.state === 'WARM' ? 'ok' : c.state === 'COOLING' ? 'warn' : c.state === 'COLD' ? 'err' : 'neutral';
  return (
    <Section id="cache" title="Cache" flashKey={c.recent.length ? c.recent[0].ts : ''}>
      <div className="ctx-top">
        <span className={`pill ${pill}`}><StatusDot status={c.state} />{c.state || 'UNKNOWN'}</span>
        <span className="ctx-num">{fmtPct(c.hitRate, 0)} hit</span>
      </div>
      <KV k="Hit rate" v={fmtPct(c.hitRate, 1)} />
      <KV k="Cached tokens" v={fmtK(c.cachedTokens, 1)} />
      <KV k="Uncached" v={fmtK(c.uncachedTokens, 1)} />
      <KV k="Est. savings" v={usd(c.savedUsd)} />
      {c.recent.length === 0 ? <Empty what="Cache events" hint="No cache activity recorded yet." /> : (
        <div className="cache-events">
          {c.recent.slice(0, 5).map((r, i) => {
            const hit = r.type === 'cache.hit';
            return (
              <div key={i} className={`change ${hit ? 'added' : r.type === 'cache.miss' ? 'removed' : 'updated'}`}>
                <span className={`pill sm ${hit ? 'ok' : r.type === 'cache.miss' ? 'err' : 'warn'}`}>{hit ? 'HIT' : r.type === 'cache.miss' ? 'MISS' : 'INVALIDATED'}</span>
                <span>{r.detail}<span className="impact">{relTime(r.ts)}</span></span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ---------- 6. Memory ----------
function MemoryPanel({ snap }: { snap: RuntimeSnapshot }) {
  return (
    <Section id="memory" title="Memory" count={snap.memory.working.length + snap.memory.longterm.length}>
      <MemoryList title="Working" items={snap.memory.working} emptyHint="No persistent working memories yet." />
      <MemoryList title="Long-term" items={snap.memory.longterm} emptyHint="No persistent long-term memories yet." />
    </Section>
  );
}
function MemoryList({ title, items, emptyHint }: { title: string; items: RuntimeSnapshot['memory']['working']; emptyHint: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const vis = showAll ? items : items.slice(0, 4);
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="eyebrow">{title} ({items.length})</div>
      {items.length === 0 && <Empty what={title + ' memory'} hint={emptyHint} />}
      {vis.map(m => (
        <div key={m.id} className="memitem">
          <button className="memhead" aria-expanded={openId === m.id} onClick={() => setOpenId(openId === m.id ? null : m.id)}>
            <b>{m.title}</b><span className="v">{m.status}</span>
          </button>
          <div className="kv"><span className="k">{m.source || 'unknown source'}</span><span className="v">rel {Number(m.importance).toFixed(2)}</span></div>
          {openId === m.id && (
            <div className="memdetail">
              {m.snippet || 'No summary available.'}
              <div className="meta">confidence {Number(m.confidence).toFixed(2)} · used {relTime(m.lastUsedAt)} · {fmtTime(m.createdAt)}</div>
            </div>
          )}
        </div>
      ))}
      {items.length > 4 && <button className="link-btn" onClick={() => setShowAll(v => !v)} aria-expanded={showAll}>{showAll ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </div>
  );
}

// ---------- 7. Tools ----------
function ToolsPanel({ snap }: { snap: RuntimeSnapshot }) {
  const running = snap.tools.filter(t => t.lastStatus === 'running');
  const recent = snap.tools.filter(t => t.calls > 0 && t.lastStatus !== 'running').slice(0, 5);
  const available = snap.tools.filter(t => t.calls === 0 && t.lastStatus !== 'running');
  if (!snap.tools.length) return <Section id="tools" title="Tools"><Empty what="Tools" hint="No tools are currently available." /></Section>;
  return (
    <Section id="tools" title="Tools" count={snap.tools.length} flashKey={running.length ? 'running' : snap.tools.map(t => t.calls).join(',')}>
      {running.length > 0 && (
        <div className="tool-group"><div className="eyebrow">ACTIVE ({running.length})</div>
          {running.map(t => (
            <div key={t.name} className="toolrow active"><span className="livedot" aria-hidden="true" /><b>{t.name}</b><span className="v">RUNNING</span></div>
          ))}
        </div>
      )}
      <div className="tool-group"><div className="eyebrow">AVAILABLE ({snap.tools.length})</div>
        {snap.tools.slice(0, 8).map(t => (
          <div key={t.name} className="toolrow">
            <StatusDot status={t.status === 'enabled' ? (t.lastStatus === 'failed' ? 'failed' : 'idle') : 'down'} />
            <span className="tname" title={t.description || t.name}>{t.name}</span>
            {t.status !== 'enabled' && <span className="pill err sm">BLOCKED</span>}
            <span className="v">×{t.calls} · {fmtSec(t.avgLatencyMs)} · {fmtPct(t.successRate, 0)}</span>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="tool-group"><div className="eyebrow">RECENT</div>
          {recent.map(t => (
            <div key={t.name} className="kv">
              <span className="k"><StatusDot status={t.lastStatus === 'failed' ? 'failed' : 'success'} />{t.name}</span>
              <span className="v">{t.lastStatus} · {fmtSec(t.avgLatencyMs)}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---------- 8. Cost ----------
function CostPanel({ snap }: { snap: RuntimeSnapshot }) {
  const c = snap.cost;
  const remain = c.budgetUsd - c.spentUsd;
  const pct = c.budgetUsd > 0 ? Math.min(1, c.spentUsd / c.budgetUsd) : 0;
  const max = Math.max(...c.breakdown.map(b => b.usd), 1e-9);
  return (
    <Section id="cost" title="Cost" flashKey={c.spentUsd}>
      <div className="cost-hero"><span className="l">CURRENT RUN COST</span><span className="n">{usd(c.spentUsd)}</span></div>
      {c.breakdown.length > 0 && (
        <div className="costrows">
          {c.breakdown.map(b => (
            <div key={b.key} className="costrow">
              <span className="k">{b.label}</span>
              <span className="barwrap"><span className="bar"><i style={{ width: `${(b.usd / max) * 100}%` }} /></span></span>
              <span className="v">{usd(b.usd)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="bar ctxbar budget" role="img" aria-label={`Budget ${usd(c.spentUsd)} spent of ${usd(c.budgetUsd)}`}>
        <i className={pct >= 1 ? 'crit' : pct >= 0.8 ? 'hot' : ''} style={{ width: `${pct * 100}%` }} />
        <span className="threshold" style={{ left: '80%' }} aria-hidden="true" />
      </div>
      <KV k="Budget used" v={`${usd(c.spentUsd)} (${fmtPct(c.budgetUsd ? c.spentUsd / c.budgetUsd : null, 0)})`} />
      <KV k="Remaining" v={usd(remain)} />
      <KV k="Projected" v={usd(c.projectedUsd)} />
      <div className="chart-block">
        <div className="chead"><span>Cost over time</span><b>{usd(c.spentUsd)}</b></div>
        <SeriesLine kind="cost" snap={snap} height={44} />
      </div>
    </Section>
  );
}

// ---------- 9. Latency ----------
function LatencyPanel({ snap }: { snap: RuntimeSnapshot }) {
  const l = snap.latency;
  return (
    <Section id="latency" title="Latency" flashKey={l.totalMs}>
      <KV k="Current step" v={fmtSec(l.currentStepMs)} />
      <KV k="Model" v={fmtSec(l.modelMs)} />
      <KV k="Tool" v={fmtSec(l.toolMs)} />
      <KV k="Average step" v={fmtSec(l.avgStepMs)} />
      <KV k="Total run" v={fmtSec(l.totalMs)} />
      <div className="chart-block">
        <div className="chead"><span>Step latency</span><b>{fmtSec(l.currentStepMs)}</b></div>
        {l.samples.length < 2 ? <Empty what="Latency samples" hint="Latency history appears after the first completed steps." /> : <SparkSamples samples={l.samples} unit="ms" />}
      </div>
      <div className="chart-block">
        <div className="chead"><span>Model latency over time</span></div>
        <SeriesLine kind="latency" snap={snap} height={44} />
      </div>
    </Section>
  );
}

// ---------- 10. Routing ----------
function RoutingPanel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const cands = [...snap.routing.candidates].sort((a, b) => b.score - a.score);
  if (!cands.length) return <Section id="routing" title="Model routing"><Empty what="Routing candidates" hint="Candidate scores appear after the first routing evaluation." /></Section>;
  const nameOf = (id: string) => state.server.models.find(m => m.id === id)?.name || id;
  const maxScore = Math.max(...cands.map(c => c.score), 1e-9);
  return (
    <Section id="routing" title="Model routing" count={cands.length}>
      {cands.slice(0, 6).map(c => {
        const cur = c.modelId === (snap.routing.currentId || snap.activeModelId);
        return (
          <div key={c.modelId} className={`cand ${cur ? 'current' : ''}`}>
            <div className="kv"><span className="k"><b style={{ color: 'var(--text)' }}>{nameOf(c.modelId)}</b></span><span className="v">score {c.score.toFixed(2)}</span></div>
            <div className="kv"><span className="k">{usd(c.costUsd)} · {fmtSec(c.latencyMs)}</span><span className="v">{cur ? 'CURRENT' : ''}</span></div>
            <div className="scorebar" role="img" aria-label={`${c.modelId} score ${c.score.toFixed(2)}`}><i style={{ width: `${(c.score / maxScore) * 100}%` }} /></div>
            <div className="dimgrid">
              {Object.entries(c.factors).map(([k, v]) => (
                <React.Fragment key={k}>
                  <span>{k}</span>
                  <span className="bar"><i style={{ width: `${Math.min(100, Math.max(0, Number(v) * 100))}%` }} /></span>
                  <span>{Number(v).toFixed(2)}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

// ---------- 11. History / time series ----------
function HistoryPanel({ snap }: { snap: RuntimeSnapshot }) {
  const series = snap.series || [];
  if (!series.length) return <Section id="history" title="Run history"><Empty what="History" hint="Time-series telemetry appears once the run starts producing samples." /></Section>;
  return (
    <Section id="history" title="Run history" count={series.length}>
      <div className="chart-block"><div className="chead"><span>Tokens (in+out)</span><b>{fmtK(series[series.length - 1].inputTokens + series[series.length - 1].outputTokens)}</b></div><SeriesLine kind="tokens" snap={snap} height={44} /></div>
      <div className="chart-block"><div className="chead"><span>Budget remaining</span><b>{usd(Math.max(0, snap.cost.budgetUsd - series[series.length - 1].cost))}</b></div><SeriesLine kind="budget" snap={snap} height={44} /></div>
      <div className="chart-block"><div className="chead"><span>Cache hit rate</span><b>{fmtPct(series[series.length - 1].cacheHitRate, 0)}</b></div><SeriesLine kind="cache" snap={snap} height={44} /></div>
      <div className="model-timeline">Model timeline: {series.map(s => s.model).filter((v, i, a) => v && a.indexOf(v) === i).join(' → ') || '—'}</div>
    </Section>
  );
}

// ---------- 12. Execution trace ----------
function TracePanel() {
  const { state, dispatch } = useRuntime();
  const trace = useMemo(() => state.server.snapshot?.trace.slice(-40).reverse() || [], [state.server.snapshot]);
  const [filter, setFilter] = useState('');
  const rows = filter ? trace.filter(t => (t.type + t.label).toLowerCase().includes(filter.toLowerCase())) : trace;
  if (!trace.length) return <Section id="trace" title="Execution trace"><Empty what="Trace" hint="Execution steps appear here as the run progresses." /></Section>;
  return (
    <Section id="trace" title="Execution trace" count={trace.length}>
      {trace.length > 8 && <input className="mini-search" placeholder="Filter trace…" aria-label="Filter execution trace" value={filter} onChange={e => setFilter(e.target.value)} />}
      <div className="trace">
        {rows.slice(0, 30).map(t => (
          <React.Fragment key={t.seq}>
            <button className="trace-row" aria-expanded={state.ui.selectedTrace === t.seq}
              onClick={() => dispatch({ type: 'ui/set', patch: { selectedTrace: state.ui.selectedTrace === t.seq ? null : t.seq } })}>
              <span className="n">{String(t.seq).padStart(3, '0')}</span>
              <span className="body"><StatusDot status={t.status} />{t.label}
                <span className="meta"><br />{fmtTime(t.ts)} · {t.type}{t.durationMs ? ` · ${fmtSec(t.durationMs)}` : ''}{t.costUsd ? ` · ${usd(t.costUsd)}` : ''}</span>
              </span>
            </button>
            {state.ui.selectedTrace === t.seq && <div className="trace-detail">{JSON.stringify({ seq: t.seq, type: t.type, status: t.status, ts: t.ts, durationMs: t.durationMs, costUsd: t.costUsd }, null, 1)}</div>}
          </React.Fragment>
        ))}
      </div>
    </Section>
  );
}

// ---------- 13. Decisions ----------
function DecisionsPanel({ snap }: { snap: RuntimeSnapshot }) {
  const rows: { ts: string; title: string; detail: string; kind: string }[] = useMemo(() => {
    const out: { ts: string; title: string; detail: string; kind: string }[] = [];
    snap.trace.filter(t => /model|context|tool|rout|budget|cache|optim/i.test(t.type + ' ' + t.label)).slice(-8).forEach(t => {
      out.push({ ts: t.ts, title: t.label.toUpperCase().slice(0, 70), detail: t.type, kind: t.status });
    });
    snap.decisions.slice(-6).forEach(d => out.push({ ts: d.timestamp, title: d.decision.slice(0, 90), detail: `${d.kind} · ${d.factors.map(f => f.label).join('; ').slice(0, 120)}`, kind: 'decision' }));
    return out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 12);
  }, [snap]);
  if (!rows.length) return <Section id="decisions" title="Runtime decisions"><Empty what="Decisions" hint="Runtime decisions (routing, cache, budget) appear here." /></Section>;
  return (
    <Section id="decisions" title="Runtime decisions" count={rows.length}>
      <div className="timeline">
        {rows.map((r, i) => (
          <div key={i} className="tl-row">
            <time dateTime={r.ts}>{fmtTime(r.ts)}</time>
            <div><StatusDot status={r.kind} /><span className="ev">{r.title}</span><div className="tl-detail">{r.detail}</div></div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------- 14. What changed ----------
function ChangesPanel({ snap }: { snap: RuntimeSnapshot }) {
  if (!snap.changes.length) return <Section id="changes" title="What changed?"><Empty what="Changes" hint="Runtime change events (prices, health, compression, switches) appear here." /></Section>;
  return (
    <Section id="changes" title="What changed?" count={snap.changes.length}>
      {snap.changes.slice(-12).reverse().map(c => (
        <div key={c.seq} className={`change ${c.kind}`}>
          <time dateTime={c.ts}>{fmtTime(c.ts)}</time>
          <span>{c.label}<span className="impact">seq {c.seq} · {c.kind}</span></span>
        </div>
      ))}
    </Section>
  );
}

// ---------- Charts (real backend data only) ----------
type SeriesKind = 'tokens' | 'cost' | 'latency' | 'context' | 'budget' | 'cache';
const SeriesLine = memo(function SeriesLine({ kind, snap, height = 44 }: { kind: SeriesKind; snap: RuntimeSnapshot; height?: number }) {
  const series = snap.series || [];
  const values: number[] = useMemo(() => {
    switch (kind) {
      case 'tokens': return series.map(s => (s.inputTokens || 0) + (s.outputTokens || 0));
      case 'cost': return series.map(s => s.cost || 0);
      case 'latency': return series.map(s => s.latencyMs || 0);
      case 'context': return series.map(s => (s.contextUtil || 0) * (snap.context.windowTokens || 0));
      case 'budget': return series.map(s => Math.max(0, (snap.cost.budgetUsd || 0) - (s.cost || 0)));
      case 'cache': return series.map(s => s.cacheHitRate || 0);
    }
  }, [kind, series, snap.context.windowTokens, snap.cost.budgetUsd]);
  const fmt = (v: number) => kind === 'cost' || kind === 'budget' ? usd(v) : kind === 'latency' ? fmtSec(v) : kind === 'cache' ? fmtPct(v, 0) : fmtK(v);
  if (!values.length) return <div className="nounit">No samples yet — charts render only backend telemetry.</div>;
  const threshold = kind === 'context' ? (snap.context.windowTokens || 0) * 0.8 : undefined;
  return <SvgLine values={values} height={height} format={fmt} threshold={threshold} label={kind} />;
});

export function SparkSamples({ samples, unit }: { samples: number[]; unit: string }) {
  const vals = samples.slice(-24);
  const max = Math.max(1, ...vals);
  return (
    <div className="spark" role="img" aria-label={`Latency samples, max ${fmtSec(max)}`}>
      {vals.map((s, i) => (
        <i key={i} title={`${fmtSec(s)}`} style={{ height: `${Math.max(3, (s / max) * 28)}px` }} />
      ))}
    </div>
  );
}

export const Sparkline = SparkSamples;

export function SvgLine({ values, height = 44, format, threshold, label }: { values: number[]; height?: number; format: (v: number) => string; threshold?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, H = height, PAD = 4;
  const max = Math.max(...values, threshold ?? -Infinity, 1e-9);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1e-9);
  const X = (i: number) => PAD + (i / Math.max(1, values.length - 1)) * (W - PAD * 2);
  const Y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${H - PAD} L${pts.split(' ').join(' L')} L${X(values.length - 1).toFixed(1)},${H - PAD} Z`;
  const ty = threshold !== undefined ? Y(threshold) : null;
  return (
    <div className="chart svgchart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={`${label} chart, latest ${format(values[values.length - 1])}, min ${format(Math.min(...values))}, max ${format(max)}`}
        onMouseLeave={() => setHover(null)} onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const idx = Math.round(((e.clientX - r.left) / r.width) * (values.length - 1));
          setHover(Math.max(0, Math.min(values.length - 1, idx)));
        }}>
        {ty !== null && <line x1={PAD} x2={W - PAD} y1={ty} y2={ty} className="thresh" strokeDasharray="4 3" />}
        <path d={area} className="area" />
        <polyline points={pts} className="line" />
        {hover !== null && <circle cx={X(hover)} cy={Y(values[hover])} r="3" className="hoverdot" />}
      </svg>
      <div className="chart-foot">
        <span>{format(Math.min(...values))}</span>
        {hover !== null ? <b>{format(values[hover])} · #{hover + 1}</b> : <span>latest {format(values[values.length - 1])}</span>}
        <span>{format(max)}</span>
      </div>
    </div>
  );
}


