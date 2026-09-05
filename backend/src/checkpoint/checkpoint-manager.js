'use strict';

const crypto = require('crypto');
const { CheckpointType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

// Versioned checkpoint schema. Version bumps must remain backward
// compatible: validateCheckpoint() accepts older versions it knows how to
// interpret and rejects anything newer or malformed.
const CHECKPOINT_VERSION = 1;
// A checkpoint older than this is treated as stale (underlying model
// metadata, pricing, and provider state may have moved on). Stale does not
// mean unusable for audit — it means automatic resume must not trust it.
const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Integrity covers the snapshot bytes, so a corrupted or hand-edited
// checkpoint fails validation instead of restoring garbage state.
function checkpointIntegrity(runId, type, stepNumber, stateSnapshot) {
  return sha256Hex(JSON.stringify([runId, type, stepNumber, stateSnapshot]));
}

class ExecutionCheckpoint {
  constructor(runId, type, stateSnapshot, options = {}) {
    this.checkpointId = options.checkpointId || generateId('checkpoint');
    this.version = CHECKPOINT_VERSION;
    this.runId = runId;
    this.type = type;
    this.timestamp = options.timestamp || now();
    this.stateSnapshot = stateSnapshot;
    // Control-plane snapshot (provider conversation history, token
    // accounting, tool counters). Restored alongside runtime state so a
    // resumed run continues the same conversation instead of replaying it.
    this.controlSnapshot = options.controlSnapshot && typeof options.controlSnapshot === 'object'
      ? options.controlSnapshot
      : null;
    this.stepNumber = Number.isFinite(options.stepNumber) ? options.stepNumber : 0;
    this.idempotencyKey = options.idempotencyKey || `${runId}:${type}:${this.stepNumber}:${Date.now()}`;
    this.metadata = options.metadata || {};
    this.completed = false;
    this.completedAt = null;
    this.integrity = checkpointIntegrity(runId, type, this.stepNumber, stateSnapshot);
  }

  markCompleted(result = null) {
    this.completed = true;
    this.completedAt = now();
    this.result = result;
  }

  isCompleted() {
    return this.completed;
  }

  toJSON() {
    return {
      checkpointId: this.checkpointId,
      version: this.version,
      runId: this.runId,
      type: this.type,
      timestamp: this.timestamp,
      stateSnapshot: this.stateSnapshot,
      controlSnapshot: this.controlSnapshot,
      stepNumber: this.stepNumber,
      idempotencyKey: this.idempotencyKey,
      metadata: this.metadata,
      completed: this.completed,
      completedAt: this.completedAt,
      result: this.result,
      integrity: this.integrity,
    };
  }

  static fromJSON(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const cp = new ExecutionCheckpoint(doc.runId, doc.type, doc.stateSnapshot, {
      checkpointId: doc.checkpointId,
      timestamp: doc.timestamp,
      controlSnapshot: doc.controlSnapshot,
      stepNumber: doc.stepNumber,
      idempotencyKey: doc.idempotencyKey,
      metadata: doc.metadata,
    });
    cp.version = doc.version;
    cp.completed = !!doc.completed;
    cp.completedAt = doc.completedAt || null;
    cp.result = doc.result;
    cp.integrity = doc.integrity;
    return cp;
  }
}

// Validate a checkpoint before trusting it for recovery. Returns
// { ok:true, checkpoint } or { ok:false, code, error } where code is one of:
// missing | bad_shape | run_mismatch | bad_version | incomplete |
// stale | corrupt (integrity mismatch).
function validateCheckpoint(checkpoint, runId, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : CHECKPOINT_MAX_AGE_MS;
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, code: 'missing', error: 'Checkpoint not found' };
  }
  if (typeof checkpoint.runId !== 'string' || typeof checkpoint.type !== 'string' ||
      !Number.isFinite(checkpoint.stepNumber) || !checkpoint.stateSnapshot ||
      typeof checkpoint.stateSnapshot !== 'object') {
    return { ok: false, code: 'bad_shape', error: 'Checkpoint has an unrecognized shape' };
  }
  if (runId && checkpoint.runId !== runId) {
    return { ok: false, code: 'run_mismatch', error: 'Checkpoint belongs to a different run' };
  }
  if (!Number.isFinite(checkpoint.version) || checkpoint.version < 1 || checkpoint.version > CHECKPOINT_VERSION) {
    return { ok: false, code: 'bad_version', error: `Unsupported checkpoint version: ${checkpoint.version}` };
  }
  if (!checkpoint.completed) {
    return { ok: false, code: 'incomplete', error: 'Checkpoint was never marked completed' };
  }
  const ts = Date.parse(checkpoint.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, code: 'bad_shape', error: 'Checkpoint timestamp is invalid' };
  }
  if (Date.now() - ts > maxAgeMs) {
    return { ok: false, code: 'stale', error: 'Checkpoint is older than the automatic-resume horizon' };
  }
  if (checkpoint.integrity) {
    const expected = checkpointIntegrity(checkpoint.runId, checkpoint.type, checkpoint.stepNumber, checkpoint.stateSnapshot);
    if (expected !== checkpoint.integrity) {
      return { ok: false, code: 'corrupt', error: 'Checkpoint integrity check failed' };
    }
  }
  return { ok: true, checkpoint };
}

class CheckpointManager {
  constructor(options = {}) {
    this.checkpoints = new Map();
    this.idempotencyKeys = new Set();
    this.maxCheckpoints = options.maxCheckpoints || 50;
  }

  createCheckpoint(runId, type, stateSnapshot, options = {}) {
    const checkpoint = new ExecutionCheckpoint(runId, type, stateSnapshot, options);
    
    if (this.idempotencyKeys.has(checkpoint.idempotencyKey)) {
      return { checkpoint, duplicate: true };
    }
    
    this.idempotencyKeys.add(checkpoint.idempotencyKey);
    
    if (!this.checkpoints.has(runId)) {
      this.checkpoints.set(runId, []);
    }
    
    const runCheckpoints = this.checkpoints.get(runId);
    runCheckpoints.push(checkpoint);
    
    if (runCheckpoints.length > this.maxCheckpoints) {
      const removed = runCheckpoints.shift();
      this.idempotencyKeys.delete(removed.idempotencyKey);
    }
    
    return { checkpoint, duplicate: false };
  }

  getCheckpoint(runId, checkpointId) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    return runCheckpoints.find(c => c.checkpointId === checkpointId) || null;
  }

  getLastCheckpoint(runId, type = null) {
    const runCheckpoints = this.checkpoints.get(runId) || [];

    if (type) {
      const filtered = runCheckpoints.filter(c => c.type === type);
      return filtered[filtered.length - 1] || null;
    }

    return runCheckpoints[runCheckpoints.length - 1] || null;
  }

  // Newest COMPLETED checkpoint of any (or a given) type — the only kind
  // automatic recovery is allowed to resume from.
  getLastCompletedCheckpoint(runId, type = null) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    for (let i = runCheckpoints.length - 1; i >= 0; i--) {
      const cp = runCheckpoints[i];
      if (!cp || !cp.completed) continue;
      if (type && cp.type !== type) continue;
      return cp;
    }
    return null;
  }

  // Validate-then-return: the single entry point for recovery paths.
  validatedResumeCheckpoint(runId, checkpointId = null, options = {}) {
    const cp = checkpointId
      ? this.getCheckpoint(runId, checkpointId)
      : this.getLastCompletedCheckpoint(runId, options.type || null);
    return validateCheckpoint(cp, runId, options);
  }

  getCheckpointsByType(runId, type) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    return runCheckpoints.filter(c => c.type === type);
  }

  markCheckpointCompleted(runId, checkpointId, result = null) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    if (checkpoint) {
      checkpoint.markCompleted(result);
      return true;
    }
    return false;
  }

  isIdempotent(runId, idempotencyKey) {
    return this.idempotencyKeys.has(idempotencyKey);
  }

  canResumeFrom(runId, checkpointId) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    return checkpoint && checkpoint.completed;
  }

  getResumeState(runId, checkpointId) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    if (!checkpoint || !checkpoint.completed) {
      return null;
    }
    return checkpoint.stateSnapshot;
  }

  clearRun(runId) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    for (const cp of runCheckpoints) {
      this.idempotencyKeys.delete(cp.idempotencyKey);
    }
    this.checkpoints.delete(runId);
  }

  getAllCheckpoints(runId) {
    return this.checkpoints.get(runId) || [];
  }
}

class RecoveryManager {
  constructor(checkpointManager, options = {}) {
    this.checkpointManager = checkpointManager;
    this.config = {
      maxRecoveryAttempts: options.maxRecoveryAttempts || 3,
      maxCheckpointAgeMs: options.maxCheckpointAgeMs || CHECKPOINT_MAX_AGE_MS,
      ...options
    };
  }

  // Decide HOW to recover from a validated checkpoint + the last known
  // side-effect state. This is the shared semantic used by manual retry and
  // restart reconciliation. Returns { action, reason, cursor } where action
  // is one of: resume | retry_step | skip_completed | ask_user |
  // mark_unknown | unrecoverable.
  planRecovery({ runId, checkpoint, validation, toolRecord = null, idempotencyStore = null, workspaceHash = null, workspaceHashAtCheckpoint = null }) {
    const record = toolRecord && typeof toolRecord.state === 'string' ? toolRecord : { state: 'not_started' };

    // Idempotency proof wins wherever it is available: the side effect
    // provably completed, so recovery must NOT re-execute it.
    let idempotencyKnownCompleted = false;
    try {
      if (idempotencyStore && typeof idempotencyStore.get === 'function' && record && record.idempotencyKey) {
        const rec = idempotencyStore.get(record.idempotencyKey);
        idempotencyKnownCompleted = !!(rec && rec.state === 'completed');
      }
    } catch { /* idempotency lookup is advisory here; unknown => cautious path */ }

    let decideRecoveryFn = null;
    try {
      // Single decision module shared by every recovery path (never inline
      // a second copy of these rules).
      decideRecoveryFn = require('../execution/recovery').decideRecovery;
    } catch { /* fall through to ask_user */ }

    const toPlan = (decision, cursor) => {
      switch (decision && decision.decision) {
        case 'skip':
          return { action: 'skip_completed', reason: decision.reason, cursor };
        case 'resume':
          return { action: 'resume', reason: decision.reason, cursor };
        case 'retry':
          return { action: 'retry_step', reason: decision.reason, cursor };
        case 'rollback':
          return { action: 'ask_user', reason: `rollback suggested (${decision.reason}); requires operator approval`, cursor };
        case 'mark_unknown':
          return { action: 'mark_unknown', reason: decision.reason, cursor };
        case 'ask_user':
        default:
          return { action: 'ask_user', reason: (decision && decision.reason) || 'ambiguous recovery state', cursor };
      }
    };

    if (!validation || !validation.ok) {
      const code = (validation && validation.code) || 'missing';
      if (code === 'stale') {
        return { action: 'ask_user', reason: 'checkpoint is stale; automatic resume refused', cursor: null };
      }
      if (code === 'missing' || code === 'incomplete') {
        // No usable checkpoint: reason from the same rules against live
        // state (cursor null = continue from the preserved live cursor).
        // Only safe when nothing irreversible is unaccounted for.
        if (!decideRecoveryFn) return { action: 'ask_user', reason: 'recovery module unavailable', cursor: null };
        if (record.state === 'not_started') {
          return { action: 'retry_step', reason: 'no completed checkpoint; nothing in flight — restarting failed run from preserved state', cursor: 0 };
        }
        return toPlan(decideRecoveryFn({
          lastCheckpoint: null,
          toolRecord: record,
          idempotencyKnownCompleted,
          workspaceHash,
          workspaceHashAtCheckpoint,
        }), null);
      }
      return { action: 'unrecoverable', reason: (validation && validation.error) || 'no usable checkpoint', cursor: null };
    }
    const cp = checkpoint || validation.checkpoint;
    const cursor = Number.isFinite(cp.stepNumber) ? cp.stepNumber : 0;

    if (!decideRecoveryFn) return { action: 'ask_user', reason: 'recovery module unavailable', cursor };
    return toPlan(decideRecoveryFn({
      lastCheckpoint: { checkpointId: cp.checkpointId, stepNumber: cursor },
      toolRecord: record,
      idempotencyKnownCompleted,
      workspaceHash,
      workspaceHashAtCheckpoint,
    }), cursor);
  }

  async recoverFromCheckpoint(runId, checkpointId, runtimeState, options = {}) {
    const raw = this.checkpointManager.getCheckpoint(runId, checkpointId);

    if (!raw) {
      return { success: false, code: 'missing', error: 'Checkpoint not found' };
    }

    // Never restore garbage: schema/version/identity/freshness/integrity.
    const validation = validateCheckpoint(raw, runId, { maxAgeMs: this.config.maxCheckpointAgeMs });
    if (!validation.ok) {
      return { success: false, code: validation.code, error: validation.error };
    }
    const checkpoint = validation.checkpoint;
    const snapshot = checkpoint.stateSnapshot;

    // Restore the durable snapshot field-by-field onto the live state
    // objects (never replace them: live objects carry methods and shared
    // references the rest of the runtime holds).
    try {
      applySnapshotToRuntime(runtimeState, snapshot);
    } catch (e) {
      return { success: false, code: 'bad_shape', error: `Checkpoint snapshot incompatible: ${String((e && e.message) || e).slice(0, 160)}` };
    }

    const restoredControl = checkpoint.controlSnapshot && typeof checkpoint.controlSnapshot === 'object'
      ? checkpoint.controlSnapshot
      : null;
    runtimeState.updatedAt = now();

    return { success: true, checkpoint, restoredState: snapshot, restoredControl, validation };
  }

  async recoverFromLastCheckpoint(runId, runtimeState, type = null) {
    const checkpoint = this.checkpointManager.getLastCompletedCheckpoint(runId, type);

    if (!checkpoint) {
      return { success: false, code: 'missing', error: 'No completed checkpoint available' };
    }

    return this.recoverFromCheckpoint(runId, checkpoint.checkpointId, runtimeState);
  }

  createIdempotencyKey(runId, operation, stepNumber) {
    return `${runId}:${operation}:${stepNumber}`;
  }

  checkIdempotency(runId, operation, stepNumber) {
    const key = this.createIdempotencyKey(runId, operation, stepNumber);
    return this.checkpointManager.isIdempotent(runId, key);
  }
}

// Restore a RuntimeState.toSnapshot() document onto live state objects.
// Throws on incompatible snapshots (caller converts to bad_shape).
// Accounting is restored exactly — a resumed run keeps its spend, token
// totals, and step cursor so retries/failovers cannot double-count or
// under-count economics and step numbers never reset.
function applySnapshotToRuntime(runtimeState, snapshot) {
  if (!runtimeState || !snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot missing');
  }
  if (!snapshot.task || !snapshot.execution || !snapshot.budget) {
    throw new Error('snapshot missing task/execution/budget sections');
  }
  const s = snapshot;

  if (s.status) runtimeState.status = s.status;
  if (s.task) {
    if (s.task.status) runtimeState.task.status = s.task.status;
    if (Number.isFinite(s.task.progress)) runtimeState.task.progress = s.task.progress;
    if (Number.isFinite(s.task.successProbability)) runtimeState.task.successProbability = s.task.successProbability;
  }
  if (s.model) {
    if (s.model.currentModel !== undefined) runtimeState.model.currentModel = s.model.currentModel;
    if (s.model.currentProvider !== undefined) runtimeState.model.currentProvider = s.model.currentProvider;
    if (Array.isArray(s.model.candidateModels)) runtimeState.model.candidateModels = s.model.candidateModels.map((c) => ({ ...c }));
    if (Number.isFinite(s.model.modelContextLimit)) runtimeState.model.modelContextLimit = s.model.modelContextLimit;
    if (s.model.modelHealth) runtimeState.model.modelHealth = s.model.modelHealth;
    if (Number.isFinite(s.model.modelLatency)) runtimeState.model.modelLatency = s.model.modelLatency;
    if (Number.isFinite(s.model.modelReliability)) runtimeState.model.modelReliability = s.model.modelReliability;
    if (typeof s.model.modelSelectionReason === 'string') runtimeState.model.modelSelectionReason = s.model.modelSelectionReason;
    if (Number.isFinite(s.model.modelSwitchCount)) runtimeState.model.modelSwitchCount = s.model.modelSwitchCount;
    if (Number.isFinite(s.model.modelStickinessScore)) runtimeState.model.modelStickinessScore = s.model.modelStickinessScore;
  }
  if (s.context) {
    if (Number.isFinite(s.context.currentTokens)) runtimeState.context.currentTokens = s.context.currentTokens;
    if (Array.isArray(s.context.contextItems)) {
      runtimeState.context.contextItems = s.context.contextItems.map((i) => ({ ...i }));
    }
    if (Array.isArray(s.context.compressedItems)) runtimeState.context.compressedItems = s.context.compressedItems.map((i) => ({ ...i }));
    if (Array.isArray(s.context.discardedItems)) runtimeState.context.discardedItems = s.context.discardedItems.slice(-50);
    if (Number.isFinite(s.context.contextVersion)) runtimeState.context.contextVersion = s.context.contextVersion;
    if (s.context.cacheState) runtimeState.context.cacheState = s.context.cacheState;
  }
  if (s.memory) {
    if (Array.isArray(s.memory.workingMemoryRefs)) runtimeState.memory.workingMemoryRefs = s.memory.workingMemoryRefs.map((r) => ({ ...r }));
    if (Array.isArray(s.memory.persistentMemoryRefs)) runtimeState.memory.persistentMemoryRefs = s.memory.persistentMemoryRefs.map((r) => ({ ...r }));
  }
  if (s.budget) {
    // Spend is authoritative: resuming must not forgive or duplicate cost.
    if (Number.isFinite(s.budget.currentSpend)) runtimeState.budget.currentSpend = s.budget.currentSpend;
    if (Number.isFinite(s.budget.maximumCost)) runtimeState.budget.maximumCost = s.budget.maximumCost;
    if (Number.isFinite(s.budget.elapsedLatency)) runtimeState.budget.elapsedLatency = s.budget.elapsedLatency;
    if (Number.isFinite(s.budget.maximumLatency)) runtimeState.budget.maximumLatency = s.budget.maximumLatency;
    if (s.budget.costBreakdown && typeof s.budget.costBreakdown === 'object') {
      runtimeState.budget.costBreakdown = new Map(Object.entries(s.budget.costBreakdown));
    }
    if (Array.isArray(s.budget.costHistory)) {
      runtimeState.budget.costHistory = s.budget.costHistory.slice(-50).map((h) => ({ ...h }));
    }
  }
  if (s.execution) {
    // Cursor restores to the last COMPLETED step; the loop continues after it.
    if (Number.isFinite(s.execution.currentStep)) runtimeState.execution.currentStep = s.execution.currentStep;
    if (Number.isFinite(s.execution.totalSteps)) runtimeState.execution.totalSteps = s.execution.totalSteps;
    if (Array.isArray(s.execution.stepHistory)) {
      runtimeState.execution.stepHistory = s.execution.stepHistory.map((h) => ({ ...h }));
    }
    if (Number.isFinite(s.execution.retries)) runtimeState.execution.retries = s.execution.retries;
    if (Number.isFinite(s.execution.failures)) runtimeState.execution.failures = s.execution.failures;
    if (s.execution.executionStatus) runtimeState.execution.executionStatus = s.execution.executionStatus;
  }
  if (Array.isArray(s.modelCalls) && typeof runtimeState.addModelCall === 'function') {
    runtimeState.modelCalls = s.modelCalls.slice(-200).map((m) => ({ ...m }));
  }
  if (s.metadata && typeof s.metadata === 'object') runtimeState.metadata = { ...s.metadata };
  runtimeState.updatedAt = now();
}

// Capture the run-control record (conversation + counters) next to a
// checkpoint so resume continues the same provider conversation.
function captureControlSnapshot(ctrl) {
  if (!ctrl || typeof ctrl !== 'object') return null;
  return {
    messages: Array.isArray(ctrl.messages) ? ctrl.messages.slice(-300).map((m) => ({ ...m })) : [],
    history: Array.isArray(ctrl.history) ? ctrl.history.slice(-300).map((h) => ({ ...h })) : [],
    tokens: ctrl.tokens ? { ...ctrl.tokens } : { input: 0, output: 0, cached: 0, reasoning: 0 },
    toolCalls: Number.isFinite(ctrl.toolCalls) ? ctrl.toolCalls : 0,
    retries: Number.isFinite(ctrl.retries) ? ctrl.retries : 0,
    triedModels: Array.from(ctrl.triedModels instanceof Set ? ctrl.triedModels : []),
    completedCheckpoints: Number.isFinite(ctrl.completedCheckpoints) ? ctrl.completedCheckpoints : 0,
    heuristicToolUsed: !!ctrl.heuristicToolUsed,
    lastUserMessage: typeof ctrl.lastUserMessage === 'string' ? ctrl.lastUserMessage.slice(0, 4000) : '',
    latency: ctrl.latency ? { ...ctrl.latency } : null,
  };
}

// Restore a captured control snapshot onto a live control record.
function restoreControlSnapshot(ctrl, snap) {
  if (!ctrl || !snap || typeof snap !== 'object') return false;
  if (Array.isArray(snap.messages)) ctrl.messages = snap.messages.map((m) => ({ ...m }));
  if (Array.isArray(snap.history)) ctrl.history = snap.history.map((h) => ({ ...h }));
  if (snap.tokens && typeof snap.tokens === 'object') ctrl.tokens = { ...snap.tokens };
  if (Number.isFinite(snap.toolCalls)) ctrl.toolCalls = snap.toolCalls;
  if (Number.isFinite(snap.retries)) ctrl.retries = snap.retries;
  if (Array.isArray(snap.triedModels)) ctrl.triedModels = new Set(snap.triedModels);
  if (Number.isFinite(snap.completedCheckpoints)) ctrl.completedCheckpoints = snap.completedCheckpoints;
  if (typeof snap.heuristicToolUsed === 'boolean') ctrl.heuristicToolUsed = snap.heuristicToolUsed;
  if (typeof snap.lastUserMessage === 'string') ctrl.lastUserMessage = snap.lastUserMessage;
  if (snap.latency && typeof snap.latency === 'object') ctrl.latency = { ...ctrl.latency, ...snap.latency };
  return true;
}

module.exports = {
  ExecutionCheckpoint,
  CheckpointManager,
  RecoveryManager,
  CHECKPOINT_VERSION,
  CHECKPOINT_MAX_AGE_MS,
  validateCheckpoint,
  applySnapshotToRuntime,
  captureControlSnapshot,
  restoreControlSnapshot,
};