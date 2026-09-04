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
const { TelemetryCollector, TelemetryEvent } = require('../telemetry/telemetry-collector');
const { StateMachine } = require('./state-machine');
const { generateId, now } = require('../state/runtime-state');
const { createLogger } = require('../logger');
const { ProviderError } = require('../providers/provider-adapter');

const TERMINAL = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);

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
    this.telemetry = new TelemetryCollector();
    this.decisionEngine = new DecisionEngine();
    this.switchingCostCalculator = dependencies.switchingCostCalculator || new SwitchingCostCalculator();
    this.stickinessManager = dependencies.stickinessManager || new ModelStickinessManager();
    // Optional sink for finished-run evaluations + persistence hooks.
    // { recordEvaluation(eval), onRunEnd(summary) }. Failures here never fail a run.
    this.runEndSink = dependencies.runEndSink || dependencies.evaluationRecorder || null;

    this.activeRuns = new Map();
    // runId -> per-run control record (never shared between runs).
    this.runControl = new Map();

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
    return this.runControl.get(runId);
  }

  policyFor(runId) {
    const ctrl = this.control(runId);
    return ctrl ? ctrl.policyEngine : null;
  }

  transition(runtimeState, to) {
    const ctrl = this.control(runtimeState.runId);
    if (!ctrl) throw new Error(`No control record for run ${runtimeState.runId}`);
    if (ctrl.machine.getState() === to) return;
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
      case EventType.MODEL_SWITCHED: return `Model switched: ${p.fromModel || p.fromId} -> ${p.toModel || p.toId}`;
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
    } catch (e) {
      this.log.warn('run-end sink failed', { error: String((e && e.message) || e).slice(0, 200) });
    }
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
    };
  }

  // ---------- lifecycle ----------

  async createRun(taskObjective, config = {}) {
    const runtimeState = new RuntimeState(taskObjective, config);

    if (config.policy) {
      runtimeState.policy = config.policy;
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

    this.activeRuns.set(runtimeState.runId, runtimeState);
    this.runControl.set(runtimeState.runId, {
      policyEngine: new PolicyEngine(runtimeState.policy, this.config),
      machine: new StateMachine(TaskStatus.CREATED),
      abort: false,
      abortController: new AbortController(),
      running: false,
      startedAt: Date.now(),
      deadlineTimer: null,
      mode: this.config.mode,
      providerId: config.provider || this.config.provider,
      providerModel: null, // resolved registry model definition for the active model
      messages: [],
      history: [], // provider conversation turns [{role, content, name?}]
      trace: [],
      decisions: [],
      changes: [],
      latency: { currentStepMs: 0, avgStepMs: 0, modelMs: 0, toolMs: 0, totalMs: 0, samples: [], modelSamples: [], toolSamples: [] },
      series: [],
      tokens: { input: 0, output: 0, cached: 0 },
      routing: { candidates: [], decision: null },
      lastPromptTokens: 0,
      lastUserMessage: '',
      heuristicToolUsed: false,
      toolCalls: 0,
      retries: 0,
      triedModels: new Set(),
      completedCheckpoints: 0,
    });

    // Snapshot current registry pricing into runtime knowledge.
    if (this.modelRegistry && typeof this.modelRegistry.getModels === 'function') {
      try {
        const models = await this.modelRegistry.getModels();
        for (const m of models) {
          runtimeState.model.setPricing(m.id, { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k, cachedPer1k: m.cachedPer1k });
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

  async startRun(runId, userMessage) {
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) throw new Error(`Run ${runId} not found`);
    const ctrl = this.control(runId);
    if (!ctrl) throw new Error(`Run ${runId} has no control record`);
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
    if (!ctrl || !ctrl.completion) return null;
    let timer = null;
    try {
      await Promise.race([
        ctrl.completion,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('wait timed out')), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.activeRuns.get(runId) || null;
  }

  _armDeadline(runtimeState) {
    const ctrl = this.control(runtimeState.runId);
    this._disarmDeadline(runtimeState.runId);
    const ms = this.config.runTimeoutMs;
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

    let steps = 0;
    while (steps < this.config.maxSteps) {
      if (ctrl.abort) return this._cancelledRun(runtimeState, 'cancelled during execution');
      if (TERMINAL.has(runtimeState.status)) return runtimeState;
      if (runtimeState.budget.isBudgetExceeded() || runtimeState.budget.isLatencyExceeded()) {
        const switched = await this._handleBudgetExceeded(runtimeState);
        if (!switched) throw Object.assign(new Error('Budget exceeded and no cheaper model available'), { code: 'budget_exceeded' });
        if (ctrl.abort || TERMINAL.has(runtimeState.status)) return runtimeState;
      }

      steps++;
      runtimeState.execution.totalSteps = steps;
      const shouldContinue = await this._executeStep(runtimeState, userMessage, steps);
      await this._checkOptimizationTriggers(runtimeState);
      if (!shouldContinue) break;
      if (ctrl.abort) return this._cancelledRun(runtimeState, 'cancelled during execution');
      if (TERMINAL.has(runtimeState.status)) return runtimeState;
    }

    if (!TERMINAL.has(runtimeState.status) && !ctrl.abort) {
      if (steps >= this.config.maxSteps) {
        // Step budget hit: complete only if work actually finished, else fail honestly.
        const lastAssistant = [...ctrl.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) await this._completeRun(runtimeState, { summary: lastAssistant.content, note: 'step limit reached' });
        else throw Object.assign(new Error(`Step limit (${this.config.maxSteps}) reached without a model response`), { code: 'step_limit' });
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

    if (this.memoryManager) {
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
    const allowedModels = models.filter((m) => policy.isModelAllowed(m.id) && m.status !== 'unavailable');

    if (allowedModels.length === 0) {
      throw Object.assign(new Error('No available models: registry is empty or all models are blocked/unavailable'), { code: 'no_models' });
    }

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

    ctrl.routing = { candidates: evaluation.candidates || [], decision };
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
      // Retryable provider errors: fail over to an untried healthy model
      // first (each candidate tried once per run — no A->B->A loops), then
      // bounded same-model retry with backoff, then honest failure.
      if (error instanceof ProviderError && error.retryable) {
        ctrl.triedModels.add(runtimeState.model.currentModel);
        this._emit(runId, EventType.MODEL_UNAVAILABLE, { modelId: runtimeState.model.currentModel, code: error.code });
        const fb = await this._failover(runtimeState, `${error.code} on ${runtimeState.model.currentModel}`, ctrl.triedModels);
        if (fb) {
          runtimeState.execution.recordRetry();
          this._emit(runId, EventType.EXECUTION_RETRY, { step: stepNumber, error: error.message, strategy: 'failover' });
          return true;
        }
        if (ctrl.retries < this.config.maxRetries) {
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

    // Stream the final text (chunked transport of already-complete content).
    if (modelResult.text) {
      for (const chunk of modelResult.text.match(/.{1,120}(\s|$)/g) || [modelResult.text]) {
        this._emit(runId, EventType.RESPONSE_DELTA, { delta: chunk });
      }
    }

    // Tool-call loop (bounded): validate -> execute -> context -> continue.
    let guard = 0;
    while (modelResult.toolCalls && modelResult.toolCalls.length && guard < 4) {
      guard++;
      if (ctrl.abort) return false;
      if (ctrl.toolCalls >= this.config.maxToolCalls) {
        throw Object.assign(new Error('Tool call budget exhausted'), { code: 'tool_budget' });
      }
      const calls = modelResult.toolCalls.slice(0, 3);
      this.transition(runtimeState, TaskStatus.WAITING_FOR_TOOL);
      for (const call of calls) {
        this._emit(runId, EventType.TOOL_SELECTED, { tool: call.name, detail: `Model requested ${call.name}` });
      }
      const results = [];
      for (const call of calls) {
        ctrl.toolCalls++;
        const res = await this.toolExecutor.execute(call.name, call.arguments || {}, runtimeState, {
          signal: ctrl.abortController.signal,
          idempotencyKey: this.toolExecutor.idempotencyKeyFor
            ? this.toolExecutor.idempotencyKeyFor(runId, call.name, call.arguments || {}, stepNumber)
            : undefined,
        });
        results.push({ call, res });
        ctrl.history.push({ role: 'tool', name: call.name, content: res.success ? JSON.stringify(res.result).slice(0, 2000) : `ERROR: ${res.error}` });
        // Tool result -> context (real path) and -> working memory.
        await this.contextManager.addContext(runtimeState, [{
          kind: 'tool_result', title: `${call.name} result`, source: `tool:${call.name}`,
          tokens: Math.ceil(JSON.stringify(res.result || res.error || '').length / 4) + 20,
          relevance: 0.9, status: 'KEEP',
        }]);
        if (this.memoryManager && res.success) {
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
      if (modelResult.text) {
        for (const chunk of modelResult.text.match(/.{1,120}(\s|$)/g) || [modelResult.text]) {
          this._emit(runId, EventType.RESPONSE_DELTA, { delta: chunk });
        }
      }
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
        const res = await this.toolExecutor.execute(assist.toolName, assist.params, runtimeState, {
          signal: ctrl.abortController.signal,
        });
        ctrl.history.push({ role: 'tool', name: assist.toolName, content: res.success ? JSON.stringify(res.result).slice(0, 2000) : `ERROR: ${res.error}` });
        await this.contextManager.addContext(runtimeState, [{
          kind: 'tool_result', title: `${assist.toolName} result`, source: `tool:${assist.toolName}`,
          tokens: Math.ceil(JSON.stringify(res.result || res.error || '').length / 4) + 20,
          relevance: 0.85, status: 'KEEP',
        }]);
        this.toObserving(runtimeState);
        this.transition(runtimeState, TaskStatus.EXECUTING);
        modelResult = await this._callModel(runtimeState, userMessage, stepNumber, true);
        if (modelResult.text) {
          for (const chunk of modelResult.text.match(/.{1,120}(\s|$)/g) || [modelResult.text]) {
            this._emit(runId, EventType.RESPONSE_DELTA, { delta: chunk });
          }
        }
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
    const { checkpoint } = this.checkpointManager.createCheckpoint(runId, CheckpointType.STEP_COMPLETE, runtimeState.toSnapshot(), {
      stepNumber,
    });
    if (checkpoint && typeof checkpoint.markCompleted === 'function') checkpoint.markCompleted({ step: stepNumber });
    ctrl.completedCheckpoints++;

    // Durable memory: explicit durable facts -> long-term, else working summary.
    if (this.memoryManager && modelResult.text) {
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
  async _callModel(runtimeState, userMessage, stepNumber, continuation = false) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    if (ctrl.abort) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

    const modelId0 = runtimeState.model.currentModel;
    let def = ctrl.providerModel || await this.modelRegistry.getModel(modelId0);
    let modelId = modelId0;
    if (!def) throw Object.assign(new Error(`Model ${modelId} not found in registry`), { code: 'no_models' });

    let messages = await this._buildPromptMessages(runtimeState, userMessage, stepNumber);
    let promptTokens = messages.reduce((n, m) => n + Math.ceil(String(m.content || '').length / 4), 0);

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
      messages = await this._buildPromptMessages(runtimeState, userMessage, stepNumber);
      promptTokens = messages.reduce((n, m) => n + Math.ceil(String(m.content || '').length / 4), 0);
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

    // Real response cache (run-namespaced). Hits are genuine replays.
    const cacheKey = this.cacheManager.scopedKey(runId, `prompt:${require('crypto').createHash('sha256').update(JSON.stringify({ p: ctrl.providerId, m: modelId, messages })).digest('hex')}`);
    const cached = await this.cacheManager.get(cacheKey, runId);
    if (cached.hit && cached.value && cached.value.text) {
      const pricing = this.modelRegistry.getPricing ? this.modelRegistry.getPricing(modelId) : null;
      const per1k = (pricing && pricing.inputPer1k) || 0;
      const cachedPer1k = (pricing && pricing.cachedPer1k) ?? per1k;
      const saved = Math.max(0, ((per1k - cachedPer1k) * promptTokens) / 1000);
      this.telemetry.recordCacheEvent(runId, EventType.CACHE_HIT, true, promptTokens, { key: 'prompt-cache' });
      this._emit(runId, EventType.CACHE_HIT, { detail: 'Repeated prompt served from response cache', savedUsd: Math.round(saved * 1e6) / 1e6 });
      this._recordCacheRecent(runId, 'cache.hit', 'Repeated prompt served from response cache');
      ctrl.tokens.cached += promptTokens;
      const est = this.costEstimator.estimateModelCost(modelId, def.provider, promptTokens, 0, promptTokens);
      runtimeState.budget.addCost(CostCategory.CACHED_INPUT_TOKENS, est[CostCategory.CACHED_INPUT_TOKENS] || 0, { cached: true });
      this._emitCost(runtimeState);
      this._pushSeries(runtimeState, { inputTokens: 0, outputTokens: 0, cachedTokens: promptTokens, cost: est.total, latencyMs: 0 });
      if (this.modelRegistry && typeof this.modelRegistry.recordObservation === 'function') {
        try { this.modelRegistry.recordObservation(modelId, { success: true, latencyMs: 0, cached: true }); } catch {}
      }
      return { ...cached.value, fromCache: true };
    }

    const adapter = this.providerRegistry
      ? this.providerRegistry.resolveForRun(ctrl.mode, ctrl.providerId)
      : null;
    if (!adapter) throw new Error('No provider registry configured');

    const tools = await this._providerTools(runtimeState);
    const started = Date.now();
    // providerModel = the registry's default for this provider when the routed
    // model ID is a local catalog alias; resolved native ID otherwise.
    const nativeModel = this._nativeModelId(def, adapter);
    let response;
    try {
      response = await adapter.complete({
        model: nativeModel,
        messages,
        tools,
        maxTokens: 1024,
        timeoutMs: this.config.providerTimeoutMs || 60000,
        signal: ctrl.abortController.signal,
      });
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

    const usage = response.usage || { inputTokens: promptTokens, outputTokens: 0, cachedTokens: 0 };
    const inputTokens = usage.inputTokens ?? promptTokens;
    const outputTokens = usage.outputTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;

    // ONE authoritative pricing path: registry -> estimator.
    const est = this.costEstimator.estimateModelCost(modelId, def.provider, inputTokens, outputTokens, cachedTokens);
    runtimeState.budget.addCost(CostCategory.INPUT_TOKENS, est[CostCategory.INPUT_TOKENS] || 0, { model: modelId });
    runtimeState.budget.addCost(CostCategory.OUTPUT_TOKENS, est[CostCategory.OUTPUT_TOKENS] || 0, { model: modelId });
    if (est[CostCategory.CACHED_INPUT_TOKENS]) {
      runtimeState.budget.addCost(CostCategory.CACHED_INPUT_TOKENS, est[CostCategory.CACHED_INPUT_TOKENS], { model: modelId });
    }
    runtimeState.budget.addLatency(latencyMs);
    this.costEstimator.recordActualCost(runId, CostCategory.OUTPUT_TOKENS, est.total, est.total, { model: modelId });

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
      { input: inputTokens, output: outputTokens, cached: cachedTokens }, latencyMs, est.total,
      { step: stepNumber, continuation });
    this.telemetry.recordMetric(runId, 'model.latency', latencyMs, { model: modelId });
    this.telemetry.recordMetric(runId, 'model.cost', est.total, { model: modelId });
    this._pushSeries(runtimeState, { inputTokens, outputTokens, cachedTokens, cost: est.total, latencyMs });

    this._emit(runId, cachedTokens > 0 ? EventType.CACHE_HIT : EventType.CACHE_MISS, {
      detail: cachedTokens > 0 ? `${cachedTokens} cached tokens reported by provider` : 'Provider call (no prompt caching on this route)',
      ...(cachedTokens > 0 ? { savedUsd: 0 } : {}),
    });
    if (cachedTokens > 0) this._recordCacheRecent(runId, 'cache.hit', `${cachedTokens} cached tokens reported by provider`);
    else this._recordCacheRecent(runId, 'cache.miss', 'Provider call (no prompt caching on this route)');

    this._emitCost(runtimeState);

    await this.cacheManager.set(cacheKey, {
      text: response.text, toolCalls: response.toolCalls,
      usage: { inputTokens, outputTokens: 0, cachedTokens: 0 },
      model: modelId,
    }, undefined, runId);

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
    // via its native ID (discovered models). Anything without a native mapping
    // resolves to the provider's configured default in LIVE mode — never send
    // a local alias to a real provider API.
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

  async _buildPromptMessages(runtimeState, userMessage, stepNumber) {
    const ctx = runtimeState.context;
    const lines = [];
    for (const item of (ctx.contextItems || []).slice(-12)) {
      const extra = item.metadata && item.metadata.text ? `: ${String(item.metadata.text).slice(0, 800)}` : '';
      lines.push(`- [${item.kind}/${item.status}] ${item.title}${extra}`);
    }
    let memLines = [];
    if (this.memoryManager) {
      try {
        const mem = await this.memoryManager.searchMemory(runtimeState, userMessage, ['working', 'longterm'], 4);
        memLines = mem.map((m) => `- (${m.scope}) ${m.title}: ${String(m.snippet || '').slice(0, 300)}`);
      } catch { /* memory is advisory */ }
    }
    const toolNames = Array.from(runtimeState.tools.availableTools.values())
      .filter((t) => t.status === 'enabled').map((t) => t.name);
    const system = [
      `You are the execution model for an adaptive agent runtime (task: ${runtimeState.task.objective}).`,
      `Step ${stepNumber}. Answer concisely. When finished with no further actions, say so explicitly.`,
      toolNames.length ? `Available tools: ${toolNames.join(', ')}. Use them via tool calls when they would help; otherwise answer directly.` : 'No tools available; answer directly.',
      lines.length ? `Context:\n${lines.join('\n')}` : '',
      memLines.length ? `Memory:\n${memLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: system }, ...this.control(runtimeState.runId).history.slice(-10)];
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
      cost: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
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
      await this.contextManager.compressContext(runtimeState, Math.floor(runtimeState.context.maximumTokens * 0.6), runtimeState.policy);
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
    const healthyModels = models.filter((m) =>
      m.status === 'healthy' &&
      runtimeState.policy.isModelAllowed(m.id) &&
      !excluded.has(m.id)
    );
    if (healthyModels.length === 0) return false;
    const { selectedModel, decision } = await this.modelRouter.route(
      runtimeState.task, runtimeState, healthyModels, runtimeState.policy
    );
    await this._applyModelSwitch(runtimeState, selectedModel, healthyModels, decision, `Failover: ${reason}`, { force: true });
    return true;
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

  async _completeRun(runtimeState, evidence = {}) {
    const runId = runtimeState.runId;
    const ctrl = this.control(runId);
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
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
    this._recordRunEnd(runtimeState, TaskStatus.COMPLETED);
    this.log.info('run completed', { runId, steps: runtimeState.execution.currentStep, spent: runtimeState.budget.currentSpend });
    return runtimeState;
  }

  async _failRun(runtimeState, error) {
    const runId = runtimeState.runId;
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
    const ctrl = this.control(runId);
    // Cancellation wins over failure: if an abort was requested, the run was
    // cancelled — never report it as failed.
    if (ctrl && ctrl.abort) {
      return this._cancelledRun(runtimeState, 'cancel requested');
    }
    const code = (error && error.code) || 'unknown';
    try {
      // Legal failure edge from any active state.
      const from = this.control(runId)?.machine.getState();
      const allowed = [TaskStatus.EXECUTING, TaskStatus.OBSERVING, TaskStatus.WAITING_FOR_TOOL, TaskStatus.REOPTIMIZING, TaskStatus.PLANNING, TaskStatus.CONTEXT_BUILD, TaskStatus.MODEL_SELECT, TaskStatus.RETRYING, TaskStatus.PAUSED, TaskStatus.CREATED];
      if (allowed.includes(from)) this.transition(runtimeState, TaskStatus.FAILED);
      else runtimeState.updateStatus(TaskStatus.FAILED);
    } catch {
      runtimeState.updateStatus(TaskStatus.FAILED);
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
    return runtimeState;
  }

  async _cancelledRun(runtimeState, reason) {
    const runId = runtimeState.runId;
    if (TERMINAL.has(runtimeState.status)) return runtimeState;
    try { this.transition(runtimeState, TaskStatus.CANCELLED); }
    catch { runtimeState.updateStatus(TaskStatus.CANCELLED); }
    this._emit(runId, EventType.RUN_CANCELLED, { reason });
    this._recordRunEnd(runtimeState, TaskStatus.CANCELLED);
    return runtimeState;
  }

  async cancelRun(runId, reason = 'User cancelled') {
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) return false;
    const ctrl = this.control(runId);
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

  async retryRun(runId) {
    const runtimeState = this.activeRuns.get(runId);
    if (!runtimeState) return false;
    const ctrl = this.control(runId);
    if (!ctrl || runtimeState.status !== TaskStatus.FAILED) return false;
    if (runtimeState.budget.isBudgetExceeded()) {
      this._emit(runId, EventType.RUN_FAILED, { error: 'Cannot retry: budget exhausted', code: 'budget_exceeded' });
      return false;
    }

    // Controlled retry: preserve valid state, resume after the last completed
    // checkpoint. Idempotency keys are step-derived, so re-executed tool calls
    // return stored results instead of duplicating irreversible operations.
    const lastCheckpoint = this.checkpointManager.getLastCheckpoint(runId);
    let fromStep = runtimeState.execution.currentStep;
    if (lastCheckpoint && typeof lastCheckpoint.stepNumber === 'number') {
      fromStep = lastCheckpoint.stepNumber;
    }
    try {
      this.transition(runtimeState, TaskStatus.RETRYING);
    } catch {
      runtimeState.updateStatus(TaskStatus.RETRYING);
    }
    ctrl.abort = false;
    ctrl.abortController = new AbortController();
    ctrl.retries = 0;
    this._emit(runId, EventType.EXECUTION_RETRY, {
      step: fromStep,
      fromCheckpoint: lastCheckpoint ? lastCheckpoint.checkpointId : null,
      preservedMessages: ctrl.messages.length,
      strategy: runtimeState.model.currentModel ? 'resume' : 'restart',
    });
    // Entry states are handled by _executeRun: resume (model exists) re-enters
    // EXECUTING; restart (nothing preserved) replays setup via RETRYING→PLANNING.
    ctrl.running = true;
    this._armDeadline(runtimeState);
    const msg = ctrl.lastUserMessage || runtimeState.task.objective;
    ctrl.completion = this._executeRun(runtimeState, msg, { resume: true })
      .catch((error) => this._failRun(runtimeState, error))
      .finally(() => { ctrl.running = false; this._disarmDeadline(runId); });
    return true;
  }

  // ---------- readers ----------

  getRunState(runId) {
    const runtimeState = this.activeRuns.get(runId);
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
    }));
  }

  cleanupRun(runId) {
    this._disarmDeadline(runId);
    this.activeRuns.delete(runId);
    this.runControl.delete(runId);
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
