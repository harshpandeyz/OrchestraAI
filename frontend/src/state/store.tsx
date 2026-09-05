import React, { createContext, useContext, useMemo, useReducer } from 'react';
import type { ChatMessage, ConnStatus, EvaluationRecord, MemoryItem, ModelInfo, Run, RuntimeSnapshot, StreamEnvelope } from '../types';

// ---------- Pure event application (tested) ----------
let localSeq = 100000;
const stamp = () => new Date().toISOString();

export function applyEventToSnapshot(snap: RuntimeSnapshot, env: StreamEnvelope): RuntimeSnapshot {
  const t = env.type, p = env.payload || {};
  // Text deltas are the highest-frequency event. Apply them with structural
  // sharing so the large snapshot, routing tables, and telemetry arrays are
  // not deep-cloned for every provider chunk. The stream hook also coalesces
  // adjacent chunks to keep React work bounded.
  if (t === 'response.delta') {
    return {
      ...snap,
      lastSeq: Math.max(snap.lastSeq, env.seq),
      updatedAt: env.ts,
      messages: appendDelta(snap.messages, String(p.delta || '')),
    };
  }
  const next: RuntimeSnapshot = JSON.parse(JSON.stringify(snap));
  next.lastSeq = Math.max(next.lastSeq, env.seq);
  next.updatedAt = env.ts;
  const pushTrace = (label: string, status = 'done', extra: any = {}) => {
    next.trace = [...next.trace.slice(-200), { seq: env.seq, ts: env.ts, type: t, label, status, ...extra }];
  };
  const pushChange = (kind: string, label: string) => {
    next.changes = [...next.changes.slice(-100), { seq: env.seq, ts: env.ts, kind: kind as any, label }];
  };
  switch (t) {
    case 'task.created': next.status = 'planning'; pushTrace(p.userText ? `Task: ${String(p.userText).slice(0, 80)}` : 'Task created'); break;
    case 'task.started': next.status = 'planning'; pushTrace('Run started'); break;
    case 'task.updated': pushTrace(p.userText ? `User: ${String(p.userText).slice(0, 80)}` : 'Task updated'); break;
    case 'planning': next.status = 'planning'; pushTrace(p.note || 'Planning...', 'running'); break;
    case 'context.built': {
      next.status = 'running';
      if (typeof p.usedTokens === 'number') next.context.usedTokens = p.usedTokens;
      if (typeof p.windowTokens === 'number') next.context.windowTokens = p.windowTokens;
      if (typeof p.utilization === 'number' && next.context.windowTokens) next.context.usedTokens = Math.round(p.utilization * next.context.windowTokens);
      pushTrace(`Context built${typeof p.usedTokens === 'number' && typeof p.windowTokens === 'number' ? ` (${(p.usedTokens / 1000).toFixed(1)}k / ${(p.windowTokens / 1000).toFixed(0)}k)` : ''}`); break;
    }
    case 'execution.started': next.status = 'running'; pushTrace('Execution started', 'running'); break;
    case 'execution.completed': pushTrace('Execution completed'); break;
    case 'execution.paused': pushTrace('Execution paused', 'running'); break;
    case 'execution.resumed': pushTrace('Execution resumed', 'running'); break;
    case 'context.added': if (p.tokens) next.context.usedTokens += p.tokens; pushTrace(`Context added: ${p.title || p.itemId || ''}`); break;
    case 'context.removed': if (p.tokens) next.context.usedTokens = Math.max(0, next.context.usedTokens - p.tokens); pushTrace(`Context removed: ${p.title || ''}`); break;
    case 'context.limit_warning': pushTrace(`Context near limit (${((p.utilization || 0) * 100).toFixed(0)}%)`, 'error'); pushChange('updated', 'Context near limit'); break;
    case 'context.compressed':
      if (p.reclaimedTokens) next.context.usedTokens = Math.max(0, next.context.usedTokens - p.reclaimedTokens);
      pushTrace(p.detail || 'Context compressed', 'done'); pushChange('updated', `↻ Context compressed −${((p.reclaimedTokens || 0) / 1000).toFixed(1)}k tokens`); break;
    case 'model.selected': {
      const mid = p.modelId || p.model || next.activeModelId;
      next.activeModelId = mid || next.activeModelId; next.routing.currentId = next.activeModelId || next.routing.currentId;
      if (Array.isArray(p.factors) && p.factors.length) {
        const factors = p.factors.map((f: any) => typeof f === 'string' ? { key: f, label: f, status: 'pass' as const } : { key: f.key || f.label || 'factor', label: f.label || f.key || 'factor', status: f.status || 'pass' as const, detail: f.detail });
        next.routing.decision = { kind: 'model_selection', decision: `SELECT ${mid || ''}${p.reason ? ` — ${p.reason}` : ''}`, timestamp: env.ts, factors };
        next.decisions = [...next.decisions.slice(-50), next.routing.decision];
      } else if (p.reason) {
        const d = { kind: 'model_selection', decision: `SELECT ${mid || ''} — ${p.reason}`, timestamp: env.ts, factors: [] as any[] };
        next.decisions = [...next.decisions.slice(-50), d];
        if (!next.routing.decision) next.routing.decision = d;
      }
      pushTrace(`Model selected: ${mid || 'unknown'}${p.reason ? ` — ${String(p.reason).slice(0, 80)}` : ''}`); pushChange('added', `+ Model selected: ${mid || 'unknown'}`); break;
    }
    case 'model.switch_requested':
      pushTrace(`Model switch requested: ${p.fromModel || p.fromId || ''} → ${p.toModel || p.toId || ''}${p.reason ? ` — ${String(p.reason).slice(0, 80)}` : ''}`, 'running'); break;
    case 'model.retained': {
      const factors = Array.isArray(p.factors) ? p.factors.map((f: any) => typeof f === 'string' ? { key: f, label: f, status: 'pass' as const } : { key: f.key || f.label, label: f.label || f.key, status: f.status || 'pass' as const }) : [];
      next.decisions = [...next.decisions, { kind: 'model', decision: `MODEL RETAINED — ${p.reason || ''}`, timestamp: env.ts, factors }];
      pushTrace(`Model retained — ${p.reason || ''}`); pushChange('retained', `→ Model retained: ${p.reason || ''}`); break;
    }
    case 'model.switch_rejected':
      next.decisions = [...next.decisions, { kind: 'model', decision: `SWITCH REJECTED — ${p.reason || ''}`, timestamp: env.ts, factors: [] }];
      pushTrace(`Model switch rejected — ${p.reason || ''}`, 'error'); pushChange('retained', `→ Switch rejected: ${p.reason || ''}`); break;
    case 'model.health_changed':
      pushTrace(`Model health: ${p.modelId} → ${p.status || p.newStatus || ''}`, 'error'); pushChange('updated', `↻ Health: ${p.modelId}`); break;
    case 'model.unavailable':
      pushTrace(`Model unavailable: ${p.modelId || ''}`, 'error'); break;
    case 'model.switched': {
      const from = p.fromModel || p.fromId || 'previous';
      const to = p.toModel || p.toId || next.activeModelId;
      next.activeModelId = to || next.activeModelId; next.routing.currentId = next.activeModelId || next.routing.currentId;
      const factors = Array.isArray(p.factors) ? p.factors.map((f: any) => typeof f === 'string' ? { key: f, label: f, status: 'pass' as const } : { key: f.key || f.label || 'factor', label: f.label || f.key || 'factor', status: f.status || 'pass' as const, detail: f.detail }) : [];
      const extra = p.switchingCost !== undefined ? ` (switch cost $${Number(p.switchingCost).toFixed(4)})` : '';
      next.decisions = [...next.decisions.slice(-50), { kind: 'model_switch', decision: `SWITCH ${from} → ${to} — ${p.reason || 'runtime optimization'}${extra}`, timestamp: env.ts, factors }];
      pushTrace(`Model switched: ${from} → ${to}${extra}`, 'done'); pushChange('updated', `↻ Model switched: ${from} → ${to}`); break;
    }
    case 'routing.evaluated':
      if (Array.isArray(p.candidates) && p.candidates.length && typeof p.candidates[0] === 'object') {
        next.routing.candidates = p.candidates.map((c: any) => ({
          modelId: c.modelId || c.id, score: c.score || 0, costUsd: c.estimatedCost ?? c.costUsd ?? null,
          latencyMs: c.avgLatencyMs ?? c.latencyMs ?? null,
          factors: { quality: c.quality || 0, cost: c.cost || 0, latency: c.latency || 0, reliability: c.reliability || 0, contextFit: c.contextFit || 0, switchCost: c.switchCost || 0 },
          predictedSuccess: c.predictedSuccess ?? null, taskFitScore: c.taskFitScore ?? null,
          toolCapabilityScore: c.toolCapabilityScore ?? null, expectedCostUsd: c.expectedCostUsd ?? null,
          expectedLatencyMs: c.expectedLatencyMs ?? null, taskCategory: c.taskCategory ?? null,
          predictionConfidence: c.predictionConfidence || 'none', predictionSamples: c.predictionSamples || 0,
          reasons: Array.isArray(c.reasons) ? c.reasons : [],
          ...(c.excluded ? { excluded: c.excluded, exclusionReason: c.exclusionReason || null } : {}),
        }));
      }
      pushTrace(p.note || 'Routing re-evaluated', 'running'); break;
    case 'tool.selected': pushTrace(`Tool selected: ${p.tool || p.toolName || ''}${p.detail ? ` — ${String(p.detail).slice(0, 80)}` : ''}`); break;
    case 'tool.started': {
      const tn = p.tool || p.toolName;
      next.tools = next.tools.map(x => x.name === tn ? { ...x, lastStatus: 'running' } : x);
      pushTrace(p.detail ? `Tool started: ${tn} — ${String(p.detail).slice(0, 80)}` : `Tool started: ${tn}`, 'running');
      next.messages = [...next.messages.slice(-200), { id: `sys-${env.seq}`, role: 'tool', content: `${tn}: RUNNING${p.detail ? ` — ${p.detail}` : ''}`, ts: env.ts }]; break;
    }
    // Canonical names are tool.completed / tool.failed (tool.finished kept as a legacy alias).
    case 'tool.completed':
    case 'tool.finished': {
      const tn = p.tool || p.toolName;
      const rawStatus = p.status || 'success';
      const ok = rawStatus === 'success';
      // Preserve canonical outcome (timed_out/cancelled/…) — never collapse
      // a timeout into generic failure.
      const lastStatus = rawStatus === 'success' ? 'success' : rawStatus === 'failed' ? 'failed' : rawStatus;
      next.tools = next.tools.map(x => x.name === tn ? { ...x, lastStatus, calls: p.deduped ? x.calls : x.calls + 1 } : x);
      if (p.durationMs) {
        next.latency.toolMs = p.durationMs;
        next.latency.samples = [...next.latency.samples.slice(-40), p.durationMs];
      }
      pushTrace(`${tn}: ${String(p.status || 'success').toUpperCase()} (${((p.durationMs || 0) / 1000).toFixed(1)}s)${p.deduped ? ' [idempotent replay]' : ''}`, ok ? 'done' : 'error');
      next.messages = [...next.messages.slice(-200), { id: `sys-${env.seq}`, role: 'tool', content: `${tn}: ${String(p.status || 'success').toUpperCase()} (${((p.durationMs || 0) / 1000).toFixed(1)}s)`, ts: env.ts }];
      if (!ok) pushChange('updated', 'Tool failed — observed, continuing');
      break;
    }
    case 'tool.failed': {
      const tn = p.tool || p.toolName;
      const lastStatus = p.status && p.status !== 'failed' ? p.status : 'failed';
      next.tools = next.tools.map(x => x.name === tn ? { ...x, lastStatus } : x);
      if (p.durationMs) {
        next.latency.toolMs = p.durationMs;
        next.latency.samples = [...next.latency.samples.slice(-40), p.durationMs];
      }
      pushTrace(`${tn}: FAILED — ${p.error || p.code || ''}`, 'error');
      next.messages = [...next.messages.slice(-200), { id: `sys-${env.seq}`, role: 'tool', content: `${tn}: FAILED — ${p.error || p.code || ''}`, ts: env.ts }];
      pushChange('updated', 'Tool failed — observed, continuing');
      break;
    }
    // NOTE: 'response.delta' is handled by the structural-sharing fast path
    // at the top of this function, not here — keep it that way so the hot
    // path never pays for a deep clone.
    case 'response.done': {
      next.messages = finalizeStream(next.messages, String(p.full || ''));
      if (p.tokens && typeof p.tokens === 'object') {
        const tk = p.tokens as any;
        if (typeof tk.input === 'number' || typeof tk.output === 'number') {
          const total = (tk.input || 0) + (tk.output || 0);
          if (total > 0) next.context.usedTokens = Math.max(next.context.usedTokens, total);
        }
      }
      if (typeof p.latencyMs === 'number') {
        next.latency.modelMs = p.latencyMs;
        next.latency.samples = [...next.latency.samples.slice(-40), p.latencyMs];
      }
      pushTrace('Model response'); break;
    }
    case 'cache.hit':
      // Hit rate itself comes from backend snapshots only — never estimated here.
      // The live event is recorded in `recent` and real savedUsd is accumulated.
      next.cache.recent = [{ type: 'cache.hit', ts: env.ts, detail: p.detail || 'Cache hit' }, ...next.cache.recent].slice(0, 20);
      if (typeof p.savedUsd === 'number') next.cache.savedUsd += p.savedUsd;
      pushChange('updated', 'Cache hit'); break;
    case 'cache.miss':
      next.cache.recent = [{ type: 'cache.miss', ts: env.ts, detail: p.detail || 'Cache miss' }, ...next.cache.recent].slice(0, 20); break;
    case 'cache.invalidated':
      next.cache.state = 'COOLING';
      next.cache.recent = [{ type: 'cache.invalidated', ts: env.ts, detail: p.detail || 'Cache invalidated' }, ...next.cache.recent].slice(0, 20);
      pushChange('updated', 'Cache invalidated'); break;
    case 'cost.updated':
      if (p.spentUsd !== undefined) next.cost.spentUsd = p.spentUsd;
      if (p.projectedUsd !== undefined) next.cost.projectedUsd = p.projectedUsd;
      if (p.sample) next.series = [...(next.series || []).slice(-200), p.sample];
      pushTrace(`Cost updated: $${(p.spentUsd || 0).toFixed(3)}`); break;
    case 'budget.warning':
      pushTrace(`Budget warning: $${(p.spent || 0).toFixed(3)} / $${(p.budget || 0).toFixed(3)}`, 'error');
      pushChange('updated', 'Budget warning'); break;
    case 'budget.exceeded':
      pushTrace(`Budget exceeded: $${(p.spent || 0).toFixed(3)} / $${(p.budget || 0).toFixed(3)}`, 'error');
      pushChange('updated', 'Budget exceeded'); break;
    case 'price.updated':
      pushTrace(`Price updated: ${p.modelId || ''}`, 'done'); pushChange('updated', `↻ Price updated: ${p.modelId || ''}`); break;
    case 'model.price_changed':
      pushTrace(`Price changed: ${p.modelId || ''}`, 'done'); pushChange('updated', `↻ Price changed: ${p.modelId || ''}`); break;
    // Canonical name is memory.written (memory.write kept as a legacy alias).
    case 'memory.written':
    case 'memory.write':
      if (p.item) { const it = p.item; next.memory = { ...next.memory, [it.scope]: [it, ...((next.memory as any)[it.scope] || [])] }; }
      else if (p.title) { const it = { id: p.itemId || `m-${env.seq}`, scope: p.scope || 'working', title: p.title, snippet: '', source: '', createdAt: env.ts, lastUsedAt: env.ts, importance: 0.5, confidence: 0.5, status: 'active' }; next.memory = { ...next.memory, [(it as any).scope]: [it, ...((next.memory as any)[(it as any).scope] || [])] }; }
      pushChange('added', `+ Memory write (${p.scope || 'working'})`); break;
    case 'memory.read': pushTrace(`Memory read (${p.scope}): ${p.count || 0} items`); break;
    case 'memory.evicted': pushChange('removed', `− Memory evicted (${p.scope || ''})`); break;
    case 'execution.step_started': pushTrace(`Step ${p.step || ''} started`, 'running'); break;
    case 'execution.step_completed': pushTrace(`Step ${p.step || ''} completed`); break;
    case 'execution.retry': pushTrace(`Retrying (attempt ${p.attempt || ''})`, 'running'); break;
    case 'execution.failed': pushTrace(`Step failed: ${p.error || ''}`, 'error'); break;
    // Session 3 execution events: trace + headline. The authoritative
    // plan/approval/changeset/episode state arrives via snapshot.execution;
    // events never reconstruct it locally (no duplicated source of truth).
    case 'plan.created': pushTrace(`Plan created (${p.steps || ''} steps)`); pushChange('added', `+ Plan created`); break;
    case 'plan.updated': pushTrace(`Plan updated (v${p.version || ''})`); pushChange('updated', '↻ Plan updated'); break;
    case 'tool.approval_required': pushTrace(`Approval required: ${p.tool || ''} (${p.risk || ''})`, 'running'); pushChange('added', `+ Approval required: ${p.tool || ''}`); break;
    case 'tool.approved': pushTrace(`Approved: ${p.actionType || p.tool || ''}`); break;
    case 'tool.denied': pushTrace(`Denied: ${p.actionType || p.tool || ''}`, 'error'); break;
    case 'tool.timed_out': pushTrace(`Timed out: ${p.tool || ''}`, 'error'); pushChange('updated', 'Tool timed out — recorded, not retried blindly'); break;
    case 'approval.requested': pushTrace(`Approval requested: ${p.actionType || ''}`, 'running'); pushChange('added', `+ Approval requested`); break;
    case 'approval.decided': pushTrace(`Approval ${p.decision || ''}: ${p.actionType || ''}`); break;
    case 'changeset.created': pushTrace(`Changes proposed (${(p.files || []).length || ''} files)`); pushChange('added', '+ Changes proposed'); break;
    case 'changeset.approval_required': pushTrace('Changeset waiting for approval', 'running'); break;
    case 'changeset.applied': pushTrace(`Changes applied (${p.additions || 0}+/${p.deletions || 0}-)`); pushChange('updated', `↻ Changes applied`); break;
    case 'changeset.rolled_back': pushTrace('Changes rolled back'); pushChange('updated', '↻ Changes rolled back'); break;
    case 'verification.started': pushTrace(`Verification started (${p.origin || ''})`, 'running'); break;
    case 'verification.passed': pushTrace(`Verified: ${p.summary || ''}`); pushChange('retained', `→ Verified: ${String(p.summary || '').slice(0, 80)}`); break;
    case 'verification.failed': pushTrace(`Verification failed: ${p.summary || ''}`, 'error'); pushChange('updated', 'Verification failed — see evidence'); break;
    case 'episode.started': pushTrace(p.parentEpisodeId ? 'Continuation started (new episode, same run)' : 'Episode started'); break;
    case 'episode.completed': pushTrace('Episode completed'); break;
    case 'execution.recovery_started': pushTrace('Recovery started', 'running'); break;
    case 'execution.recovered': pushTrace('Recovered'); break;
    case 'execution.recovery_blocked': pushTrace('Recovery needs your decision (unknown side effects)', 'error'); pushChange('updated', 'Recovery blocked — review required'); break;
    case 'optimization.triggered': pushTrace('Optimization triggered', 'running'); break;
    case 'optimization.completed': pushTrace('Optimization completed'); break;
    case 'run.completed': next.status = 'completed'; pushTrace(p.summary ? String(p.summary).slice(0, 120) : 'Task completed'); pushChange('retained', 'Run completed'); break;
    case 'run.failed': next.status = 'failed'; pushTrace(p.error || p.reason || 'Run failed', 'error'); break;
    case 'run.cancelled': next.status = 'cancelled'; pushTrace('Run cancelled', 'error'); break;
    case 'change.recorded': pushChange(p.kind || 'updated', p.label || 'Changed'); break;
    default: pushTrace(t);
  }
  return next;
}

const MAX_MESSAGES = 300;
function appendDelta(msgs: ChatMessage[], delta: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && last.meta?.streaming) {
    return [...msgs.slice(-MAX_MESSAGES, -1), { ...last, content: last.content + delta }];
  }
  return [...msgs.slice(-MAX_MESSAGES + 1), { id: `stream-${localSeq++}`, role: 'assistant', content: delta, ts: stamp(), meta: { streaming: true } }];
}
function finalizeStream(msgs: ChatMessage[], full: string): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last && last.meta?.streaming) return [...msgs.slice(-MAX_MESSAGES, -1), { ...last, content: full, meta: {} }];
  return [...msgs.slice(-MAX_MESSAGES + 1), { id: `a-${localSeq++}`, role: 'assistant', content: full, ts: stamp() }];
}

// ---------- Store ----------
export type View = 'overview' | 'savings' | 'run' | 'sessions' | 'models' | 'prompts' | 'memory' | 'tools' | 'evals' | 'cache' | 'alerts' | 'projects' | 'billing' | 'settings';
export interface Toast { id: number; kind: 'ok' | 'warn' | 'err' | 'info'; title: string; body?: string }
interface ServerState { runs: Run[]; activeRunId: string | null; snapshot: RuntimeSnapshot | null; models: ModelInfo[]; tools: RuntimeSnapshot['tools']; memItems: MemoryItem[]; evals: EvaluationRecord[]; evalNote: string; conn: { status: ConnStatus; lastSeq: number; lastUpdate: string | null }; sending: boolean; }
interface UIState { view: View; settingsAnchor: string | null; leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number; expanded: Record<string, boolean>; selectedTrace: number | null; paletteOpen: boolean; newRunOpen: boolean; taskMode: string; memQuery: string; modelQuery: string; toolQuery: string; runQuery: string; runStatusFilter: string; theme: 'dark' | 'light'; toasts: Toast[]; }
interface State { server: ServerState; ui: UIState }
type Action =
  | { type: 'runs/set'; runs: Run[] } | { type: 'runs/active'; id: string | null }
  | { type: 'snap/set'; snap: RuntimeSnapshot } | { type: 'event/apply'; env: StreamEnvelope }
  | { type: 'conn/set'; conn: Partial<ServerState['conn']> }
  | { type: 'models/set'; models: ModelInfo[] } | { type: 'tools/set'; tools: RuntimeSnapshot['tools'] }
  | { type: 'mem/set'; items: MemoryItem[] } | { type: 'evals/set'; evals: EvaluationRecord[]; note: string }
  | { type: 'send/set'; sending: boolean } | { type: 'msg/add'; msg: ChatMessage }
  | { type: 'ui/set'; patch: Partial<UIState> } | { type: 'ui/toggle'; key: string }
  | { type: 'toast/push'; toast: Omit<Toast, 'id'> } | { type: 'toast/dismiss'; id: number };

let toastSeq = 1;
const PANEL_KEY = 'orchestra-panels-v1';
function initialPanels(): { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number } {
  const fallback = { leftOpen: true, rightOpen: true, leftWidth: 264, rightWidth: 380 };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(PANEL_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    return {
      leftOpen: typeof p.leftOpen === 'boolean' ? p.leftOpen : fallback.leftOpen,
      rightOpen: typeof p.rightOpen === 'boolean' ? p.rightOpen : fallback.rightOpen,
      leftWidth: clampWidth(typeof p.leftWidth === 'number' ? p.leftWidth : fallback.leftWidth, 180, 380),
      rightWidth: clampWidth(typeof p.rightWidth === 'number' ? p.rightWidth : fallback.rightWidth, 300, 520),
    };
  } catch { return fallback; }
}
export function clampWidth(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
export function persistPanels(ui: Pick<UIState, 'leftOpen' | 'rightOpen' | 'leftWidth' | 'rightWidth'>) {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({
      leftOpen: ui.leftOpen, rightOpen: ui.rightOpen,
      leftWidth: ui.leftWidth, rightWidth: ui.rightWidth,
    }));
  } catch { /* private mode — session-only */ }
}
function initialTheme(): 'dark' | 'light' {
  try {
    const saved = (typeof localStorage !== 'undefined' && (localStorage.getItem('orchestra-theme') || localStorage.getItem('aar-theme'))) as string | null;
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* ignore */ }
  // Friendly light-first product; dark remains one toggle away.
  return 'light';
}
const panels = initialPanels();
const initial: State = {
  server: { runs: [], activeRunId: null, snapshot: null, models: [], tools: [], memItems: [], evals: [], evalNote: '', conn: { status: 'idle', lastSeq: 0, lastUpdate: null }, sending: false },
  // Progressive disclosure: the runtime story (health/model/why/context/cost) is
  // open; historical + low-frequency detail (switches/cache/memory/latency/
  // routing/history/trace/decisions/changes) starts collapsed.
  ui: { view: 'overview', settingsAnchor: null, leftOpen: panels.leftOpen, rightOpen: panels.rightOpen, leftWidth: panels.leftWidth, rightWidth: panels.rightWidth, expanded: { health: true, model: true, why: true, switch: false, context: true, cache: false, memory: false, tools: true, cost: true, latency: false, history: false, routing: false, trace: false, changes: false, decisions: false, outcome: true, replay: false, compare: false, focus: true }, selectedTrace: null, paletteOpen: false, newRunOpen: false, taskMode: 'auto', memQuery: '', modelQuery: '', toolQuery: '', runQuery: '', runStatusFilter: 'all', theme: initialTheme(), toasts: [] },
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'runs/set': return { ...s, server: { ...s.server, runs: a.runs } };
    case 'runs/active': return { ...s, server: { ...s.server, activeRunId: a.id } };
    case 'snap/set': return { ...s, server: { ...s.server, snapshot: a.snap, conn: { ...s.server.conn, lastSeq: a.snap.lastSeq, lastUpdate: a.snap.updatedAt } } };
    case 'event/apply': {
      if (!s.server.snapshot || a.env.runId !== s.server.snapshot.runId) return s;
      if (a.env.seq <= s.server.conn.lastSeq) return s; // dedupe/out-of-order guard
      const snap = applyEventToSnapshot(s.server.snapshot, a.env);
      // Keep the sidebar run row live: status/spend/model derive from the same backend snapshot.
      const runs = s.server.runs.map(r => r.id === snap.runId
        ? { ...r, status: snap.status, spent: snap.cost.spentUsd, budget: snap.cost.budgetUsd, activeModelId: snap.activeModelId, updatedAt: snap.updatedAt }
        : r);
      return { ...s, server: { ...s.server, snapshot: snap, runs, conn: { ...s.server.conn, lastSeq: a.env.seq, lastUpdate: a.env.ts, status: 'connected' } } };
    }
    case 'conn/set': return { ...s, server: { ...s.server, conn: { ...s.server.conn, ...a.conn } } };
    case 'models/set': return { ...s, server: { ...s.server, models: a.models } };
    case 'tools/set': return { ...s, server: { ...s.server, tools: a.tools } };
    case 'mem/set': return { ...s, server: { ...s.server, memItems: a.items } };
    case 'evals/set': return { ...s, server: { ...s.server, evals: a.evals, evalNote: a.note } };
    case 'send/set': return { ...s, server: { ...s.server, sending: a.sending } };
    case 'msg/add': return s.server.snapshot ? { ...s, server: { ...s.server, snapshot: { ...s.server.snapshot, messages: [...s.server.snapshot.messages, a.msg] } } } : s;
    case 'ui/set': return { ...s, ui: { ...s.ui, ...a.patch } };
    case 'ui/toggle': return { ...s, ui: { ...s.ui, expanded: { ...s.ui.expanded, [a.key]: !s.ui.expanded[a.key] } } };
    case 'toast/push': {
      const t: Toast = { ...a.toast, id: toastSeq++ };
      // Restrained notifications: cap at 4, drop oldest.
      return { ...s, ui: { ...s.ui, toasts: [...s.ui.toasts.slice(-3), t] } };
    }
    case 'toast/dismiss': return { ...s, ui: { ...s.ui, toasts: s.ui.toasts.filter(t => t.id !== a.id) } };
    default: return s;
  }
}

const Ctx = createContext<{ state: State; dispatch: React.Dispatch<Action> } | null>(null);
export function RuntimeProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useRuntime() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRuntime outside provider');
  return v;
}
export { initial, reducer };
