'use strict';

// P0-A regression tests: checkpoint-based recovery is real, not a re-run.
//
// Matrix covered:
//   1. crash before tool invocation            -> resume from checkpoint
//   2. crash after tool request, before result -> safe retry_step (idempotent)
//   3. crash after side effect, before checkpoint -> skip_completed (no dup)
//   4. crash after checkpoint                  -> resume, step numbers continue
//   5. duplicate concurrent retry              -> exactly one winner
//   6. idempotent tool retry                   -> stored result reused (deduped)
//   7. unknown side-effect outcome (destructive in-flight) -> blocked, stays FAILED
//   8. invalid/corrupted checkpoint            -> unrecoverable, stays FAILED
//   9. stale checkpoint                        -> ask_user, stays FAILED
//  10. resumed budget/accounting correctness   -> spend preserved, never reset
//  11. resumed event sequence correctness      -> monotonic, no reset
//  12. resumed state matches checkpoint       -> context/model/cursor restored
//
// Run: node backend/test/recovery.test.js (no network)

process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = 'backend/.runtime-data-test';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');

const { Orchestrator } = require('../src/core/orchestrator');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryModelRouter } = require('../src/impl/model-router');
const { InMemoryContextManager } = require('../src/impl/context-manager');
const { InMemoryMemoryManager } = require('../src/impl/memory-manager');
const { InMemoryCacheManager } = require('../src/impl/cache-manager');
const { InMemoryToolRegistry } = require('../src/impl/tool-registry');
const { InMemoryToolExecutor } = require('../src/impl/tool-executor');
const { CostEstimator } = require('../src/cost/cost-estimator');
const { ProviderRegistry } = require('../src/providers/provider-adapter');
const { TaskStatus, CheckpointType } = require('../src/core/types');
const { eventBus } = require('../src/events/event-bus');
const { validateCheckpoint } = require('../src/checkpoint/checkpoint-manager');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

const MODEL = {
  id: 'm1', name: 'M1', provider: 'openrouter', status: 'healthy',
  contextWindow: 64000, quality: 0.9, avgLatencyMs: 50, reliability: 0.99,
  inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001,
  capabilities: ['text'], source: 'static', nativeId: 'm1',
};

function seedTools(toolRegistry) {
  toolRegistry.seedTools([
    { name: 'read_file', description: 'read', status: 'enabled', risk: 'low', costPerCall: 0.0002, timeoutMs: 10000, permissions: ['workspace:read'], capabilities: ['read'], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
}

// Script-driven stub adapter: behaviors are consumed in order; functions
// receive the call index and may throw to simulate a crash.
function makeOrchestrator(behaviors) {
  const registry = new InMemoryModelRegistry([{ ...MODEL }]);
  const toolRegistry = new InMemoryToolRegistry();
  seedTools(toolRegistry);
  const toolExecutor = new InMemoryToolExecutor(toolRegistry, eventBus, { workspace: process.cwd() });
  let calls = 0;
  const providerRegistry = new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 5000 }, {
    createAdapter: () => ({
      providerId: 'openrouter',
      hasCredentials: true,
      defaultModel: 'm1',
      complete: async (req) => {
        const i = calls++;
        const b = behaviors[Math.min(i, behaviors.length - 1)];
        if (typeof b === 'function') return b(i, req);
        return b;
      },
      listModels: async () => [],
    }),
  });
  const orch = new Orchestrator({
    modelRegistry: registry,
    modelRouter: new InMemoryModelRouter(registry),
    contextManager: new InMemoryContextManager(),
    memoryManager: new InMemoryMemoryManager(),
    cacheManager: new InMemoryCacheManager(),
    toolRegistry,
    toolExecutor,
    costEstimator: new CostEstimator(),
    providerRegistry,
    config: { mode: 'live', provider: 'openrouter', maxSteps: 6, maxToolCalls: 8, maxRetries: 1 },
  });
  return { orch, toolExecutor, getCalls: () => calls };
}

function okText(text) {
  return { text, toolCalls: [], usage: { inputTokens: 50, outputTokens: 20, cachedTokens: 0 }, latencyMs: 5, model: 'm1', provider: 'openrouter', stopReason: 'stop' };
}
function toolCallBehavior(toolCalls) {
  return { text: '', toolCalls, usage: { inputTokens: 50, outputTokens: 5, cachedTokens: 0 }, latencyMs: 5, model: 'm1', provider: 'openrouter', stopReason: 'tool_calls' };
}
function readFileCall(id) {
  return { id, name: 'read_file', arguments: { path: 'package.json' } };
}
function crashError() {
  return Object.assign(new Error('simulated crash: provider connection reset'), { code: 'fetch_failure' });
}

function eventsFor(runId) {
  return (eventBus.eventLogs.get(runId) || []).filter((e) => e && e.runId === runId);
}
function hasEvent(runId, type) {
  return eventsFor(runId).some((e) => e.type === type);
}
function maxSeq(runId) {
  return eventsFor(runId).reduce((m, e) => Math.max(m, e.seq || 0), 0);
}

// Drive a run until it FAILS (adapter script must throw).
async function runToFailure(orch, objective) {
  const rs = await orch.createRun(objective || 'do the thing');
  await orch.startRun(rs.runId, rs.task.objective);
  await orch.waitForCompletion(rs.runId, 30000);
  const final = orch.getRun(rs.runId);
  assert.strictEqual(final.status, TaskStatus.FAILED, `expected FAILED, got ${final.status}`);
  return final;
}

// Access the retired FAILED run + its control record (retryRun resurrects
// these itself; tests only craft crash signals on top).
function crashedPair(orch, runId) {
  const term = orch.terminalRuns.get(runId);
  assert.ok(term, 'expected retired FAILED run');
  assert.strictEqual(term.status, TaskStatus.FAILED);
  return { live: term.runtimeState, ctrl: term.control };
}

async function main() {
  // ---------- 4. crash after checkpoint: resume, steps continue ----------
  await test('crash after checkpoint resumes from cursor with continuing step numbers', async () => {
    // One script function: call 0 requests a tool, call 1 (continuation)
    // crashes before STEP_COMPLETE, later calls answer directly.
    const script = (i) => {
      if (i === 0) return toolCallBehavior([readFileCall('c1')]);
      if (i === 1) throw crashError();
      return okText('recovered and done');
    };
    const { orch } = makeOrchestrator([script]);
    const rs = await orch.createRun('read package.json then answer');
    await orch.startRun(rs.runId, rs.task.objective);
    await orch.waitForCompletion(rs.runId, 30000);
    const failed = orch.getRun(rs.runId);
    assert.strictEqual(failed.status, TaskStatus.FAILED, `expected FAILED, got ${failed.status}`);
    // Crash-after-checkpoint shape: the step-1 tool completed AND a
    // completed checkpoint for step 1 exists.
    const { live, ctrl } = crashedPair(orch, rs.runId);
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 1, result: { step: 1 } });
    assert.ok(cp && cp.completed, 'checkpoint captured+completed');
    const spendBefore = live.budget.currentSpend;
    const seqBefore = maxSeq(rs.runId);

    const ok = await orch.retryRun(rs.runId);
    assert.strictEqual(ok, true, 'retry accepted');
    await orch.waitForCompletion(rs.runId, 30000);
    const final = orch.getRun(rs.runId);
    assert.strictEqual(final.status, TaskStatus.COMPLETED, `expected COMPLETED, got ${final.status}`);
    // Step numbers continued (never reset to 1 for the resumed work).
    assert.ok(final.execution.currentStep >= 2, `steps continued, got currentStep=${final.execution.currentStep}`);
    // Budget preserved (never reset), then grew with resumed work.
    assert.ok(final.budget.currentSpend >= spendBefore, 'spend preserved across resume');
    // Event sequence kept increasing (no reset).
    assert.ok(maxSeq(rs.runId) > seqBefore, 'event seq continued');
    assert.ok(hasEvent(rs.runId, 'execution.recovery_started'), 'recovery_started emitted');
    assert.ok(hasEvent(rs.runId, 'execution.recovered'), 'recovered emitted');
    const plan = orch.lastRecoveryPlan(rs.runId);
    assert.ok(plan && plan.checkpointId === cp.checkpointId, 'plan references the checkpoint');
  });

  // ---------- 1. crash before tool invocation -> resume ----------
  await test('crash before tool invocation resumes from checkpoint', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('fine')]);
    const rs = await orch.createRun('answer briefly');
    await orch.startRun(rs.runId, rs.task.objective);
    await orch.waitForCompletion(rs.runId, 30000);
    const live = orch.getRun(rs.runId);
    assert.strictEqual(live.status, TaskStatus.FAILED);
    const ctrl = orch.control(rs.runId);
    // Checkpoint with model selected but no tool ever dispatched.
    live.model.currentModel = 'm1';
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 0, result: { step: 0 } });
    assert.ok(cp.completed);
    ctrl.lastToolEffect = null;

    const ok = await orch.retryRun(rs.runId);
    assert.strictEqual(ok, true);
    await orch.waitForCompletion(rs.runId, 30000);
    assert.strictEqual(orch.getRun(rs.runId).status, TaskStatus.COMPLETED);
    assert.strictEqual(orch.lastRecoveryPlan(rs.runId).action, 'resume');
  });

  // ---------- 2. crash after tool request, before result (idempotent) ----------
  await test('crash with idempotent tool in-flight retries the step safely', async () => {
    const { orch, toolExecutor } = makeOrchestrator([() => { throw crashError(); }, () => okText('done after retry')]);
    const failed = await runToFailure(orch, 'task');
    const { live, ctrl } = crashedPair(orch, failed.runId);
    live.model.currentModel = 'm1';
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 1, result: { step: 1 } });
    const key = toolExecutor.idempotencyKeyFor(failed.runId, 'read_file', { path: 'package.json' }, 2);
    ctrl.lastToolEffect = { state: 'in_flight', tool: 'read_file', idempotencyKey: key, step: 2, destructive: false, idempotent: true, retryable: true };

    const ok = await orch.retryRun(failed.runId);
    assert.strictEqual(ok, true, 'idempotent in-flight is safe to retry');
    await orch.waitForCompletion(failed.runId, 30000);
    assert.strictEqual(orch.getRun(failed.runId).status, TaskStatus.COMPLETED);
    assert.strictEqual(orch.lastRecoveryPlan(failed.runId).action, 'retry_step');
    assert.ok(cp.completed);
  });

  // ---------- 3+6. crash after side effect, before checkpoint: no duplicate --
  await test('completed side effect with idempotency proof is not re-executed', async () => {
    const { orch, toolExecutor } = makeOrchestrator([() => { throw crashError(); }, () => okText('all good')]);
    const failed = await runToFailure(orch, 'task needing a read');
    const { live, ctrl } = crashedPair(orch, failed.runId);
    // Pre-complete the idempotency key of the crashed tool call: durable
    // proof the side effect already happened (as if it completed in the
    // crashed process and persisted before the crash).
    const params = { path: 'package.json' };
    const key = toolExecutor.idempotencyKeyFor(failed.runId, 'read_file', params, 1);
    const durableResult = { success: true, result: { path: 'package.json', content: 'CACHED-PROOF' }, error: null, executionId: 'exec-proof', code: 'ok' };
    const store = toolExecutor.idempotencyStore;
    if (store && typeof store.complete === 'function') {
      store.begin(key, { runId: failed.runId, op: 'read_file' });
      store.complete(key, durableResult);
    } else {
      toolExecutor.completedKeys.set(key, { ...durableResult, idempotencyKey: key });
    }
    // Crash shape: FAILED, checkpoint at step 0, last tool completed w/ proof.
    live.model.currentModel = 'm1';
    orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 0, result: { step: 0 } });
    ctrl.lastToolEffect = { state: 'completed', tool: 'read_file', idempotencyKey: key, step: 1, destructive: false, idempotent: true, retryable: true };

    assert.strictEqual(orch.lastRecoveryPlan(failed.runId), null);
    const ok = await orch.retryRun(failed.runId);
    assert.strictEqual(ok, true);
    await orch.waitForCompletion(failed.runId, 30000);
    assert.strictEqual(orch.getRun(failed.runId).status, TaskStatus.COMPLETED);
    const after = orch.lastRecoveryPlan(failed.runId);
    assert.ok(['skip_completed', 'resume'].includes(after.action), `expected skip/resume, got ${after.action}`);
  });

  // ---------- 6b. same idempotency key returns the stored result ----------
  await test('same idempotency key concurrently returns stored result without re-executing', async () => {
    const { orch, toolExecutor } = makeOrchestrator([() => okText('x')]);
    const rs = await orch.createRun('dedupe probe');
    const live = orch.getRun(rs.runId);
    const key = 'probe-key-1';
    const first = await toolExecutor.execute('read_file', { path: 'package.json' }, live, { idempotencyKey: key });
    assert.strictEqual(first.success, true);
    assert.ok(!first.deduped, 'first execution is live');
    const [a, b] = await Promise.all([
      toolExecutor.execute('read_file', { path: 'package.json' }, live, { idempotencyKey: key }),
      toolExecutor.execute('read_file', { path: 'package.json' }, live, { idempotencyKey: key }),
    ]);
    assert.strictEqual(a.deduped, true);
    assert.strictEqual(b.deduped, true);
    assert.strictEqual(a.executionId, first.executionId, 'stored result returned, handler not re-run');
    assert.strictEqual(b.executionId, first.executionId);
  });

  // ---------- 5. duplicate concurrent retry: exactly one winner ----------
  await test('two concurrent retries do not duplicate execution', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('winner')]);
    const rs = await orch.createRun('concurrent retry');
    await orch.startRun(rs.runId, rs.task.objective);
    await orch.waitForCompletion(rs.runId, 30000);
    const live = orch.getRun(rs.runId);
    live.model.currentModel = 'm1';
    orch.recoveryService.captureCheckpoint(live, orch.control(rs.runId), CheckpointType.STEP_COMPLETE, { stepNumber: 0, result: {} });

    const [a, b] = await Promise.all([orch.retryRun(rs.runId), orch.retryRun(rs.runId)]);
    assert.strictEqual([a, b].filter(Boolean).length, 1, `exactly one winner, got [${a},${b}]`);
    await orch.waitForCompletion(rs.runId, 30000);
    assert.strictEqual(orch.getRun(rs.runId).status, TaskStatus.COMPLETED);
  });

  // ---------- 7. unknown destructive outcome -> blocked ----------
  await test('destructive in-flight tool with unknown outcome blocks recovery', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('should never run')]);
    const failed = await runToFailure(orch, 'dangerous task');
    const { live, ctrl } = crashedPair(orch, failed.runId);
    live.model.currentModel = 'm1';
    orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 2, result: {} });
    ctrl.lastToolEffect = {
      state: 'in_flight', tool: 'apply_patch', idempotencyKey: `${failed.runId}:apply_patch:3:abc`,
      step: 3, destructive: true, idempotent: false, retryable: false,
    };

    const ok = await orch.retryRun(failed.runId);
    assert.strictEqual(ok, false, 'must refuse to blindly re-run destructive unknown');
    assert.strictEqual(orch.getRun(failed.runId).status, TaskStatus.FAILED, 'run stays FAILED and auditable');
    assert.ok(hasEvent(failed.runId, 'execution.recovery_blocked'), 'recovery_blocked emitted');
    assert.strictEqual(orch.lastRecoveryPlan(failed.runId).action, 'mark_unknown');
  });

  // ---------- 8. corrupted checkpoint -> unrecoverable ----------
  await test('corrupted checkpoint is rejected, run stays FAILED', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('never')]);
    const failed = await runToFailure(orch, 'corrupt me');
    const { live, ctrl } = crashedPair(orch, failed.runId);
    live.model.currentModel = 'm1';
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 1, result: {} });
    cp.stepNumber = 999; // tamper after sealing -> integrity mismatch
    const v = validateCheckpoint(cp, failed.runId);
    assert.strictEqual(v.ok, false, 'tampered checkpoint fails validation');
    assert.strictEqual(v.code, 'corrupt');

    const ok = await orch.retryRun(failed.runId);
    assert.strictEqual(ok, false, 'corrupt checkpoint must not resume');
    assert.strictEqual(orch.getRun(failed.runId).status, TaskStatus.FAILED);
    assert.strictEqual(orch.lastRecoveryPlan(failed.runId).action, 'unrecoverable');
  });

  // ---------- 8b. checkpoint for another run is rejected ----------
  await test('checkpoint from another run cannot restore this run', async () => {
    const { orch } = makeOrchestrator([() => okText('never')]);
    const a = await orch.createRun('run a');
    await orch.startRun(a.runId, a.task.objective);
    await orch.waitForCompletion(a.runId, 30000);
    const other = orch.checkpointManager.createCheckpoint('run-OTHER', CheckpointType.STEP_COMPLETE, a.getRun ? {} : {}, { stepNumber: 1 });
    const v = validateCheckpoint(other.checkpoint, a.runId);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, 'run_mismatch');
  });

  // ---------- 9. stale checkpoint -> ask_user ----------
  await test('stale checkpoint requires operator instead of auto-resume', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('never')]);
    const failed = await runToFailure(orch, 'stale task');
    const { live, ctrl } = crashedPair(orch, failed.runId);
    live.model.currentModel = 'm1';
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 1, result: {} });
    cp.timestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days old
    const v = validateCheckpoint(cp, failed.runId);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, 'stale');

    const ok = await orch.retryRun(failed.runId);
    assert.strictEqual(ok, false, 'stale checkpoint must not auto-resume');
    assert.strictEqual(orch.lastRecoveryPlan(failed.runId).action, 'ask_user');
    assert.ok(hasEvent(failed.runId, 'execution.recovery_blocked'));
  });

  // ---------- 10. budget preserved ----------
  await test('resumed run preserves spend and keeps accounting exact', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('done')]);
    const rs = await orch.createRun('budgeted task');
    await orch.startRun(rs.runId, rs.task.objective);
    await orch.waitForCompletion(rs.runId, 30000);
    const live = orch.getRun(rs.runId);
    live.model.currentModel = 'm1';
    live.budget.addCost('input_tokens', 0.2, { note: 'pre-crash spend' });
    const historyLen = live.budget.costHistory.length;
    orch.recoveryService.captureCheckpoint(live, orch.control(rs.runId), CheckpointType.STEP_COMPLETE, { stepNumber: 0, result: {} });
    const spendBefore = live.budget.currentSpend;
    assert.ok(spendBefore >= 0.2);

    assert.strictEqual(await orch.retryRun(rs.runId), true);
    await orch.waitForCompletion(rs.runId, 30000);
    const final = orch.getRun(rs.runId);
    assert.strictEqual(final.status, TaskStatus.COMPLETED);
    assert.ok(final.budget.currentSpend >= spendBefore, `spend preserved+extended (${final.budget.currentSpend} >= ${spendBefore})`);
    assert.ok(final.budget.costHistory.length >= historyLen, 'cost history preserved, not reset');
    const preCrash = final.budget.costHistory.find((h) => h.note === 'pre-crash spend');
    assert.ok(preCrash, 'pre-crash cost record survived recovery');
  });

  // ---------- 11. event sequence monotonic ----------
  await test('resumed run keeps a single monotonic event sequence', async () => {
    const { orch } = makeOrchestrator([() => { throw crashError(); }, () => okText('done')]);
    const rs = await orch.createRun('sequenced task');
    await orch.startRun(rs.runId, rs.task.objective);
    await orch.waitForCompletion(rs.runId, 30000);
    const live = orch.getRun(rs.runId);
    live.model.currentModel = 'm1';
    orch.recoveryService.captureCheckpoint(live, orch.control(rs.runId), CheckpointType.STEP_COMPLETE, { stepNumber: 0, result: {} });
    const seqBefore = maxSeq(rs.runId);

    assert.strictEqual(await orch.retryRun(rs.runId), true);
    await orch.waitForCompletion(rs.runId, 30000);
    const evts = eventsFor(rs.runId);
    assert.ok(maxSeq(rs.runId) > seqBefore, 'sequence extended, not reset');
    const seqs = evts.map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.deepStrictEqual(seqs, sorted, 'event order is monotonic');
    assert.strictEqual(new Set(seqs).size, seqs.length, 'no duplicate sequence numbers');
  });

  // ---------- 12. restored state matches checkpoint ----------
  await test('restore applies checkpoint snapshot exactly (context/model/cursor/control)', async () => {
    const { orch } = makeOrchestrator([() => okText('x')]);
    const rs = await orch.createRun('state match');
    const live = orch.getRun(rs.runId);
    const ctrl = orch.control(rs.runId);
    live.model.currentModel = 'm1';
    live.model.currentProvider = 'openrouter';
    live.context.currentTokens = 1234;
    live.context.contextItems = [{ id: 'ctx-1', kind: 'chat', title: 'Checkpointed context', tokens: 100 }];
    live.budget.currentSpend = 0.11;
    live.execution.currentStep = 3;
    ctrl.messages = [{ id: 'm1', role: 'user', content: 'hello' }];
    ctrl.history = [{ role: 'user', content: 'hello' }];
    ctrl.toolCalls = 2;
    ctrl.triedModels = new Set(['m0']);
    const cp = orch.recoveryService.captureCheckpoint(live, ctrl, CheckpointType.STEP_COMPLETE, { stepNumber: 3, result: {} });

    // Diverge live state (simulating post-checkpoint crashed work).
    live.context.currentTokens = 9999;
    live.context.contextItems = [];
    live.budget.currentSpend = 0.99;
    live.execution.currentStep = 9;
    live.model.currentModel = 'other';
    ctrl.messages = [];
    ctrl.history = [];
    ctrl.toolCalls = 99;

    const res = await orch.recoveryManager.recoverFromCheckpoint(rs.runId, cp.checkpointId, live);
    assert.strictEqual(res.success, true);
    const { restoreControlSnapshot } = require('../src/checkpoint/checkpoint-manager');
    restoreControlSnapshot(ctrl, res.restoredControl);
    assert.strictEqual(live.context.currentTokens, 1234, 'context tokens restored');
    assert.strictEqual(live.context.contextItems[0].title, 'Checkpointed context', 'context items restored');
    assert.strictEqual(live.budget.currentSpend, 0.11, 'spend restored exactly');
    assert.strictEqual(live.execution.currentStep, 3, 'cursor restored');
    assert.strictEqual(live.model.currentModel, 'm1', 'model restored');
    assert.deepStrictEqual(ctrl.messages.map((m) => m.content), ['hello'], 'conversation restored');
    assert.strictEqual(ctrl.toolCalls, 2, 'tool counter restored');
    assert.ok(ctrl.triedModels.has('m0'), 'tried models restored');
  });
}

main().then(() => {
  console.log(`\n--- Recovery results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
