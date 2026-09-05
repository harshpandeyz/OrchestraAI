'use strict';

// Session 3 — Executable plans, observations, episodes (same-run
// continuation), cooperative pause/resume, and human override commands.
//
// Same-run continuation: a COMPLETED run that receives another user message
// starts a NEW execution episode on the SAME run/thread — never an unrelated
// run. History is available structurally (not dumped wholesale into context;
// Session 2 owns context selection).

const crypto = require('crypto');

const PlanStepStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

const EpisodeStatus = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED',
});

const PauseState = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSING: 'PAUSING',
  PAUSED: 'PAUSED',
  RESUMING: 'RESUMING',
});

let planSeq = 0;
let episodeSeq = 0;

function newPlanStep(description, { dependencies = [], expectedArtifacts = [], verification = null } = {}) {
  return {
    id: `step-${Date.now().toString(36)}-${(planSeq++).toString(36)}`,
    description: String(description || '').slice(0, 500),
    status: PlanStepStatus.PENDING,
    dependencies: [...dependencies],
    expectedArtifacts: [...expectedArtifacts],
    verification: verification || null,
    startedAt: null,
    completedAt: null,
    attempts: 0,
  };
}

class PlanManager {
  constructor() {
    this.plans = new Map(); // runId -> { steps, updatedAt, version }
  }

  create(runId, descriptions = []) {
    const steps = descriptions.map((d) => (typeof d === 'string' ? newPlanStep(d) : newPlanStep(d.description, d)));
    const plan = { runId, steps, version: 1, updatedAt: new Date().toISOString() };
    this.plans.set(runId, plan);
    return this.view(runId);
  }

  view(runId) {
    const p = this.plans.get(runId);
    return p ? { runId: p.runId, version: p.version, updatedAt: p.updatedAt, steps: p.steps.map((s) => ({ ...s })) } : null;
  }

  // Revise the plan when new evidence appears (adaptation, not blind replay).
  // Keeps completed steps; appends/replaces pending ones; bumps version.
  adapt(runId, { updateStep = {}, addSteps = [], skipStepIds = [] } = {}) {
    const p = this.plans.get(runId);
    if (!p) return null;
    for (const s of p.steps) {
      if (updateStep[s.id]) Object.assign(s, updateStep[s.id]);
      if (skipStepIds.includes(s.id) && s.status === PlanStepStatus.PENDING) s.status = PlanStepStatus.SKIPPED;
    }
    for (const d of addSteps) p.steps.push(typeof d === 'string' ? newPlanStep(d) : newPlanStep(d.description, d));
    p.version++;
    p.updatedAt = new Date().toISOString();
    return this.view(runId);
  }

  setStatus(runId, stepId, status, extra = {}) {
    const p = this.plans.get(runId);
    if (!p) return null;
    const s = p.steps.find((x) => x.id === stepId);
    if (!s) return null;
    s.status = status;
    if (status === PlanStepStatus.RUNNING && !s.startedAt) { s.startedAt = new Date().toISOString(); s.attempts++; }
    if ([PlanStepStatus.COMPLETED, PlanStepStatus.FAILED, PlanStepStatus.SKIPPED].includes(status)) s.completedAt = new Date().toISOString();
    Object.assign(s, extra);
    p.updatedAt = new Date().toISOString();
    return { ...s };
  }

  // Dependency-aware readiness: a step is ready when PENDING and all deps completed.
  readySteps(runId) {
    const p = this.plans.get(runId);
    if (!p) return [];
    const byId = new Map(p.steps.map((s) => [s.id, s]));
    return p.steps.filter((s) => {
      if (s.status !== PlanStepStatus.PENDING) return false;
      return (s.dependencies || []).every((d) => byId.get(d) && byId.get(d).status === PlanStepStatus.COMPLETED);
    }).map((s) => ({ ...s }));
  }

  isComplete(runId) {
    const p = this.plans.get(runId);
    if (!p || !p.steps.length) return false;
    return p.steps.every((s) => [PlanStepStatus.COMPLETED, PlanStepStatus.SKIPPED].includes(s.status));
  }

  clearRun(runId) { this.plans.delete(runId); }
}

// Structured observation per tool action (for Session 2, without raw logs).
function actionObservation({ tool, intent, inputsSummary, resultSummary, artifacts = [], sideEffects = [], success }) {
  return {
    tool,
    intent: String(intent || '').slice(0, 500),
    inputsSummary: String(inputsSummary || '').slice(0, 1000),
    resultSummary: String(resultSummary || '').slice(0, 1000),
    artifacts: artifacts.slice(0, 8),
    sideEffects: sideEffects.slice(0, 20),
    success: !!success,
    at: new Date().toISOString(),
  };
}

class EpisodeManager {
  constructor() {
    this.episodes = new Map(); // runId -> [episodes]
  }

  start(runId, { parentEpisodeId = null, goal = '' } = {}) {
    const list = this.episodes.get(runId) || [];
    const ep = {
      episodeId: `ep-${Date.now().toString(36)}-${(episodeSeq++).toString(36)}${crypto.randomBytes(2).toString('hex')}`,
      runId,
      parentEpisodeId,
      goal: String(goal || '').slice(0, 1000),
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: EpisodeStatus.RUNNING,
      steps: 0,
      toolCalls: 0,
    };
    list.push(ep);
    this.episodes.set(runId, list);
    return { ...ep };
  }

  recordStep(runId, episodeId, { toolCalls = 0 } = {}) {
    const ep = (this.episodes.get(runId) || []).find((e) => e.episodeId === episodeId);
    if (!ep) return null;
    ep.steps++;
    ep.toolCalls += toolCalls;
    return { ...ep };
  }

  finish(runId, episodeId, status = EpisodeStatus.COMPLETED) {
    const ep = (this.episodes.get(runId) || []).find((e) => e.episodeId === episodeId);
    if (!ep) return null;
    ep.status = status;
    ep.completedAt = new Date().toISOString();
    return { ...ep };
  }

  current(runId) {
    const list = this.episodes.get(runId) || [];
    return list.length ? { ...list[list.length - 1] } : null;
  }

  list(runId) {
    return (this.episodes.get(runId) || []).map((e) => ({ ...e }));
  }

  clearRun(runId) { this.episodes.delete(runId); }
}

// Cooperative pause controller. Pause never kills a provider/network request:
// PAUSING waits for the in-flight non-interruptible operation, then settles
// to PAUSED before the next action. RESUMING re-enters RUNNING.
class PauseController {
  constructor() {
    this.states = new Map(); // runId -> PauseState
    this.requested = new Set();
  }

  state(runId) { return this.states.get(runId) || PauseState.RUNNING; }

  requestPause(runId) {
    const cur = this.state(runId);
    if (cur !== PauseState.RUNNING) return cur;
    this.states.set(runId, PauseState.PAUSING);
    this.requested.add(runId);
    return PauseState.PAUSING;
  }

  // Called at safe boundaries (between steps / before next tool call).
  settlePause(runId) {
    if (this.states.get(runId) === PauseState.PAUSING) {
      this.states.set(runId, PauseState.PAUSED);
      return PauseState.PAUSED;
    }
    return this.state(runId);
  }

  requestResume(runId) {
    const cur = this.state(runId);
    if (cur !== PauseState.PAUSED && cur !== PauseState.PAUSING) return cur;
    this.states.set(runId, PauseState.RESUMING);
    this.requested.delete(runId);
    return PauseState.RESUMING;
  }

  settleResume(runId) {
    if (this.states.get(runId) === PauseState.RESUMING) {
      this.states.set(runId, PauseState.RUNNING);
      return PauseState.RUNNING;
    }
    return this.state(runId);
  }

  isPaused(runId) { return this.state(runId) === PauseState.PAUSED; }
  isPausing(runId) { return this.state(runId) === PauseState.PAUSING; }
  shouldHold(runId) {
    const s = this.state(runId);
    return s === PauseState.PAUSING || s === PauseState.PAUSED;
  }

  clearRun(runId) { this.states.delete(runId); this.requested.delete(runId); }
}

// Human override: explicit runtime commands/events, not ordinary model text.
// "Stop" / "Pause" / "Don't touch X" / "Use this branch" / "Only these files"
// become structured constraints the execution layer enforces.
const RuntimeCommand = Object.freeze({
  STOP: 'stop',
  PAUSE: 'pause',
  RESUME: 'resume',
  CONSTRAIN_PATHS: 'constrain_paths',
  FORBID_PATHS: 'forbid_paths',
  USE_BRANCH: 'use_branch',
  SET_APPROVAL_MODE: 'set_approval_mode',
  ADD_NOTE: 'note',
});

function parseRuntimeCommand(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (/^(stop|cancel|abort)\.?$/.test(low)) return { type: RuntimeCommand.STOP };
  if (/^pause\.?$/.test(low)) return { type: RuntimeCommand.PAUSE };
  if (/^resume(\s+execution)?\.?$/.test(low)) return { type: RuntimeCommand.RESUME };
  let m = t.match(/^(?:only (?:change|touch|modify|edit)\s+)(.+)$/i);
  if (m) return { type: RuntimeCommand.CONSTRAIN_PATHS, paths: m[1].split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20) };
  m = t.match(/^(?:don't|do not|never)\s+(?:touch|modify|change|edit)\s+(.+)$/i);
  if (m) return { type: RuntimeCommand.FORBID_PATHS, paths: m[1].split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20) };
  m = t.match(/^use (?:branch\s+)?([A-Za-z0-9._/-]{1,128})$/i);
  if (m) return { type: RuntimeCommand.USE_BRANCH, branch: m[1] };
  return { type: RuntimeCommand.ADD_NOTE, note: t.slice(0, 2000) };
}

class ConstraintStore {
  constructor() {
    this.constraints = new Map(); // runId -> { forbidPaths, onlyPaths, branch, notes[] }
  }

  get(runId) {
    return this.constraints.get(runId) || { forbidPaths: [], onlyPaths: [], branch: null, notes: [] };
  }

  applyCommand(runId, cmd) {
    const cur = this.get(runId);
    switch (cmd.type) {
      case RuntimeCommand.CONSTRAIN_PATHS:
        cur.onlyPaths = [...new Set([...cur.onlyPaths, ...(cmd.paths || [])])].slice(0, 20);
        break;
      case RuntimeCommand.FORBID_PATHS:
        cur.forbidPaths = [...new Set([...cur.forbidPaths, ...(cmd.paths || [])])].slice(0, 20);
        break;
      case RuntimeCommand.USE_BRANCH:
        cur.branch = cmd.branch;
        break;
      case RuntimeCommand.ADD_NOTE:
        cur.notes = [...cur.notes, cmd.note].slice(-20);
        break;
      default:
        break;
    }
    this.constraints.set(runId, cur);
    return { ...cur, notes: [...cur.notes] };
  }

  // Enforced at tool time: a write outside onlyPaths / inside forbidPaths is denied.
  checkWrite(runId, relPath) {
    const c = this.get(runId);
    const p = String(relPath || '');
    if (c.forbidPaths.some((f) => p === f || p.startsWith(`${f}/`) || p.endsWith(f))) {
      return { allowed: false, reason: `path forbidden by user constraint: ${p}` };
    }
    if (c.onlyPaths.length && !c.onlyPaths.some((f) => p === f || p.startsWith(`${f}/`) || p.endsWith(f) || f.endsWith(p))) {
      return { allowed: false, reason: `path outside user-constrained scope: ${p}` };
    }
    return { allowed: true };
  }

  clearRun(runId) { this.constraints.delete(runId); }
}

module.exports = {
  PlanStepStatus,
  EpisodeStatus,
  PauseState,
  RuntimeCommand,
  PlanManager,
  newPlanStep,
  actionObservation,
  EpisodeManager,
  PauseController,
  parseRuntimeCommand,
  ConstraintStore,
};
