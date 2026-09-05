'use strict';

// Session 3 — Recovery (actionable checkpoints, crash recovery with UNKNOWN
// semantics), structured retry with bounded exponential backoff, verification
// execution, the agent result contract, tool telemetry/health, and the
// disciplined agent loop guard.
//
// Crash rule: never assume a side effect failed because the process crashed.
// tool request sent + crash => state UNKNOWN unless idempotency evidence
// proves otherwise. Recovery decides resume | retry | skip | rollback |
// ask-user | mark-unknown from (checkpoint + tool state + idempotency +
// workspace hash) — never blindly re-runs the last action.

const crypto = require('crypto');
const { ToolStatus } = require('./tool-system');

const RecoveryDecision = Object.freeze({
  RESUME: 'resume',
  RETRY: 'retry',
  SKIP: 'skip',
  ROLLBACK: 'rollback',
  ASK_USER: 'ask_user',
  MARK_UNKNOWN: 'mark_unknown',
});

const SideEffectState = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_FLIGHT: 'in_flight',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

// Actionable checkpoint: references (not huge prompt dumps).
function buildCheckpoint({ runId, episodeId, step, planVersion, model, toolHistoryTail = [], changesetIds = [], contextFingerprint = '', successCriteria = [], pendingApprovalIds = [], workspaceHash = '', extra = {} }) {
  return {
    checkpointId: `ckpt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    runId,
    episodeId: episodeId || null,
    step: Number(step) || 0,
    takenAt: new Date().toISOString(),
    planVersion: planVersion ?? null,
    model: model || null,
    toolHistoryTail: toolHistoryTail.slice(-10),
    changesetIds: [...changesetIds],
    contextFingerprint: String(contextFingerprint).slice(0, 64),
    successCriteria: successCriteria.slice(0, 20),
    pendingApprovalIds: pendingApprovalIds.slice(0, 20),
    workspaceHash: String(workspaceHash).slice(0, 64),
    ...extra,
  };
}

function fingerprintContext(items = []) {
  const h = crypto.createHash('sha256');
  for (const i of items.slice(-20)) h.update(JSON.stringify([i.kind, i.title, i.tokens, i.status]));
  return h.digest('hex').slice(0, 16);
}

// Recovery decision from durable signals. Priority: idempotency proof >
// workspace evidence > checkpoint position > safe default (ask/unknown).
function decideRecovery({ lastCheckpoint, toolRecord, idempotencyKnownCompleted, workspaceHash, workspaceHashAtCheckpoint }) {
  // Proven completed (idempotent store has the result): skip re-execution.
  if (idempotencyKnownCompleted) return { decision: RecoveryDecision.SKIP, reason: 'idempotency proof: side effect already completed' };
  if (!toolRecord || toolRecord.state === SideEffectState.NOT_STARTED) {
    return { decision: RecoveryDecision.RESUME, reason: 'no in-flight side effect; resume from checkpoint' };
  }
  if (toolRecord.state === SideEffectState.COMPLETED) {
    return { decision: RecoveryDecision.RESUME, reason: 'last action completed before crash' };
  }
  if (toolRecord.state === SideEffectState.FAILED) {
    if (toolRecord.retryable) return { decision: RecoveryDecision.RETRY, reason: 'last action failed retryably' };
    return { decision: RecoveryDecision.ASK_USER, reason: 'last action failed non-retryably' };
  }
  if (toolRecord.state === SideEffectState.IN_FLIGHT || toolRecord.state === SideEffectState.UNKNOWN) {
    // Destructive or unknown-effect actions must never blindly re-run.
    if (toolRecord.destructive) return { decision: RecoveryDecision.MARK_UNKNOWN, reason: 'in-flight destructive action: state UNKNOWN, needs user' };
    if (workspaceHash && workspaceHashAtCheckpoint && workspaceHash !== workspaceHashAtCheckpoint) {
      return { decision: RecoveryDecision.MARK_UNKNOWN, reason: 'workspace changed during outage; side effect UNKNOWN' };
    }
    if (toolRecord.idempotent) return { decision: RecoveryDecision.RETRY, reason: 'in-flight but idempotent: safe to retry' };
    return { decision: RecoveryDecision.MARK_UNKNOWN, reason: 'in-flight non-idempotent action: state UNKNOWN' };
  }
  return { decision: RecoveryDecision.ASK_USER, reason: 'ambiguous recovery state', lastCheckpoint: lastCheckpoint?.checkpointId || null };
}

// --- Structured retry: do NOT retry everything ---

const BACKOFF_SEQUENCE = [250, 500, 1000, 2000];

function backoffForAttempt(attempt) {
  const i = Math.max(0, Math.min(attempt, BACKOFF_SEQUENCE.length - 1));
  return BACKOFF_SEQUENCE[i];
}

function retryDecision({ code, attempt = 0, maxAttempts = 3, idempotent = false, destructive = false }) {
  const c = String(code || '');
  // Never retry unchanged: validation / permission / scope errors.
  if (['bad_params', 'denied', 'scope_violation', 'path_escape', 'not_found', 'patch_conflict'].includes(c)) {
    return { retry: false, reason: `${c}: retrying unchanged would fail identically` };
  }
  // Destructive + unknown: NEVER blindly retry.
  if (destructive && (c === 'unknown' || c === 'timeout' || c === 'cancelled')) {
    return { retry: false, reason: 'destructive action with unknown outcome must not auto-retry' };
  }
  if (['timeout', 'rate_limited', 'rate-limit', 'transient', 'fetch_failure', 'provider_overloaded'].includes(c)) {
    if (attempt >= maxAttempts) return { retry: false, reason: 'retry budget exhausted' };
    return { retry: true, backoffMs: backoffForAttempt(attempt), reason: `${c}: transient, backoff ${backoffForAttempt(attempt)}ms` };
  }
  if (c === 'test_failure' || c === 'command_failure' || c === 'git_failure') {
    // Evidence-gathering failures: one retry only if idempotent read path.
    if (idempotent && attempt < 1) return { retry: true, backoffMs: backoffForAttempt(attempt), reason: 'single retry of idempotent read' };
    return { retry: false, reason: `${c}: needs strategy change, not blind retry` };
  }
  return { retry: false, reason: `no retry rule for ${c || 'unknown'}` };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Verification (execution of checks; Session 2 owns evaluation intelligence) ---

const VerificationKind = Object.freeze({
  TESTS: 'tests',
  LINT: 'lint',
  BUILD: 'build',
  DIFF_INSPECTION: 'diff_inspection',
  EVIDENCE: 'evidence',
});

function verificationRecord({ kind, passed, summary, artifacts = [], durationMs = 0 }) {
  return {
    kind,
    passed: !!passed,
    summary: String(summary || '').slice(0, 1000),
    artifacts: artifacts.slice(0, 8),
    durationMs,
    at: new Date().toISOString(),
  };
}

// Completion honesty: MODEL_STOPPED (model finished text) is NOT
// TASK_COMPLETED (verified outcome). Missing required verification =>
// verificationIncomplete, never success=true.
function agentResult({ status, goal, summary, plan, completedSteps, changeset, artifacts, verification, approvals, toolExecutions, episodes, unresolvedIssues, confidence, requiredVerification = [] }) {
  const doneKinds = new Set((verification || []).filter((v) => v.passed).map((v) => v.kind));
  const missing = requiredVerification.filter((k) => !doneKinds.has(k));
  return {
    status, // TASK_COMPLETED | VERIFICATION_INCOMPLETE | FAILED | CANCELLED | UNKNOWN
    goal: String(goal || '').slice(0, 1000),
    summary: String(summary || '').slice(0, 2000),
    plan: plan || null,
    completedSteps: completedSteps || [],
    changeset: changeset || null,
    artifacts: (artifacts || []).slice(0, 20),
    verification: verification || [],
    verificationIncomplete: missing.length > 0,
    missingVerification: missing,
    approvals: approvals || [],
    toolExecutions: (toolExecutions || []).slice(-50),
    executionEpisodes: episodes || [],
    unresolvedIssues: unresolvedIssues || [],
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    at: new Date().toISOString(),
  };
}

// --- Tool telemetry + health (uses Session 1 telemetry bus; no duplicate infra) ---

class ToolHealthTracker {
  constructor() {
    this.stats = new Map(); // toolName -> { calls, success, failures, timeouts, ... }
  }

  record({ tool, durationMs, status, risk, approvalId, outputBytes, artifactCount }) {
    const s = this.stats.get(tool) || { calls: 0, success: 0, failures: 0, timeouts: 0, totalDurationMs: 0, approvals: 0, totalOutputBytes: 0, totalArtifacts: 0 };
    s.calls++;
    if (status === ToolStatus.SUCCESS) s.success++;
    else if (status === ToolStatus.TIMED_OUT) s.timeouts++;
    else s.failures++;
    s.totalDurationMs += Number(durationMs) || 0;
    if (approvalId) s.approvals++;
    s.totalOutputBytes += Number(outputBytes) || 0;
    s.totalArtifacts += Number(artifactCount) || 0;
    this.stats.set(tool, s);
    return {
      executionTool: tool, durationMs, status, risk: risk || null,
      approval: approvalId || null, outputBytes: outputBytes || 0, artifactCount: artifactCount || 0,
    };
  }

  health(tool) {
    const s = this.stats.get(tool);
    if (!s || !s.calls) return { tool, calls: 0, successRate: 1, avgDurationMs: 0, timeoutRate: 0, approvalRate: 0 };
    return {
      tool,
      calls: s.calls,
      successRate: Math.round((s.success / s.calls) * 1000) / 1000,
      avgDurationMs: Math.round(s.totalDurationMs / s.calls),
      timeoutRate: Math.round((s.timeouts / s.calls) * 1000) / 1000,
      approvalRate: Math.round((s.approvals / s.calls) * 1000) / 1000,
      avgOutputBytes: Math.round(s.totalOutputBytes / s.calls),
      totalArtifacts: s.totalArtifacts,
    };
  }

  all() { return [...this.stats.keys()].map((t) => this.health(t)); }
}

// --- Disciplined agent loop guard (budgets consumed every iteration) ---

class LoopGuard {
  constructor({ maxSteps = 12, maxToolCalls = 20, maxTimeMs = 300000, maxRetries = 3 } = {}) {
    this.maxSteps = maxSteps;
    this.maxToolCalls = maxToolCalls;
    this.maxTimeMs = maxTimeMs;
    this.maxRetries = maxRetries;
    this.steps = 0;
    this.toolCalls = 0;
    this.retries = 0;
    this.startedAt = Date.now();
  }

  // Returns { ok } or { ok:false, reason } — the loop MUST stop when !ok.
  nextStep() {
    this.steps++;
    if (this.steps > this.maxSteps) return { ok: false, reason: `step budget exhausted (${this.maxSteps})` };
    if (Date.now() - this.startedAt > this.maxTimeMs) return { ok: false, reason: 'time budget exhausted' };
    return { ok: true, step: this.steps };
  }

  nextToolCall() {
    this.toolCalls++;
    if (this.toolCalls > this.maxToolCalls) return { ok: false, reason: `tool call budget exhausted (${this.maxToolCalls})` };
    return { ok: true, count: this.toolCalls };
  }

  nextRetry() {
    this.retries++;
    if (this.retries > this.maxRetries) return { ok: false, reason: 'retry budget exhausted' };
    return { ok: true, count: this.retries };
  }
}

module.exports = {
  RecoveryDecision,
  SideEffectState,
  buildCheckpoint,
  fingerprintContext,
  decideRecovery,
  BACKOFF_SEQUENCE,
  backoffForAttempt,
  retryDecision,
  sleep,
  VerificationKind,
  verificationRecord,
  agentResult,
  ToolHealthTracker,
  LoopGuard,
};
