'use strict';

// Orchestrator — the runtime control plane (Session 5 integration).
//
// This is the ONLY production execution path. It wires, per run:
//
//   user task -> ContextManager -> ModelRouter/ModelRegistry -> ProviderAdapter
//     -> normalized response -> ToolRegistry/ToolExecutor -> RuntimeState
//     -> MemoryManager/CacheManager -> telemetry -> EventBus/SSE -> reevaluate
//
// Per-run isolation: policy engine, state machine, abort controller, message /
// trace / decision / change / latency / time-series stores are all scoped to
// the run ID. Shared registries are read-mostly; run-scoped writes are tagged.
//
// Lifecycle (every state has an explicit legal transition; StateMachine
// enforces them, so the run can never get stuck in OBSERVING/WAITING_FOR_TOOL):
//
//   CREATED -> PLANNING -> CONTEXT_BUILD -> MODEL_SELECT -> EXECUTING
//     EXECUTING <-> WAITING_FOR_TOOL   (tool dispatch / result)
//     EXECUTING <-> OBSERVING          (model call / observation)
//     EXECUTING -> REOPTIMIZING -> MODEL_SELECT | CONTEXT_BUILD | EXECUTING
//     -> COMPLETED | FAILED | CANCELLED,  FAILED -> RETRYING -> EXECUTING
//
// Guards on every loop iteration: cancellation, deadline, max steps, retry
// budget, spend budget, latency budget, context budget.

const { TaskStatus, EventType, DecisionType, CheckpointType, CostCategory } = require('../core/types');
const { RuntimeState } = require('../state/runtime-state');
const { eventBus } = require('../events/event-bus');
const { DecisionEngine } = require('../decisions/decision-engine');
const { SwitchingCostCalculator, ModelStickinessManager } = require('../decisions/switching-cost');
const { PolicyEngine } = require('../policies/policy-engine');
const { CostEstimator } = require('../cost/cost-estimator');
const { CheckpointManager, RecoveryManager } = require('../checkpoint/checkpoint-manager');
const { RecoveryService, classifySideEffect } = require('./recovery-service');
const { TelemetryCollector, TelemetryEvent } = require('../telemetry/telemetry-collector');
const { StateMachine } = require('./state-machine');
const { generateId, now } = require('../state/runtime-state');
const { createLogger } = require('../logger');
const { ProviderError } = require('../providers/provider-adapter');
const { resolveRunConfig, attachRunConfig, runConfigFor, syncLegacyMaxSteps } = require('../run-config');
const { createModelCallRecord } = require('../economics/canonical-record');

const TERMINAL = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);

function contentRetentionAllowed(runtimeState) {
  return !!runtimeState && runtimeState.privacyMode === 'standard';
}

function frontendStatus(internal) {
  switch (internal) {
    case TaskStatus.CREATED: return 'idle';
    case TaskStatus.PLANNING: return 'planning';
    case TaskStatus.WAITING_FOR_TOOL: return 'waiting';
    case TaskStatus.COMPLETED: return 'completed';
    case TaskStatus.FAILED: return 'failed';
    case TaskStatus.CANCELLED: return 'cancelled';
    default: return 'running';
  }
}

// Human-readable one-line summary of a tool result for memory snippets and
// trace labels. Raw JSON.stringify output embeds literal "\n" escapes (and
// slicing can cut mid-escape), which renders as noise in the UI. Prefer a
// result's own textual field when present, then collapse whitespace.
function summarizeToolResult(result) {
  let text = '';
  if (typeof result === 'string') {
    text = result;
  } else if (result && typeof result === 'object') {
    const direct = ['summary', 'output', 'stdout', 'text', 'message'].find(
      (k) => typeof result[k] === 'string' && result[k].trim()
    );
    if (direct) {
      const passed = result.passed === true ? 'passed' : result.passed === false ? 'failed' : null;
      const suite = typeof result.suite === 'string' && result.suite ? ` (${result.suite})` : '';
      text = (passed ? `${passed}${suite}: ` : '') + result[direct];
    } else {
      try {
        text = JSON.stringify(result);
      } catch {
        text = String(result);
      }
    }
  } else if (result !== undefined && result !== null) {
    text = String(result);
  }
  return text.replace(/\s+/g, ' ').trim();
}

class Orchestrator {
  constructor(dependencies = {}) {
    this.modelRegistry = dependencies.modelRegistry;
    this.modelRouter = dependencies.modelRouter;
    this.contextManager = dependencies.contextManager;
    this.memoryManager = dependencies.memoryManager;
    this.cacheManager = dependencies.cacheManager;
    this.toolRegistry = dependencies.toolRegistry;
    this.toolExecutor = dependencies.toolExecutor;
    this.costEstimator = dependencies.costEstimator || new CostEstimator();
    this.providerRegistry = dependencies.providerRegistry || null;
    this.config = {
      mode: 'demo',
      provider: 'openrouter',
      runTimeoutMs: 300000,
      maxSteps: 12,
      maxToolCalls: 20,
      maxRetries: 2,
      optimizationInterval: 5,
      maxToolCallsTotal: 100,
      contextCompressionThreshold: 0.8,
      budgetWarningThreshold: 0.8,
      ...(dependencies.config || {}),
    };
    // Single authoritative pricing path: registry -> estimator.
    if (this.modelRegistry && typeof this.costEstimator.attachRegistry === 'function') {
      this.costEstimator.attachRegistry(this.modelRegistry);
    }
    this.checkpointManager = new CheckpointManager();
    this.recoveryManager = new RecoveryManager(this.checkpointManager);
    this.recoveryService = new RecoveryService({
      checkpointManager: this.checkpointManager,
      recoveryManager: this.recoveryManager,
      logger: this.log,
    });
    // Optional durable hook invoked after every completed step checkpoint:
    // (runId) => void. The server wires snapshot persistence here so a
    // crash loses at most the in-flight step, not the whole run.
    this.persistHook = dependencies.persistHook || null;
    this.telemetry = new TelemetryCollector();
    this.decisionEngine = new DecisionEngine();
    this.switchingCostCalculator = dependencies.switchingCostCalculator || new SwitchingCostCalculator();
    this.stickinessManager = dependencies.stickinessManager || new ModelStickinessManager();
    // Optional sink for finished-run evaluations + persistence hooks.
    // { recordEvaluation(eval), onRunEnd(summary) }. Failures here never fail a run.
    this.runEndSink = dependencies.runEndSink || dependencies.evaluationRecorder || null;
    // Optional Session 2 intelligence store (IntelligenceStore). Attached by
    // server wiring; every use is guarded so runs never depend on it.
    this.intelligence = dependencies.intelligence || null;

    this.activeRuns = new Map();
    // runId -> per-run control record (never shared between runs).
    this.runControl = new Map();
    // Terminal history (bounded): runs retired from activeRuns after their
    // final state/events/snapshot are persisted. History stays queryable for
    // replay/compare/retry without leaking live memory forever.
    // runId -> { runtimeState, control, endedAt, status }
    this.terminalRuns = new Map();
    this.terminalOrder = []; // FIFO for bounded eviction
    this.maxTerminalRetained = dependencies.maxTerminalRetained || 200;

    this.log = dependencies.logger || createLogger({ level: process.env.LOG_LEVEL || 'info' });

    // Bridge registry price changes into every affected active run.
    if (this.modelRegistry && typeof this.modelRegistry.on === 'function') {
      this.modelRegistry.on('price.changed', (evt) => {
        this.handlePriceUpdate(evt).catch((e) => this.log.warn('price update handling failed', { error: String(e).slice(0, 200) }));
      });
    }
  }

  // ---------- run-scoped helpers ----------

  control(runId) {
    return this.runControl.get(runId) || (this.terminalRuns.get(runId) || {}).control || null;
  }

  // Live control only (for mutation paths that must reject terminal runs).
  liveControl(runId) {
    return this.runControl.get(runId) || null;
  }

  // Unified run lookup: live first, then retired history. Never throws.
  getRun(runId) {
    return this.activeRuns.get(runId) || (this.terminalRuns.get(runId) || {}).runtimeState || null;
  }

  isActiveRun(runId) {
    return this.activeRuns.has(runId);
  }

  isTerminalRun(runId) {
    return this.terminalRuns.has(runId);
  }

  runConfig(runId) {
    return runConfigFor(this.control(runId), this.config);
  }

  policyFor(runId) {
    const ctrl = this.control(runId);
    return ctrl ? ctrl.policyEngine : null;
  }

  transition(runtimeState, to) {
    const ctrl = this.control(runtimeState.runId);
    if (!ctrl) throw new Error(`No control record for run ${runtimeState.runId}`);
    if (ctrl.machine.getState() === to) return;
    // Explicit rejection of invalid transitions (never silent mutation).
    if (!ctrl.machine.canTransition(to)) {
      const e = new Error(`Invalid state transition: ${ctrl.machine.getState()} -> ${to}`);
      e.code = 'invalid_transition';
      e.currentState = ctrl.machine.getState();
      e.attemptedState = to;
      throw e;
    }
    ctrl.machine.transition(to);
    runtimeState.updateStatus(to);
  }

  // WAITING_FOR_TOOL has no direct edge to OBSERVING; route via EXECUTING so
  // every transition stays legal and the run can never get stuck.
  toObserving(runtimeState) {
    const ctrl = this.control(runtimeState.runId);
    if (ctrl && ctrl.machine.getState() === TaskStatus.WAITING_FOR_TOOL) {
      this.transition(runtimeState, TaskStatus.EXECUTING);
    }
    this.transition(runtimeState, TaskStatus.OBSERVING);
  }

  // Track the last tool side effect for recovery: mark in_flight BEFORE
  // dispatch (a crash at any point after this is UNKNOWN until proven
  // otherwise), then completed/failed with the outcome. Classification is
  // cached per run so recovery never depends on registry availability.
  async _markToolInFlight(runtimeState, toolName, idempotencyKey, stepNumber) {
    const ctrl = this.control(runtimeState.runId);
    if (!ctrl) return null;
    let cls = ctrl.toolRiskCache.get(toolName);
    if (!cls) {
      let def = null;
      try {
        if (this.toolRegistry && typeof this.toolRegistry.getTool === 'function') {
          def = await this.toolRegistry.getTool(toolName);
        }
      } catch { /* registry advisory; default classification is cautious */ }
      cls = classifySideEffect(def || { name: toolName, risk: 'medium' });
      if (ctrl.toolRiskCache.size > 100) ctrl.toolRiskCache.clear();
      ctrl.toolRiskCache.set(toolName, cls);
    }
    ctrl.lastToolEffect = {
      state: 'in_flight',
      tool: toolName,
      idempotencyKey: idempotencyKey || null,
      step: stepNumber,
      destructive: cls.destructive,
      idempotent: cls.idempotent,
      retryable: true,
      startedAt: now(),
    };
    return ctrl.lastToolEffect;
  }

  _markToolSettled(runtimeState, ok, code = null) {
    const ctrl = this.control(runtimeState.runId);
    if (!ctrl || !ctrl.lastToolEffect) return;
    const rec = ctrl.lastToolEffect;
    rec.state = ok ? 'completed' : 'failed';
    rec.retryable = ok || !['bad_params', 'denied', 'scope_violation', 'path_escape', 'not_found', 'patch_conflict'].includes(String(code || ''));
    rec.settledAt = now();
    if (code) rec.code = code;
  }

  _emit(runId, type, payload) {
    const env = eventBus.emit(runId, type, payload);
    const ctrl = this.control(runId);
    if (ctrl && ctrl.trace.length < 300) {
      ctrl.trace.push({ seq: env.seq, ts: env.ts, type, label: this._traceLabel(type, payload), status: this._traceStatus(type) });
    }
    return env;
  }

  _traceLabel(type, p = {}) {
    switch (type) {
      case EventType.TASK_CREATED: return `Task created: ${String(p.title || '').slice(0, 80)}`;
      case EventType.TASK_STARTED: return 'Run started';
      case EventType.PLANNING: return p.note || 'Planning';
      case EventType.CONTEXT_BUILT: return `Context built (${((p.usedTokens || 0) / 1000).toFixed(1)}k tokens)`;
      case EventType.CONTEXT_COMPRESSED: return `Context compressed (-${((p.reclaimedTokens || 0) / 1000).toFixed(1)}k)`;
      case EventType.MODEL_SELECTED: return `Model selected: ${p.modelId}`;
      case EventType.MODEL_SWITCHED: return `Model switched: ${p.fromModel || p.fromId} -> ${p.toModel || p.toId}${p.reason ? ` — ${String(p.reason).slice(0, 120)}` : ''}`;
      case EventType.MODEL_RETAINED: return `Model retained: ${p.modelId} (${p.reason || ''})`;
      case EventType.ROUTING_EVALUATED: return p.note || 'Routing evaluated';
      case EventType.TOOL_SELECTED: return `Tool selected: ${p.tool}`;
      case EventType.TOOL_STARTED: return `Tool started: ${p.tool}`;
      case EventType.TOOL_COMPLETED: return `Tool completed: ${p.tool} (${p.status || 'success'})`;
      case EventType.TOOL_FAILED: return `Tool failed: ${p.tool}`;
      case EventType.RESPONSE_DONE: return 'Model response received';
      case EventType.CACHE_HIT: return `Cache hit: ${String(p.detail || '').slice(0, 80)}`;
      case EventType.CACHE_MISS: return `Cache miss: ${String(p.detail || '').slice(0, 80)}`;
      case EventType.CACHE_INVALIDATED: return 'Cache invalidated';
      case EventType.MEMORY_WRITTEN: return `Memory written (${p.scope}): ${String(p.title || '').slice(0, 60)}`;
      case EventType.COST_UPDATED: return `Cost updated: $${Number(p.spentUsd || 0).toFixed(4)}`;
      case EventType.BUDGET_WARNING: return 'Budget warning';
      case EventType.BUDGET_EXCEEDED: return 'Budget exceeded';
      case EventType.RUN_COMPLETED: return 'Run completed';
      case EventType.RUN_FAILED: return `Run failed: ${String(p.error || '').slice(0, 120)}`;
      case EventType.RUN_CANCELLED: return 'Run cancelled';
      case EventType.PRICE_UPDATED: return `Price updated: ${p.modelId}`;
      case EventType.EXECUTION_RETRY: return `Retrying (attempt ${p.attempt || ''})`;
      case EventType.EXECUTION_RECOVERY_STARTED: return 'Evaluating recovery...';
      case EventType.EXECUTION_RECOVERED: return `Recovered (${p.action || 'resume'} from step ${p.cursor ?? '?'})`;
      case EventType.EXECUTION_RECOVERY_BLOCKED: return `Recovery blocked: ${String(p.reason || '').slice(0, 100)}`;
      default: return type;
    }
  }

  _traceStatus(type) {
    if (type === EventType.RUN_FAILED || type === EventType.TOOL_FAILED || type === EventType.BUDGET_EXCEEDED) return 'error';
    if (type === EventType.TOOL_STARTED || type === EventType.PLANNING) return 'running';
    return 'done';
  }

  _recordChange(runId, kind, label, seq) {
    const ctrl = this.control(runId);
    if (!ctrl) return;
    ctrl.changes.push({ seq: seq || 0, ts: now(), kind, label });
    if (ctrl.changes.length > 100) ctrl.changes.shift();
  }

  _recordDecision(runId, decision) {
    const ctrl = this.control(runId);
    const json = typeof decision.toJSON === 'function' ? decision.toJSON() : decision;
    if (ctrl) {
      ctrl.decisions.push(json);
      if (ctrl.decisions.length > 50) ctrl.decisions.shift();
    }
    this.decisionEngine.recordDecision(decision);
    this.telemetry.recordDecision(runId, decision);
  }

  _recordRunEnd(runtimeState, status) {
    // Real evaluation evidence from the run's own state (no invented metrics).
    try {
      const ctrl = this.control(runtimeState.runId);
      const calls = runtimeState.tools.recentToolCalls || [];
      const failures = calls.filter((c) => c && c.success === false).length;
      const hasAssistant = !!(ctrl && (ctrl.messages || []).some((m) => m.role === 'assistant' && String(m.content || '').trim()));
      const evidence = {
        runId: runtimeState.runId,
        model: runtimeState.model.currentModel,
        provider: runtimeState.model.currentProvider,
        category: runtimeState.task.taskType,
        completed: status === TaskStatus.COMPLETED,
        status,
        hasAssistantMessage: hasAssistant,
        toolCalls: calls.length,
        toolFailures: failures,
        withinBudget: !runtimeState.budget.isBudgetExceeded(),
        cost: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
        latencyMs: runtimeState.budget.elapsedLatency,
        steps: runtimeState.execution.currentStep,
      };
      if (this.runEndSink && typeof this.runEndSink.recordEvaluation === 'function') {
        this.runEndSink.recordEvaluation(evidence);
      }
      if (this.runEndSink && typeof this.runEndSink.onRunEnd === 'function') {
        this.runEndSink.onRunEnd(this._summaryOf(runtimeState));
      }
      // Session 2 learning loop (§8, §31): outcome -> empirical model/task
      // performance. Guarded and evidence-based; failures never fail a run.
      if (this.intelligence && typeof this.intelligence.ingestRunOutcome === 'function') {
        try {
          const ctrl = this.control(runtimeState.runId);
          const calls = runtimeState.tools.recentToolCalls || [];
          const failures = calls.filter((c) => c && c.success === false).length;
          const hasAssistant = !!(ctrl && (ctrl.messages || []).some((m) => m.role === 'assistant' && String(m.content || '').trim()));
          const failedTests = calls
            .filter((c) => c && c.name === 'run_tests' && c.success === true && c.result && Number.isFinite(Number(c.result.failed)))
            .reduce((a, c) => a + Number(c.result.failed), 0);
          const passedTests = calls
            .filter((c) => c && c.name === 'run_tests' && c.success === true && c.result && Number.isFinite(Number(c.result.passed)))
            .reduce((a, c) => a + Number(c.result.passed), 0);
          const hasTestCounts = calls.some((c) => c && c.name === 'run_tests' && c.success === true && c.result && (Number.isFinite(Number(c.result.passed)) || Number.isFinite(Number(c.result.failed))));
          this.intelligence.ingestRunOutcome({
            runId: runtimeState.runId,
            orgId: runtimeState.orgId || null,
            projectId: runtimeState.projectId || null,
            modelId: runtimeState.model.currentModel,
            taskText: runtimeState.task.objective,
            taskCategory: runtimeState.task.taskType && runtimeState.task.taskType !== 'general'
              ? runtimeState.task.taskType
              : undefined,
            completed: status === TaskStatus.COMPLETED,
            hasAssistantMessage: hasAssistant,
            toolFailures: failures,
            toolObservations: calls.slice(-20).map((c) => ({ toolName: c.name, success: c.success !== false })),
            testSummary: hasTestCounts ? { passed: passedTests, failed: failedTests } : null,
            userFeedback: (this.intelligence.userFeedback && this.intelligence.userFeedback.get(runtimeState.runId)) || null,
            withinBudget: !runtimeState.budget.isBudgetExceeded(),
            cost: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
            latencyMs: runtimeState.budget.elapsedLatency,
            steps: runtimeState.execution.currentStep,
            errorCode: status === TaskStatus.FAILED ? 'run_failed' : null,
          });
        } catch (e) {
          this.log.warn('intelligence ingest failed', { error: String((e && e.message) || e).slice(0, 200) });
        }
      }
    } catch (e) {
      this.log.warn('run-end sink failed', { error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  setRuntimeDefaults(defaults) {
    this.runtimeDefaults = { ...(defaults || {}) };
  }

  _summaryOf(runtimeState) {
    return {
      id: runtimeState.runId,
      title: runtimeState.task.objective,
      taskMode: runtimeState.task.taskType,
      status: frontendStatus(runtimeState.status),
      internalStatus: runtimeState.status,
      createdAt: runtimeState.createdAt,
      updatedAt: runtimeState.updatedAt,
      activeModelId: runtimeState.model.currentModel,
      budget: runtimeState.budget.maximumCost,
      spent: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
      ownerId: runtimeState.ownerId || null,
      orgId: runtimeState.orgId || null,
      projectId: runtimeState.projectId || null,
      referenceModelId: runtimeState.referenceModelId || null,
    };
  }

  // ---------- lifecycle ----------

async createRun(taskObjective, config = {}) {
    // Concurrency guard: bounded live runs (DoS protection).
    const liveCount = this.activeRuns.size;
    const maxConcurrent = (this.config.maxConcurrentRuns) || 20;
    if (liveCount >= maxConcurrent) {
      const e = new Error(`Too many concurrent runs (${liveCount}/${maxConcurrent})`);
      e.code = 'busy';
      throw e;
    }
    // Prototype-pollution guard: drop dangerous keys from policy/tools/memory.
    if (config.policy && typeof config.policy === 'object') {
      for (const k of ['__proto__', 'constructor', 'prototype']) delete config.policy[k];
    }
    const runtimeState = new RuntimeState(taskObjective, config);

    // Merge user policy into the PolicyState instance (never replace it:
    // replacing would drop isModelAllowed/isToolAllowed methods). Extra
    // runtime keys (routerWeights, preset, preferredModel, allowSwitching,
    // allowCompaction) ride along as own props for router/orchestrator use.
    if (config.policy && typeof config.policy === 'object') {
      for (const [k, v] of Object.entries(config.policy)) {
        if (k === 'routerWeights' || k === 'preset' || k === 'preferredModel' ||
            k === 'allowSwitching' || k === 'allowCompaction' || k === 'minReliability' ||
            k === 'qualityFloor' || k === 'latencyTargetMs' || k === 'hardBudget' ||
            k === 'allowUnknownPricing') {
          runtimeState.policy[k] = v;
        } else if (k in runtimeState.policy) {
          runtimeState.policy[k] = v;
        }
      }
    }

    // One authoritative ToolRegistry -> per-run tool state. A tool visible on
    // GET /api/tools is always present in the run (status preserved).
    if (this.toolRegistry && typeof this.toolRegistry.getTools === 'function') {
      const catalog = await this.toolRegistry.getTools();
      for (const tool of catalog) {
        runtimeState.tools.registerTool(tool.name, tool);
        if (tool.status && tool.status !== 'enabled') runtimeState.tools.disableTool(tool.name);
      }
    }
    if (config.tools) {
      for (const tool of config.tools) {
        runtimeState.tools.registerTool(tool.name, tool);
      }
    }

    if (config.memory) {
      if (config.memory.working) {
        for (const item of config.memory.working) runtimeState.memory.addWorkingMemory(item);
      }
      if (config.memory.longterm) {
        for (const item of config.memory.longterm) runtimeState.memory.addPersistentMemory(item);
      }
    }

    // Tool policy shortcut: 'readonly' blocks mutating tools for this run.
    if (config.toolPolicy === 'readonly') {
      for (const t of ['apply_patch', 'deploy_preview']) {
        if (!runtimeState.policy.blockedTools.includes(t)) runtimeState.policy.blockedTools.push(t);
      }
    }

    // One authoritative resolved config per run (process -> runtime -> run).
    const resolved = resolveRunConfig({
      processDefaults: {
        maxSteps: this.config.maxSteps,
        defaultBudgetUsd: this.config.defaultBudgetUsd ?? 0.5,
        runTimeoutMs: this.config.runTimeoutMs,
        maxToolCalls: this.config.maxToolCalls,
        maxRetries: this.config.maxRetries,
        defaultMaxContextTokens: this.config.defaultMaxContextTokens,
        provider: this.config.provider,
      },
      runtimeDefaults: this.runtimeDefaults || {},
      overrides: {
        maxSteps: config.maxSteps,
        budget: config.maxCost ?? config.budget,
        runTimeoutMs: config.runTimeoutMs,
        maxToolCalls: config.maxToolCalls,
        maxRetries: config.maxRetries,
        maxLatencyMs: config.maxLatencyMs,
        maxContextTokens: config.maxContextTokens,
        provider: config.provider,
      },
    });
    // Resolved budget/timeout win over the raw constructor values.
    runtimeState.budget.maximumCost = resolved.budgetUsd;
    if (resolved.maxContextTokens) {
      runtimeState.context.maximumTokens = resolved.maxContextTokens;
      runtimeState.context.tokenBudget = resolved.maxContextTokens;
    }

    this.activeRuns.set(runtimeState.runId, runtimeState);
    if (typeof eventBus.setPrivacyMode === 'function') {
      eventBus.setPrivacyMode(runtimeState.runId, runtimeState.privacyMode);
    }
    const ctrlRecord = {
      policyEngine: new PolicyEngine(runtimeState.policy, this.config),
      machine: new StateMachine(TaskStatus.CREATED),
      abort: false,
      abortController: new AbortController(),
      running: false,
      startedAt: Date.now(),
      deadlineTimer: null,
      mode: config.mode || this.config.mode,
      providerId: resolved.provider,
      providerModel: null, // resolved model definition for the active model
      messages: [],
      history: [], // provider conversation turns [{role, content, name?}]
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
      // Last known tool side-effect state for crash recovery. Updated around
      // every tool dispatch: in_flight -> completed | failed. Consulted with
      // idempotency records by RecoveryService before any retry resumes.
      lastToolEffect: null,
      toolRiskCache: new Map(),
      // Synchronous re-entry guard: two concurrent retry/cancel paths must
      // never resurrect or duplicate the same run.
      recoveryInProgress: false,
    };
    this.runControl.set(runtimeState.runId, ctrlRecord);
    attachRunConfig(ctrlRecord, resolved);

    // Snapshot current registry pricing into runtime knowledge.
    if (this.modelRegistry && typeof this.modelRegistry.getModels === 'function') {
      try {
        const models = await this.modelRegistry.getModels();
        for (const m of models) {
          runtimeState.model.setPricing(m.id, { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k, cachedPer1k: m.cachedPer1k });
        }
        if (runtimeState.referenceModelId && typeof this.modelRegistry.getPricing === 'function') {
          const referencePricing = this.modelRegistry.getPricing(runtimeState.referenceModelId);
          if (referencePricing) runtimeState.referencePricingSnapshot = { ...referencePricing, capturedAt: now() };
        }
      } catch { /* registry unavailable -> routing will report honestly */ }
    }

    this._emit(runtimeState.runId, EventType.TASK_CREATED, {
      runId: runtimeState.runId,
      title: runtimeState.task.objective,
      taskType: runtimeState.task.taskType,
    });

    this.telemetry.recordEvent(runtimeState.runId, new TelemetryEvent(
      runtimeState.runId, EventType.TASK_CREATED,
      { runId: runtimeState.runId, title: runtimeState.task.objective },
      { status: 'success' }
    ));

    this.log.info('run created', { runId: runtimeState.runId, taskType: runtimeState.task.taskType, mode: this.config.mode });
    return runtimeState;
  }

  // ---------- run fork / duplicate (Session 5) ----------

  async forkRun(runId) {
    const src = this.activeRuns.get(runId);
    if (!src) throw Object.assign(new Error(`Run ${runId} not found`), { code: 'not_found' });
    if (TERMINAL.has(src.status)) throw Object.assign(new Error(`Cannot fork a terminal run (${src.status})`), { code: 'terminal' });

    // Build a new run config from the source, preserving key settings.
    const newConfig = {
      mode: src.config.mode || this.config.mode,
      provider: src.config.provider,
      taskMode: src.config.taskType || 'general',
      maxSteps: src.config.maxSteps,
      maxToolCalls: src.config.maxToolCalls,
      maxRetries: src.config.maxRetries,
      defaultBudgetUsd: src.config.defaultBudgetUsd,
      defaultMaxContextTokens: src.config.defaultMaxContextTokens,
      runTimeoutMs: src.config.runTimeoutMs,
      optimizationInterval: this.config.optimizationInterval,
      maxToolCallsTotal: this.config.maxToolCallsTotal,
      contextCompressionThreshold: this.config.contextCompressionThreshold,
      budgetWarningThreshold: this.config.budgetWarningThreshold,
    };

    const title = `Fork of ${src.task.objective}`.slice(0, 200);
    const forkConfig = {
      title,
      taskMode: newConfig.taskMode,
      budget: newConfig.defaultBudgetUsd,
      maxCost: newConfig.defaultBudgetUsd,
      maxLatencyMs: newConfig.runTimeoutMs,
      maxContextTokens: newConfig.defaultMaxContextTokens,
      policy: {
        allowSwitching: src.policy.allowSwitching ?? newConfig.allowSwitching ?? this.config.allowSwitching ?? true,
        allowCompaction: src.policy.allowCompaction ?? newConfig.allowCompaction ?? this.config.allowCompaction ?? true,
        qualityFloor: src.policy.qualityFloor,
        latencyTargetMs: src.policy.latencyTargetMs,
        hardBudget: src.policy.hardBudget,
      },
      tools: [],
      memory: {
        working: src.memory.working.length ? src.memory.working.slice(0, 20) : [],
        longterm: src.memory.longterm.length ? src.memory.longterm.slice(0, 50) : [],
      },
    };

    // Clear transient per-run state that shouldn't cross fork boundaries.
    const runtimeState = new RuntimeState(forkConfig.title, forkConfig);
    runtimeState.task.taskType = newConfig.taskMode;
    runtimeState.task.objective = src.task.objective;
    runtimeState.status = TaskStatus.CREATED;
    runtimeState.updatedAt = new Date().toISOString();

    // Copy over model pricing from the source registry.
    if (this.modelRegistry && typeof this.modelRegistry.getModels === 'function') {
      try {
        const models = await this.modelRegistry.getModels();
        for (const m of models) {
          runtimeState.model.setPricing(m.id, { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k, cachedPer1k: m.cachedPer1k });
        }
      } catch { /* best-effort */ }
    }

    // Preserve the active model if it still exists in the registry.
    if (src.model.currentModel) {
      const def = this.modelRegistry?.getModels?.()?.find((m) => m.id === src.model.currentModel);
      if (def) {
        runtimeState.model.setCurrentModel(src.model.currentModel, def.provider || null, 'Forked from parent run');
        runtimeState.model.modelContextLimit = def?.contextWindow || 0;
        runtimeState.model.setPricing(def.id, { inputPer1k: def.inputPer1k, outputPer1k: def.outputPer1k, cachedPer1k: def.cachedPer1k });
      }
    }

    this.activeRuns.set(runtimeState.runId, runtimeState);
    if (typeof eventBus.setPrivacyMode === 'function') {
      eventBus.setPrivacyMode(runtimeState.runId, runtimeState.privacyMode);
    }
    const ctrlRecord = {
      policyEngine: new PolicyEngine(runtimeState.policy, this.config),
      machine: new StateMachine(TaskStatus.CREATED),
      abort: false,
      abortController: new AbortController(),
      running: false,
      startedAt: Date.now(),
      deadlineTimer: null,
      mode: newConfig.mode || this.config.mode,
      providerId: newConfig.provider,
      providerModel: null,
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
    this.runControl.set(runtimeState.runId, ctrlRecord);

    this._emit(runtimeState.runId, EventType.TASK_CREATED, {
      runId: runtimeState.runId,
      title: runtimeState.task.objective,
      taskType: runtimeState.task.taskType,
    });

    this.telemetry.recordEvent(runtimeState.runId, new TelemetryEvent(
      runtimeState.runId, EventType.TASK_CREATED,
      { runId: runtimeState.runId, title: runtimeState.task.objective },
      { status: 'success' }
    ));

    this.log.info('run forked', { runId: runtimeState.runId, sourceRunId: runId });
    return runtimeState.runId;
  }

  async duplicateRun(runId) {
    const src = this.activeRuns.get(runId);
    if (!src) throw Object.assign(new Error(`Run ${runId} not found`), { code: 'not_found' });
    if (TERMINAL.has(src.status)) throw Object.assign(new Error(`Cannot duplicate a terminal run (${src.status})`), { code: 'terminal' });

    // Build a new run config from the source, preserving key settings.
    const newConfig = {
      mode: src.config.mode || this.config.mode,
      provider: src.config.provider,
      taskMode: src.config.taskType || 'general',
      maxSteps: src.config.maxSteps,
      maxToolCalls: src.config.maxToolCalls,
      maxRetries: src.config.maxRetries,
      defaultBudgetUsd: src.config.defaultBudgetUsd,
      defaultMaxContextTokens: src.config.defaultMaxContextTokens,
      runTimeoutMs: src.config.runTimeoutMs,
      optimizationInterval: this.config.optimizationInterval,
      maxToolCallsTotal: this.config.maxToolCallsTotal,
      contextCompressionThreshold: this.config.contextCompressionThreshold,
      budgetWarningThreshold: this.config.budgetWarningThreshold,
    };

    const title = `Duplicate of ${src.task.objective}`.slice(0, 200);
    const dupConfig = {
      title,
      taskMode: newConfig.taskMode,
      budget: newConfig.defaultBudgetUsd,
      maxCost: newConfig.defaultBudgetUsd,
      maxLatencyMs: newConfig.runTimeoutMs,
      maxContextTokens: newConfig.defaultMaxContextTokens,
      policy: {
        allowSwitching: src.policy.allowSwitching ?? newConfig.allowSwitching ?? this.config.allowSwitching ?? true,
        allowCompaction: src.policy.allowCompaction ?? newConfig.allowCompaction ?? this.config.allowCompaction ?? true,
        qualityFloor: src.policy.qualityFloor,
        latencyTargetMs: src.policy.latencyTargetMs,
        hardBudget: src.policy.hardBudget,
      },
      tools: [],
      memory: {
        working: src.memory.working.length ? src.memory.working.slice(0, 20) : [],
        longterm: src.memory.longterm.length ? src.memory.longterm.slice(0, 50) : [],
      },
    };

    // Clear transient per-run state that shouldn't cross duplicate boundaries.
    const runtimeState = new RuntimeState(dupConfig.title, dupConfig);
    runtimeState.task.taskType = newConfig.taskMode;
    runtimeState.task.objective = src.task.objective;
    runtimeState.status = TaskStatus.CREATED;
    runtimeState.updatedAt = new Date().toISOString();

    // Copy over model pricing from the source registry.
    if (this.modelRegistry && typeof this.modelRegistry.getModels === 'function') {
      try {
        const models = await this.modelRegistry.getModels();
        for (const m of models) {
          runtimeState.model.setPricing(m.id, { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k, cachedPer1k: m.cachedPer1k });
        }
      } catch { /* best-effort */ }
    }

    // Preserve the active model if it still exists in the registry.
    if (src.model.currentModel) {
      const def = this.modelRegistry?.getModels?.()?.find((m) => m.id === src.model.currentModel);
      if (def) {
        runtimeState.model.setCurrentModel(src.model.currentModel, def.provider || null, 'Duplicated from parent run');
        runtimeState.model.modelContextLimit = def?.contextWindow || 0;
        runtimeState.model.setPricing(def.id, { inputPer1k: def.inputPer1k, outputPer1k: def.outputPer1k, cachedPer1k: def.cachedPer1k });
      }
    }

    this.activeRuns.set(runtimeState.runId, runtimeState);
    if (typeof eventBus.setPrivacyMode === 'function') {
      eventBus.setPrivacyMode(runtimeState.runId, runtimeState.privacyMode);
    }
    const ctrlRecord = {
      policyEngine: new PolicyEngine(runtimeState.policy, this.config),
      machine: new StateMachine(TaskStatus.CREATED),
      abort: false,
      abortController: new AbortController(),
      running: false,
      startedAt: Date.now(),
      deadlineTimer: null,
      mode: newConfig.mode || this.config.mode,
      providerId: newConfig.provider,
      providerModel: null,
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
    this.runControl.set(runtimeState.runId, ctrlRecord);

    this._emit(runtimeState.runId, EventType.TASK_CREATED, {
      runId: runtimeState.runId,
      title: runtimeState.task.objective,
      taskType: runtimeState.task.taskType,
    });

    this.telemetry.recordEvent(runtimeState.runId, new TelemetryEvent(
      runtimeState.runId, EventType.TASK_CREATED,
      { runId: runtimeState.runId, title: runtimeState.task.objective },
      { status: 'success' }
    ));

    this.log.info('run duplicated', { runId: runtimeState.runId, sourceRunId: runId });
    return runtimeState.runId;
  }

  async startRun(runId, userMessage) {
    // Terminal history is checked first so messages to finished runs get a
    // 409 terminal error (not 404) with a clear retry hint.
    if (this.terminalRuns.has(runId)) {
      const term = this.terminalRuns.get(runId);
      const st = term.runtimeState ? term.runtimeState.status : 'terminal';
      const e = new Error(`Run is ${st}; use retry to resume a failed run`);
      e.code = 'terminal';
      throw e;
    }
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) {
      const e = new Error(`Run ${runId} not found`);
      e.code = 'not_found';
      throw e;
    }
    const ctrl = this.liveControl(runId);
    if (!ctrl) {
      const e = new Error(`Run ${runId} has no control record`);
      e.code = 'not_found';
      throw e;
    }
    if (TERMINAL.has(runtimeState.status)) {
      const e = new Error(`Run is ${runtimeState.status}; use retry to resume a failed run`);
      e.code = 'terminal';
      throw e;
    }
    if (ctrl.running) {
      const e = new Error('Run is already executing');
      e.code = 'busy';
      throw e;
    }

    ctrl.running = true;
    ctrl.abort = false;
    ctrl.abortController = new AbortController();
    if (ctrl.machine.getState() === TaskStatus.CREATED) {
      ctrl.triedModels = new Set();
      ctrl.retries = 0;
    }
    ctrl.lastUserMessage = String(userMessage || ctrl.lastUserMessage || runtimeState.task.objective);
    const userText = ctrl.lastUserMessage;
    ctrl.messages.push({ id: generateId('m'), role: 'user', content: userText, ts: now() });
    ctrl.history.push({ role: 'user', content: userText });

    this._armDeadline(runtimeState);

    // Fire-and-forget from the API's perspective; the promise settles the run.
    const done = this._executeRun(runtimeState, userText)
      .catch((error) => this._failRun(runtimeState, error))
      .finally(() => {
        ctrl.running = false;
        this._disarmDeadline(runId);
      });
    // Allow callers (tests) to await completion.
    ctrl.completion = done;
    return runtimeState;
  }

  async waitForCompletion(runId, timeoutMs = 120000) {
    const ctrl = this.control(runId);
    if (!ctrl || !ctrl.completion) {
      // Retired runs have no pending completion; return their terminal state.
      // Queue-scheduled starts may land a few ms after the HTTP 202: when the
      // run is active but non-terminal with no completion yet, poll briefly
      // for the worker's claim instead of returning a stale snapshot.
      const rs = this.getRun(runId);
      const terminal = !rs || ['completed', 'failed', 'cancelled'].includes(String(rs.status));
      if (!ctrl || terminal) return rs;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        const c2 = this.control(runId);
        if ((c2 && c2.completion) || !this.getRun(runId) || ['completed', 'failed', 'cancelled'].includes(String(this.getRun(runId).status))) break;
      }
      const c3 = this.control(runId);
      if (!c3 || !c3.completion) return this.getRun(runId);
      return this.waitForCompletion(runId, timeoutMs);
    }
    let timer = null;
    try {
      await Promise.race([
        ctrl.completion,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('wait timed out')), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.getRun(runId);
  }

  _armDeadline(runtimeState) {
    const ctrl = this.liveControl(runtimeState.runId) || this.control(runtimeState.runId);
    this._disarmDeadline(runtimeState.runId);
    // Per-run timeout is authoritative (ResolvedRunConfig).
    const ms = this.runConfig(runtimeState.runId).timeoutMs ?? this.config.runTimeoutMs;
    if (ms && ms > 0) {
      ctrl.deadlineTimer = setTimeout(() => {
        ctrl.abort = true;
        try { ctrl.abortController.abort(); } catch {}
        this._failRun(runtimeState, Object.assign(new Error(`Run timed out after ${ms}ms`), { code: 'timeout' }));
      }, ms);
      if (ctrl.deadlineTimer.unref) ctrl.deadlineTimer.unref();
    }
  }

  _disarmDeadline(runId) {
    const ctrl = this.control(runId);
    if (ctrl && ctrl.deadlineTimer) {
      clearTimeout(ctrl.deadlineTimer);
      ctrl.deadlineTimer = null;
    }
  }

  // ---------- main agent loop ----------

  async _executeRun(runtimeState, userMessage, opts = {}) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    const t0 = Date.now();
    const resume = !!opts.resume && !!runtimeState.model.currentModel;
    // Recovery cursor: first step to (re)execute. Fresh runs start at 0;
    // resumed runs continue after the last COMPLETED checkpoint step so step
    // numbers (and step-scoped idempotency keys) never reset.
    const startStep = Number.isFinite(opts.startStep) && opts.startStep >= 0 ? Math.floor(opts.startStep) : 0;

    if (resume) {
      // Retry resume: valid state (context, model, history) is preserved, so
      // re-enter at EXECUTING instead of replaying the setup phases.
      this._emit(runId, EventType.PLANNING, { note: 'Resuming from preserved state...' });
      if (ctrl.machine.getState() !== TaskStatus.EXECUTING) {
        this.transition(runtimeState, TaskStatus.EXECUTING);
      }
    } else {
      // Fresh setup — legal from CREATED (new run) or RETRYING (retry with
      // nothing preserved, e.g. failure before model selection).
      if (ctrl.machine.getState() !== TaskStatus.PLANNING) {
        this.transition(runtimeState, TaskStatus.PLANNING);
      }
      this._emit(runId, EventType.TASK_STARTED, { userMessage });
      this._emit(runId, EventType.PLANNING, { note: 'Planning execution...' });
    }

    // Budget pre-check: refuse to start when already exhausted.
    if (runtimeState.budget.isBudgetExceeded()) {
      throw Object.assign(new Error('Budget already exhausted'), { code: 'budget_exceeded' });
    }

    if (!resume) {
      this.transition(runtimeState, TaskStatus.CONTEXT_BUILD);
      await this._buildContext(runtimeState, userMessage);

      this.transition(runtimeState, TaskStatus.MODEL_SELECT);
      await this._selectModel(runtimeState, 'initial selection');

      this.transition(runtimeState, TaskStatus.EXECUTING);
    }

    // Authoritative per-run step budget (ResolvedRunConfig). The global
    // config is only the fallback for runs created before this module.
    syncLegacyMaxSteps(ctrl);
    const maxSteps = this.runConfig(runId).maxSteps;
    let steps = startStep;
    // totalSteps is monotonic across retries: a resumed run never forgets
    // work already accounted for.
    runtimeState.execution.totalSteps = Math.max(runtimeState.execution.totalSteps || 0, steps);
    while (steps < maxSteps) {
      if (ctrl.abort) return this._cancelledRun(runtimeState, 'cancelled during execution');
      if (TERMINAL.has(runtimeState.status)) return runtimeState;
      if (runtimeState.budget.isBudgetExceeded() || runtimeState.budget.isLatencyExceeded()) {
        const switched = await this._handleBudgetExceeded(runtimeState);
        if (!switched) throw Object.assign(new Error('Budget exceeded and no cheaper model available'), { code: 'budget_exceeded' });
        if (ctrl.abort || TERMINAL.has(runtimeState.status)) return runtimeState;
      }

      steps++;
      runtimeState.execution.totalSteps = Math.max(runtimeState.execution.totalSteps || 0, steps);
      const shouldContinue = await this._executeStep(runtimeState, userMessage, steps);
      await this._checkOptimizationTriggers(runtimeState);
      if (!shouldContinue) break;
      if (ctrl.abort) return this._cancelledRun(runtimeState, 'cancelled during execution');
      if (TERMINAL.has(runtimeState.status)) return runtimeState;
    }

    if (!TERMINAL.has(runtimeState.status) && !ctrl.abort) {
      if (steps >= maxSteps) {
        // Step budget hit: complete only if work actually finished, else fail honestly.
        const lastAssistant = [...ctrl.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) await this._completeRun(runtimeState, { summary: lastAssistant.content, note: 'step limit reached' });
        else throw Object.assign(new Error(`Step limit (${maxSteps}) reached without a model response`), { code: 'step_limit' });
      } else {
        await this._completeRun(runtimeState, {});
      }
    }

    ctrl.latency.totalMs = Date.now() - t0;
    return runtimeState;
  }

  async _buildContext(runtimeState, userMessage) {
    const runId = runtimeState.runId;
    // Real sources only: the user message + relevant memory. No canned files.
    const context = await this.contextManager.buildContext(runtimeState.task, runtimeState, runtimeState.policy);
    runtimeState.context = context;

    await this.contextManager.addContext(runtimeState, [{
      kind: 'chat', title: 'User task', source: 'user',
      tokens: await this.contextManager.estimateTokens(userMessage),
      relevance: 1.0, status: 'KEEP', metadata: { text: userMessage.slice(0, 2000) },
    }]);

    if (contentRetentionAllowed(runtimeState) && this.memoryManager) {
      const mem = await this.memoryManager.searchMemory(runtimeState, userMessage, ['working', 'longterm'], 5);
      if (mem.length) {
        await this.contextManager.addContext(runtimeState, mem.slice(0, 3).map((m) => ({
          kind: 'memory', title: m.title, source: m.source || 'memory',
          tokens: Math.ceil(String(m.snippet || '').length / 4) + 20,
          relevance: m.importance || 0.5, status: 'KEEP',
        })));
      }
    }

    this._emit(runId, EventType.CONTEXT_BUILT, {
      usedTokens: context.currentTokens,
      windowTokens: context.maximumTokens,
    });

    this.checkpointManager.createCheckpoint(runId, CheckpointType.CONTEXT_UPDATE, runtimeState.toSnapshot(), {
      stepNumber: runtimeState.execution.currentStep,
    });
  }

  async _selectModel(runtimeState, reason = '') {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    const policy = runtimeState.policy;
    const models = await this.modelRegistry.getModels();
    // Live execution requires a provider-native mapping: a candidate without
    // one can never be the model the provider actually runs, so it is
    // excluded here (not silently substituted at request time). Demo mode has
    // no provider-native namespace and is unaffected.
    const liveMode = (ctrl.mode || this.config.mode) === 'live';
    const allowedModels = models.filter((m) =>
      policy.isModelAllowed(m.id) && m.status !== 'unavailable' && (!liveMode || m.nativeId)
    );

    if (allowedModels.length === 0) {
      const unmapped = liveMode ? models.filter((m) => policy.isModelAllowed(m.id) && m.status !== 'unavailable' && !m.nativeId).length : 0;
      throw Object.assign(new Error(unmapped
        ? `No available models: ${unmapped} candidate(s) lack a provider-native mapping for live execution`
        : 'No available models: registry is empty or all models are blocked/unavailable'), { code: 'no_models' });
    }

    // Router context-fit consumes the same canonical PromptPlan: compile it
    // first so needTokens reflects the actual prompt definition (selected
    // context + memory + tools), not a parallel size estimate.
    try {
      let selectionMemory = [];
      try {
        if (contentRetentionAllowed(runtimeState) && this.memoryManager) selectionMemory = await this.memoryManager.searchMemory(runtimeState, runtimeState.task.objective, ['working', 'longterm'], 4);
      } catch { /* advisory */ }
      const selectionTools = await this._providerTools(runtimeState);
      const { plan: selectionPlan } = await this.contextManager.compilePrompt(runtimeState, {
        userMessage: runtimeState.task.objective, stepNumber: 1,
        memoryItems: selectionMemory, toolSpecs: selectionTools, history: [],
      });
      runtimeState.context.currentTokens = Math.max(runtimeState.context.currentTokens, selectionPlan.totalEstimatedTokens);
      ctrl.lastPromptPlan = selectionPlan;
    } catch { /* plan is advisory for selection; router still decides */ }

    const { selectedModel, decision, evaluation } = await this.modelRouter.route(
      runtimeState.task, runtimeState, allowedModels, policy
    );

    const def = allowedModels.find((m) => m.id === selectedModel) || null;
    runtimeState.model.setCurrentModel(selectedModel, def?.provider || null, decision.reason);
    runtimeState.model.candidateModels = evaluation.candidates;
    if (def) {
      runtimeState.model.modelContextLimit = def.contextWindow || 0;
      runtimeState.model.setPricing(def.id, { inputPer1k: def.inputPer1k, outputPer1k: def.outputPer1k, cachedPer1k: def.cachedPer1k });
      ctrl.providerModel = def; // resolved model definition drives execution (never a hard-coded string)
    }

    ctrl.routing = {
      candidates: evaluation.candidates || [],
      decision,
      // Session 2 routing intelligence (additive; consumed by snapshot + API).
      counterfactuals: evaluation.counterfactuals || [],
      explanation: evaluation.explanation || null,
      tradeoff: evaluation.tradeoff || null,
      taskProfile: evaluation.taskProfile || null,
      inputsHash: evaluation.inputsHash || null,
      policyVersion: evaluation.policyVersion || null,
    };
    this._recordDecision(runId, decision);
    this.telemetry.recordMetric(runId, 'routing.candidates', (evaluation.candidates || []).length, { model: selectedModel });

    const env = this._emit(runId, EventType.MODEL_SELECTED, {
      modelId: selectedModel,
      reason: decision.reason,
      factors: decision.factors,
    });
    this._recordChange(runId, 'added', `+ Model selected: ${selectedModel}${reason ? ` (${reason})` : ''}`, env.seq);
    this._emit(runId, EventType.ROUTING_EVALUATED, {
      note: decision.reason,
      candidates: (evaluation.candidates || []).map((c) => c.modelId),
    });

    this.checkpointManager.createCheckpoint(runId, CheckpointType.MODEL_EXECUTION, runtimeState.toSnapshot(), {
      stepNumber: runtimeState.execution.currentStep,
    });
    return { selectedModel, decision, evaluation };
  }

  // One agent step: model call (+ tool loop). Returns false when the run should stop.
  async _executeStep(runtimeState, userMessage, stepNumber) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    runtimeState.execution.startStep({ step: stepNumber, description: `Step ${stepNumber}` });
    const stepT0 = Date.now();
    this._emit(runId, EventType.EXECUTION_STEP_STARTED, { step: stepNumber });

    let modelResult;
    try {
      modelResult = await this._callModel(runtimeState, userMessage, stepNumber);
    } catch (error) {
      runtimeState.execution.failStep(String((error && error.message) || error));
      if (ctrl.abort) return false;
      // Context exhaustion never retries the same model: fail over once to a
      // larger-context healthy model, then continue the step.
      if (error && error.code === 'context_exhausted') {
        const fb = await this._failoverLargerContext(runtimeState);
        if (fb) {
          runtimeState.execution.recordRetry();
          this._emit(runId, EventType.EXECUTION_RETRY, { step: stepNumber, error: error.message, strategy: 'larger-context-failover' });
          return true;
        }
        throw error;
      }
      // Provider errors with a viable alternative: fail over to an untried
      // healthy model first (each candidate tried once per run — no A->B->A
      // loops), then bounded same-model retry with backoff, then honest
      // failure. Model-access failures (model_unavailable: the provider will
      // not serve this model id/tier) ALWAYS fail over when policy allows and
      // NEVER retry the same model — repeating the identical request cannot
      // succeed. Only transient (retryable) errors use same-model backoff.
      // model_resolution (no provider-native mapping) fails over the same
      // way but never marks the registry: it is a configuration gap, not a
      // provider availability fact.
      const failoverEligible = error instanceof ProviderError && (error.retryable || error.code === 'model_unavailable' || error.code === 'model_resolution');
      if (failoverEligible) {
        const failedModel = runtimeState.model.currentModel;
        ctrl.triedModels.add(failedModel);
        this._emit(runId, EventType.MODEL_UNAVAILABLE, { modelId: failedModel, code: error.code });
        if (error.code === 'model_unavailable') {
          // Record request-time availability so routing excludes this model
          // for the rest of the process (registry is per-process memory).
          // This is a deliberate provider-authoritative state change, not the
          // observation counter (which by contract never auto-marks
          // unavailable for transient failures).
          await this._markModelUnavailable(failedModel, error);
        }
        const fb = await this._failover(runtimeState, `${error.code} on ${failedModel}`, ctrl.triedModels);
        if (fb) {
          runtimeState.execution.recordRetry();
          this._emit(runId, EventType.EXECUTION_RETRY, { step: stepNumber, error: error.message, strategy: 'failover' });
          return true;
        }
        if (error.code === 'model_unavailable') {
          const provider = (ctrl.providerModel && ctrl.providerModel.provider) || ctrl.providerId || 'provider';
          throw Object.assign(
            new Error(`Model '${failedModel}' is not accessible via ${provider} (${String(error.message).slice(0, 200)}) and no viable alternative models remain`),
            { code: 'model_unavailable' }
          );
        }
        if (ctrl.retries < this.runConfig(runId).maxRetries) {
          ctrl.retries++;
          const backoff = Math.min(5000, 500 * 2 ** (ctrl.retries - 1));
          this._emit(runId, EventType.EXECUTION_RETRY, { step: stepNumber, error: error.message, attempt: ctrl.retries, backoffMs: backoff, strategy: 'backoff' });
          await new Promise((r) => setTimeout(r, backoff));
          if (ctrl.abort) return false;
          runtimeState.execution.recordRetry();
          return true;
        }
      }
      throw error;
    }

    // Tool-call loop (bounded): validate -> execute -> context -> continue.
    let guard = 0;
    while (modelResult.toolCalls && modelResult.toolCalls.length && guard < 4) {
      guard++;
      if (ctrl.abort) return false;
      if (ctrl.toolCalls >= this.runConfig(runId).maxToolCalls) {
        throw Object.assign(new Error('Tool call budget exhausted'), { code: 'tool_budget' });
      }
      const calls = modelResult.toolCalls.slice(0, 3);
      // Preserve the provider conversation contract: Anthropic requires the
      // assistant tool_use turn immediately before user tool_result blocks;
      // OpenAI-compatible providers also rely on this pairing on continuation.
      ctrl.history.push({
        role: 'assistant', content: modelResult.text || '',
        tool_calls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments || {} })),
      });
      this.transition(runtimeState, TaskStatus.WAITING_FOR_TOOL);
      for (const call of calls) {
        this._emit(runId, EventType.TOOL_SELECTED, { tool: call.name, detail: `Model requested ${call.name}` });
      }
      const results = [];
      for (const call of calls) {
        ctrl.toolCalls++;
        const toolKey = this.toolExecutor.idempotencyKeyFor
          ? this.toolExecutor.idempotencyKeyFor(runId, call.name, call.arguments || {}, stepNumber)
          : undefined;
        await this._markToolInFlight(runtimeState, call.name, toolKey, stepNumber);
        const res = await this.toolExecutor.execute(call.name, call.arguments || {}, runtimeState, {
          signal: ctrl.abortController.signal,
          idempotencyKey: toolKey,
        });
        this._markToolSettled(runtimeState, !!res.success, res.success ? null : (res.code || res.errorCode || null));
        results.push({ call, res });
        const evidence = res.success
          ? summarizeToolResult(res.result).slice(0, 600)
          : `ERROR: ${String(res.error || 'tool failed').slice(0, 400)}`;
        ctrl.history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: evidence });
        // Tool result -> context (real path) and -> working memory.
        await this.contextManager.addContext(runtimeState, [{
          kind: 'tool_result', title: `${call.name} result`, source: `tool:${call.name}`,
          tokens: Math.ceil(evidence.length / 4) + 20,
          metadata: { text: evidence, sourceKind: 'compact_evidence' },
          relevance: 0.9, status: 'KEEP',
        }]);
        if (contentRetentionAllowed(runtimeState) && this.memoryManager && res.success) {
          await this.memoryManager.writeWorkingMemory(runtimeState, {
            title: `${call.name} result (step ${stepNumber})`,
            snippet: summarizeToolResult(res.result).slice(0, 500),
            source: `tool:${call.name}`,
            importance: 0.7, confidence: 0.8,
          });
        }
        // TOOL_COMPLETED/TOOL_FAILED events are emitted by the executor itself.
      }
      this.toObserving(runtimeState);
      this._emit(runId, EventType.EXECUTION_STEP_COMPLETED, { step: stepNumber, tools: calls.map((c) => c.name) });
      this.transition(runtimeState, TaskStatus.EXECUTING);
      // Continue the model with tool observations in context.
      modelResult = await this._callModel(runtimeState, userMessage, stepNumber, true);
    }

    // Heuristic single tool assist (only when the provider used no tools and the
    // task text clearly suggests one). Keeps coding tasks working with providers
    // that lack function calling. Runs at most once per run. Never during abort.
    if (ctrl.abort) {
      runtimeState.execution.completeStep({ cancelled: true });
      return false;
    }
    if ((!modelResult.toolCalls || !modelResult.toolCalls.length) && !ctrl.heuristicToolUsed && stepNumber <= 2) {
      const assist = this._heuristicToolCall(userMessage, ctrl);
      if (assist) {
        ctrl.heuristicToolUsed = true;
        this.transition(runtimeState, TaskStatus.WAITING_FOR_TOOL);
        this._emit(runId, EventType.TOOL_SELECTED, { tool: assist.toolName, detail: 'Heuristic assist (provider returned no tool calls)' });
        ctrl.toolCalls++;
        const heuristicCallId = `heuristic-${stepNumber}`;
        ctrl.history.push({ role: 'assistant', content: modelResult.text || '', tool_calls: [{ id: heuristicCallId, name: assist.toolName, arguments: assist.params }] });
        await this._markToolInFlight(runtimeState, assist.toolName, null, stepNumber);
        const res = await this.toolExecutor.execute(assist.toolName, assist.params, runtimeState, {
          signal: ctrl.abortController.signal,
        });
        this._markToolSettled(runtimeState, !!res.success, res.success ? null : (res.code || res.errorCode || null));
        const evidence = res.success
          ? summarizeToolResult(res.result).slice(0, 600)
          : `ERROR: ${String(res.error || 'tool failed').slice(0, 400)}`;
        ctrl.history.push({ role: 'tool', tool_call_id: heuristicCallId, name: assist.toolName, content: evidence });
        await this.contextManager.addContext(runtimeState, [{
          kind: 'tool_result', title: `${assist.toolName} result`, source: `tool:${assist.toolName}`,
          tokens: Math.ceil(evidence.length / 4) + 20,
          metadata: { text: evidence, sourceKind: 'compact_evidence' },
          relevance: 0.85, status: 'KEEP',
        }]);
        this.toObserving(runtimeState);
        this.transition(runtimeState, TaskStatus.EXECUTING);
        modelResult = await this._callModel(runtimeState, userMessage, stepNumber, true);
      }
    }

    this.toObserving(runtimeState);
    runtimeState.execution.completeStep({ text: (modelResult.text || '').slice(0, 500), tools: ctrl.toolCalls });
    const stepMs = Date.now() - stepT0;
    ctrl.latency.currentStepMs = stepMs;

    ctrl.messages.push({ id: generateId('m'), role: 'assistant', content: modelResult.text || '', ts: now() });
    ctrl.history.push({ role: 'assistant', content: modelResult.text || '' });
    this._emit(runId, EventType.RESPONSE_DONE, { full: modelResult.text || '' });

    // Completion contract: final text + no pending required actions.
    const completion = this._evaluateCompletion(runtimeState, modelResult);
    // Resume-grade checkpoint: runtime snapshot + control snapshot, marked
    // completed, integrity-sealed. Recovery resumes from the newest one.
    this.recoveryService.captureCheckpoint(runtimeState, ctrl, CheckpointType.STEP_COMPLETE, {
      stepNumber,
      result: { step: stepNumber },
    });
    // Best-effort durable snapshot so a process crash loses at most the
    // in-flight step. Failures here never fail the run (advisory).
    if (typeof this.persistHook === 'function') {
      try { await this.persistHook(runtimeState.runId); } catch (e) {
        this.log.warn('post-checkpoint persist failed', { runId, error: String((e && e.message) || e).slice(0, 160) });
      }
    }

    // Durable memory: explicit durable facts -> long-term, else working summary.
    if (contentRetentionAllowed(runtimeState) && this.memoryManager && modelResult.text) {
      if (/(remember|preference|always|never|convention)\s*:/i.test(modelResult.text)) {
        await this.memoryManager.writeLongTermMemory(runtimeState, {
          title: `Durable fact (step ${stepNumber})`, snippet: modelResult.text.slice(0, 500),
          source: `model:${runtimeState.model.currentModel}`, importance: 0.8, confidence: 0.7,
        });
      }
    }

    if (completion.complete) {
      await this._completeRun(runtimeState, completion);
      return false;
    }
    this.transition(runtimeState, TaskStatus.EXECUTING);
    return true;
  }

  _heuristicToolCall(userMessage, ctrl) {
    const text = String(userMessage || '');
    if (/test|fail|bug|spec|broken/i.test(text)) return { toolName: 'run_tests', params: { suite: 'session' } };
    const m = text.match(/[\w\-./]+\.(ts|tsx|js|jsx|json|md|py|go|rs)/);
    if (/read|file|inspect|open|look at/i.test(text) && m) return { toolName: 'read_file', params: { path: m[0] } };
    if (/search|find|where|locate|grep/i.test(text)) return { toolName: 'search_code', params: { query: text.slice(0, 120) } };
    return null;
  }

  _evaluateCompletion(runtimeState, modelResult) {
    const ctrl = this.control(runtimeState.runId);
    const failedTools = (runtimeState.tools.recentToolCalls || []).filter((c) => c && c.success === false);
    const unresolved = failedTools.length > 0 && !/complete|done|no further|finished/i.test(modelResult.text || '');
    if (unresolved) {
      return { complete: false, reason: 'tool failures unresolved' };
    }
    if (modelResult.toolCalls && modelResult.toolCalls.length) {
      return { complete: false, reason: 'pending tool calls' };
    }
    if (!modelResult.text || !modelResult.text.trim()) {
      return { complete: false, reason: 'empty model response' };
    }
    return {
      complete: true,
      summary: modelResult.text,
      evidence: {
        modelResponse: true,
        toolCalls: ctrl.toolCalls,
        toolFailures: failedTools.length,
        steps: runtimeState.execution.currentStep,
      },
    };
  }

  // The model request receives the ContextManager's output — never a prompt
  // invented inside the execution engine.
  async _callProvider(adapter, request, ctrl, runId) {
    // Live adapters expose native SSE. DEMO and injected test adapters use the
    // normalized complete() contract; their response is emitted as one
    // honest event rather than pretending a completed response was streamed.
    if (ctrl.mode === 'live' && typeof adapter.stream === 'function') {
      let final = null;
      for await (const part of adapter.stream(request)) {
        if (part && part.delta) this._emit(runId, EventType.RESPONSE_DELTA, { delta: part.delta, provider: adapter.providerId, nativeStream: true });
        if (part && part.done) final = part;
      }
      if (final) return final;
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, latencyMs: 0 };
    }
    const response = await adapter.complete(request);
    if (response && response.text) this._emit(runId, EventType.RESPONSE_DELTA, { delta: response.text, provider: adapter.providerId, nativeStream: false });
    return response;
  }

  async _callModel(runtimeState, userMessage, stepNumber, continuation = false) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    if (ctrl.abort) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

    const modelId0 = runtimeState.model.currentModel;
    let def = ctrl.providerModel || await this.modelRegistry.getModel(modelId0);
    let modelId = modelId0;
    if (!def) throw Object.assign(new Error(`Model ${modelId} not found in registry`), { code: 'no_models' });
    // No native provider model ID -> never silently substitute another model
    // (e.g. the provider default) while reporting the selected id. Live-only
    // guard: demo mode has no provider-native namespace.
    if (!def.nativeId && ctrl.mode === 'live') {
      throw Object.assign(
        new Error(`Model '${modelId}' has no provider-native mapping for live execution; refusing to substitute another model`),
        { code: 'model_resolution' }
      );
    }

    // Single canonical source: PromptPlan. promptTokens, the cache key and
    // the fingerprint all derive from the plan — never from a parallel
    // message-size summation. Counts are ESTIMATES (length/4); observed
    // provider usage below stays authoritative for cost.
    let built = await this._buildPrompt(runtimeState, userMessage, stepNumber);
    let messages = built.messages;
    let plan = built.plan;
    let promptTokens = plan.totalEstimatedTokens;
    ctrl.lastPromptPlan = plan;

    // Context-limit guard BEFORE any provider call: never send a request the
    // model cannot hold. Try one compression pass, then fail honestly so the
    // step can fail over to a larger-context model instead of erroring at the
    // provider.
    const window = def.contextWindow || runtimeState.context.maximumTokens || 0;
    if (window > 0 && promptTokens > window) {
      let reclaimed = 0;
      try {
        const c = await this.contextManager.compressContext(runtimeState, Math.floor(window * 0.5), runtimeState.policy);
        reclaimed = (c && c.reclaimed) || 0;
      } catch {}
      built = await this._buildPrompt(runtimeState, userMessage, stepNumber);
      messages = built.messages;
      plan = built.plan;
      promptTokens = plan.totalEstimatedTokens;
      ctrl.lastPromptPlan = plan;
      if (promptTokens > window) {
        throw Object.assign(
          new Error(`Prompt (${promptTokens} tokens) exceeds ${modelId} context window (${window})`),
          { code: 'context_exhausted' }
        );
      }
      if (reclaimed > 0) {
        this._emit(runId, EventType.CONTEXT_COMPRESSED, { reclaimedTokens: reclaimed, reason: 'pre-call fit' });
      }
    }

    // Budget guard during execution (loop-top checks alone cannot catch
    // mid-step overspend after tool calls). Uses the SAME cheaper-model
    // handling as the loop-top path so `budget.exceeded` is always surfaced
    // and a cheaper model gets one chance before honest failure.
    if (runtimeState.budget.isBudgetExceeded() || runtimeState.budget.isLatencyExceeded()) {
      const switched = await this._handleBudgetExceeded(runtimeState);
      if (!switched) {
        throw Object.assign(new Error('Budget exceeded before provider call'), { code: 'budget_exceeded' });
      }
      modelId = runtimeState.model.currentModel;
      const refreshed = ctrl.providerModel || await this.modelRegistry.getModel(modelId);
      if (!refreshed) throw Object.assign(new Error(`Model ${modelId} not found in registry`), { code: 'no_models' });
      def = refreshed;
      // The failover model may have a smaller window; re-verify the fit.
      const window2 = def.contextWindow || 0;
      if (window2 > 0 && promptTokens > window2) {
        throw Object.assign(
          new Error(`Prompt (${promptTokens} tokens) exceeds ${modelId} context window (${window2}) after budget failover`),
          { code: 'context_exhausted' }
        );
      }
    }

    ctrl.lastPromptTokens = promptTokens;
    runtimeState.context.currentTokens = Math.max(runtimeState.context.currentTokens, promptTokens);
    runtimeState.context.setCacheablePrefix(promptTokens);

    // Real response cache (run-namespaced). Hits are genuine replays. The key
    // derives from the canonical plan (fingerprint + history + model +
    // provider) — the same logical prompt always maps to the same key.
    const historyHash = require('crypto').createHash('sha256')
      .update(JSON.stringify((messages || []).filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`))).digest('hex').slice(0, 16);
    const cacheKey = this.cacheManager.scopedKey(runId, `prompt:${require('crypto').createHash('sha256').update(JSON.stringify({ p: ctrl.providerId, m: modelId, fp: plan.fingerprint, h: historyHash })).digest('hex')}`);
    const cached = contentRetentionAllowed(runtimeState) && this.cacheManager
      ? await this.cacheManager.get(cacheKey, runId) : { hit: false, value: null };
    if (cached.hit && cached.value && cached.value.text) {
      runtimeState.addModelCall(createModelCallRecord({
        runId, step: stepNumber, provider: def.provider, model: modelId,
        providerCall: false, cacheType: 'local_response', plan,
        pricingSnapshot: this.modelRegistry.getPricing(modelId), latencyMs: 0,
      }));
      this.telemetry.recordCacheEvent(runId, EventType.CACHE_HIT, true, promptTokens, { key: 'prompt-cache' });
      this._emit(runId, EventType.CACHE_HIT, { detail: 'Repeated prompt served from local response cache', providerCall: false, providerCostUsd: 0 });
      this._recordCacheRecent(runId, 'cache.hit', 'Repeated prompt served from response cache');
      // A local response-cache hit never reaches a provider. Keep the audit
      // category visible with a zero amount for compatibility, but never add
      // fictitious provider usage or cost to the run budget.
      runtimeState.budget.addCost(CostCategory.CACHED_INPUT_TOKENS, 0, { cached: true, local: true, providerCall: false });
      this._emitCost(runtimeState);
      this._pushSeries(runtimeState, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, latencyMs: 0 });
      if (this.modelRegistry && typeof this.modelRegistry.recordObservation === 'function') {
        try { this.modelRegistry.recordObservation(modelId, { success: true, latencyMs: 0, cached: true }); } catch {}
      }
      return { ...cached.value, fromCache: true };
    }

    const adapter = this.providerRegistry
      ? this.providerRegistry.resolveForRun(ctrl.mode, ctrl.providerId, runtimeState.orgId || runtimeState.ownerId || 'default')
      : null;
    if (!adapter) throw new Error('No provider registry configured');

    const tools = await this._providerTools(runtimeState);
    const toolNamesForCache = tools.map((t) => (t.function && t.function.name) || t.name).filter(Boolean);

    // L3 semantic reuse (existing SemanticCacheIndex via cacheManager):
    //   TASK + CONTEXT FINGERPRINT -> validate -> reuse | miss -> execute.
    // Gates enforced by the index (similarity, freshness, fingerprint, tool
    // compatibility) plus caller-side gates (same model served it, not this
    // run's own entry). Fresh steps only: in-step continuations after tool
    // results always execute fresh. Similarity here is lexical, not
    // embeddings — conservative thresholds keep it honest.
    if (contentRetentionAllowed(runtimeState) && !continuation && this.cacheManager && typeof this.cacheManager.lookupSemantic === 'function') {
      let sem = null;
      try {
        sem = await this.cacheManager.lookupSemantic({
          taskText: runtimeState.task.objective,
          fingerprint: plan.fingerprint,
          tools: toolNamesForCache,
          runId,
          tenantId: runtimeState.orgId || runtimeState.ownerId || 'default',
          projectId: runtimeState.projectId || null,
        });
      } catch { sem = null; /* semantic cache is advisory; miss on error */ }
      if (sem && sem.hit && sem.result && (typeof sem.result.text === 'string' || (sem.result.toolCalls || []).length)) {
        const modelMismatch = sem.modelUsed && sem.modelUsed !== modelId;
        const ownEntry = sem.runId && sem.runId === runId;
        if (!modelMismatch && !ownEntry) {
          runtimeState.addModelCall(createModelCallRecord({
            runId, step: stepNumber, provider: def.provider, model: modelId,
            providerCall: false, cacheType: 'semantic', plan,
            pricingSnapshot: this.modelRegistry.getPricing(modelId), latencyMs: 0,
          }));
          this.telemetry.recordCacheEvent(runId, EventType.CACHE_HIT, true, promptTokens, { key: 'semantic' });
          this._emit(runId, EventType.CACHE_HIT, {
            detail: `Semantic reuse of "${String(sem.sourceTask || '').slice(0, 80)}" (similarity ${sem.similarity}, freshness ${sem.freshness})`,
            savedUsd: 0, semantic: true, similarity: sem.similarity, freshness: sem.freshness,
          });
          this._recordCacheRecent(runId, 'cache.hit', 'Semantic cache reuse — no provider call');
          this._pushSeries(runtimeState, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, latencyMs: 0 });
          return {
            text: sem.result.text || '',
            toolCalls: sem.result.toolCalls || [],
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            latencyMs: 0,
            complete: false,
            fromSemanticCache: true,
          };
        }
        this._emit(runId, EventType.CACHE_MISS, {
          detail: `Semantic reuse rejected (${modelMismatch ? 'different model served the cached answer' : 'same-run entry'})`,
        });
      }
    }
    const started = Date.now();
    // providerModel = the registry's default for this provider when the routed
    // model ID is a local catalog alias; resolved native ID otherwise.
    const nativeModel = this._nativeModelId(def, adapter);
    let response;
    try {
      response = await this._callProvider(adapter, {
        model: nativeModel,
        messages,
        tools,
        maxTokens: 1024,
        timeoutMs: this.config.providerTimeoutMs || 60000,
        signal: ctrl.abortController.signal,
      }, ctrl, runId);
    } catch (e) {
      // Observed-health hookup: provider outcomes feed the registry so future
      // routing uses real reliability/latency. Transient failures never mark a
      // model permanently unhealthy (see recordObservation).
      if (this.modelRegistry && typeof this.modelRegistry.recordObservation === 'function') {
        try { this.modelRegistry.recordObservation(modelId, { success: false, code: e && e.code }); } catch {}
      }
      throw e;
    }
    const latencyMs = Date.now() - started;

    // Provider usage is authoritative. A missing field stays unknown in the
    // canonical economic record; prompt-plan values are forecasts for budget
    // control only and must never become observed provider usage.
    const usage = response.usage || {};
    const observedInputTokens = Number.isFinite(Number(usage.inputTokens)) && Number(usage.inputTokens) >= 0 ? Number(usage.inputTokens) : null;
    const observedOutputTokens = Number.isFinite(Number(usage.outputTokens)) && Number(usage.outputTokens) >= 0 ? Number(usage.outputTokens) : null;
    const observedCachedTokens = Number.isFinite(Number(usage.cachedTokens)) && Number(usage.cachedTokens) >= 0 ? Number(usage.cachedTokens) : null;
    const observedReasoningTokens = Number.isFinite(Number(usage.reasoningTokens)) && Number(usage.reasoningTokens) >= 0 ? Number(usage.reasoningTokens) : null;
    const inputTokens = observedInputTokens ?? promptTokens;
    const outputTokens = observedOutputTokens ?? 0;
    const cachedTokens = observedCachedTokens ?? 0;

    // ONE authoritative pricing path: registry -> estimator. Categories stay
    // semantic: input / cached input / output / reasoning are distinct; the
    // total is their sum and is NEVER recorded as OUTPUT_TOKENS.
    const reasoningTokens = observedReasoningTokens ?? 0;
    const est = this.costEstimator.estimateModelCost(modelId, def.provider, inputTokens, outputTokens, cachedTokens, { reasoningTokens });
    const providerCostUsd = Number(usage.costUsd ?? response.costUsd);
    const hasProviderCost = Number.isFinite(providerCostUsd) && providerCostUsd >= 0;
    const hasObservedUsage = observedInputTokens !== null && observedOutputTokens !== null;
    const estimateIsPriced = est && est.breakdown && est.breakdown.pricingSource !== 'default';
    // An unpriced fallback estimate must never masquerade as a calculated
    // cost: without observed usage AND registry pricing there is no honest
    // calculated figure, so it stays null (canonical record => unknown).
    const calculatedCostUsd = hasObservedUsage && estimateIsPriced ? est.total : null;
    const usageSource = response.usageSource || (hasObservedUsage ? 'provider_reported' : 'unknown');
    const modelCall = createModelCallRecord({
      runId, step: stepNumber, provider: response.provider || def.provider,
      model: response.model || modelId, requestId: response.requestId,
      providerRequestId: response.requestId, providerMetadata: response.providerMetadata,
      usage: { inputTokens: observedInputTokens, outputTokens: observedOutputTokens, cachedTokens: observedCachedTokens, reasoningTokens: observedReasoningTokens },
      usageSource,
      plan, pricingSnapshot: this.modelRegistry.getPricing(modelId),
      providerCostUsd: hasProviderCost ? providerCostUsd : null,
      calculatedCostUsd,
      latencyMs,
      costSource: hasProviderCost ? 'provider_reported' : !hasObservedUsage || !estimateIsPriced ? 'unknown_estimate' : 'pricing_snapshot',
    });
    runtimeState.addModelCall(modelCall);
    // Honest pricing provenance: token counts are OBSERVED (provider usage),
    // but rates may be registry-unknown fallbacks. Never present a
    // fallback-priced total as precisely metered.
    if (est && est.breakdown && est.breakdown.pricingSource === 'default') ctrl.pricingUnknown = true;
    runtimeState.budget.addCost(CostCategory.INPUT_TOKENS, est[CostCategory.INPUT_TOKENS] || 0, { model: modelId, callId: modelCall.callId });
    runtimeState.budget.addCost(CostCategory.OUTPUT_TOKENS, est[CostCategory.OUTPUT_TOKENS] || 0, { model: modelId, callId: modelCall.callId });
    if (est[CostCategory.CACHED_INPUT_TOKENS]) {
      runtimeState.budget.addCost(CostCategory.CACHED_INPUT_TOKENS, est[CostCategory.CACHED_INPUT_TOKENS], { model: modelId, callId: modelCall.callId });
    }
    if (est.reasoning_tokens) {
      runtimeState.budget.addCost('reasoning_tokens', est.reasoning_tokens, { model: modelId, callId: modelCall.callId });
    }
    // Keep the live budget aligned with the provider's authoritative charge
    // without destroying the token-composition estimate used for explanation.
    // The adjustment is explicit and can be positive or negative.
    if (hasProviderCost) {
      const reconciliation = modelCall.canonicalCostUsd - (modelCall.calculatedCostUsd || 0);
      if (Math.abs(reconciliation) > 0.0000005) {
        runtimeState.budget.addCost('provider_reconciliation', reconciliation, { model: modelId, providerReported: true, callId: modelCall.callId });
      }
    }
    runtimeState.budget.addLatency(latencyMs);
    // Per-category actuals (not total-as-output): keeps cost accuracy honest.
    this.costEstimator.recordActualCost(runId, CostCategory.INPUT_TOKENS, est[CostCategory.INPUT_TOKENS] || 0, est[CostCategory.INPUT_TOKENS] || 0, { model: modelId });
    this.costEstimator.recordActualCost(runId, CostCategory.OUTPUT_TOKENS, est[CostCategory.OUTPUT_TOKENS] || 0, est[CostCategory.OUTPUT_TOKENS] || 0, { model: modelId });
    if (est[CostCategory.CACHED_INPUT_TOKENS]) {
      this.costEstimator.recordActualCost(runId, CostCategory.CACHED_INPUT_TOKENS, est[CostCategory.CACHED_INPUT_TOKENS], est[CostCategory.CACHED_INPUT_TOKENS], { model: modelId });
    }

    ctrl.tokens.input += inputTokens;
    ctrl.tokens.output += outputTokens;
    ctrl.tokens.cached += cachedTokens;

    ctrl.latency.modelMs = latencyMs;
    ctrl.latency.modelSamples.push(latencyMs);
    if (ctrl.latency.modelSamples.length > 40) ctrl.latency.modelSamples.shift();
    ctrl.latency.samples.push(latencyMs);
    if (ctrl.latency.samples.length > 40) ctrl.latency.samples.shift();
    ctrl.latency.avgStepMs = ctrl.latency.samples.reduce((a, b) => a + b, 0) / ctrl.latency.samples.length;

    this.telemetry.recordModelEvent(runId, EventType.RESPONSE_DONE, modelId, def.provider,
      { input: inputTokens, output: outputTokens, cached: cachedTokens }, latencyMs, modelCall.canonicalCostUsd,
      { step: stepNumber, continuation, modelCall });
    this.telemetry.recordMetric(runId, 'model.latency', latencyMs, { model: modelId });
    this.telemetry.recordMetric(runId, 'model.cost', modelCall.canonicalCostUsd, { model: modelId, costSource: modelCall.costSource });
    this._pushSeries(runtimeState, { inputTokens, outputTokens, cachedTokens, cost: modelCall.canonicalCostUsd, estimatedCost: est.total, providerCostUsd: hasProviderCost ? providerCostUsd : null, latencyMs });

    this._emit(runId, EventType.MODEL_CALL_COMPLETED, {
      step: stepNumber, model: modelId, provider: def.provider,
      inputTokens, outputTokens, cachedTokens, reasoningTokens,
      cost: modelCall.canonicalCostUsd, ...(hasProviderCost ? { providerCostUsd } : {}),
      modelCall,
      pricingSource: est.breakdown && est.breakdown.pricingSource,
      latencyMs, continuation,
    });

    this._emit(runId, cachedTokens > 0 ? EventType.CACHE_HIT : EventType.CACHE_MISS, {
      detail: cachedTokens > 0 ? `${cachedTokens} cached tokens reported by provider` : 'Provider call (no prompt caching on this route)',
      ...(cachedTokens > 0 ? { savedUsd: 0 } : {}),
    });
    if (cachedTokens > 0) this._recordCacheRecent(runId, 'cache.hit', `${cachedTokens} cached tokens reported by provider`);
    else this._recordCacheRecent(runId, 'cache.miss', 'Provider call (no prompt caching on this route)');

    this._emitCost(runtimeState);

    if (contentRetentionAllowed(runtimeState) && this.cacheManager) {
      await this.cacheManager.set(cacheKey, {
        text: response.text, toolCalls: response.toolCalls,
        usage: { inputTokens, outputTokens: 0, cachedTokens: 0 },
        model: modelId,
      }, undefined, runId);
    }

    // L3 semantic store: pure answers only (no pending tool calls), so
    // intermediate tool-loop turns are never reused as final answers.
    // A run never serves its own entry (runId gate on lookup).
    if (contentRetentionAllowed(runtimeState) && !continuation && this.cacheManager && typeof this.cacheManager.storeSemantic === 'function'
        && response.text && !(response.toolCalls && response.toolCalls.length)) {
      try {
        await this.cacheManager.storeSemantic(runtimeState.task.objective, {
          text: response.text, toolCalls: [],
          usage: { inputTokens, outputTokens, cachedTokens },
        }, {
          fingerprint: plan.fingerprint, modelId,
          tools: toolNamesForCache, runId,
          tenantId: runtimeState.orgId || runtimeState.ownerId || 'default',
          projectId: runtimeState.projectId || null,
        });
      } catch { /* semantic store is advisory */ }
    }

    runtimeState.model.updateLatency(latencyMs);
    if (this.modelRegistry && typeof this.modelRegistry.recordObservation === 'function') {
      try { this.modelRegistry.recordObservation(modelId, { success: true, latencyMs }); } catch {}
    }
    return {
      text: response.text || '',
      toolCalls: response.toolCalls || [],
      usage: { inputTokens, outputTokens, cachedTokens },
      latencyMs,
      complete: false,
    };
  }

  _nativeModelId(def, adapter) {
    // Registry IDs are catalog aliases. A model reaches the provider API only
    // via its native ID. Live execution of an unmapped model is rejected
    // upstream (model_resolution) — this fallback never silently substitutes
    // the provider default for a reported selection.
    if (def && def.nativeId) return def.nativeId;
    if (adapter && adapter.providerId !== 'demo' && adapter.defaultModel) {
      return adapter.defaultModel;
    }
    return def && def.id;
  }

  async _providerTools(runtimeState) {
    const available = Array.from(runtimeState.tools.availableTools.values())
      .filter((t) => t.status === 'enabled' && runtimeState.policy.isToolAllowed(t.name));
    return available.slice(0, 8).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || t.name).slice(0, 500),
        parameters: t.parameters && t.parameters.type ? t.parameters : { type: 'object', properties: {}, required: [] },
      },
    }));
  }

  // Canonical prompt assembly lives in ContextManager.compilePrompt — this
  // wrapper only gathers live inputs (memory, tools, history) the manager
  // does not own. There is exactly one message-assembly implementation.
  async _buildPrompt(runtimeState, userMessage, stepNumber) {
    let memoryItems = [];
    if (contentRetentionAllowed(runtimeState) && this.memoryManager) {
      try {
        memoryItems = await this.memoryManager.searchMemory(runtimeState, userMessage, ['working', 'longterm'], 4);
      } catch { /* memory is advisory */ }
    }
    const toolSpecs = await this._providerTools(runtimeState);
    const history = (this.control(runtimeState.runId) && this.control(runtimeState.runId).history.slice(-10)) || [];
    return this.contextManager.compilePrompt(runtimeState, {
      userMessage, stepNumber, memoryItems, toolSpecs, history,
    });
  }

  async _buildPromptMessages(runtimeState, userMessage, stepNumber) {
    const { messages } = await this._buildPrompt(runtimeState, userMessage, stepNumber);
    return messages;
  }

  _emitCost(runtimeState, sample = null) {
    const payload = {
      spentUsd: runtimeState.budget.currentSpend,
      projectedUsd: runtimeState.budget.getProjectedTotal(),
    };
    if (sample) {
      const ctrl = this.control(runtimeState.runId);
      const stats = this.cacheManager && this.cacheManager.statsFor
        ? this.cacheManager.statsFor(runtimeState.runId) : { hitRate: 0 };
      payload.sample = {
        t: now(), step: runtimeState.execution.currentStep,
        inputTokens: sample.inputTokens || 0, outputTokens: sample.outputTokens || 0,
        cachedTokens: sample.cachedTokens || 0,
        cost: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
        latencyMs: sample.latencyMs || 0,
        cacheHitRate: Math.round((stats.hitRate || 0) * 1000) / 1000,
        contextUtil: Math.round(runtimeState.context.getUtilization() * 1000) / 1000,
        model: runtimeState.model.currentModel,
      };
    }
    this._emit(runtimeState.runId, EventType.COST_UPDATED, payload);
  }

  _pushSeries(runtimeState, sample) {
    const ctrl = this.control(runtimeState.runId);
    const stats = this.cacheManager && this.cacheManager.statsFor
      ? this.cacheManager.statsFor(runtimeState.runId) : { hitRate: 0 };
    ctrl.series.push({
      t: now(), step: runtimeState.execution.currentStep,
      inputTokens: sample.inputTokens, outputTokens: sample.outputTokens, cachedTokens: sample.cachedTokens,
      // `cost` remains the cumulative run series value for the console;
      // `callCost` is the per-provider-call value used by accounting.
      cost: Math.round((sample.cost ?? runtimeState.budget.currentSpend) * 1e6) / 1e6,
      ...(sample.estimatedCost !== undefined ? { estimatedCost: Math.round(Number(sample.estimatedCost || 0) * 1e6) / 1e6 } : {}),
      cumulativeCost: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
      ...(sample.cost !== undefined ? { callCost: Math.round(Number(sample.cost || 0) * 1e6) / 1e6 } : {}),
      ...(sample.providerCostUsd !== undefined ? { providerCostUsd: sample.providerCostUsd } : {}),
      latencyMs: sample.latencyMs, cacheHitRate: Math.round((stats.hitRate || 0) * 1000) / 1000,
      contextUtil: Math.round(runtimeState.context.getUtilization() * 1000) / 1000,
      model: runtimeState.model.currentModel,
    });
    if (ctrl.series.length > 200) ctrl.series.shift();
  }

  _recordCacheRecent(runId, type, detail) {
    if (this.cacheManager && typeof this.cacheManager._recordRecent === 'function') {
      this.cacheManager._recordRecent(runId, type, detail);
    }
  }

  // ---------- optimization / failover / budget ----------

  async _checkOptimizationTriggers(runtimeState) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    const policyEngine = ctrl.policyEngine;
    const budgetEval = policyEngine.evaluateBudget(runtimeState.budget);
    const latencyEval = policyEngine.evaluateLatency(runtimeState.budget);
    const contextEval = policyEngine.evaluateContext(runtimeState.context);
    const modelEval = policyEngine.evaluateModelHealth(runtimeState.model);

    const triggers = policyEngine.getOptimizationTriggers(budgetEval, latencyEval, contextEval, modelEval);

    for (const trigger of triggers) {
      if (trigger.severity === 'critical') {
        this._emit(runId, EventType.OPTIMIZATION_TRIGGERED, { trigger });
        await this._handleOptimization(runtimeState, trigger);
        this._emit(runId, EventType.OPTIMIZATION_COMPLETED, { trigger });
      }
    }

    if (budgetEval.isWarning && !budgetEval.isExceeded) {
      this._emit(runId, EventType.BUDGET_WARNING, {
        spent: runtimeState.budget.currentSpend,
        budget: runtimeState.budget.maximumCost,
        ratio: budgetEval.ratio,
      });
    }

    if (contextEval.isNearLimit) {
      this._emit(runId, EventType.CONTEXT_LIMIT_WARNING, {
        utilization: contextEval.utilization,
        currentTokens: contextEval.currentTokens,
        maxTokens: contextEval.maxTokens,
      });
      if (runtimeState.policy && runtimeState.policy.allowCompaction === false) {
        this._emit(runId, EventType.OPTIMIZATION_TRIGGERED, {
          trigger: { type: 'context_compaction_skipped', severity: 'info' },
          reason: 'Context compaction disabled for this run — utilization will keep growing',
        });
      } else {
        await this.contextManager.compressContext(runtimeState, Math.floor(runtimeState.context.maximumTokens * 0.6), runtimeState.policy);
      }
    }
  }

  async _handleOptimization(runtimeState, trigger) {
    switch (trigger.type) {
      case 'model_unavailable':
      case 'model_degraded':
        await this._failover(runtimeState, trigger.type);
        break;
      case 'context_critical': {
        const { reclaimed } = await this.contextManager.compressContext(runtimeState, Math.floor(runtimeState.context.maximumTokens * 0.5), runtimeState.policy);
        if (reclaimed <= 0 && runtimeState.context.getUtilization() >= 1) {
          throw Object.assign(new Error('Context budget exhausted and nothing left to compress'), { code: 'context_exhausted' });
        }
        break;
      }
      case 'budget_critical':
        await this._handleBudgetExceeded(runtimeState);
        break;
      default:
        break;
    }
  }

  async _failover(runtimeState, reason, exclude = null) {
    const runId = runtimeState.runId;
    const excluded = new Set(exclude || []);
    excluded.add(runtimeState.model.currentModel);
    const models = await this.modelRegistry.getModels();
    const liveMode = ((this.control(runId) && this.control(runId).mode) || this.config.mode) === 'live';
    const healthyModels = models.filter((m) =>
      m.status === 'healthy' &&
      runtimeState.policy.isModelAllowed(m.id) &&
      !excluded.has(m.id) &&
      (!liveMode || m.nativeId)
    );
    if (healthyModels.length === 0) return false;
    const { selectedModel, decision } = await this.modelRouter.route(
      runtimeState.task, runtimeState, healthyModels, runtimeState.policy
    );
    await this._applyModelSwitch(runtimeState, selectedModel, healthyModels, decision, `Failover: ${reason}`, { force: true });
    return true;
  }

  // Request-time availability: the provider authoritatively refused this
  // model id (unknown, withdrawn, or not served for the current tier/key).
  // Marks the registry so routing excludes it process-wide. Deliberate and
  // explicit — recordObservation() by contract never does this for transient
  // failures. Registry is per-process memory, so the mark resets on restart.
  async _markModelUnavailable(modelId, error) {
    try {
      if (!modelId || !this.modelRegistry || typeof this.modelRegistry.getModel !== 'function') return false;
      const m = await this.modelRegistry.getModel(modelId);
      if (!m || m.status === 'unavailable') return false;
      if (typeof this.modelRegistry.updateModel !== 'function') return false;
      await this.modelRegistry.updateModel(modelId, {
        status: 'unavailable',
        unavailableReason: String((error && error.message) || error || 'model_unavailable').slice(0, 300),
        unavailableAt: now(),
        unavailableCode: (error && error.code) || 'model_unavailable',
        degradedByObserver: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  async _failoverLargerContext(runtimeState) {
    const current = await this.modelRegistry.getModel(runtimeState.model.currentModel);
    const currentWindow = (current && current.contextWindow) || runtimeState.context.maximumTokens || 0;
    const models = await this.modelRegistry.getModels();
    const bigger = models.filter((m) =>
      m.status === 'healthy' &&
      runtimeState.policy.isModelAllowed(m.id) &&
      m.id !== runtimeState.model.currentModel &&
      (m.contextWindow || 0) > currentWindow
    ).sort((a, b) => (a.contextWindow || 0) - (b.contextWindow || 0));
    if (bigger.length === 0) return false;
    const { selectedModel, decision } = await this.modelRouter.route(
      runtimeState.task, runtimeState, bigger.slice(0, 3), runtimeState.policy
    );
    return this._applyModelSwitch(runtimeState, selectedModel, bigger, decision, 'Context overflow: larger window', { force: true });
  }

  // State-aware switch: switching cost accounts for context rebuild, cache
  // loss, token resend, provider overhead, latency, state translation and
  // restart risk (SwitchingCostCalculator). Stickiness prevents A->B->A for
  // optimization switches; failure-driven failover bypasses the cooldown (a
  // dead model cannot be sticky) but still pays and records the cost.
  async _applyModelSwitch(runtimeState, toModelId, candidates, decision, reason, opts = {}) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    const fromModel = runtimeState.model.currentModel;
    const def = (candidates || []).find((m) => (m.id || m.modelId) === toModelId)
      || await this.modelRegistry.getModel(toModelId);
    const provider = def?.provider || def?.provider_id || null;

    const switchingCost = this.switchingCostCalculator.calculate(
      runtimeState.context, runtimeState.model, fromModel, toModelId,
      { toProvider: provider, toModelLatency: def?.avgLatencyMs }
    );
    if (!opts.force) {
      // Benefit was already scored by the router; this gate enforces only
      // cooldown and per-run switch limits (Infinity benefit skips the
      // hysteresis comparison, never the cooldown/count checks).
      const stickiness = this.stickinessManager.canSwitch(runId, fromModel, toModelId, Infinity, switchingCost.total);
      if (!stickiness.allowed && (!decision || decision.decisionType !== DecisionType.FALLBACK)) {
        const env = this._emit(runId, EventType.MODEL_SWITCH_REJECTED, { fromModel, toModel: toModelId, reason: stickiness.reason });
        this._recordChange(runId, 'retained', `→ Switch to ${toModelId} rejected (${stickiness.reason})`, env.seq);
        return false;
      }
    }

    // Invalidate run-scoped prompt cache: a new model cannot reuse it (this is
    // the cache-loss cost, made real instead of theoretical).
    if (this.cacheManager && typeof this.cacheManager.invalidatePrefix === 'function') {
      await this.cacheManager.invalidatePrefix(`${runId}:prompt:`, runId);
    }
    runtimeState.budget.addCost(CostCategory.SWITCHING, switchingCost.total, { fromModel, toModel: toModelId });

    runtimeState.model.setCurrentModel(toModelId, provider, reason);
    if (def) {
      runtimeState.model.setPricing(def.id || toModelId, { inputPer1k: def.inputPer1k, outputPer1k: def.outputPer1k, cachedPer1k: def.cachedPer1k });
      ctrl.providerModel = def.id ? def : { ...def, id: toModelId };
    }
    this.stickinessManager.recordSwitch(runId);
    if (decision) this._recordDecision(runId, decision);

    this.checkpointManager.createCheckpoint(runId, CheckpointType.MODEL_SWITCH, runtimeState.toSnapshot(), {
      stepNumber: runtimeState.execution.currentStep,
    });

    const env = this._emit(runId, EventType.MODEL_SWITCHED, {
      fromModel, toModel: toModelId, fromId: fromModel, toId: toModelId,
      reason, factors: decision?.factors || [], switchingCost: switchingCost.total,
    });
    this._recordChange(runId, 'updated', `↻ Model switched: ${fromModel} -> ${toModelId} (${reason})`, env.seq);
    this._emitCost(runtimeState);
    return true;
  }

  async _handleBudgetExceeded(runtimeState) {
    const runId = runtimeState.runId;
    this._emit(runId, EventType.BUDGET_EXCEEDED, {
      spent: runtimeState.budget.currentSpend,
      budget: runtimeState.budget.maximumCost,
    });
    // Try a cheaper healthy candidate once; otherwise the caller fails honestly.
    const models = await this.modelRegistry.getModels();
    const current = await this.modelRegistry.getModel(runtimeState.model.currentModel);
    const currentOut = current?.outputPer1k ?? Infinity;
    const cheaper = models
      .filter((m) => m.status === 'healthy' && runtimeState.policy.isModelAllowed(m.id)
        && m.id !== runtimeState.model.currentModel && (m.outputPer1k ?? Infinity) < currentOut)
      .sort((a, b) => (a.outputPer1k ?? 0) - (b.outputPer1k ?? 0));
    if (cheaper.length === 0) return false;
    const { selectedModel, decision } = await this.modelRouter.route(
      runtimeState.task, runtimeState, cheaper.slice(0, 3), runtimeState.policy
    );
    return this._applyModelSwitch(runtimeState, selectedModel, cheaper, decision, 'Budget optimization');
  }

  // ---------- price changes during execution ----------

  async handlePriceUpdate(evt = {}) {
    const { modelId, pricing, prev, source } = evt;
    if (!modelId || !pricing) return;
    for (const [runId, runtimeState] of this.activeRuns.entries()) {
      if (TERMINAL.has(runtimeState.status)) continue;
      const ctrl = this.control(runId);
      const usesModel = runtimeState.model.currentModel === modelId ||
        (runtimeState.model.candidateModels || []).some((c) => (c.modelId || c.id) === modelId);
      if (!usesModel) continue;
      // Runtime knowledge updates immediately; history is preserved in the registry.
      runtimeState.model.setPricing(modelId, pricing);
      const env = this._emit(runId, EventType.PRICE_UPDATED, { modelId, pricing, prev, source });
      this._recordChange(runId, 'updated', `↻ Price updated: ${modelId}`, env.seq);
      // Reevaluate WITHOUT auto-switching: late-run progress keeps the current
      // model unless it became unhealthy; early runs get a scored decision.
      const lateRun = runtimeState.execution.currentStep >= 3;
      const currentHealth = (await this.modelRegistry.getModel(modelId))?.status;
      if (lateRun || currentHealth === 'healthy') {
        const decision = this.decisionEngine.createDecision(
          DecisionType.MODEL_RETENTION, `KEEP ${runtimeState.model.currentModel}`,
          `run:${runId}`,
          {
            candidates: runtimeState.model.candidateModels || [],
            selectedCandidate: { modelId: runtimeState.model.currentModel },
            score: 0,
            factors: [
              { key: 'price_change', label: 'Price change observed', status: 'warn', detail: JSON.stringify(pricing).slice(0, 120) },
              { key: 'progress', label: lateRun ? 'Late-run progress preserved' : 'No better candidate after rescore', status: 'pass', detail: `step ${runtimeState.execution.currentStep}` },
            ],
            reason: lateRun
              ? 'Price changed mid-run; preserving progress (no automatic switch on price alone)'
              : 'Reevaluated after price change; current model retained',
            confidence: 0.85,
          }
        );
        this._recordDecision(runId, decision);
        this._emit(runId, EventType.MODEL_RETAINED, { modelId: runtimeState.model.currentModel, reason: decision.reason, factors: [] });
        this._emit(runId, EventType.ROUTING_EVALUATED, { note: `Reevaluated after price change for ${modelId}; retained current model` });
      } else {
        await this._selectModel(runtimeState, `price change for ${modelId}`);
      }
    }
  }

  // ---------- completion / failure / cancellation / retry ----------

  // Lifecycle: CREATED -> RUNNING -> COMPLETED/FAILED/CANCELLED -> PERSISTED
  // -> REMOVED FROM ACTIVE MEMORY. Retirement happens only AFTER the terminal
  // event + snapshot + sink persistence, so replay/history survive.
  _retireRun(runId) {
    const runtimeState = this.activeRuns.get(runId);
    const ctrl = this.runControl.get(runId);
    if (!runtimeState || !ctrl) return;
    // Disarm deadline before moving (no timer firing on retired runs).
    try {
      if (ctrl.deadlineTimer) { clearTimeout(ctrl.deadlineTimer); ctrl.deadlineTimer = null; }
    } catch {}
    ctrl.running = false;
    this.activeRuns.delete(runId);
    this.runControl.delete(runId);
    this.terminalRuns.set(runId, { runtimeState, control: ctrl, endedAt: Date.now(), status: runtimeState.status });
    this.terminalOrder.push(runId);
    // Bounded terminal history (no unbounded memory growth).
    while (this.terminalOrder.length > this.maxTerminalRetained) {
      const oldest = this.terminalOrder.shift();
      if (oldest && this.terminalRuns.has(oldest) && oldest !== runId) {
        this.terminalRuns.delete(oldest);
        // Final eviction clears per-run telemetry/cache/events/checkpoints.
        // Persisted FileStore history remains the durable record.
        try { this.telemetry.clearRun(oldest); } catch {}
        try { if (this.cacheManager && typeof this.cacheManager.clearRun === 'function') this.cacheManager.clearRun(oldest); } catch {}
        try { this.checkpointManager.clearRun(oldest); } catch {}
        // Keep event logs for replay within retention; prune only on overflow.
      }
    }
    // Completed runs must not hold live SSE sockets.
    try { eventBus.closeSubscribers(runId); } catch {}
  }

  async _completeRun(runtimeState, evidence = {}) {
    const runId = runtimeState.runId;
    // Idempotent: multiple terminal transitions collapse to the first.
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
    if (!this.activeRuns.has(runId)) return runtimeState;
    const ctrl = this.liveControl(runId) || this.control(runId);
    // A step may finish in OBSERVING/WAITING_FOR_TOOL; route back explicitly.
    if (runtimeState.status === TaskStatus.OBSERVING || runtimeState.status === TaskStatus.WAITING_FOR_TOOL) {
      this.transition(runtimeState, TaskStatus.EXECUTING);
    }
    this.transition(runtimeState, TaskStatus.COMPLETED);
    runtimeState.task.updateProgress(1);

    this._emit(runId, EventType.RUN_COMPLETED, {
      summary: typeof evidence.summary === 'string' ? evidence.summary.slice(0, 500) : 'Task completed successfully',
      steps: runtimeState.execution.currentStep,
      cost: runtimeState.budget.currentSpend,
      latency: runtimeState.budget.elapsedLatency,
      evidence: evidence.evidence || null,
    });
    this._recordChange(runId, 'retained', '→ Run completed', undefined);

    this.telemetry.recordEvent(runId, new TelemetryEvent(
      runId, EventType.RUN_COMPLETED, { summary: 'Completed' }, { status: 'completed' }
    ));
    // Terminal guarantees: final state -> terminal event -> persistence -> cleanup.
    this._recordRunEnd(runtimeState, TaskStatus.COMPLETED);
    this.log.info('run completed', { runId, steps: runtimeState.execution.currentStep, spent: runtimeState.budget.currentSpend, model: runtimeState.model.currentModel });
    this._retireRun(runId);
    return runtimeState;
  }

  async _failRun(runtimeState, error) {
    const runId = runtimeState ? runtimeState.runId : null;
    if (!runId) return runtimeState;
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
    if (!this.activeRuns.has(runId)) return runtimeState;
    const ctrl = this.liveControl(runId) || this.control(runId);
    // Cancellation wins over failure: if an abort was requested, the run was
    // cancelled — never report it as failed.
    if (ctrl && ctrl.abort) {
      return this._cancelledRun(runtimeState, 'cancel requested');
    }
    const code = (error && error.code) || 'unknown';
    // Invariant budget-caused termination must surface `budget.exceeded`
    // before `run.failed`. Budget failures can originate in several places
    // (pre-check, loop-top guard, mid-step guard, router budget eligibility),
    // and only some of them emit the event inline — so _failRun closes the
    // gap here (once per run) instead of trusting every throw site.
    if (code === 'budget_exceeded' || code === 'budget_constraint') {
      try {
        const log = this.eventBus && this.eventBus.eventLogs
          ? this.eventBus.eventLogs.get(runId) || []
          : [];
        const already = log.some((e) => e && e.type === EventType.BUDGET_EXCEEDED);
        if (!already) {
          this._emit(runId, EventType.BUDGET_EXCEEDED, {
            spent: runtimeState.budget.currentSpend,
            budget: runtimeState.budget.maximumCost,
          });
        }
      } catch {}
    }
    try {
      this.transition(runtimeState, TaskStatus.FAILED);
    } catch (e) {
      // transition() already rejects invalid edges; FAILED is reachable from
      // every active state via the StateMachine, so a throw here means a
      // programming error — record it and force the terminal state explicitly
      // only as a last resort (never silently).
      this.log.warn('failure transition rejected', { runId, from: ctrl?.machine?.getState(), error: String((e && e.message) || e).slice(0, 200) });
      runtimeState.updateStatus(TaskStatus.FAILED);
      try { if (ctrl) ctrl.machine.currentState = TaskStatus.FAILED; } catch {}
    }

    const safe = error instanceof ProviderError ? error.message : String((error && error.message) || error).slice(0, 500);
    this._emit(runId, EventType.RUN_FAILED, {
      error: safe, code,
      steps: runtimeState.execution.currentStep,
      cost: runtimeState.budget.currentSpend,
    });

    this.telemetry.recordEvent(runId, new TelemetryEvent(
      runId, EventType.RUN_FAILED, { error: safe }, { status: 'failed', error: safe }
    ));
    this._recordRunEnd(runtimeState, TaskStatus.FAILED);
    this.log.warn('run failed', { runId, code, error: safe });
    this._retireRun(runId);
    return runtimeState;
  }

  async _cancelledRun(runtimeState, reason) {
    const runId = runtimeState.runId;
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
    if (!this.activeRuns.has(runId)) return runtimeState;
    try { this.transition(runtimeState, TaskStatus.CANCELLED); }
    catch (e) {
      this.log.warn('cancel transition rejected', { runId, error: String((e && e.message) || e).slice(0, 200) });
      runtimeState.updateStatus(TaskStatus.CANCELLED);
      try { const c = this.control(runId); if (c) c.machine.currentState = TaskStatus.CANCELLED; } catch {}
    }
    this._emit(runId, EventType.RUN_CANCELLED, { reason });
    this._recordRunEnd(runtimeState, TaskStatus.CANCELLED);
    this.log.info('run cancelled', { runId, reason });
    this._retireRun(runId);
    return runtimeState;
  }

  async cancelRun(runId, reason = 'User cancelled') {
    if (this.terminalRuns.has(runId)) return false;
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) return false;
    const ctrl = this.liveControl(runId);
    if (!ctrl || TERMINAL.has(runtimeState.status)) return false;

    // Real cancellation: flag the loop, abort in-flight provider/tool calls,
    // clear the deadline — not just a status flip.
    ctrl.abort = true;
    try { ctrl.abortController.abort(); } catch {}
    this._disarmDeadline(runId);
    // Give the loop one tick to observe the flag, then force the state so the
    // UI never waits on background work.
    await new Promise((r) => setTimeout(r, 25));
    if (!TERMINAL.has(runtimeState.status)) {
      await this._cancelledRun(runtimeState, reason);
    }
    ctrl.running = false;
    this.log.info('run cancelled', { runId, reason });
    return true;
  }

  // Last recovery plan per run (diagnostics for API/UI; never throws).
  lastRecoveryPlan(runId) {
    const ctrl = this.control(runId);
    return (ctrl && ctrl.lastRecoveryPlan) || null;
  }

  async retryRun(runId, options = {}) {
    // Synchronous re-entry guard: two concurrent retries of the same run
    // must not resurrect/duplicate it. The flag is set before any await.
    const existingCtrl = this.runControl.get(runId) || (this.terminalRuns.get(runId) || {}).control || null;
    if (existingCtrl && existingCtrl.recoveryInProgress) return false;
    if (existingCtrl) existingCtrl.recoveryInProgress = true;
    try {
      return await this._retryRunInner(runId, options);
    } finally {
      try {
        const c = this.control(runId);
        if (c) c.recoveryInProgress = false;
      } catch {}
    }
  }

  async _retryRunInner(runId, options = {}) {
    // Failed runs retire to history but stay retryable: resurrect to active.
    if (this.terminalRuns.has(runId)) {
      const term = this.terminalRuns.get(runId);
      if (!term || term.status !== TaskStatus.FAILED) return false;
      if (term.runtimeState.budget.isBudgetExceeded()) {
        return false;
      }
      // Resurrect: move back to active with preserved state.
      this.terminalRuns.delete(runId);
      this.terminalOrder = this.terminalOrder.filter((id) => id !== runId);
      this.activeRuns.set(runId, term.runtimeState);
      this.runControl.set(runId, term.control);
    }
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) return false;
    const ctrl = this.liveControl(runId);
    if (!ctrl || runtimeState.status !== TaskStatus.FAILED) return false;
    if (ctrl.running) return false;
    if (runtimeState.budget.isBudgetExceeded()) {
      this._emit(runId, EventType.RUN_FAILED, { error: 'Cannot retry: budget exhausted', code: 'budget_exceeded' });
      return false;
    }

    // ---- Real recovery: validate checkpoint, inspect last side effect,
    // consult idempotency, decide, restore cursor/state. ----
    this._emit(runId, EventType.EXECUTION_RECOVERY_STARTED, { note: 'Evaluating recovery...' });
    const idempotencyStore = (this.toolExecutor && this.toolExecutor.idempotencyStore) || null;
    let recovery;
    try {
      recovery = await this.recoveryService.recover({
        runId,
        runtimeState,
        ctrl,
        idempotencyStore,
        toolRecord: options.toolRecord || null,
        checkpointId: options.checkpointId || null,
      });
    } catch (e) {
      this._emit(runId, EventType.EXECUTION_RECOVERY_BLOCKED, {
        reason: `recovery evaluation failed: ${String((e && e.message) || e).slice(0, 200)}`,
      });
      return false;
    }
    ctrl.lastRecoveryPlan = {
      action: recovery.plan.action,
      reason: recovery.plan.reason,
      cursor: recovery.plan.cursor,
      checkpointId: recovery.checkpoint ? recovery.checkpoint.checkpointId : null,
      at: now(),
    };

    if (recovery.plan.action === 'ask_user' || recovery.plan.action === 'mark_unknown' || recovery.plan.action === 'unrecoverable') {
      // Do NOT re-run blindly. The run stays FAILED (auditable) with a
      // recovery_blocked event explaining exactly what is needed. An
      // operator can resolve the underlying state and retry again.
      this._emit(runId, EventType.EXECUTION_RECOVERY_BLOCKED, {
        action: recovery.plan.action,
        reason: recovery.plan.reason,
        checkpointId: ctrl.lastRecoveryPlan.checkpointId,
      });
      return false;
    }

    const rawCursor = Number.isFinite(recovery.cursor) ? recovery.cursor
      : (Number.isFinite(recovery.plan.cursor) ? recovery.plan.cursor : null);
    // Cursor null (no checkpoint) keeps the preserved live cursor so step
    // numbers and step-scoped idempotency keys stay stable.
    const cursor = rawCursor !== null ? rawCursor : (runtimeState.execution.currentStep || 0);
    const hasModel = !!runtimeState.model.currentModel;
    try {
      this.transition(runtimeState, TaskStatus.RETRYING);
    } catch {
      runtimeState.updateStatus(TaskStatus.RETRYING);
    }
    ctrl.abort = false;
    ctrl.abortController = new AbortController();
    ctrl.retries = 0;
    ctrl.recoveryAttempts = (ctrl.recoveryAttempts || 0) + 1;
    // Clear a stale in-flight marker from the crashed attempt: the plan has
    // already accounted for it (skip => proven completed; retry_step =>
    // safe). Keeping it would mislabel the resumed execution.
    if (ctrl.lastToolEffect && ctrl.lastToolEffect.state === 'in_flight') {
      ctrl.lastToolEffect = { ...ctrl.lastToolEffect, state: 'unknown', note: 'superseded by recovery plan' };
    }
    this._emit(runId, EventType.EXECUTION_RECOVERED, {
      action: recovery.plan.action,
      reason: recovery.plan.reason,
      cursor,
      checkpointId: ctrl.lastRecoveryPlan.checkpointId,
      preservedSpend: runtimeState.budget.currentSpend,
    });
    this._emit(runId, EventType.EXECUTION_RETRY, {
      step: cursor,
      fromCheckpoint: ctrl.lastRecoveryPlan.checkpointId,
      preservedMessages: ctrl.messages.length,
      strategy: hasModel ? 'resume' : 'restart',
      recoveryAction: recovery.plan.action,
    });
    // Entry states are handled by _executeRun: resume (model exists)
    // re-enters at EXECUTING from the cursor; restart (nothing preserved,
    // e.g. failure before model selection) replays setup via
    // RETRYING→PLANNING. Accounting (spend, tokens, event seq) is preserved.
    ctrl.running = true;
    this._armDeadline(runtimeState);
    const msg = ctrl.lastUserMessage || runtimeState.task.objective;
    ctrl.completion = this._executeRun(runtimeState, msg, { resume: hasModel, startStep: hasModel ? cursor : 0 })
      .catch((error) => this._failRun(runtimeState, error))
      .finally(() => { ctrl.running = false; this._disarmDeadline(runId); });
    return true;
  }

  // ---------- readers ----------

  getRunState(runId) {
    const runtimeState = this.getRun(runId);
    if (!runtimeState) return null;
    return runtimeState.toSnapshot();
  }

  getRunTelemetry(runId) {
    return this.telemetry.getRunTelemetry(runId);
  }

  getRunSummary(runId) {
    return this.telemetry.getRunSummary(runId);
  }

  getActiveRuns() {
    return Array.from(this.activeRuns.values()).map((r) => ({
      id: r.runId,
      title: r.task.objective,
      taskMode: r.task.taskType,
      status: frontendStatus(r.status),
      internalStatus: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      activeModelId: r.model.currentModel,
      budget: r.budget.maximumCost,
      spent: Math.round(r.budget.currentSpend * 1e6) / 1e6,
      ownerId: r.ownerId || null,
      orgId: r.orgId || null,
      projectId: r.projectId || null,
      privacyMode: r.privacyMode || 'standard',
    }));
  }

  getTerminalRuns() {
    return Array.from(this.terminalRuns.entries()).map(([id, t]) => ({
      id,
      status: frontendStatus(t.status),
      internalStatus: t.status,
      endedAt: new Date(t.endedAt).toISOString(),
    }));
  }

  cleanupRun(runId) {
    this._disarmDeadline(runId);
    this.activeRuns.delete(runId);
    this.runControl.delete(runId);
    this.terminalRuns.delete(runId);
    this.terminalOrder = this.terminalOrder.filter((id) => id !== runId);
    this.checkpointManager.clearRun(runId);
    this.telemetry.clearRun(runId);
    if (this.cacheManager && typeof this.cacheManager.clearRun === 'function') {
      this.cacheManager.clearRun(runId);
    }
    eventBus.clearRun(runId);
  }
}

module.exports = {
  Orchestrator,
  frontendStatus,
  summarizeToolResult,
};
