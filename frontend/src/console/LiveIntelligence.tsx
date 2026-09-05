// Live Intelligence v2: a single cohesive cockpit canvas.
// Whitespace + hairlines separate ideas. Large numerals tell the story.
// Every value derives from RuntimeSnapshot — unknown stays unknown.
import React, { memo, useMemo, useState } from 'react';
import { useRuntime } from '../state/store';
import { freshnessLabel } from '../hooks/useEventStream';
import { Empty, fmtK, fmtPct, fmtSec, fmtTime, relTime, usd } from '../components/ui';
import { IconChevronRight } from '../components/icons';
import { ApprovalCenter } from '../components/execution/ApprovalCenter';
import { EvidencePanel } from '../components/outcome/EvidencePanel';
import { LineChart } from './charts';
import { useRuntimeTelemetry } from './telemetry';
import type { RuntimeSnapshot } from '../types';
import { effectiveStatus } from '../lib/semantics';

function ConnWord({ status, lastUpdate, terminal }: { status: string | null; lastUpdate: string | null; terminal?: boolean }) {
  const raw = freshnessLabel(status || '', lastUpdate);
  const label = terminal && raw !== 'DISCONNECTED' ? 'FINAL' : raw;
  const word = label === 'LIVE' ? 'Live' : label === 'STALE' ? 'Stale' : label === 'DISCONNECTED' ? 'Offline' : label === 'FINAL' ? 'Final' : 'Idle';
  const dot = label === 'LIVE' ? 'live' : label === 'STALE' ? 'warn' : label === 'DISCONNECTED' ? 'bad' : '';
  return (
    <span className="o2-liveword" role="status" aria-label={`Intelligence ${label}`}>
      <span className={`o2-dot ${dot}`} aria-hidden="true" />{word}
    </span>
  );
}

function Disclosure({ id, title, children, defaultOpen }: { id: string; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="o2-disc" id={`sec-${id}`}>
      <button type="button" className="o2-disch" aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {title}<span className="o2-plus" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div style={{ paddingBottom: 14 }}>{children}</div>}
    </div>
  );
}

const ModelBlock = memo(function ModelBlock({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const model = state.server.models.find((m) => m.id === snap.activeModelId);
  const tele = useRuntimeTelemetry(snap);
  const runRec = state.server.runs.find((r) => r.id === snap.runId);
  const eff = effectiveStatus(snap.status, runRec?.status);
  const terminal = ['completed', 'failed', 'cancelled'].includes(eff);
  const failed = eff === 'failed';
  const cancelled = eff === 'cancelled';
  if (!model && !snap.activeModelId) {
    return (
      <div className="o2-modelblock" aria-label="Current model">
        <div className="o2-eyebrow">Model</div>
        <Empty what="Active model" hint="No model selected yet for this run." />
      </div>
    );
  }
  return (
    <div className="o2-modelblock" aria-label="Current model">
      <div className="o2-eyebrow">{terminal ? 'Final model' : 'Current model'}</div>
      <div className="o2-mname">
        {tele?.live && <span className="o2-dot work" aria-hidden="true" />}
        <span title={snap.activeModelId || ''}>{model?.name || snap.activeModelId}</span>
      </div>
      <div className="o2-msub">
        {terminal ? 'Ran' : 'Running'} on <b>{model ? model.provider : 'unknown provider'}</b>
        {model?.status ? ` · ${model.status}` : ''}
        {snap.meta?.mode ? ` · ${snap.meta.mode}` : ''}
        {model?.reliability != null ? ` · ${(model.reliability * 100).toFixed(0)}% reliability` : ''}
      </div>
      {(failed || cancelled) && (
        <div role="status" aria-label={`Runtime health: ${failed ? 'Needs attention' : 'Stopped'}`}
          style={{ marginTop: 8, fontSize: 12.5, color: failed ? 'var(--o2-err)' : 'var(--o2-muted)', fontWeight: 650 }}>
          {failed ? 'Needs attention — review the trace, then retry from the last checkpoint.' : 'Stopped — state is preserved.'}
        </div>
      )}
    </div>
  );
});

function LatencyHero({ snap }: { snap: RuntimeSnapshot }) {
  const tele = useRuntimeTelemetry(snap);
  const vals = tele?.latency.series || [];
  const n = vals.length;
  return (
    <div className="o2-telesec" aria-label="Latency">
      <div className="o2-telerow"><span className="o2-eyebrow">Latency</span></div>
      <div className="o2-bignum o2-num">{tele?.latency.current != null ? fmtSec(tele.latency.current) : '—'}</div>
      <LineChart values={vals} height={104} format={(v) => fmtSec(v)} label="Latency" tone="sky" />
      <div className="o2-telesub">
        {tele?.latency.average != null ? <>avg <span className="o2-num">{fmtSec(tele.latency.average)}</span></> : 'no samples yet'}
        {n > 0 ? ` · ${n} sample${n === 1 ? '' : 's'}` : ''}
      </div>
    </div>
  );
}

function CostFlow({ snap }: { snap: RuntimeSnapshot }) {
  const tele = useRuntimeTelemetry(snap);
  const vals = tele?.cost.series || [];
  const pct = tele?.cost.utilization ?? 0;
  const railCls = pct >= 1 ? 'crit' : pct >= 0.8 ? 'hot' : '';
  return (
    <div className="o2-telesec" aria-label="Cost">
      <div className="o2-telerow"><span className="o2-eyebrow">Cost</span></div>
      <div className="o2-bignum o2-num">{tele?.cost.spent != null ? usd(tele.cost.spent) : '—'}</div>
      {vals.length >= 1 && <LineChart values={vals} height={56} format={(v) => usd(v)} label="Cost" tone="amber" minPoints={1} />}
      {tele?.cost.budget != null && tele?.cost.spent != null ? (
        <>
          <div className={`o2-rail ${railCls}`} role="img" aria-label={`Budget ${usd(tele.cost.spent)} spent of ${usd(tele.cost.budget)}`}>
            <i style={{ width: `${Math.min(100, pct * 100)}%` }} />
          </div>
          <div className="o2-telesub">of <span className="o2-num">{usd(tele.cost.budget)}</span> budget{tele?.cost.projected != null ? <> · projected <span className="o2-num">{usd(tele.cost.projected)}</span></> : null}</div>
        </>
      ) : (
        <div className="o2-telesub">{tele?.cost.projected != null ? (
      <>projected <span className="o2-num">{usd(tele.cost.projected)}</span></>
    ) : 'budget unknown'}</div>
      )}
    </div>
  );
}

function ContextFlow({ snap }: { snap: RuntimeSnapshot }) {
  const tele = useRuntimeTelemetry(snap);
  const util = tele?.context.utilization ?? null;
  const pct = util ?? 0;
  const railCls = pct >= 0.95 ? 'crit' : pct >= 0.8 ? 'hot' : '';
  return (
    <div className="o2-telesec" aria-label="Context">
      <div className="o2-telerow"><span className="o2-eyebrow">Context</span></div>
      <div className="o2-bignum o2-num">{tele?.context.used != null ? fmtK(tele.context.used, 1) : '—'}</div>
      <div className="o2-telesub">of {tele?.context.window != null ? fmtK(tele.context.window, 0) : '—'} tokens{util !== null ? <> · {(util * 100).toFixed(0)}%</> : ''}</div>
      <div className={`o2-rail ${railCls}`} role="img" aria-label={util !== null ? `Context ${(util * 100).toFixed(0)} percent used` : 'Context usage unknown'}>
        <i style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </div>
      {tele?.context.compressed && (
        <div className="o2-telesub" role="status">↻ Optimized mid-run — tokens reclaimed automatically.</div>
      )}
    </div>
  );
}

function RoutingFlow({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const tele = useRuntimeTelemetry(snap);
  const cands = useMemo(() => [...(tele?.routing.candidates || [])].sort((a, b) => b.score - a.score), [tele?.routing.candidates]);
  const nameOf = (id: string) => state.server.models.find((m) => m.id === id)?.name || id.split('/').pop() || id;
  const maxScore = Math.max(...cands.map((c) => c.score), 1e-9);
  const selected = tele?.routing.selectedId;
  return (
    <Disclosure id="routing" title="Model routing">
      <div aria-label="Model routing">
        {cands.length === 0 && <Empty what="Routing candidates" hint="Candidate scores appear after the first routing evaluation." />}
        {cands.slice(0, 5).map((c) => {
          const cur = c.modelId === selected;
          return (
            <div key={c.modelId} className={`o2-cand ${cur ? 'sel' : ''}`} aria-label={`${nameOf(c.modelId)}, score ${c.score.toFixed(2)}${cur ? ', selected' : ''}`}>
              <div className="o2-cand-top">
                {cur && <span className="o2-dot work" aria-hidden="true" />}
                <b title={c.modelId}>{nameOf(c.modelId)}</b>
                <span className="o2-score">{cur ? 'SELECTED · ' : ''}{c.score.toFixed(0)}</span>
              </div>
              <div className="o2-cand-bar" role="img" aria-label={`${c.modelId} score ${c.score.toFixed(2)}`}>
                <i style={{ width: `${(c.score / maxScore) * 100}%` }} />
              </div>
            </div>
          );
        })}
        {tele?.routing.decision && tele.routing.decision.factors.length > 0 && (
          <p className="o2-whyline">Why: {tele.routing.decision.factors.slice(0, 3).map((f) => f.label).join(' · ')}</p>
        )}
        {tele?.routing.explanation && <p className="o2-whyline">{tele.routing.explanation}</p>}
      </div>
    </Disclosure>
  );
}

function WhyFlow({ snap }: { snap: RuntimeSnapshot }) {
  const { state } = useRuntime();
  const d = snap.routing.decision;
  const nameOf = (id: string) => state.server.models.find((m) => m.id === id)?.name || id;
  return (
    <Disclosure id="why" title="Why this model?">
      <div aria-label="Why this model?">
        {!d && <Empty what="Routing decision" hint="No routing evaluation recorded yet. It appears after the first model selection." />}
        {d && (
          <>
            <div className="o2-kv"><span className="o2-k">Selected</span><span className="o2-v">{nameOf(snap.routing.currentId || snap.activeModelId || '')}</span></div>
            {d.factors.slice(0, 5).map((f) => (
              <div key={f.key} className="o2-kv"><span className="o2-k">{f.status === 'pass' ? '✓' : f.status === 'warn' ? '!' : '✕'} {f.label}</span><span className="o2-v">{f.detail || ''}</span></div>
            ))}
            <p className="o2-whyline">{d.decision} · {relTime(d.timestamp)}</p>
          </>
        )}
      </div>
    </Disclosure>
  );
}

function SwitchFlow({ snap }: { snap: RuntimeSnapshot }) {
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
  const short = (id: string) => (id || '—').split('/').pop()!.slice(0, 30);
  return (
    <Disclosure id="switch" title="Model switches">
      <div aria-label="Model switches">
        {!switches.length && <Empty what="Model switches" hint="No switches recorded — the runtime kept its initial model." />}
        {switches.map((s, i) => (
          <div key={i} className="o2-event" role={s.rejected ? undefined : 'status'}>
            {s.rejected ? (
              <span><b>MODEL SWITCH REJECTED</b> — {s.reason} <span style={{ color: 'var(--o2-faint)' }}>· kept current model</span></span>
            ) : (
              <span><b>MODEL SWITCH</b> — {short(s.from)} → {short(s.to)} <span style={{ color: 'var(--o2-faint)' }}>· {s.reason}{s.cost !== undefined ? ' · ' + usd(s.cost) : ''}</span></span>
            )}
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

function ToolsFlow({ snap }: { snap: RuntimeSnapshot }) {
  const tele = useRuntimeTelemetry(snap);
  if (!tele || !tele.tools.all.length) return null;
  return (
    <div className="o2-telesec" aria-label="Tools">
      <div className="o2-telerow"><span className="o2-eyebrow">Tools</span></div>
      {tele.tools.active.map((t) => (
        <div key={t.name} className="o2-trow" role="status" aria-label={`Tool ${t.name} running`}>
          <span className="o2-dot work" aria-hidden="true" />
          <span className="o2-tname" title={t.description || t.name}>{t.name}</span>
          <span className="o2-tstate warn">Running</span>
        </div>
      ))}
      {tele.tools.recent.map((t) => (
        <div key={t.name} className="o2-trow">
          <span className={`o2-tstate ${t.failed ? 'err' : 'ok'}`}>{t.failed ? '✕' : '✓'}</span>
          <span className="o2-tname" title={t.description || t.name}>{t.name}</span>
          <span className="o2-tv">×{t.calls} · {fmtSec(t.avgLatencyMs)}</span>
        </div>
      ))}
      {tele.tools.all.filter((t) => t.calls === 0 && !t.active).slice(0, 4).map((t) => (
        <div key={t.name} className="o2-trow">
          <span className="o2-tstate mut">·</span>
          <span className="o2-tname" title={t.description || t.name}>{t.name}</span>
          <span className="o2-tv">{t.status !== 'enabled' ? 'blocked' : 'ready'}</span>
        </div>
      ))}
    </div>
  );
}

function CacheFlow({ snap }: { snap: RuntimeSnapshot }) {
  const c = snap.cache;
  const latest = c.recent[0];
  return (
    <Disclosure id="cache" title="Cache">
      <div className="o2-kv"><span className="o2-k">Hit rate</span><span className="o2-v mono">{fmtPct(c.hitRate, 0)}</span></div>
      <div className="o2-kv"><span className="o2-k">Saved</span><span className="o2-v mono">{usd(c.savedUsd)}</span></div>
      {latest && <div className="o2-kv"><span className="o2-k">Latest</span><span className="o2-v">{latest.type === 'cache.hit' ? 'Hit' : latest.type === 'cache.miss' ? 'Miss' : 'Invalidated'} · {relTime(latest.ts)}</span></div>}
      {!c.recent.length && <Empty what="Cache events" hint="No cache activity recorded yet." />}
    </Disclosure>
  );
}

function TraceFlow() {
  const { state } = useRuntime();
  const trace = state.server.snapshot?.trace.slice(-30).reverse() || [];
  const [filter, setFilter] = useState('');
  const rows = filter ? trace.filter((t) => (t.type + t.label).toLowerCase().includes(filter.toLowerCase())) : trace;
  return (
    <Disclosure id="trace" title="Execution trace">
      <div aria-label="Execution trace">
        {!trace.length && <Empty what="Trace" hint="Execution steps appear here as the run progresses." />}
        {trace.length > 8 && <input className="o2-search" style={{ marginBottom: 6 }} placeholder="Filter trace…" aria-label="Filter execution trace" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        {rows.slice(0, 24).map((t) => (
          <div key={t.seq} className="o2-kv">
            <span className="o2-k" style={{ fontFamily: 'var(--o2-mono)', fontSize: 11 }}> {String(t.seq).padStart(3, '0')} · {t.label.slice(0, 60)}</span>
            <span className="o2-v" style={{ fontWeight: 500, color: 'var(--o2-faint)' }}>{fmtTime(t.ts)}</span>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

/** Live Intelligence: one canvas, hairlines, big numerals. */
export function LiveIntelligence() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  if (!snap) {
    return (
      <aside className={`o2-intel ${state.ui.rightOpen ? 'open' : ''}`} aria-label="Runtime inspector">
        <Empty what="Runtime state" hint="Select a run to inspect live runtime telemetry." />
      </aside>
    );
  }
  const open = state.ui.rightOpen;
  const runRec = state.server.runs.find((r) => r.id === snap.runId);
  const eff = effectiveStatus(snap.status, runRec?.status);
  const terminal = ['completed', 'failed', 'cancelled'].includes(eff);
  const pendingCount = (snap.execution?.pendingApprovals || []).length || (snap.approvals || []).filter((a) => a.status === 'pending' || a.status === 'PENDING').length;
  return (
    <aside className={`o2-intel ${open ? 'open' : ''}`} aria-label="Runtime inspector">
      <span className="o2-sheet-handle" aria-hidden="true" />
      <div className="o2-intel-head">
        <span className="o2-intel-title">Live Intelligence</span>
        <ConnWord status={state.server.conn.status} lastUpdate={state.server.conn.lastUpdate} terminal={terminal} />
        <button className="o2-iconbtn" style={{ width: 28, height: 28 }} aria-label="Collapse live intelligence panel" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: false } })}>
          <IconChevronRight size={14} />
        </button>
      </div>
      <div className="o2-telesub" role="note" style={{ margin: '10px 0 0' }}>
        {terminal ? 'Final state · read-only history' : 'Live · updating as the run executes'}
      </div>

      <ModelBlock snap={snap} />
      <LatencyHero snap={snap} />
      <CostFlow snap={snap} />
      <ContextFlow snap={snap} />
      <ToolsFlow snap={snap} />

      <div className="o2-telesec" aria-label="Approvals" style={{ paddingBottom: 8 }}>
        <div className="o2-telerow" style={{ marginBottom: 6 }}>
          <span className="o2-eyebrow">Approvals{pendingCount > 0 ? ` · ${pendingCount} waiting` : ''}</span>
        </div>
        <ApprovalCenter snap={snap} />
      </div>

      <RoutingFlow snap={snap} />
      <WhyFlow snap={snap} />
      <SwitchFlow snap={snap} />
      <CacheFlow snap={snap} />

      <Disclosure id="evidence" title="Evidence">
        <div id="sec-evidence"><EvidencePanel snap={snap} /></div>
      </Disclosure>
      <Disclosure id="changes" title="What changed?">
        <div id="sec-changes">
          {!snap.changes.length && <Empty what="Changes" hint="Runtime change events appear here." />}
          {snap.changes.slice(-10).reverse().map((c) => (
            <div key={c.seq} className="o2-kv">
              <span className="o2-k">{c.label.slice(0, 80)}</span>
              <span className="o2-v" style={{ fontWeight: 500, color: 'var(--o2-faint)' }}>{fmtTime(c.ts)}</span>
            </div>
          ))}
        </div>
      </Disclosure>
      <TraceFlow />

      <Disclosure id="technical" title="Technical details">
        <div className="o2-kv"><span className="o2-k">Status</span><span className="o2-v mono">{String(snap.status)}</span></div>
        <div className="o2-kv"><span className="o2-k">Run</span><span className="o2-v mono">{snap.runId}</span></div>
        <div className="o2-kv"><span className="o2-k">Sequence</span><span className="o2-v mono">{String(snap.lastSeq)}</span></div>
        <div className="o2-kv"><span className="o2-k">Updated</span><span className="o2-v mono">{snap.updatedAt ? fmtTime(snap.updatedAt) : '—'}</span></div>
        <div className="o2-kv"><span className="o2-k">Model</span><span className="o2-v mono">{snap.activeModelId || '—'}</span></div>
        {snap.decisions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {snap.decisions.slice(-5).reverse().map((d, i) => (
              <div key={i} style={{ fontSize: 12, padding: '4px 0', color: 'var(--o2-muted)' }}>
                {String(d.decision).slice(0, 120)}
                <div style={{ fontSize: 11, color: 'var(--o2-faint)' }}>{d.kind} · {relTime(d.timestamp)}</div>
              </div>
            ))}
          </div>
        )}
      </Disclosure>
    </aside>
  );
}

// Back-compat export: existing imports of RuntimeInspector keep working.
export const RuntimeInspector = LiveIntelligence;
export type InspectorTab = 'overview' | 'decisions' | 'resources' | 'evidence' | 'technical';
