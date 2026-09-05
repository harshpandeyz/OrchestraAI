'use strict';

// Focused regression tests: provider model-access failure -> automatic failover.
//
// Covers the reported Helium B / OpenRouter incident: the router selected a
// model the provider will not serve ("unavailable for free" tier), the
// request failed, and the run failed without trying the next candidate.
//
// Chain under test:
//   discovery/registry status -> router candidate filtering -> provider
//   request -> error classification (model_unavailable) -> failover ->
//   no-repeat of the failed model -> honest exhaustion -> switch decision
//   recorded -> UI-facing snapshot shows the final model and reason.
//
// Run: node backend/test/model-failover.test.js
// No network access. Provider HTTP mapping uses a stubbed global fetch;
// run-level failover uses injected stub adapters (same pattern as
// integration.test.js M/N).

process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = 'backend/.runtime-data-test';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');

const {
  isModelAccessFailure,
  OpenRouterAdapter,
  ProviderError,
  ProviderRegistry,
} = require('../src/providers/provider-adapter');
const { Orchestrator } = require('../src/core/orchestrator');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryModelRouter } = require('../src/impl/model-router');
const { InMemoryContextManager } = require('../src/impl/context-manager');
const { InMemoryMemoryManager } = require('../src/impl/memory-manager');
const { InMemoryCacheManager } = require('../src/impl/cache-manager');
const { InMemoryToolRegistry } = require('../src/impl/tool-registry');
const { InMemoryToolExecutor } = require('../src/impl/tool-executor');
const { CostEstimator } = require('../src/cost/cost-estimator');
const { TaskStatus } = require('../src/core/types');
const { eventBus } = require('../src/events/event-bus');
const { buildSnapshot } = require('../src/api/snapshot');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.message}`);
    failed++;
  }
}

function fakeRuntime() {
  return {
    runId: 'run-failover-test',
    task: { objective: 'Say hello briefly' },
    context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
    model: { currentModel: null, getPricing: () => ({}), modelLatency: 0 },
    budget: { getRemainingBudget: () => 1.0 },
    policy: {},
  };
}

const HELIUM = {
  id: 'helium-b', name: 'Helium B', provider: 'openrouter', status: 'healthy',
  contextWindow: 64000, quality: 0.99, avgLatencyMs: 100, reliability: 0.99,
  inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001,
  capabilities: ['text'], source: 'discovered', nativeId: 'helium-b',
};
const FALLBACK = {
  id: 'ferrite-c', name: 'Ferrite C', provider: 'openrouter', status: 'healthy',
  contextWindow: 64000, quality: 0.5, avgLatencyMs: 100, reliability: 0.9,
  inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001,
  capabilities: ['text'], source: 'discovered', nativeId: 'ferrite-c',
};

function makeOrchestrator(models, completeImpl) {
  const registry = new InMemoryModelRegistry(models.map((m) => ({ ...m })));
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.seedTools([
    { name: 'read_file', description: 'read', status: 'enabled', costPerCall: 0.0002, timeoutMs: 10000, permissions: ['workspace:read'], capabilities: ['read'], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
  const toolExecutor = new InMemoryToolExecutor(toolRegistry, null, { workspace: process.cwd() });
  const providerRegistry = new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 5000 }, {
    createAdapter: () => ({
      providerId: 'openrouter',
      hasCredentials: true,
      defaultModel: 'helium-b',
      complete: completeImpl,
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
    config: { mode: 'live', provider: 'openrouter', maxSteps: 4, maxToolCalls: 5, maxRetries: 1 },
  });
  return orch;
}

function okCompletion(text) {
  return { text, toolCalls: [], usage: { inputTokens: 50, outputTokens: 20, cachedTokens: 0 }, latencyMs: 5, model: 'ferrite-c', provider: 'openrouter', stopReason: 'stop' };
}

// OpenRouter access-tier refusal shape: 404, model named, not served.
function accessTierError() {
  return new ProviderError(
    'openrouter request failed: No endpoints found for helium-b (model is unavailable for free tier)',
    { code: 'model_unavailable', retryable: false, status: 404, provider: 'openrouter' }
  );
}

async function main() {
  // ---------- classification (pure, no network) ----------
  await test('access-tier refusal classifies as model_unavailable (not auth/rate-limit)', () => {
    assert.strictEqual(isModelAccessFailure(404, 'No endpoints found for helium-b'), true, 'openrouter 404 names the model');
    assert.strictEqual(isModelAccessFailure(404, 'Model not found'), true);
    assert.strictEqual(isModelAccessFailure(400, 'No endpoints found for helium-b'), true);
    assert.strictEqual(isModelAccessFailure(403, 'Model helium-b is not allowed for your key'), true, 'tier/key-scoped 403');
    assert.strictEqual(isModelAccessFailure(401, 'invalid key'), false, 'key auth stays auth');
    assert.strictEqual(isModelAccessFailure(403, 'invalid key'), false, 'key auth stays auth');
    assert.strictEqual(isModelAccessFailure(429, 'slow down'), false, 'rate limit untouched');
    assert.strictEqual(isModelAccessFailure(500, 'boom'), false, 'server errors stay retryable-unavailable');
    assert.strictEqual(isModelAccessFailure(400, 'bad request'), false, 'generic 400 stays bad_request');
  });

  await test('adapter maps the OpenRouter 404 body to model_unavailable via stubbed fetch', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'No endpoints found for helium-b', code: 404 } }),
    });
    try {
      const a = new OpenRouterAdapter({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
      await assert.rejects(a.complete({ model: 'helium-b', messages: [] }), (e) => {
        assert.ok(e instanceof ProviderError);
        assert.strictEqual(e.code, 'model_unavailable', `got ${e.code}`);
        assert.strictEqual(e.retryable, false, 'same-model retry must not be attempted');
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ---------- 1. unavailable excluded from candidate selection ----------
  await test('1. unavailable model is excluded from candidate selection', async () => {
    const registry = new InMemoryModelRegistry([
      { ...HELIUM, status: 'unavailable' },
      { ...FALLBACK, status: 'healthy' },
    ]);
    const router = new InMemoryModelRouter(registry);
    const rt = fakeRuntime();
    const { selectedModel, evaluation } = await router.route(
      { objective: 'Say hello briefly' }, rt, await registry.getModels(), {}
    );
    assert.strictEqual(selectedModel, 'ferrite-c', 'healthy candidate selected over unavailable helium');
    assert.ok(!evaluation.candidates.some((c) => c.modelId === 'helium-b'), 'unavailable model not even scored');
  });

  await test('1b. all-unavailable pool fails fast with a clear reason', async () => {
    const registry = new InMemoryModelRegistry([{ ...HELIUM, status: 'unavailable' }]);
    const router = new InMemoryModelRouter(registry);
    await assert.rejects(
      router.route({ objective: 'hi' }, fakeRuntime(), await registry.getModels(), {}),
      (e) => {
        assert.strictEqual(e.code, 'no_models');
        assert.ok(/unavailable/i.test(e.message), `clear reason, got: ${e.message}`);
        return true;
      }
    );
  });

  // ---------- 2/3/5/6. request-time failure -> failover, no repeat, recorded, visible ----------
  await test('2/3/5/6. access-tier failure fails over once, never repeats helium, records the switch, snapshot shows fallback', async () => {
    const seenModels = [];
    const orch = makeOrchestrator([HELIUM, FALLBACK], async (req) => {
      seenModels.push(req.model);
      if (req.model === 'helium-b') throw accessTierError();
      return okCompletion('Recovered on fallback. Task complete, no further actions.');
    });
    const rs = await orch.createRun('failover e2e', {});
    await orch.startRun(rs.runId, 'Say hello briefly.');
    await orch.waitForCompletion(rs.runId, 60000);

    const run = orch.getRun(rs.runId);
    assert.ok(run, 'run queryable');
    assert.strictEqual(run.status, TaskStatus.COMPLETED, `run completed after failover, got ${run.status}`);
    // 6. UI-facing state: final model + reason.
    assert.strictEqual(run.model.currentModel, 'ferrite-c', 'final model is the fallback');
    const snap = buildSnapshot(orch, rs.runId);
    assert.ok(snap, 'snapshot exists');
    assert.strictEqual(snap.activeModelId, 'ferrite-c');
    assert.strictEqual(snap.routing.currentId, 'ferrite-c');
    // 3. helium was tried exactly once — never repeated after access failure.
    assert.deepStrictEqual(seenModels, ['helium-b', 'ferrite-c'], `provider saw each model once, got ${JSON.stringify(seenModels)}`);
    const ctrl = orch.control(rs.runId);
    assert.ok(ctrl.triedModels.has('helium-b'), 'failed model recorded as tried');
    // Request-time availability recorded so routing excludes helium afterwards.
    assert.strictEqual((await orch.modelRegistry.getModel('helium-b')).status, 'unavailable', 'helium marked unavailable in registry');
    // 5. switch decision + event recorded with the failover reason.
    const trace = ctrl.trace || [];
    const switched = trace.filter((t) => t.type === 'model.switched');
    assert.ok(switched.length >= 1, 'model.switched event emitted');
    assert.ok(/model_unavailable|Failover/i.test(switched[0].label), `reason carried, got: ${switched[0].label}`);
    assert.ok((ctrl.decisions || []).length >= 1, 'failover decision recorded');
    const unavailableEvents = (ctrl.trace || []).filter((t) => t.type === 'model.unavailable');
    assert.ok(unavailableEvents.length >= 1, 'model.unavailable event emitted for helium');
  });

  // ---------- 4. exhaustion fails honestly ----------
  await test('4. all viable models exhausted -> run fails with a clear reason', async () => {
    const seenModels = [];
    const orch = makeOrchestrator([HELIUM], async (req) => {
      seenModels.push(req.model);
      throw accessTierError();
    });
    const rs = await orch.createRun('failover exhausted', {});
    await orch.startRun(rs.runId, 'Say hello briefly.');
    await orch.waitForCompletion(rs.runId, 60000);

    const run = orch.getRun(rs.runId);
    assert.ok(run, 'run queryable');
    assert.strictEqual(run.status, TaskStatus.FAILED, `run failed honestly, got ${run.status}`);
    assert.deepStrictEqual(seenModels, ['helium-b'], 'no blind repeat of the inaccessible model');
    const ctrl = orch.control(rs.runId);
    const failTrace = (ctrl.trace || []).filter((t) => t.type === 'run.failed');
    assert.ok(failTrace.length >= 1, 'run.failed traced');
    // The full reason lives in the event payload (trace labels truncate);
    // both must name the model and the exhaustion.
    const failEvents = (eventBus.eventLogs.get(rs.runId) || []).filter((e) => e.type === 'run.failed');
    assert.ok(failEvents.length >= 1, 'run.failed event emitted');
    const errText = String((failEvents[0].payload || {}).error || '');
    assert.ok(/helium-b/.test(errText) && /no viable alternative/i.test(errText),
      `clear exhaustion reason, got: ${errText.slice(0, 200)}`);
    assert.ok(/helium-b/.test(failTrace[0].label), `trace names the model, got: ${failTrace[0].label}`);
    const snap = buildSnapshot(orch, rs.runId);
    assert.strictEqual(snap.status, 'failed', 'UI-facing status is failed (not stuck, not fake success)');
  });

  // ---------- P0-5: no silent model substitution ----------
  await test('P0-5.1 live selection excludes candidates without a provider-native mapping', async () => {
    const unmapped = { ...HELIUM, quality: 0.99 };
    delete unmapped.nativeId;
    const orch = makeOrchestrator([unmapped, FALLBACK], async (req) => okCompletion('done'));
    const rs = await orch.createRun('p05 selection', {});
    await orch.startRun(rs.runId, 'Say hello briefly.');
    await orch.waitForCompletion(rs.runId, 60000);
    const run = orch.getRun(rs.runId);
    assert.strictEqual(run.status, TaskStatus.COMPLETED);
    assert.strictEqual(run.model.currentModel, 'ferrite-c', 'mapped candidate selected, unmapped never reported');
  });

  await test('P0-5.2 all-unmapped live pool fails honestly (no default substitution)', async () => {
    const unmapped = { ...HELIUM };
    delete unmapped.nativeId;
    const orch = makeOrchestrator([unmapped], async () => okCompletion('must never run'));
    const rs = await orch.createRun('p05 exhausted', {});
    await orch.startRun(rs.runId, 'Say hello briefly.');
    await orch.waitForCompletion(rs.runId, 60000);
    const run = orch.getRun(rs.runId);
    assert.strictEqual(run.status, TaskStatus.FAILED, 'honest failure instead of silent substitution');
    const events = (eventBus.eventLogs.get(rs.runId) || []).filter((e) => e.type === 'run.failed');
    assert.ok(events.length >= 1);
    assert.ok(/provider-native mapping|No available models/i.test(String(events[0].payload.error || '')),
      `clear resolution reason, got: ${String(events[0].payload.error || '').slice(0, 160)}`);
  });

  await test('P0-5.3 request-time guard refuses unmapped ids (never the provider default)', async () => {
    const seenModels = [];
    const unmapped = { ...HELIUM, quality: 0.99 };
    delete unmapped.nativeId;
    const orch = makeOrchestrator([unmapped, FALLBACK], async (req) => {
      seenModels.push(req.model);
      return okCompletion('done');
    });
    // Bypass selection: force the current model to the unmapped id, as if a
    // stale/external selection reached execution. The guard must reject
    // before any provider call (never substituting the provider default).
    const rs = await orch.createRun('p05 guard', {});
    const ctrl = orch.control(rs.runId);
    const unmappedDef = await orch.modelRegistry.getModel('helium-b');
    rs.model.setCurrentModel('helium-b', 'openrouter', 'forced for guard test');
    ctrl.providerModel = unmappedDef;
    await assert.rejects(orch._callModel(rs, 'Say hello briefly.', 1), (e) => {
      assert.strictEqual(e.code, 'model_resolution', `got ${e.code}`);
      assert.ok(/no provider-native mapping/i.test(e.message));
      return true;
    });
    assert.deepStrictEqual(seenModels, [], 'provider never called for the unmapped id');
  });

  console.log(`\n--- Model-failover results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('model-failover harness failed:', e); process.exit(1); });
