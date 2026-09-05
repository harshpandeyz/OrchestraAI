import React, { memo, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { Empty, KV, Section, StatusDot, displaySnippet, elapsed, fmtK, fmtPct, fmtSec, fmtTime, relTime, usd } from './ui';
import { Tip } from './Tooltip';
import { IconAlert, IconArrowDown, IconCheck, IconChevronLeft, IconChevronRight, IconX } from './icons';
import { ApprovalCenter } from './execution/ApprovalCenter';
import { EvidencePanel } from './outcome/EvidencePanel';
import { WhyContextItem, WhyMemoryItem } from './decisions/WhyPanels';
import type { CompareResponse, RuntimeSnapshot } from '../types';

const SEG_COLORS = ['#0C7A5C', '#2F9E7E', '#2F7AC2', '#D9A62E', '#7C8B84', '#4FB3A9'];
// Quick-nav covers the high-value runtime story only. Low-frequency detail
// (switches, routing, cache, memory, latency, history, decisions) stays
// reachable by scrolling or expanding — never competing for attention.
const NAV = [['health', 'Health'], ['model', 'Model'], ['why', 'Why?'], ['context', 'Context'], ['cost', 'Cost'], ['tools', 'Tools'], ['changes', 'Changes'], ['trace', 'Trace']];

function freshnessLabel(status: string | null, lastUpdate: string | null): 'LIVE' | 'STALE' | 'DISCONNECTED' | 'UNKNOWN' {
  if (status === 'connected') {
    if (!lastUpdate) return 'LIVE';
    const age = Date.now() - new Date(lastUpdate).getTime();
    return age > 30000 ? 'STALE' : 'LIVE';
  }
  if (status === 'reconnecting') return 'STALE';
  if (status === 'disconnected') return 'DISCONNECTED';
  return 'UNKNOWN';
}

function ConnStatusBadge({ status, lastUpdate, terminal }: { status: string | null; lastUpdate: string | null; terminal?: boolean }) {
  const raw = freshnessLabel(status, lastUpdate);
  // Terminal runs are final history, never stale.
  const label = terminal && raw !== 'DISCONNECTED' ? 'FINAL' : raw;
  const colors = { LIVE: 'ok', STALE: 'warn', DISCONNECTED: 'err', UNKNOWN: 'muted', FINAL: 'muted' };
  const texts = { LIVE: 'LIVE', STALE: 'STALE', DISCONNECTED: 'DISCONNECTED', UNKNOWN: 'UNKNOWN', FINAL: 'FINAL' };
  const classNames = { LIVE: 'conn live', STALE: 'conn stale', DISCONNECTED: 'conn disconnected', UNKNOWN: 'conn unknown', FINAL: 'conn final' };
  return (
    <span className={`conn ${classNames[label]}`} title={label === 'FINAL' ? 'Run is complete — final state' : texts[label]}>
      <span className="dot" />
      {texts[label]}
    </span>
  );
}

export type InspectorTab = 'overview' | 'decisions' | 'resources' | 'evidence' | 'technical';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'resources', label: 'Resources' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'technical', label: 'Technical' },
];

export function RuntimeInspector() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  const [tab, setTab] = useState<InspectorTab>('overview');
  if (!snap) return <aside className="right" aria-label="Runtime inspector"><Empty what="Runtime state" hint="Select a run to inspect live runtime telemetry." /></aside>;
  const open = state.ui.rightOpen;
  const snapTerminal = !!snap && ['completed', 'failed', 'cancelled'].includes(String(snap.status));
  return (
    <aside className={`right ${open ? 'open' : ''}`} aria-label="Runtime inspector">
      {!open && (
        <Tip label="Open runtime inspector" side="left">
          <button className="inspector-fab" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: true } })} aria-label="Open runtime inspector"><IconChevronLeft size={15} /> Inspector</button>
        </Tip>
      )}
      <div className="inspector-head">
        <span className="inspector-title">Runtime</span>
        <ConnStatusBadge status={state.server.conn.status} lastUpdate={state.server.conn.lastUpdate} terminal={snapTerminal} />
        <Tip label="Collapse runtime inspector">
          <button className="icon-btn sm icon-only" aria-label="Collapse runtime inspector" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: false } })}><IconChevronRight size={15} /></button>
        </Tip>
      </div>
      <div className="inspector-mode-note" role="note">
        {snapTerminal ? 'Final state · read-only history' : 'Live · updating as the run executes'}
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`inspanel-${t.id}`}
            id={`instab-${t.id}`}
            className={`inspector-tab${tab === t.id ? ' on' : ''}`}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const idx = TABS.findIndex((x) => x.id === t.id);
              const next = e.key === 'ArrowRight' ? TABS[(idx + 1) % TABS.length] : TABS[(idx - 1 + TABS.length) % TABS.length];
              setTab(next.id);
              document.getElementById(`instab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`inspanel-${tab}`} role="tabpanel" aria-labelledby={`instab-${tab}`}>
        {tab === 'overview' && (
          <>
            {snapTerminal && <RunOutcomePanel snap={snap} />}
            {!snapTerminal && <FocusCard snap={snap} />}
            <HealthPanel snap={snap} />
            <CurrentModel snap={snap} />
            <CostPanel snap={snap} />
            <ToolsPanel snap={snap} />
            <Section id="approvals" title="Approvals"><ApprovalCenter snap={snap} /></Section>
          </>
        )}
        {tab === 'decisions' && (
          <>
            <WhyModel snap={snap} />
            <RoutingPanel snap={snap} />
            <ModelSwitch snap={snap} />
            <DecisionsPanel snap={snap} />
          </>
        )}
        {tab === 'resources' && (
          <>
            <ContextPanel snap={snap} />
            <CachePanel snap={snap} />
            <MemoryPanel snap={snap} />
            <LatencyPanel snap={snap} />
            <HistoryPanel snap={snap} />
          </>
        )}
        {tab === 'evidence' && (
          <>
            <Section id="evidence" title="Evidence">
              <EvidencePanel snap={snap} />
            </Section>
            <ChangesPanel snap={snap} />
            {snapTerminal && <ReplayPanel snap={snap} />}
            {snapTerminal && <ComparePanel snap={snap} />}
          </>
        )}
        {tab === 'technical' && (
          <>
            <TracePanel />
            <Section id="runtime" title="Runtime state">
              <KV k="Status" v={String(snap.status)} />
              <KV k="Internal" v={String(snap.internalStatus || snap.status)} />
              <KV k="Run" v={snap.runId} />
              <KV k="Sequence" v={String(snap.lastSeq)} />
              <KV k="Updated" v={snap.updatedAt ? fmtTime(snap.updatedAt) : '—'} />
              <KV k="Model" v={snap.activeModelId || '—'} />
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

// ---------- 0. Runtime health ----------
// One high-level status so the user never has to synthesize latency + cost +
// provider + model + tools into a conclusion themselves.
function healthOf(snap: RuntimeSnapshot): { label: string; pill: string; detail: string } {
  const status = String(snap.status || '');
  const spent = snap.cost?.spentUsd, budget = snap.cost?.budgetUsd;
  const overBudget = typeof spent === 'number' && typeof budget === 'number' && budget > 0 && spent >= budget;
  const nearBudget = typeof spent === 'number' && typeof budget === 'number' && budget > 0 && spent / budget >= 0.8;
  const toolFailed = snap.tools.some(t => ['failed', 'timed_out', 'cancelled'].includes(String(t.lastStatus)));
  if (status === 'failed') return { label: 'Needs attention', pill: 'err', detail: 'The run failed. Review the trace, then retry from the last checkpoint.' };
  if (status === 'cancelled') return { label: 'Stopped', pill: 'neutral', detail: 'The run was cancelled. State is preserved.' };
  if (status === 'completed') return { label: 'Completed', pill: 'ok', detail: 'The run finished. Outcome and cost are final.' };
  if (overBudget) return { label: 'Blocked', pill: 'err', detail: 'Budget exhausted — the runtime stopped safely.' };
  if (nearBudget) return { label: 'Attention needed', pill: 'warn', detail: 'Spend is near budget. The runtime is constraining work.' };
  if (toolFailed) return { label: 'Attention needed', pill: 'warn', detail: 'A tool failed but the run continues. See Tools.' };
  if (['running', 'planning', 'waiting'].includes(status)) {
    const runningTool = snap.tools.find(t => t.lastStatus === 'running');
    if (runningTool) return { label: 'Working', pill: 'info', detail: `Running tool ${runningTool.name}…` };
    return { label: 'Working', pill: 'info', detail: 'The agent is executing.' };
  }
  return { label: 'Ready', pill: 'neutral', detail: 'Idle — describe a task to start.' };
}

function HealthPanel({ snap }: { snap: RuntimeSnapshot }) {
  const h = healthOf(snap);
  const lastTrace = snap.trace[snap.trace.length - 1];
  return (
    <Section id="health" title="Runtime health">
      <div className={`health-hero health-${h.pill}`}>
        <span className={`pill ${h.pill}`} role="status" aria-label={`Runtime health: ${h.label}`}>
          {h.pill === 'ok' ? <IconCheck size={13} /> : h.pill === 'err' || h.pill === 'warn' ? <IconAlert size={13} /> : null}
          {h.label}
        </span>
        <p className="health-detail">{h.detail}</p>
        {lastTrace && (
          <div className="health-step" title={`${lastTrace.type} · ${lastTrace.ts}`}>
            <span className="eyebrow">Current step</span>
            <span className="health-step-label">{lastTrace.label}</span>
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------- 1. Current model ----------
function CurrentModel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const model = state.server.models.find(m => m.id === snap.activeModelId);
  const util = snap.context.windowTokens ? snap.context.usedTokens / snap.context.windowTokens : null;
  const terminal = ['completed', 'failed', 'cancelled'].includes(String(snap.status));
  if (!model && !snap.activeModelId) {
    return <Section id="model" title="Current model"><Empty what="Active model" hint="No model selected yet for this run." /></Section>;
  }
  return (
    <Section id="model" title="Current model" flashKey={snap.activeModelId || ''}>
      <div className="model-hero">
        <div className="eyebrow">{terminal ? 'FINAL' : 'ACTIVE'} {snap.meta?.mode === 'live' ? `· LIVE ${snap.meta.provider || ''}` : '· DEMO'}</div>
        <div className="name">
          <StatusDot status={model?.status || 'active'} />
          <span title={snap.activeModelId || ''}>{model?.name || snap.activeModelId}</span>
        </div>
        <div className="prov">{model ? `${model.provider} · ${model.status}` : 'provider unknown'}{snap.meta?.preset ? ` · ${snap.meta.preset} preset` : ''}</div>
        <div className="grid">
          <div className="stat"><div className="l">Context</div><div className="n">{util === null ? '—' : `${fmtK(snap.context.usedTokens, 1)} / ${fmtK(snap.context.windowTokens, 0)}`}</div><div className="s">{util === null ? 'window unknown' : fmtPct(util, 1)}</div></div>
          <div className="stat"><div className="l">Health</div><div className="n">{model && model.reliability !== null && model.reliability !== undefined ? fmtPct(model.reliability, 1) : '—'}</div><div className="s">{model?.status || 'unknown'}</div></div>
          <div className="stat"><div className="l">Latency</div><div className="n">{model ? fmtSec(model.avgLatencyMs) : fmtSec(snap.latency.modelMs)}</div><div className="s">avg model</div></div>
          <div className="stat"><div className="l">Quality</div><div className="n">{model && model.quality !== null && model.quality !== undefined ? model.quality.toFixed(2) : '—'}</div><div className="s">{model && model.qualitySource === 'observed' ? 'observed' : model && model.qualitySource === 'demo' ? 'demo sample' : 'not measured'}</div></div>
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
              <span className={`mk ${f.status}`} aria-hidden="true">{f.status === 'pass' ? <IconCheck size={11} /> : f.status === 'warn' ? '!' : <IconX size={11} />}</span>
              <span>{f.label}{f.detail ? <span className="fd"> — {f.detail}</span> : null}</span>
            </div>
          ))}
        </>
      )}
      {(alts.length > 0 || (d?.alternatives && d.alternatives.length > 0)) && (
        <>
          <div className="eyebrow">ALTERNATIVES</div>
          {alts.map(a => {
            const saving = current && current.costUsd !== null && a.costUsd !== null ? current.costUsd - a.costUsd : null;
            return (
              <div key={a.modelId} className="cand alt">
                <div className="kv"><span className="k"><b style={{ color: 'var(--text)' }}>{nameOf(a.modelId)}</b></span><span className="v">score {a.score.toFixed(2)}</span></div>
                <div className="kv"><span className="k">{usd(a.costUsd)} · {fmtSec(a.latencyMs)}</span>
                  <span className="v">{saving === null ? 'cost unknown' : saving > 0.0000005 ? `saves ${usd(saving)}` : saving < -0.0000005 ? `+${usd(-saving).slice(1)}` : ''}</span></div>
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
          <div className="switch-flow"><span className="old">{shortModel(s.from)}</span><span className="arrow" aria-hidden="true"><IconArrowDown size={14} /></span><span className="new">{shortModel(s.to)}</span></div>
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
          <WhyContextItem item={it} />
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
      <MemoryList title="Working" items={snap.memory.working} emptyHint="No working memories for this run yet. Working memory is per-run and process-local." />
      <MemoryList title="Long-term" items={snap.memory.longterm} emptyHint="No long-term memories yet. Long-term memory is process-local; learned model performance persists separately via intelligence." />
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
          <WhyMemoryItem item={m} />
          {openId === m.id && (
            <div className="memdetail">
              {displaySnippet(m.snippet) || 'No summary available.'}
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
            <StatusDot status={t.status === 'enabled' ? (['failed', 'timed_out', 'cancelled'].includes(String(t.lastStatus)) ? 'failed' : 'idle') : 'down'} />
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
              <span className="k"><StatusDot status={['failed', 'timed_out', 'cancelled'].includes(String(t.lastStatus)) ? 'failed' : 'success'} />{t.name}</span>
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



// ---------- Adaptive focus ----------
// One contextual highlight chosen by current state — never a static stack of
// equally-weighted cards. Priority: budget block > context pressure >
// active tool > routing decision > latest runtime change > current step.
function FocusCard({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const spent = snap.cost?.spentUsd;
  const budget = snap.cost?.budgetUsd;
  const overBudget = typeof spent === 'number' && typeof budget === 'number' && budget > 0 && spent >= budget;
  const nearBudget = typeof spent === 'number' && typeof budget === 'number' && budget > 0 && spent / budget >= 0.8;
  const util = snap.context.windowTokens ? snap.context.usedTokens / snap.context.windowTokens : null;
  const contextHot = util !== null && util >= 0.8;
  const runningTool = snap.tools.find((t) => t.lastStatus === 'running');
  const decision = snap.routing.decision;
  const lastChange = snap.changes[snap.changes.length - 1];
  const lastTrace = snap.trace[snap.trace.length - 1];

  let title = 'Current step';
  let body: React.ReactNode = lastTrace ? lastTrace.label : 'Waiting for the run to start.';
  let meta: string | null = lastTrace ? `${fmtTime(lastTrace.ts)} · ${lastTrace.type}` : null;

  if (overBudget || nearBudget) {
    title = overBudget ? 'Budget exhausted' : 'Budget warning';
    body = `${usd(spent)} of ${usd(budget)} used${overBudget ? ' — the runtime stopped safely.' : ' — the runtime is constraining work.'}`;
    meta = 'See Cost for the breakdown';
  } else if (contextHot && util !== null) {
    title = 'Context pressure';
    body = `${fmtK(snap.context.usedTokens, 1)} / ${fmtK(snap.context.windowTokens, 0)} (${fmtPct(util, 0)}) — optimization triggers automatically.`;
    meta = 'See Context for composition';
  } else if (runningTool) {
    title = `Tool running: ${runningTool.name}`;
    body = runningTool.description || 'Executing tool…';
    meta = `×${runningTool.calls} calls · ${fmtSec(runningTool.avgLatencyMs)} avg`;
  } else if (decision) {
    const nameOf = (id: string) => state.server.models.find((m) => m.id === id)?.name || id;
    const current = snap.routing.currentId || snap.activeModelId || '';
    title = 'Latest routing decision';
    body = decision.decision;
    meta = `${nameOf(current)} · ${relTime(decision.timestamp)}`;
  } else if (lastChange && /switch|compress|invalidat|exceed|warning/i.test(lastChange.label)) {
    title = 'Latest runtime change';
    body = lastChange.label;
    meta = relTime(lastChange.ts);
  }

  return (
    <Section id="focus" title="Now">
      <div className="focus-card" role="status" aria-label={`Current focus: ${title}`}>
        <div className="eyebrow">{title}</div>
        <div>{body}</div>
        {meta && <div className="meta">{meta}</div>}
      </div>
    </Section>
  );
}

// ---------- Run outcome (terminal runs first) ----------
// Concise, real numbers only: duration, cost, tools, switches + the runtime
// optimizations that actually happened. Empty categories render nothing.
function RunOutcomePanel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const run = state.server.runs.find((r) => r.id === snap.runId);
  const status = String(snap.status);
  const toolCalls = snap.tools.reduce((a, t) => a + (t.calls || 0), 0);
  const switches = snap.decisions.filter((d) => d.kind === 'model_switch').length;
  const failedTools = snap.trace.filter((t) => t.type === 'tool.failed').length;
  const compressions = snap.changes.filter((c) => /compress/i.test(c.label));
  const cacheSaved = snap.cache.savedUsd > 0 ? snap.cache.savedUsd : null;

  const stats: { l: string; n: string }[] = [];
  if (run?.createdAt && snap.updatedAt && elapsed(run.createdAt, snap.updatedAt) !== '—') {
    stats.push({ l: 'Duration', n: elapsed(run.createdAt, snap.updatedAt) });
  }
  stats.push({ l: 'Cost', n: usd(snap.cost.spentUsd) });
  if (toolCalls > 0) stats.push({ l: 'Tool calls', n: String(toolCalls) });
  if (switches > 0) stats.push({ l: 'Switches', n: String(switches) });
  stats.push({ l: 'Status', n: status.toUpperCase() });

  const optims: string[] = [];
  for (const c of compressions.slice(-2)) optims.push(`Context optimized — ${c.label}`);
  if (cacheSaved !== null) optims.push(`Cache reuse saved ${usd(cacheSaved)}`);
  if (switches > 0) {
    const last = snap.decisions.filter((d) => d.kind === 'model_switch').slice(-1)[0];
    if (last) optims.push(`Model switch — ${last.decision.slice(0, 100)}`);
  }
  if (failedTools > 0 && status === 'completed') {
    optims.push(`Recovered from ${failedTools} tool failure${failedTools === 1 ? '' : 's'} — run still completed`);
  }

  return (
    <Section id="outcome" title="Outcome">
      <div className="outcome-grid">
        {stats.map((s) => (
          <div key={s.l} className="outcome-stat">
            <div className="l">{s.l}</div>
            <div className="n">{s.n}</div>
          </div>
        ))}
      </div>
      {optims.length > 0 && (
        <>
          <div className="eyebrow">RUNTIME OPTIMIZATION</div>
          {optims.map((o, i) => (
            <div key={i} className="optim-row"><IconCheck size={13} /><span>{o}</span></div>
          ))}
        </>
      )}
      <KV k="Cost basis" v={snap.cost.source || 'unknown'} />
    </Section>
  );
}

// ---------- Run replay (read-only timeline scrub) ----------
function ReplayPanel({ snap }: { snap: RuntimeSnapshot }) {
  const trace = snap.trace;
  const [pos, setPos] = useState(trace.length);
  React.useEffect(() => { setPos(trace.length); }, [snap.runId, trace.length]);
  if (!trace.length) {
    return <Section id="replay" title="Replay"><Empty what="Replay" hint="No execution steps were recorded for this run." /></Section>;
  }
  const idx = Math.max(1, Math.min(trace.length, pos));
  const ev = trace[idx - 1];
  return (
    <Section id="replay" title="Replay" count={trace.length}>
      <div className="replay-controls">
        <button className="icon-btn sm" disabled={idx <= 1} onClick={() => setPos(idx - 1)} aria-label="Previous step">‹</button>
        <input type="range" min={1} max={trace.length} value={idx} aria-label={`Replay step ${idx} of ${trace.length}`}
          onChange={(e) => setPos(Number(e.target.value))} />
        <button className="icon-btn sm" disabled={idx >= trace.length} onClick={() => setPos(idx + 1)} aria-label="Next step">›</button>
        <span className="mono" aria-live="polite">{idx}/{trace.length}</span>
      </div>
      <div className="replay-event" role="status" aria-label={`Step ${idx}: ${ev.label}`}>
        <b>{ev.label}</b>
        <div className="mono">{fmtTime(ev.ts)} · {ev.type} · {ev.status}{ev.durationMs ? ` · ${fmtSec(ev.durationMs)}` : ''}{ev.costUsd ? ` · ${usd(ev.costUsd)}` : ''}</div>
      </div>
      <div className="nr-hint">Read-only — replay inspects history, it never re-executes tools or models.</div>
    </Section>
  );
}

// ---------- Run comparison ----------
function ComparePanel({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const candidates = state.server.runs.filter((r) => r.id !== snap.runId).slice(0, 50);
  const [otherId, setOtherId] = useState('');
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compare = async (id: string) => {
    if (!id) { setResult(null); return; }
    setLoading(true);
    setError(null);
    try {
      setResult(await api.compareRuns(snap.runId, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  if (!candidates.length) {
    return <Section id="compare" title="Compare"><Empty what="Comparison" hint="Run another task first — comparison needs two runs." /></Section>;
  }
  const fmtDur = (ms: number | null) => (ms === null || ms === undefined ? '—' : fmtSec(ms));
  const row = (label: string, a: string, b: string, better?: 'a' | 'b' | null) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td className={`mono${better === 'a' ? ' win' : ''}`}>{a}</td>
      <td className={`mono${better === 'b' ? ' win' : ''}`}>{b}</td>
    </tr>
  );
  const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return (
    <Section id="compare" title="Compare">
      <label className="nr-field" style={{ marginTop: 0 }}>
        <span>Compare this run with</span>
        <select value={otherId} aria-label="Other run to compare"
          onChange={(e) => { setOtherId(e.target.value); void compare(e.target.value); }}>
          <option value="">Select a run…</option>
          {candidates.map((r) => (
            <option key={r.id} value={r.id}>{r.title} · {r.status}</option>
          ))}
        </select>
      </label>
      {loading && <div className="settings-row"><span className="settings-row-desc">Comparing…</span></div>}
      {error && <div className="banner err" role="alert"><span>{error}</span></div>}
      {result && (
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead><tr><th scope="col">Metric</th><th scope="col">This run</th><th scope="col">Other run</th></tr></thead>
            <tbody>
              {row('Status', String(result.a.status), String(result.b.status))}
              {row('Duration', fmtDur(result.a.durationMs), fmtDur(result.b.durationMs),
                num(result.a.durationMs) !== null && num(result.b.durationMs) !== null
                  ? (result.a.durationMs! <= result.b.durationMs! ? 'a' : 'b') : null)}
              {row('Cost', usd(result.a.costUsd), usd(result.b.costUsd),
                num(result.a.costUsd) !== null && num(result.b.costUsd) !== null
                  ? (result.a.costUsd! <= result.b.costUsd! ? 'a' : 'b') : null)}
              {row('Tool calls', String(result.a.toolCalls ?? '—'), String(result.b.toolCalls ?? '—'))}
              {row('Model switches', String(result.a.switches ?? '—'), String(result.b.switches ?? '—'))}
              {row('Model path', (result.a.modelPath || []).join(' → ') || '—', (result.b.modelPath || []).join(' → ') || '—')}
              {row('Cost basis', String(result.a.costSource || '—'), String(result.b.costSource || '—'))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
