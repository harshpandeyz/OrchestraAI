// Centralized backend-event → frontend-semantic-state → visual-state mapping.
//
// One translation layer for the whole console. Components must use these
// helpers instead of spreading raw `event.type === "..."` checks across the
// UI (see CONTRACTS.md event table). All functions are pure and unit-tested.
//
// Honesty rules enforced here:
// - Human labels never invent data; unknown types fall back to a Technical
//   label, never to a fake success.
// - Observed vs estimated vs unknown is explicit everywhere via Provenance.

export type Provenance = 'observed' | 'estimated' | 'projected' | 'unknown';

export interface Milestone {
  id: string;
  stage: 'plan' | 'context' | 'model' | 'action' | 'verify' | 'result';
  label: string;
  detail: string;
  ts: string;
  status: 'done' | 'active' | 'failed';
  seq: number;
  eventType: string;
}

export interface HumanEvent {
  title: string;
  detail: string;
  tone: 'ok' | 'warn' | 'err' | 'info' | 'neutral';
  milestone: Milestone['stage'] | null;
}

import type { RuntimeSnapshot } from '../types';

// Human-readable copy for product surfaces. Technical event codes remain
// available under Technical details / trace views.
const HUMAN: Record<string, { title: string; tone: HumanEvent['tone']; milestone: HumanEvent['milestone'] }> = {
  'task.created': { title: 'Task received', tone: 'info', milestone: 'plan' },
  'task.started': { title: 'Task started', tone: 'info', milestone: 'plan' },
  'task.updated': { title: 'Task updated', tone: 'info', milestone: 'plan' },
  'planning': { title: 'Thinking through the task', tone: 'info', milestone: 'plan' },
  'context.built': { title: 'Building task context', tone: 'info', milestone: 'context' },
  'context.added': { title: 'Context added', tone: 'neutral', milestone: 'context' },
  'context.removed': { title: 'Context removed', tone: 'neutral', milestone: 'context' },
  'context.compressed': { title: 'Context optimized', tone: 'info', milestone: 'context' },
  'context.limit_warning': { title: 'Context filling up', tone: 'warn', milestone: 'context' },
  'model.selected': { title: 'Model selected', tone: 'ok', milestone: 'model' },
  'model.switch_requested': { title: 'Considering a model switch', tone: 'warn', milestone: 'model' },
  'model.switched': { title: 'Switched models to improve the chance of success', tone: 'warn', milestone: 'model' },
  'model.retained': { title: 'Kept the current model', tone: 'neutral', milestone: 'model' },
  'model.switch_rejected': { title: 'Model switch not worthwhile', tone: 'neutral', milestone: 'model' },
  'model.health_changed': { title: 'Model health changed', tone: 'warn', milestone: 'model' },
  'model.unavailable': { title: 'Model unavailable', tone: 'err', milestone: 'model' },
  'model.price_changed': { title: 'Model pricing updated', tone: 'neutral', milestone: 'model' },
  'price.updated': { title: 'Model pricing updated', tone: 'neutral', milestone: 'model' },
  'routing.evaluated': { title: 'Selecting the best model', tone: 'info', milestone: 'model' },
  'tool.selected': { title: 'Choosing a tool', tone: 'info', milestone: 'action' },
  'tool.started': { title: 'Running tool', tone: 'info', milestone: 'action' },
  'tool.completed': { title: 'Tool finished', tone: 'ok', milestone: 'action' },
  'tool.finished': { title: 'Tool finished', tone: 'ok', milestone: 'action' },
  'tool.failed': { title: 'Tool failed — observed, continuing', tone: 'err', milestone: 'action' },
  'execution.started': { title: 'Execution started', tone: 'info', milestone: 'action' },
  'execution.step_started': { title: 'Working on the next step', tone: 'info', milestone: 'action' },
  'execution.step_completed': { title: 'Step completed', tone: 'ok', milestone: 'action' },
  'execution.retry': { title: 'Retrying the step', tone: 'warn', milestone: 'action' },
  'execution.failed': { title: 'Step failed', tone: 'err', milestone: 'action' },
  'execution.paused': { title: 'Execution paused', tone: 'warn', milestone: 'action' },
  'execution.resumed': { title: 'Execution resumed', tone: 'info', milestone: 'action' },
  'execution.completed': { title: 'Execution finished', tone: 'ok', milestone: 'verify' },
  'optimization.triggered': { title: 'Reviewing the approach', tone: 'info', milestone: 'verify' },
  'optimization.completed': { title: 'Approach reviewed', tone: 'ok', milestone: 'verify' },
  'cache.hit': { title: 'Reused cached work', tone: 'ok', milestone: 'action' },
  'cache.miss': { title: 'Cache miss', tone: 'neutral', milestone: 'action' },
  'cache.invalidated': { title: 'Cache invalidated', tone: 'warn', milestone: 'context' },
  'memory.read': { title: 'Recalled project memory', tone: 'neutral', milestone: 'context' },
  'memory.written': { title: 'Saved to project memory', tone: 'neutral', milestone: 'context' },
  'memory.write': { title: 'Saved to project memory', tone: 'neutral', milestone: 'context' },
  'memory.evicted': { title: 'Memory evicted', tone: 'neutral', milestone: 'context' },
  'cost.updated': { title: 'Cost updated', tone: 'neutral', milestone: null },
  'budget.warning': { title: 'Approaching the budget limit', tone: 'warn', milestone: 'verify' },
  'budget.exceeded': { title: 'Budget exhausted — stopped safely', tone: 'err', milestone: 'verify' },
  'run.completed': { title: 'Task completed', tone: 'ok', milestone: 'result' },
  'run.failed': { title: 'Run failed', tone: 'err', milestone: 'result' },
  'run.cancelled': { title: 'Run cancelled', tone: 'neutral', milestone: 'result' },
  'change.recorded': { title: 'Change recorded', tone: 'neutral', milestone: null },
  'response.delta': { title: 'Generating', tone: 'info', milestone: 'action' },
  'response.done': { title: 'Response ready', tone: 'ok', milestone: 'verify' },
};

export function humanizeEvent(type: string, label: string): HumanEvent {
  const known = HUMAN[type];
  if (known) return { title: known.title, detail: label, tone: known.tone, milestone: known.milestone };
  // Unknown future event: surface honestly as technical, never as success.
  return { title: technicalLabel(type), detail: label, tone: 'neutral', milestone: null };
}

export function technicalLabel(type: string): string {
  return String(type || 'unknown event');
}

/** Current human-readable activity for a running snapshot. */
export function liveActivity(snap: RuntimeSnapshot | null | undefined): string | null {
  if (!snap) return null;
  const status = String(snap.status || '');
  const busy = status === 'running' || status === 'planning' || status === 'waiting';
  if (!busy) return null;
  const trace = Array.isArray(snap.trace) ? snap.trace : [];
  const last = trace[trace.length - 1];
  if (!last) return status === 'planning' ? 'Thinking through the task…' : 'Starting the run…';
  const h = humanizeEvent(last.type, last.label);
  // Prefer the human title; append the tool name when a tool is active.
  const runningTool = snap.tools.find((t) => t.lastStatus === 'running');
  if (runningTool) {
    if (/tool/i.test(h.title)) return `${h.title}: ${runningTool.name}…`;
    return `Running ${runningTool.name}…`;
  }
  if (last.type === 'response.delta') return 'Generating…';
  if (status === 'planning') return 'Thinking through the task…';
  return `${h.title}…`;
}

const STAGE_ORDER: Milestone['stage'][] = ['plan', 'context', 'model', 'action', 'verify', 'result'];
const STAGE_LABEL: Record<Milestone['stage'], string> = {
  plan: 'PLAN',
  context: 'CONTEXT',
  model: 'MODEL',
  action: 'ACTION',
  verify: 'VERIFY',
  result: 'RESULT',
};

export function stageLabel(stage: Milestone['stage']): string {
  return STAGE_LABEL[stage];
}

/**
 * Transform a raw execution trace into understandable milestones with
 * causality. Groups noisy repeats (e.g. consecutive tool steps) and keeps
 * only the latest event per burst, capped for performance.
 */
export function toMilestones(trace: { seq: number; ts: string; type: string; label: string; status: string }[]): Milestone[] {
  const out: Milestone[] = [];
  let burstKey = '';
  let burstCount = 0;
  for (const t of trace.slice(-120)) {
    const h = humanizeEvent(t.type, t.label);
    if (!h.milestone) continue;
    // Group consecutive same-stage tool/cache chatter into one milestone.
    const key = `${h.milestone}:${h.title}`;
    if (key === burstKey && (h.milestone === 'action' || t.type === 'cost.updated')) {
      burstCount += 1;
      const prev = out[out.length - 1];
      if (prev) {
        prev.detail = burstCount > 1 ? `${stripCount(prev.detail)} · ${t.label} (×${burstCount})` : t.label;
        prev.ts = t.ts;
        prev.seq = t.seq;
        prev.status = t.status === 'error' ? 'failed' : prev.status;
      }
      continue;
    }
    burstKey = key;
    burstCount = 1;
    out.push({
      id: `${t.seq}`,
      stage: h.milestone,
      label: STAGE_LABEL[h.milestone],
      detail: compactDetail(t.type, t.label),
      ts: t.ts,
      status: t.status === 'error' ? 'failed' : 'done',
      seq: t.seq,
      eventType: t.type,
    });
  }
  // Mark the latest milestone active when the run is still in flight is done
  // by the caller (status-aware); here everything observed is done/failed.
  void STAGE_ORDER;
  return out.slice(-40);
}

function stripCount(s: string): string {
  return String(s || '').replace(/\s*\(×\d+\)\s*$/, '');
}

function compactDetail(type: string, label: string): string {
  const s = String(label || '').slice(0, 160);
  if (type === 'model.switched') return s || 'Model changed mid-run';
  if (type === 'context.compressed') return s || 'Reclaimed context tokens';
  if (type === 'tool.failed') return s || 'A tool call failed';
  return s || humanizeEvent(type, '').title;
}

/** Provenance badge model: never mix observed and estimated visually. */
export function provenanceLabel(source: string | undefined | null, kind: 'cost' | 'quality' | 'latency' | 'success'): { text: string; cls: string; title: string } {
  const s = String(source || 'unknown').toLowerCase();
  if (s === 'observed' || s === 'metered' || s === 'metered (usage × provider pricing)') {
    return { text: 'OBSERVED', cls: 'observed', title: kind === 'cost' ? 'Metered from real usage × provider pricing' : 'Measured from real runs' };
  }
  if (s === 'provider') {
    return { text: 'PROVIDER', cls: 'provider', title: 'Reported by the provider' };
  }
  if (s === 'estimated' || s === 'projected') {
    return { text: s === 'projected' ? 'PROJECTED' : 'ESTIMATED', cls: 'estimated', title: 'Model estimate — not a measurement' };
  }
  if (s === 'demo' || s === 'sample') {
    return { text: 'DEMO', cls: 'demo', title: 'Demo sample data — not a real measurement' };
  }
  return { text: 'UNKNOWN', cls: 'unknown', title: 'No data yet — appears after real usage' };
}

/** Explain a confidence/trust score only from legitimate backend grounding. */
export function trustGrounding(evidence: {
  evaluationScore?: number | null;
  testsPassed?: boolean | null;
  criteriaSatisfied?: boolean | null;
  noUnrelatedChanges?: boolean | null;
  historicalReliability?: boolean | null;
}): { label: string; items: string[] } | null {
  const items: string[] = [];
  if (evidence.evaluationScore !== undefined && evidence.evaluationScore !== null) items.push('automated evaluation');
  if (evidence.testsPassed) items.push('passing tests');
  if (evidence.criteriaSatisfied) items.push('evidence coverage');
  if (evidence.historicalReliability) items.push('historical model reliability');
  if (!items.length) return null;
  return { label: 'Based on', items };
}
