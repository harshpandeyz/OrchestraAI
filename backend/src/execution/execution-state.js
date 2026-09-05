'use strict';

const { TaskStatus, CheckpointType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');
const { applySnapshotToRuntime } = require('../checkpoint/checkpoint-manager');
const { captureControlSnapshot } = require('../checkpoint/checkpoint-manager');

// Execution state schema version. Increments on structural changes;
// older versions accepted by validateExecutionState for backward compat.
const EXECUTION_STATE_VERSION = 1;

// Types for the durable execution-state document.
function buildExecutionState(runtimeState, ctrl, options = {}) {
  const checkpoint = runtimeState.execution && runtimeState.execution.getLastCheckpoint
    ? runtimeState.execution.getLastCheckpoint()
    : runtimeState.execution && runtimeState.execution.lastCheckpoint;

  return {
    version: EXECUTION_STATE_VERSION,
    runId: runtimeState.runId,
    capturedAt: now(),
    status: runtimeState.status,
    interrupted: !!options.interrupted,
    cursor: Number.isFinite(runtimeState.execution.currentStep) ? runtimeState.execution.currentStep : 0,
    runtime: runtimeState.toSnapshot(),
    control: serializeControl(ctrl, options),
    checkpoint: checkpoint ? {
      checkpointId: checkpoint.checkpointId,
      type: checkpoint.type,
      stepNumber: checkpoint.stepNumber,
      completed: checkpoint.completed,
    } : null,
  };
}

function serializeControl(ctrl, options = {}) {
  const snapshot = captureControlSnapshot(ctrl);

  return {
    mode: ctrl.mode || 'demo',
    providerId: ctrl.providerId || null,
    providerModel: ctrl.providerModel ? {
      id: ctrl.providerModel.id,
      provider: ctrl.providerModel.provider,
      nativeId: ctrl.providerModel.nativeId,
      contextWindow: ctrl.providerModel.contextWindow || 0,
    } : null,
    lastPromptTokens: ctrl.lastPromptTokens || 0,
    routing: ctrl.routing || {},
    lastToolEffect: ctrl.lastToolEffect ? {
      state: ctrl.lastToolEffect.state,
      tool: ctrl.lastToolEffect.tool,
      idempotencyKey: ctrl.lastToolEffect.idempotencyKey || null,
      step: ctrl.lastToolEffect.step,
      destructive: !!ctrl.lastToolEffect.destructive,
      idempotent: !!ctrl.lastToolEffect.idempotent,
      retryable: !!ctrl.lastToolEffect.retryable,
      startedAt: ctrl.lastToolEffect.startedAt,
    } : null,
    lastUserMessage: typeof ctrl.lastUserMessage === 'string' ? ctrl.lastUserMessage.slice(0, 4000) : (ctrl.lastUserMessage || ''),
    tokens: ctrl.tokens ? { input: ctrl.tokens.input || 0, output: ctrl.tokens.output || 0, cached: ctrl.tokens.cached || 0, reasoning: ctrl.tokens.reasoning || 0 } : { input: 0, output: 0, cached: 0, reasoning: 0 },
    latency: ctrl.latency ? {
      currentStepMs: ctrl.latency.currentStepMs || 0,
      avgStepMs: ctrl.latency.avgStepMs || 0,
      modelMs: ctrl.latency.modelMs || 0,
      toolMs: ctrl.latency.toolMs || 0,
      totalMs: ctrl.latency.totalMs || 0,
      samples: ctrl.latency.samples ? ctrl.latency.samples.slice(-40) : [],
      modelSamples: ctrl.latency.modelSamples ? ctrl.latency.modelSamples.slice(-40) : [],
    } : null,
    attemptedModels: ctrl.triedModels ? Array.from(ctrl.triedModels) : [],
    completedCheckpoints: Number.isFinite(ctrl.completedCheckpoints) ? ctrl.completedCheckpoints : 0,
    heuristicToolUsed: !!ctrl.heuristicToolUsed,
    decisions: ctrl.decisions || [],
    changes: ctrl.changes || [],
    series: ctrl.series ? ctrl.series.slice(-200) : [],
    policy: ctrl.policyEngine ? {
      allowedProviders: ctrl.policyEngine.allowedProviders || [],
      allowedModels: ctrl.policyEngine.allowedModels || [],
      allowedTools: ctrl.policyEngine.allowedTools || [],
      blockedProviders: ctrl.policyEngine.blockedProviders || [],
      blockedModels: ctrl.policyEngine.blockedModels || [],
      blockedTools: ctrl.policyEngine.blockedTools || [],
      privacyConstraints: ctrl.policyEngine.privacyConstraints || {},
      costConstraints: ctrl.policyEngine.costConstraints || {},
      latencyConstraints: ctrl.policyEngine.latencyConstraints || {},
      capabilityRequirements: ctrl.policyEngine.capabilityRequirements || [],
      modelStickinessThreshold: ctrl.policyEngine.modelStickinessThreshold || 0.7,
      modelSwitchingThreshold: ctrl.policyEngine.modelSwitchingThreshold || 0.15,
      contextUtilizationThreshold: ctrl.policyEngine.contextUtilizationThreshold || 0.8,
      maxRetries: ctrl.policyEngine.maxRetries || 3,
      retryBackoffMs: ctrl.policyEngine.retryBackoffMs || 1000,
    } : null,
    resolvedConfig: options.resolvedConfig || {},
    ...snapshot,
  };
}

function validateExecutionState(doc) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, code: 'bad_shape', error: 'Execution state document missing' };
  }
  if (typeof doc.version !== 'number' || doc.version !== EXECUTION_STATE_VERSION) {
    return { ok: false, code: 'bad_version', error: `Unsupported execution state version: ${doc.version}` };
  }
  if (typeof doc.runId !== 'string' || doc.runId.length === 0) {
    return { ok: false, code: 'bad_shape', error: 'Missing or invalid runId' };
  }
  if (typeof doc.status !== 'string') {
    return { ok: false, code: 'bad_shape', error: 'Missing or invalid status' };
  }
  if (typeof doc.cursor !== 'number' || !Number.isFinite(doc.cursor)) {
    return { ok: false, code: 'bad_shape', error: 'Missing or invalid cursor' };
  }
  if (typeof doc.runtime !== 'object' || doc.runtime === null) {
    return { ok: false, code: 'bad_shape', error: 'Missing or invalid runtime snapshot' };
  }
  if (typeof doc.control !== 'object' || doc.control === null) {
    return { ok: false, code: 'bad_shape', error: 'Missing or invalid control record' };
  }
  // Checkpoint validation only needed if present.
  if (doc.checkpoint && typeof doc.checkpoint === 'object') {
    const cpCheck = validateCheckpointLegacy(doc.checkpoint);
    if (!cpCheck.ok) {
      return { ok: false, code: cpCheck.code || 'bad_shape', error: cpCheck.error || 'Invalid checkpoint in execution state' };
    }
  }
  return { ok: true };
}

function validateCheckpointLegacy(cp) {
  if (!cp || typeof cp !== 'object') return { ok: false, code: 'missing', error: 'Checkpoint missing' };
  if (typeof cp.checkpointId !== 'string' || typeof cp.type !== 'string') return { ok: false, code: 'bad_shape', error: 'Checkpoint bad shape' };
  if (!Number.isFinite(cp.stepNumber)) return { ok: false, code: 'bad_shape', error: 'Checkpoint bad stepNumber' };
  if (typeof cp.completed !== 'boolean') return { ok: false, code: 'bad_shape', error: 'Checkpoint completed should be boolean' };
  // We do NOT check integrity here because the checkpoint may have been
  // stored from an older schema; callers that need integrity should use
  // the recovery-service/checkpoint-manager path.
  return { ok: true };
}

function hydrateRuntimeState(doc, config = {}) {
  // Build a fresh RuntimeState and restore fields from the doc snapshot.
  // We need a task objective; prefer from the doc.
  const taskObjective = doc.runtime && doc.runtime.task ? doc.runtime.task.objective : config.objective || 'unknown task';
  const rs = new (require('../state/runtime-state').RuntimeState)(taskObjective, config);

  // Now apply everything from the snapshot via applySnapshotToRuntime
  // and then restore the top-level task fields that applySnapshotToRuntime
  // does not cover (objective, taskId, taskType, complexity, priority, etc).
  try {
    applySnapshotToRuntime(rs, doc.runtime);
  } catch (e) {
    // If the snapshot is truly incompatible, fall back to partial restoration.
    // We still restore the parts we can without throwing.
    try { if (doc.runtime.status) rs.status = doc.runtime.status; } catch {}
    try { rs.task.progress = doc.runtime.task && Number.isFinite(doc.runtime.task.progress) ? doc.runtime.task.progress : 0; } catch {}
    try { rs.task.successProbability = doc.runtime.task && Number.isFinite(doc.runtime.task.successProbability) ? doc.runtime.task.successProbability : 0.5; } catch {}
  }

  // Top-level fields that applySnapshotToRuntime does not restore:
  // task objective already used in constructor. Set remaining ones.
  if (doc.runtime && doc.runtime.task) {
    // taskId, taskType, complexity, priority were set in constructor; we trust those.
    // status overrides:
    if (Number.isFinite(doc.runtime.task.status)) rs.task.status = doc.runtime.task.status;
    if (Number.isFinite(doc.runtime.task.progress)) rs.task.progress = doc.runtime.task.progress;
    if (Number.isFinite(doc.runtime.task.successProbability)) rs.task.successProbability = doc.runtime.task.successProbability;
    if (typeof doc.runtime.task.metadata === 'object') rs.task.metadata = { ...doc.runtime.task.metadata };
  }

  // model
  if (doc.runtime && doc.runtime.model) {
    const m = doc.runtime.model;
    if (m.currentModel !== undefined) rs.model.currentModel = m.currentModel;
    if (m.currentProvider !== undefined) rs.model.currentProvider = m.currentProvider;
    if (Array.isArray(m.candidateModels)) rs.model.candidateModels = m.candidateModels.map(c => ({ ...c }));
    if (Number.isFinite(m.modelContextLimit)) rs.model.modelContextLimit = m.modelContextLimit;
    if (typeof m.modelHealth === 'string') rs.model.modelHealth = m.modelHealth;
    if (Number.isFinite(m.modelLatency)) rs.model.modelLatency = m.modelLatency;
    if (Number.isFinite(m.modelReliability)) rs.model.modelReliability = m.modelReliability;
    if (typeof m.modelSelectionReason === 'string') rs.model.modelSelectionReason = m.modelSelectionReason;
    if (Number.isFinite(m.modelSwitchCount)) rs.model.modelSwitchCount = m.modelSwitchCount;
    if (Number.isFinite(m.modelStickinessScore)) rs.model.modelStickinessScore = m.modelStickinessScore;
  }

  // context
  if (doc.runtime && doc.runtime.context) {
    const c = doc.runtime.context;
    if (Number.isFinite(c.currentTokens)) rs.context.currentTokens = c.currentTokens;
    if (Array.isArray(c.contextItems)) rs.context.contextItems = c.contextItems.map(i => ({ ...i }));
    if (Array.isArray(c.compressedItems)) rs.context.compressedItems = c.compressedItems.map(i => ({ ...i }));
    if (Array.isArray(c.discardedItems)) rs.context.discardedItems = c.discardedItems.slice(-50);
    if (Number.isFinite(c.contextVersion)) rs.context.contextVersion = c.contextVersion;
    if (c.cacheState) rs.context.cacheState = c.cacheState;
    if (typeof c.cacheablePrefixTokens === 'number') rs.context.setCacheablePrefix(c.cacheablePrefixTokens);
  }

  // memory
  if (doc.runtime && doc.runtime.memory) {
    const mem = doc.runtime.memory;
    if (Array.isArray(mem.workingMemoryRefs)) rs.memory.workingMemoryRefs = mem.workingMemoryRefs.map(r => ({ ...r }));
    if (Array.isArray(mem.persistentMemoryRefs)) rs.memory.persistentMemoryRefs = mem.persistentMemoryRefs.map(r => ({ ...r }));
  }

  // budget
  if (doc.runtime && doc.runtime.budget) {
    const b = doc.runtime.budget;
    if (Number.isFinite(b.currentSpend)) rs.budget.currentSpend = b.currentSpend;
    if (Number.isFinite(b.maximumCost)) rs.budget.maximumCost = b.maximumCost;
    if (Number.isFinite(b.elapsedLatency)) rs.budget.elapsedLatency = b.elapsedLatency;
    if (Number.isFinite(b.maximumLatency)) rs.budget.maximumLatency = b.maximumLatency;
    if (b.costBreakdown && typeof b.costBreakdown === 'object') {
      rs.budget.costBreakdown = new Map(Object.entries(b.costBreakdown));
    }
    if (Array.isArray(b.costHistory)) {
      rs.budget.costHistory = b.costHistory.slice(-50).map(h => ({ ...h }));
    }
  }

  // execution
  if (doc.runtime && doc.runtime.execution) {
    const ex = doc.runtime.execution;
    if (Number.isFinite(ex.currentStep)) rs.execution.currentStep = ex.currentStep;
    if (Number.isFinite(ex.totalSteps)) rs.execution.totalSteps = ex.totalSteps;
    if (Array.isArray(ex.stepHistory)) {
      rs.execution.stepHistory = ex.stepHistory.map(h => ({ ...h }));
    }
    if (Number.isFinite(ex.retries)) rs.execution.retries = ex.retries;
    if (Number.isFinite(ex.failures)) rs.execution.failures = ex.failures;
    if (typeof ex.executionStatus === 'string') rs.execution.executionStatus = ex.executionStatus;
  }

  // modelCalls
  if (doc.runtime && Array.isArray(doc.runtime.modelCalls)) {
    rs.modelCalls = doc.runtime.modelCalls.slice(-200).map(m => ({ ...m }));
  }

  // ownership
  if (doc.runtime && doc.runtime.ownerId !== undefined) rs.ownerId = doc.runtime.ownerId.slice(0, 128) || null;
  if (doc.runtime && doc.runtime.orgId !== undefined) rs.orgId = doc.runtime.orgId.slice(128) || null;
  if (doc.runtime && doc.runtime.projectId !== undefined) rs.projectId = doc.runtime.projectId.slice(128) || null;
  if (doc.runtime && doc.runtime.referenceModelId !== undefined) rs.referenceModelId = doc.runtime.referenceModelId.slice(200) || null;
  if (doc.runtime && doc.runtime.referencePricingSnapshot) {
    rs.referencePricingSnapshot = { ...doc.runtime.referencePricingSnapshot };
  }
  if (doc.runtime && doc.runtime.economics) {
    rs.economics = JSON.parse(JSON.stringify(doc.runtime.economics));
  }
  if (doc.runtime && doc.runtime.privacyMode) rs.privacyMode = doc.runtime.privacyMode;
  if (doc.runtime && doc.runtime.executionMode) rs.executionMode = doc.runtime.executionMode;

  return rs;
}

function buildControlRecordOrNull(runtimeState, resolvedConfig = {}) {
  // Build a control record shape that mirrors Orchestrator.createRun's
  // inline ctrlRecord creation. This is used by orchestrator.hydrateRun.
  // It's a builder that returns the raw record; the caller registers it.
  const policyEngine = new (require('../policies/policy-engine').PolicyEngine)(runtimeState.policy, resolvedConfig);
  const maxSteps = resolvedConfig.maxSteps || 12;
  const timeoutMs = resolvedConfig.timeoutMs || 300000;
  const maxToolCalls = resolvedConfig.maxToolCalls || 20;
  const maxRetries = resolvedConfig.maxRetries || 2;

  const ctrl = {
    policyEngine,
    machine: new (require('../core/state-machine').StateMachine)(TaskStatus.CREATED),
    abort: false,
    abortController: new AbortController(),
    running: false,
    startedAt: Date.now(),
    mode: resolvedConfig.mode || 'demo',
    providerId: resolvedConfig.provider || 'openrouter',
    providerModel: runtimeState.model.currentModel ? {
      id: runtimeState.model.currentModel,
      provider: runtimeState.model.currentProvider || null,
      nativeId: runtimeState.model.modelContextLimit || null,
      contextWindow: runtimeState.model.modelContextLimit || 0,
    } : null,
    messages: [],
    history: [],
    trace: [],
    decisions: [],
    changes: [],
    latency: { currentStepMs: 0, avgStepMs: 0, modelMs: 0, toolMs: 0, totalMs: 0, samples: [], modelSamples: [], toolSamples: [] },
    series: [],
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    routing: { candidates: [], decision: null },
    lastPromptTokens: 0,
    lastUserMessage: '',
    heuristicToolUsed: false,
    toolCalls: 0,
    retries: 0,
    triedModels: new Set(),
    completedCheckpoints: 0,
    lastToolEffect: null,
    toolRiskCache: new Map(),
    recoveryInProgress: false,
  };

  // Attach resolved config (same as attachRunConfig does for createRun).
  ctrl.runConfig = { ...resolvedConfig };
  ctrl.maxSteps = resolvedConfig.maxSteps || 12;

  return ctrl;
}

module.exports = {
  EXECUTION_STATE_VERSION,
  buildExecutionState,
  validateExecutionState,
  hydrateRuntimeState,
  serializeControl,
  buildControlRecordOrNull,
};