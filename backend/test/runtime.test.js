'use strict';

const assert = require('assert');
const {
  TaskStatus,
  EventType,
  DecisionType,
  CheckpointType,
  CostCategory,
  RuntimeState,
  TaskState,
  ModelState,
  ContextState,
  ContextItem,
  MemoryState,
  ToolState,
  BudgetState,
  ExecutionState,
  PolicyState,
  EventBus,
  Decision,
  DecisionEngine,
  SwitchingCostCalculator,
  ModelStickinessManager,
  PolicyEngine,
  CostEstimator,
  ExecutionCheckpoint,
  CheckpointManager,
  RecoveryManager,
  TelemetryCollector,
  StateMachine,
  Orchestrator,
  summarizeToolResult,
  loadConfig,
  InMemoryModelRegistry,
  InMemoryModelRouter,
  InMemoryContextManager,
  InMemoryMemoryManager,
  InMemoryCacheManager,
  InMemoryToolRegistry,
  InMemoryToolExecutor
} = require('../src/index');

const MODELS = [
  { id: 'model-a', name: 'Model A', provider: 'Provider X', status: 'healthy', contextWindow: 128000, quality: 0.9, avgLatencyMs: 1500, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.0002, capabilities: ['coding', 'reasoning'] },
  { id: 'model-b', name: 'Model B', provider: 'Provider X', status: 'healthy', contextWindow: 64000, quality: 0.85, avgLatencyMs: 1200, reliability: 0.98, inputPer1k: 0.0005, outputPer1k: 0.0015, cachedPer1k: 0.0001, capabilities: ['coding'] },
  { id: 'model-c', name: 'Model C', provider: 'Provider Y', status: 'degraded', contextWindow: 32000, quality: 0.7, avgLatencyMs: 800, reliability: 0.95, inputPer1k: 0.0002, outputPer1k: 0.0006, cachedPer1k: 0.00005, capabilities: ['chat'] }
];

const TOOLS = [
  { name: 'search_code', description: 'Search code', status: 'enabled', costPerCall: 0.001, avgLatencyMs: 500, successRate: 0.99, capabilities: ['search'] },
  { name: 'run_tests', description: 'Run tests', status: 'enabled', costPerCall: 0.002, avgLatencyMs: 2000, successRate: 0.95, capabilities: ['test'] }
];

async function runTests() {
  let passed = 0;
  let failed = 0;
  // Queue + sequential drain: async test bodies are actually awaited, so
  // rejections fail the test instead of passing vacuously.
  const queue = [];

  function test(name, fn) {
    queue.push([name, fn]);
  }
  
  function assertEqual(actual, expected, msg) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  
  function assertThrows(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'Expected function to throw');
  }

  // ===========================================
  // 1. Basic Task Lifecycle
  // ===========================================
  test('RuntimeState creates with correct initial values', () => {
    const state = new RuntimeState('Test task', { taskType: 'code', maxCost: 0.1 });
    assertEqual(state.runId.startsWith('run-'), true);
    assertEqual(state.task.objective, 'Test task');
    assertEqual(state.task.status, TaskStatus.CREATED);
    assertEqual(state.status, TaskStatus.CREATED);
    assertEqual(state.budget.maximumCost, 0.1);
  });

  test('RuntimeState updates status correctly', () => {
    const state = new RuntimeState('Test task');
    state.updateStatus(TaskStatus.PLANNING);
    assertEqual(state.status, TaskStatus.PLANNING);
    assertEqual(state.task.status, TaskStatus.PLANNING);
  });

  test('RuntimeState toSnapshot includes all sub-states', () => {
    const state = new RuntimeState('Test task');
    const snapshot = state.toSnapshot();
    assertEqual(typeof snapshot.runId, 'string');
    assertEqual(typeof snapshot.task, 'object');
    assertEqual(typeof snapshot.model, 'object');
    assertEqual(typeof snapshot.context, 'object');
    assertEqual(typeof snapshot.memory, 'object');
    assertEqual(typeof snapshot.tools, 'object');
    assertEqual(typeof snapshot.budget, 'object');
    assertEqual(typeof snapshot.execution, 'object');
    assertEqual(typeof snapshot.policy, 'object');
  });

  // ===========================================
  // 2. Model Selection Interface
  // ===========================================
  test('ModelRegistry returns registered models', async () => {
    const registry = new InMemoryModelRegistry(MODELS);
    const models = await registry.getModels();
    assertEqual(models.length, 3);
    assertEqual(models[0].id, 'model-a');
  });

  test('ModelRegistry filters by capability', async () => {
    const registry = new InMemoryModelRegistry(MODELS);
    const codingModels = await registry.getModelsByCapability('coding');
    assertEqual(codingModels.length, 2);
  });

  test('ModelRouter evaluates candidates and returns scored list', async () => {
    const registry = new InMemoryModelRegistry(MODELS);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('Test task');
    state.model.currentModel = 'model-a';
    
    const { candidates, currentScore } = await router.evaluateCandidates(state.task, state, MODELS);
    assertEqual(candidates.length, 3);
    assertEqual(typeof candidates[0].score, 'number');
    assertEqual(candidates[0].score >= candidates[1].score, true);
  });

  // ===========================================
  // 3. Model Switching
  // ===========================================
  test('ModelRouter switches model when beneficial', async () => {
    const registry = new InMemoryModelRegistry(MODELS);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('Test task');
    state.model.currentModel = 'model-c';
    state.model.modelLatency = 800;
    state.context.currentTokens = 10000;
    state.context.cacheablePrefixTokens = 0;

    // Incumbent is degraded and not among the healthy candidates: the router
    // must fail over to a healthy model without hysteresis stickiness.
    const { selectedModel, decision } = await router.route(state.task, state, MODELS.filter(m => m.status === 'healthy'), state.policy);
    assertEqual(['model-a', 'model-b'].includes(selectedModel), true, 'switches to a healthy model');
    assertEqual(decision.decisionType, DecisionType.MODEL_SWITCH);
  });

  // ===========================================
  // 4. Switching Rejected Because Cost Too High
  // ===========================================
  test('ModelRouter retains model when switching cost exceeds benefit', async () => {
    // Challenger wins on raw score (higher quality) but the normalized net
    // benefit cannot clear hysteresis: tiny gains must not oscillate models.
    const tuned = MODELS.map((m) => m.id === 'model-b' ? { ...m, quality: 0.99 } : m);
    const registry = new InMemoryModelRegistry(tuned);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('Test task');
    state.model.currentModel = 'model-a';
    state.model.modelLatency = 1500;
    state.context.currentTokens = 2000;
    state.context.cacheablePrefixTokens = 0;

    const { selectedModel, decision } = await router.route(state.task, state, tuned.filter(m => m.status === 'healthy'), state.policy);
    assertEqual(selectedModel, 'model-a');
    assertEqual(decision.decisionType, DecisionType.MODEL_RETENTION);
    assertEqual(decision.factors.some(f => f.key === 'switch_cost'), true);
  });

  test('ModelRouter retains model during cooldown even for a better challenger', async () => {
    const tuned = MODELS.map((m) => m.id === 'model-b' ? { ...m, quality: 0.99 } : m);
    const registry = new InMemoryModelRegistry(tuned);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('Test task');
    state.model.currentModel = 'model-a';
    state.model.modelLatency = 1500;
    state.context.currentTokens = 2000;
    state.context.cacheablePrefixTokens = 0;

    router.stickinessManager.recordSwitch(state.runId); // recent switch -> cooldown
    const { selectedModel, decision } = await router.route(state.task, state, tuned.filter(m => m.status === 'healthy'), state.policy);
    assertEqual(selectedModel, 'model-a');
    assertEqual(decision.decisionType, DecisionType.MODEL_RETENTION);
  });

  // ===========================================
  // 5. Budget Exceeded
  // ===========================================
  test('BudgetState tracks spend and detects exceeded', () => {
    const budget = new BudgetState(0.1);
    budget.addCost(CostCategory.INPUT_TOKENS, 0.05);
    budget.addCost(CostCategory.OUTPUT_TOKENS, 0.06);
    assertEqual(budget.isBudgetExceeded(), true);
    assertEqual(budget.getRemainingBudget(), 0);
  });

  test('BudgetState warns at threshold', () => {
    const budget = new BudgetState(0.1);
    budget.addCost(CostCategory.INPUT_TOKENS, 0.085);
    assertEqual(budget.isBudgetWarning(0.8), true);
    assertEqual(budget.isBudgetExceeded(), false);
  });

  test('PolicyEngine evaluates budget correctly', () => {
    const policy = new PolicyState();
    policy.costConstraints = { maxCost: 0.1, warningThreshold: 0.8 };
    const budget = new BudgetState(0.1);
    budget.addCost(CostCategory.INPUT_TOKENS, 0.095);
    
    const engine = new PolicyEngine(policy, { budgetCriticalThreshold: 0.9 });
    const budgetEval = engine.evaluateBudget(budget);
    assertEqual(budgetEval.isWarning, true);
    assertEqual(budgetEval.isCritical, true);
    assertEqual(budgetEval.canContinue, true); // Not exceeded yet, just critical
  });

  // ===========================================
  // 6. Model Becomes Unavailable
  // ===========================================
  test('ModelRegistry health check returns unavailable status', async () => {
    const registry = new InMemoryModelRegistry(MODELS);
    registry.simulateHealthChange('model-a', 'unavailable');
    const health = await registry.healthCheck('model-a');
    assertEqual(health.healthy, false);
    assertEqual(health.status, 'unavailable');
  });

  test('PolicyEngine detects unavailable model', () => {
    const policy = new PolicyState();
    const engine = new PolicyEngine(policy);
    const modelState = new ModelState();
    modelState.modelHealth = 'unavailable';
    
    const healthEval = engine.evaluateModelHealth(modelState);
    assertEqual(healthEval.canContinue, false);
    assertEqual(healthEval.isUnavailable, true);
  });

  // ===========================================
  // 7. Context Limit Reached
  // ===========================================
  test('ContextState tracks utilization and warns at threshold', () => {
    const context = new ContextState(100000);
    context.addItem(new ContextItem('1', 'file', 'test.ts', 'read', 90000, 0.9));
    assertEqual(context.getUtilization(), 0.9);
    assertEqual(context.isNearLimit(0.8), true);
  });

  test('ContextManager compresses context when limit reached', async () => {
    const mgr = new InMemoryContextManager();
    const state = new RuntimeState('Test task', { maxContextTokens: 100000 });
    state.context.addItem(new ContextItem('1', 'file', 'large.ts', 'read', 90000, 0.5));
    state.context.addItem(new ContextItem('2', 'file', 'small.ts', 'read', 20000, 0.9));
    
    const result = await mgr.compressContext(state, 60000, state.policy);
    assertEqual(result.reclaimed > 0, true);
    assertEqual(state.context.currentTokens <= 60000, true);
  });

  // ===========================================
  // 8. Cache Invalidation
  // ===========================================
  test('CacheManager tracks hits and misses', async () => {
    const cache = new InMemoryCacheManager();
    await cache.set('key1', 'value1');
    const hit = await cache.get('key1');
    const miss = await cache.get('key2');
    assertEqual(hit.hit, true);
    assertEqual(miss.hit, false);
    
    const stats = await cache.getStats();
    assertEqual(stats.hits, 1);
    assertEqual(stats.misses, 1);
    assertEqual(stats.hitRate, 0.5);
  });

  test('CacheManager invalidates keys', async () => {
    const cache = new InMemoryCacheManager();
    await cache.set('key1', 'value1');
    await cache.invalidate('key1');
    const result = await cache.get('key1');
    assertEqual(result.hit, false);
  });

  // ===========================================
  // 9. Tool Failure
  // ===========================================
  test('ToolExecutor records tool failures', async () => {
    const registry = new InMemoryToolRegistry();
    registry.seedTools(TOOLS);
    const executor = new InMemoryToolExecutor(registry);
    const state = new RuntimeState('Test task');

    // Real failure paths (no simulated success rates): unknown tool and
    // missing required params both fail honestly with an error.
    const missing = await executor.execute('no_such_tool', {}, state);
    assertEqual(missing.success, false);
    assertEqual(missing.error !== null, true);

    const badParams = await executor.execute('search_code', {}, state);
    assertEqual(badParams.success, false);
    assertEqual(/query/i.test(badParams.error || ''), true);
  });

  test('ToolState tracks tool health and failures', () => {
    const tools = new ToolState();
    tools.registerTool('test_tool', { description: 'Test' });
    tools.recordCall('test_tool', { success: false, latencyMs: 100 });
    tools.recordCall('test_tool', { success: false, latencyMs: 100 });
    
    assertEqual(tools.toolFailures.get('test_tool'), 2);
    assertEqual(tools.toolHealth.get('test_tool') < 1, true);
  });

  // ===========================================
  // 10. Retry
  // ===========================================
  test('PolicyEngine evaluates retry with backoff', () => {
    const policy = new PolicyState();
    policy.maxRetries = 3;
    policy.retryBackoffMs = 1000;
    const engine = new PolicyEngine(policy);
    
    const execState = new ExecutionState();
    execState.retries = 1;
    
    const retryEval = engine.evaluateRetry(execState, new Error('Test error'));
    assertEqual(retryEval.shouldRetry, true);
    assertEqual(retryEval.retryCount, 1);
    assertEqual(retryEval.backoffMs, 2000);
  });

  test('ExecutionState records retries', () => {
    const exec = new ExecutionState();
    exec.recordRetry();
    exec.recordRetry();
    assertEqual(exec.retries, 2);
  });

  // ===========================================
  // 11. Checkpoint/Resume
  // ===========================================
  test('CheckpointManager creates and retrieves checkpoints', () => {
    const mgr = new CheckpointManager();
    const state = new RuntimeState('Test task');
    state.task.updateProgress(0.5);
    
    const { checkpoint, duplicate } = mgr.createCheckpoint(state.runId, CheckpointType.STEP_COMPLETE, state.toSnapshot(), { stepNumber: 1 });
    assertEqual(duplicate, false);
    assertEqual(checkpoint.type, CheckpointType.STEP_COMPLETE);
    
    const retrieved = mgr.getCheckpoint(state.runId, checkpoint.checkpointId);
    assertEqual(retrieved.checkpointId, checkpoint.checkpointId);
  });

  test('CheckpointManager prevents duplicate idempotency keys', () => {
    const mgr = new CheckpointManager();
    const state = new RuntimeState('Test task');
    
    mgr.createCheckpoint(state.runId, CheckpointType.STEP_COMPLETE, state.toSnapshot(), { stepNumber: 1, idempotencyKey: 'run-1:step:1' });
    const { duplicate } = mgr.createCheckpoint(state.runId, CheckpointType.STEP_COMPLETE, state.toSnapshot(), { stepNumber: 1, idempotencyKey: 'run-1:step:1' });
    assertEqual(duplicate, true);
  });

  test('RecoveryManager restores state from checkpoint', async () => {
    const checkpointMgr = new CheckpointManager();
    const recoveryMgr = new RecoveryManager(checkpointMgr);
    
    const state = new RuntimeState('Test task');
    state.task.updateProgress(0.5);
    state.model.currentModel = 'model-a';
    state.budget.addCost(CostCategory.INPUT_TOKENS, 0.01);
    
    const { checkpoint } = checkpointMgr.createCheckpoint(state.runId, CheckpointType.STEP_COMPLETE, state.toSnapshot(), { stepNumber: 1 });
    checkpoint.markCompleted();
    
    const newState = new RuntimeState('Test task');
    const result = await recoveryMgr.recoverFromCheckpoint(state.runId, checkpoint.checkpointId, newState);
    
    assertEqual(result.success, true);
    assertEqual(newState.task.progress, 0.5);
    assertEqual(newState.model.currentModel, 'model-a');
    assertEqual(newState.budget.currentSpend, 0.01);
  });

  // ===========================================
  // 12. Duplicate Event/Idempotency
  // ===========================================
  test('EventBus prevents duplicate event processing via seq', () => {
    const bus = new EventBus();
    bus.emit('run-1', EventType.TASK_CREATED, { title: 'Test' });
    bus.emit('run-1', EventType.TASK_CREATED, { title: 'Test' });
    
    const events = bus.getEventsSince('run-1', 0);
    assertEqual(events.length, 2);
    assertEqual(events[0].seq, 1);
    assertEqual(events[1].seq, 2);
  });

  test('CheckpointManager idempotency key prevents duplicate checkpoints', () => {
    const mgr = new CheckpointManager();
    const state = new RuntimeState('Test task');
    
    const key = 'run-1:model_switch:1';
    mgr.createCheckpoint(state.runId, CheckpointType.MODEL_SWITCH, state.toSnapshot(), { idempotencyKey: key });
    const { duplicate } = mgr.createCheckpoint(state.runId, CheckpointType.MODEL_SWITCH, state.toSnapshot(), { idempotencyKey: key });
    assertEqual(duplicate, true);
  });

  // ===========================================
  // 13. Model Oscillation Prevention
  // ===========================================
  test('ModelStickinessManager enforces cooldown between switches', () => {
    const mgr = new ModelStickinessManager({ cooldownPeriodMs: 60000 });
    const runId = 'run-1';
    
    mgr.recordSwitch(runId);
    const check = mgr.canSwitch(runId, 'model-a', 'model-b', 0.5, 0.1);
    assertEqual(check.allowed, false);
    assertEqual(check.reason, 'cooldown_active');
  });

  test('ModelStickinessManager enforces max switches per task', () => {
    const mgr = new ModelStickinessManager({ maxSwitchesPerTask: 2 });
    const runId = 'run-1';
    
    mgr.recordSwitch(runId);
    mgr.recordSwitch(runId);
    const check = mgr.canSwitch(runId, 'model-a', 'model-b', 1.0, 0.01);
    assertEqual(check.allowed, false);
    assertEqual(check.reason, 'max_switches_exceeded');
  });

  test('ModelStickinessManager requires hysteresis benefit', () => {
    const mgr = new ModelStickinessManager({ hysteresisFactor: 2.0, cooldownPeriodMs: 0 });
    const runId = 'run-1';
    
    const check = mgr.canSwitch(runId, 'model-a', 'model-b', 0.05, 0.1);
    assertEqual(check.allowed, false);
    assertEqual(check.reason, 'insufficient_benefit');
    assertEqual(check.requiredBenefit, 0.2);
  });

  // ===========================================
  // 14. Concurrent Tool Completion
  // ===========================================
  test('ToolExecutor executes tools in parallel with limit', async () => {
    const registry = new InMemoryToolRegistry();
    registry.seedTools([
      { name: 'search_code', description: 'Search code', status: 'enabled', costPerCall: 0.001, avgLatencyMs: 500, successRate: 0.99, capabilities: ['search'], parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'read_file', description: 'Read file', status: 'enabled', costPerCall: 0.001, avgLatencyMs: 100, successRate: 0.99, capabilities: ['read'], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ]);
    const executor = new InMemoryToolExecutor(registry, null, { maxParallel: 2 });
    const state = new RuntimeState('Test task');

    const calls = [
      { toolName: 'search_code', params: { query: 'RuntimeState' } },
      { toolName: 'read_file', params: { path: 'package.json' } },
      { toolName: 'search_code', params: { query: 'ToolExecutor' } }
    ];

    const results = await executor.executeParallel(calls, state);
    assertEqual(results.length, 3);
    assertEqual(results.every(r => r.success), true);
  });

  // ===========================================
  // 15. State Transition Validity
  // ===========================================
  test('StateMachine allows valid transitions', () => {
    const sm = new StateMachine(TaskStatus.CREATED);
    sm.transition(TaskStatus.PLANNING);
    assertEqual(sm.getState(), TaskStatus.PLANNING);
    sm.transition(TaskStatus.CONTEXT_BUILD);
    assertEqual(sm.getState(), TaskStatus.CONTEXT_BUILD);
    sm.transition(TaskStatus.MODEL_SELECT);
    assertEqual(sm.getState(), TaskStatus.MODEL_SELECT);
    sm.transition(TaskStatus.EXECUTING);
    assertEqual(sm.getState(), TaskStatus.EXECUTING);
    sm.transition(TaskStatus.COMPLETED);
    assertEqual(sm.getState(), TaskStatus.COMPLETED);
  });

  test('StateMachine rejects invalid transitions', () => {
    const sm = new StateMachine(TaskStatus.CREATED);
    assertThrows(() => sm.transition(TaskStatus.EXECUTING), 'Should reject CREATED -> EXECUTING');
  });

  test('StateMachine rejects transitions from terminal states', () => {
    const sm = new StateMachine(TaskStatus.COMPLETED);
    assertThrows(() => sm.transition(TaskStatus.EXECUTING), 'Should reject COMPLETED -> EXECUTING');
    assertEqual(sm.isTerminal(), true);
  });

  test('StateMachine validates sequences', () => {
    const valid = StateMachine.validateSequence([TaskStatus.CREATED, TaskStatus.PLANNING, TaskStatus.CONTEXT_BUILD, TaskStatus.MODEL_SELECT, TaskStatus.EXECUTING, TaskStatus.COMPLETED]);
    assertEqual(valid.valid, true);
    
    const invalid = StateMachine.validateSequence([TaskStatus.CREATED, TaskStatus.EXECUTING]);
    assertEqual(invalid.valid, false);
    assertEqual(invalid.from, TaskStatus.CREATED);
    assertEqual(invalid.to, TaskStatus.EXECUTING);
  });

  // ===========================================
  // Additional Integration Tests
  // ===========================================
  test('Orchestrator creates run with all components', async () => {
    const orchestrator = new Orchestrator({
      modelRegistry: new InMemoryModelRegistry(MODELS),
      modelRouter: new InMemoryModelRouter(new InMemoryModelRegistry(MODELS)),
      contextManager: new InMemoryContextManager(),
      memoryManager: new InMemoryMemoryManager(),
      cacheManager: new InMemoryCacheManager(),
      toolRegistry: new InMemoryToolRegistry(),
      toolExecutor: new InMemoryToolExecutor(new InMemoryToolRegistry()),
      costEstimator: new CostEstimator()
    });
    
    const state = await orchestrator.createRun('Test task', { taskType: 'code', maxCost: 0.1 });
    assertEqual(state.runId.startsWith('run-'), true);
    assertEqual(state.task.objective, 'Test task');
  });

  test('CostEstimator calculates model cost with cache', () => {
    const estimator = new CostEstimator();
    const cost = estimator.estimateModelCost('model-a', 'Provider X', 10000, 1000, 5000);
    assertEqual(cost.total > 0, true);
    assertEqual(cost[CostCategory.CACHED_INPUT_TOKENS] > 0, true);
    assertEqual(cost[CostCategory.UNCACHED_INPUT_TOKENS] > 0, true);
  });

  test('CostEstimator estimates switching cost', () => {
    const estimator = new CostEstimator();
    const cost = estimator.estimateSwitchingCost('model-a', 'model-b', 50000, 10000);
    assertEqual(cost.total > 0, true);
    assertEqual(cost.breakdown.fromModel, 'model-a');
    assertEqual(cost.breakdown.toModel, 'model-b');
  });

  test('Decision calculates net benefit', () => {
    const decision = new Decision(DecisionType.MODEL_SWITCH, 'SWITCH', 'run-1', {
      expectedQuality: 0.1,
      expectedCost: -0.005,
      expectedLatency: -200,
      switchingCost: 0.01
    });
    
    const netBenefit = decision.getNetBenefit();
    assertEqual(netBenefit > 0, true);
  });

  test('TelemetryCollector records events and metrics', () => {
    const collector = new TelemetryCollector();
    collector.recordEvent('run-1', { eventId: 'e1', runId: 'run-1', type: EventType.TASK_CREATED, timestamp: new Date().toISOString() });
    collector.recordMetric('run-1', 'latency', 100, { model: 'model-a' });
    
    const telemetry = collector.getRunTelemetry('run-1');
    assertEqual(telemetry.events.length, 1);
    assertEqual(telemetry.metrics.length, 1);
  });

  test('SwitchingCostCalculator calculates all cost components', () => {
    const calc = new SwitchingCostCalculator();
    const context = new ContextState(100000);
    context.currentTokens = 80000;
    context.cacheablePrefixTokens = 20000;
    
    const modelState = new ModelState();
    modelState.currentModel = 'model-a';
    modelState.currentProvider = 'Provider X';
    modelState.modelLatency = 1500;
    
    const costs = calc.calculate(context, modelState, 'model-a', 'model-b', { toProvider: 'Provider Y', toModelLatency: 1200 });
    assertEqual(costs.total > 0, true);
    assertEqual(costs.breakdown.contextReconstruction > 0, true);
    assertEqual(costs.breakdown.cacheLoss > 0, true);
    assertEqual(costs.breakdown.providerOverhead > 0, true);
  });

  // ===========================================
  // Tool-result memory summaries are human-readable (no raw JSON escapes)
  // ===========================================
  test('summarizeToolResult prefers textual result fields and collapses whitespace', () => {
    const out = summarizeToolResult({ suite: 'session', passed: true, stdout: 'line1\nline2\n  line3' });
    assertEqual(out, 'passed (session): line1 line2 line3');
  });
  test('summarizeToolResult handles strings, null, and undefined', () => {
    assertEqual(summarizeToolResult('plain string'), 'plain string');
    assertEqual(summarizeToolResult(null), '');
    assertEqual(summarizeToolResult(undefined), '');
  });

  // ===========================================
  // loadConfig threads the provided env object
  // ===========================================
  test('loadConfig honors a custom env object instead of process.env', () => {
    const c = loadConfig({ PORT: '9999', PROVIDER: 'openai', OPENAI_API_KEY: 'x', DISCOVERY_ENABLED: '0', DEFAULT_BUDGET_USD: '1.5' });
    assertEqual(c.port, 9999);
    assertEqual(c.mode, 'live');
    assertEqual(c.provider, 'openai');
    assertEqual(c.discoveryEnabled, false);
    assertEqual(c.defaultBudgetUsd, 1.5);
  });
  test('loadConfig resolves demo without keys and honors explicit demo', () => {
    assertEqual(loadConfig({ PROVIDER: 'openrouter' }).mode, 'demo');
    assertEqual(loadConfig({ PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', RUNTIME_MODE: 'demo' }).mode, 'demo');
    assertEqual(loadConfig({ PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }).mode, 'live');
  });

  for (const [name, fn] of queue) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}: ${e && e.message}`);
      failed++;
    }
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);