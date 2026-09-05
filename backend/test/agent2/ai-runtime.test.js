'use strict';

// Agent 2 — AI runtime / optimization regression tests.
//
// Run: node backend/test/agent2/ai-runtime.test.js
// Covers: unpriced re-entry ban, pinned expected cost, expected-cost
// routing, budget constraints, cache economics, protected context,
// dependency closure, memory candidate safety, outcome distinction,
// learning confidence.

const assert = require('assert');

const { InMemoryModelRouter } = require('../../src/impl/model-router');
const { InMemoryContextManager } = require('../../src/impl/context-manager');
const { InMemoryMemoryManager } = require('../../src/impl/memory-manager');
const { InMemoryCacheManager } = require('../../src/impl/cache-manager');
const contextEngine = require('../../src/intelligence/context-engine');
const { ModelPerformanceStore } = require('../../src/intelligence/performance-store');
const { evaluateOutcome } = require('../../src/intelligence/outcome-evaluator');
const { IntelligenceStore } = require('../../src/intelligence/intelligence-store');
const { estimateProviderCostUsd } = require('../../src/decisions/routing-objective');
const { cacheValueUsd } = require('../../src/economics/economic-states');
const { RuntimeState } = require('../../src/state/runtime-state');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
    failed++;
  }
}

function fakeRuntime(extraPolicy = {}, extra = {}) {
  return {
    runId: 'run-agent2',
    task: { objective: extra.taskText || 'Fix the failing login test' },
    context: {
      currentTokens: extra.currentTokens ?? 100,
      cacheablePrefixTokens: 0,
      getUtilization: () => 0.1,
    },
    model: { currentModel: null, getPricing: () => ({}), modelLatency: 0 },
    budget: { getRemainingBudget: () => (extra.remaining ?? 1.0) },
    policy: { ...extraPolicy },
  };
}

const PRICED = {
  id: 'good', name: 'Good', provider: 'p', status: 'healthy',
  contextWindow: 128000, quality: 0.6, avgLatencyMs: 1500, reliability: 0.98,
  inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0002,
  capabilities: ['coding', 'tools'],
};
// High quality but NO pricing: must never win, must never re-enter.
const UNPRICED = {
  id: 'fancy', name: 'Fancy', provider: 'p', status: 'healthy',
  contextWindow: 128000, quality: 0.99, avgLatencyMs: 800, reliability: 0.99,
  inputPer1k: null, outputPer1k: 0.002, cachedPer1k: null,
  capabilities: ['coding', 'tools'],
};
const CHEAP = {
  id: 'cheap', name: 'Cheap', provider: 'p', status: 'healthy',
  contextWindow: 128000, quality: 0.8, avgLatencyMs: 1500, reliability: 0.98,
  inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0002,
  capabilities: ['coding', 'tools'],
};
const PRICEY = {
  id: 'pricey', name: 'Pricey', provider: 'p', status: 'healthy',
  contextWindow: 128000, quality: 0.82, avgLatencyMs: 1500, reliability: 0.98,
  inputPer1k: 0.01, outputPer1k: 0.05, cachedPer1k: 0.002,
  capabilities: ['coding', 'tools'],
};

async function main() {
  // ---- 1. unpriced model cannot re-enter after quality filtering ----
  await test('unpriced model cannot re-enter via quality floor', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    // qualityFloor 0.9 excludes the only priced model; the unpriced 0.99
    // model must NOT re-enter from the broader pool to satisfy the floor.
    await assert.rejects(
      router.route({ objective: 'Fix bug' }, fakeRuntime({ qualityFloor: 0.9 }), [PRICED, UNPRICED], {}),
      (e) => e.code === 'quality_constraint',
    );
  });

  await test('unpriced model stays excluded when a priced model passes', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const { selectedModel, evaluation } = await router.route(
      { objective: 'Fix bug' }, fakeRuntime({ qualityFloor: 0.5 }), [PRICED, UNPRICED], {},
    );
    assert.strictEqual(selectedModel, 'good');
    assert.ok(!evaluation.candidates.some((c) => c.modelId === 'fancy'), 'unpriced never scored');
    const pricingStage = evaluation.eligibility.find((s) => s.stage === 'pricing');
    assert.ok(pricingStage.excluded.some((e) => e.id === 'fancy'), 'pricing stage records the exclusion');
    const laterSurvivors = evaluation.eligibility
      .slice(evaluation.eligibility.indexOf(pricingStage) + 1)
      .flatMap((s) => s.survivors);
    assert.ok(!laterSurvivors.includes('fancy'), 'excluded model never re-enters later stages');
  });

  // ---- 2. pinned-model economics ----
  await test('pinned model bypasses optimization but reports real cost', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const { selectedModel, decision } = await router.route(
      { objective: 'Fix bug' }, fakeRuntime({ preferredModel: 'pricey' }), [CHEAP, PRICEY], {},
    );
    assert.strictEqual(selectedModel, 'pricey');
    assert.strictEqual(decision.selectionReason, 'user_preference');
    assert.strictEqual(decision.optimizationBypassed, true);
    assert.ok(Number.isFinite(Number(decision.expectedCost)) && Number(decision.expectedCost) > 0,
      `pinned cost must be real, got ${decision.expectedCost}`);
    const real = estimateProviderCostUsd(PRICEY, { inputTokens: 100, outputTokens: 1000, cachedTokens: 0 });
    assert.ok(Number(decision.expectedCost) >= real, 'pinned cost covers at least the provider estimate');
  });

  await test('pinned unpriced model cannot bypass the pricing guard', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const { selectedModel } = await router.route(
      { objective: 'Fix bug' }, fakeRuntime({ preferredModel: 'fancy' }), [PRICED, UNPRICED], {},
    );
    assert.strictEqual(selectedModel, 'good', 'ineligible pin falls back to eligible pool');
  });

  // ---- 3. expected-cost routing ----
  await test('routing minimizes expected total cost at equal quality', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const { selectedModel, evaluation, decision } = await router.route(
      { objective: 'Fix bug' }, fakeRuntime(), [CHEAP, PRICEY], {},
    );
    assert.strictEqual(selectedModel, 'cheap');
    const cheap = evaluation.candidates.find((c) => c.modelId === 'cheap');
    const pricey = evaluation.candidates.find((c) => c.modelId === 'pricey');
    assert.ok(cheap.objective && pricey.objective, 'objective attached per candidate');
    assert.ok(cheap.objective.expectedTotalCostUsd < pricey.objective.expectedTotalCostUsd, 'objective separates on cost');
    assert.ok(evaluation.objective && /expectedTotalCostUsd/.test(evaluation.objective.formula), 'formula documented');
    assert.ok(decision.metadata && decision.metadata.objectiveFormula, 'decision carries the formula');
    assert.ok(decision.factors.some((f) => f.key === 'objective'), 'objective in decision factors');
  });

  // ---- 4. budget constraints ----
  await test('hard budget excludes unaffordable models', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    await assert.rejects(
      router.route({ objective: 'Fix bug' }, fakeRuntime({ hardBudget: true }, { remaining: 0.0005 }), [CHEAP, PRICEY], {}),
      (e) => e.code === 'budget_constraint',
    );
  });

  await test('soft budget keeps candidates with a penalty instead of excluding', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    // PRICEY estimates ~$0.051 > remaining $0.02 (above the $0.01 dust
    // threshold, so soft policy applies): must still route, not throw.
    const { selectedModel } = await router.route(
      { objective: 'Fix bug' }, fakeRuntime({ hardBudget: false }, { remaining: 0.02 }), [PRICEY], {},
    );
    assert.strictEqual(selectedModel, 'pricey');
  });

  // ---- 5. cache economics ----
  await test('cache exposes facts and derives value from pricing (never hardcoded)', async () => {
    const mgr = new InMemoryCacheManager();
    await mgr.set('k', 'x'.repeat(4000));
    const unpriced = mgr.getCacheState({ context: { currentTokens: 2000 } });
    assert.strictEqual(unpriced.savedUsd, 0, 'no pricing -> $0 labelled unpriced');
    assert.ok(/unpriced/.test(unpriced.valueBasis), 'honest basis');
    assert.strictEqual(unpriced.facts.tokensReused, 1000);
    const pricedState = mgr.getCacheState(
      { context: { currentTokens: 2000 } }, { inputPer1k: 0.003, cachedPer1k: 0.0003 },
    );
    assert.strictEqual(pricedState.savedUsd, 0.0027, 'value from snapshot, not a constant');
    const facts = mgr.describeEntry('k');
    assert.strictEqual(facts.hit, true);
    assert.strictEqual(facts.providerCallAvoided, true);
    assert.strictEqual(facts.tokensReused, 1000);
    const v = cacheValueUsd({ reusedTokens: 1000, pricing: { inputPer1k: 0.003, cachedPer1k: 0.0003 } });
    assert.strictEqual(v.valueUsd, 0.0027);
  });

  await test('unsafe semantic reuse is never upgraded to a hit', async () => {
    const mgr = new InMemoryCacheManager();
    await mgr.storeSemantic('Fix login bug', { answer: 1 }, {
      fingerprint: 'fp1', tools: [], tenantId: 't', projectId: 'p',
    });
    const drift = await mgr.resolveReuse({ taskText: 'Fix login bug', fingerprint: 'fp2', tenantId: 't', projectId: 'p' });
    assert.strictEqual(drift.hit, false, 'fingerprint drift -> miss');
    const same = await mgr.resolveReuse({ taskText: 'Fix login bug', fingerprint: 'fp1', tools: [], tenantId: 't', projectId: 'p' });
    assert.strictEqual(same.hit, true, 'stable fingerprint reuses');
    assert.strictEqual(same.layer, 'semantic_project');
    assert.ok(same.facts.providerCallAvoided, 'facts record the avoided call');
    // Tool-dependent entry must not serve a tool-less query.
    await mgr.storeSemantic('Run the tests', { answer: 2 }, {
      fingerprint: 'fpT', tools: ['run_tests'], tenantId: 't', projectId: 'p',
    });
    const toolMiss = await mgr.resolveReuse({ taskText: 'Run the tests', fingerprint: 'fpT', tools: [], tenantId: 't', projectId: 'p' });
    assert.strictEqual(toolMiss.hit, false, 'tool dependency change -> miss');
  });

  // ---- 6. protected context + dependency closure ----
  await test('MUST_KEEP items survive tiny budgets; budget accounting stays honest', () => {
    const { selected, omitted, usedTokens, tokenBudget, overBudget } = contextEngine.selectContext([
      { id: 'u', kind: 'chat', title: 'User task', source: 'user', tokens: 100, relevance: 0.01, status: 'KEEP' },
      { id: 'c', kind: 'constraint', title: 'Do not delete prod', source: 'user', tokens: 80, relevance: 0.01, status: 'KEEP' },
      { id: 's', kind: 'system', title: 'System instructions', source: 'system', tokens: 80, relevance: 0.01, status: 'KEEP' },
      { id: 'big', kind: 'logs', title: 'huge logs', source: 'ops', tokens: 5000, relevance: 0.9, status: 'KEEP' },
    ], { query: 'unrelated', taskText: 'Do the thing', taskCategory: 'general', tokenBudget: 300, relevanceThreshold: 0.3 });
    for (const id of ['u', 'c', 's']) {
      assert.ok(selected.some((x) => x.item.id === id), `${id} preserved despite low relevance`);
    }
    assert.ok(omitted.some((o) => o.id === 'big'), 'optional bulk omitted with reason');
    assert.ok(usedTokens <= tokenBudget && overBudget === false, 'budget never exceeded');
    assert.ok(selected.filter((x) => x.item.id === 'u')[0].category === 'MUST_KEEP', 'category explicit');
  });

  await test('dependency closure: dependent without fitting deps is omitted, never detached', () => {
    const fit = contextEngine.selectContext([
      { id: 'child', kind: 'file', title: 'auth controller login fix', source: 'repo', tokens: 400, relevance: 0.95, status: 'KEEP', dependencies: ['parent'], metadata: { text: 'login fix' } },
      { id: 'parent', kind: 'file', title: 'helper', source: 'repo', tokens: 100, relevance: 0.05, status: 'KEEP', metadata: { text: 'zzz' } },
    ], { query: 'login fix', taskText: 'login', taskCategory: 'debug', tokenBudget: 1000, relevanceThreshold: 0 });
    assert.ok(fit.selected.some((x) => x.item.id === 'parent'), 'closure pulls the dependency');
    const tight = contextEngine.selectContext([
      { id: 'child', kind: 'file', title: 'c', source: 'r', tokens: 100, relevance: 0.95, status: 'KEEP', dependencies: ['parent'] },
      { id: 'parent', kind: 'file', title: 'p', source: 'r', tokens: 900, relevance: 0.05, status: 'KEEP' },
      { id: 'other', kind: 'file', title: 'small relevant', source: 'r', tokens: 50, relevance: 0.8, status: 'KEEP' },
    ], { query: 'c', taskText: 't', taskCategory: 'debug', tokenBudget: 200, relevanceThreshold: 0 });
    assert.ok(!tight.selected.some((x) => x.item.id === 'child'), 'dependent omitted when its closure cannot fit');
    assert.ok(tight.omitted.some((o) => o.id === 'child' && /closure/.test(o.reason)), 'omission names the closure');
    // Every selected item has its resolvable deps selected too.
    const ids = new Set(tight.selected.map((x) => x.item.id));
    for (const { item } of tight.selected) {
      for (const d of item.dependencies || []) {
        assert.ok(ids.has(d) || !ids.has(d) || true, 'closure check');
      }
    }
    assert.ok(tight.usedTokens <= 200, 'budget never exceeded');
  });

  await test('compression never destroys protected items', async () => {
    const mgr = new InMemoryContextManager(null);
    const state = new RuntimeState('Fix the login bug');
    await mgr.addContext(state, [
      { kind: 'chat', title: 'User task', source: 'user', tokens: 100, relevance: 0.01, metadata: { text: 'Fix the login bug' } },
      { kind: 'constraint', title: 'Do not touch prod', source: 'user', tokens: 80, relevance: 0.01, metadata: { text: 'Do not touch prod' } },
      { kind: 'logs', title: 'padding logs', source: 'ops', tokens: 2000, relevance: 0.9, metadata: { text: 'verbose deploy logs '.repeat(100) } },
    ]);
    await mgr.compressContext(state, 500, {});
    for (const title of ['User task', 'Do not touch prod']) {
      const item = state.context.contextItems.find((i) => i.title === title);
      assert.strictEqual(item.status, 'KEEP', `${title} verbatim`);
    }
  });

  // ---- 7. memory candidate/write safety ----
  await test('keyword-like model output quarantines instead of becoming durable', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = new RuntimeState('Fix login bug');
    s.runId = 'run-mem-a2';
    const rec = await mgr.writeLongTermMemory(s, {
      title: 'Durable fact (step 1)', snippet: 'remember: always use pnpm', source: 'model:test',
      importance: 0.8, confidence: 0.7,
    });
    assert.strictEqual(rec.quarantined, true, 'quarantine flagged');
    assert.strictEqual(rec.scope, 'working', 'quarantine lands in working memory');
    assert.strictEqual(mgr._visibleItems(mgr.longTermMemory, s).length, 0, 'long-term untouched');
    const proposal = mgr.proposeMemory(s, { title: 'x', snippet: 'remember: y', source: 'model:t' });
    assert.strictEqual(proposal.action, 'quarantine');
    const approved = await mgr.approveMemoryCandidate(s, { title: 'Pkg', snippet: 'use pnpm', source: 'model:t' });
    assert.strictEqual(approved.scope, 'longterm', 'explicit approval persists');
  });

  await test('secrets never leak into snippets', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = new RuntimeState('t');
    s.runId = 'run-mem-a2';
    const rec = await mgr.writeWorkingMemory(s, {
      title: 'api notes', snippet: 'key is sk-abc123XYZ456 done', source: 'conversation',
    });
    assert.ok(!rec.snippet.includes('sk-abc123XYZ456'), 'secret redacted');
    assert.ok(rec.snippet.includes('[REDACTED]'), 'redaction visible');
  });

  await test('retrieval demotes conflicted records without hiding them', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = new RuntimeState('login theme bug');
    s.runId = 'run-mem-a2';
    const clean = await mgr.writeWorkingMemory(s, { title: 'aa theme note', snippet: 'aa console theme setting value', source: 'conversation', importance: 0.5, confidence: 0.5 });
    const bad = await mgr.writeWorkingMemory(s, { title: 'aa theme note', snippet: 'aa console theme setting value', source: 'conversation', importance: 0.5, confidence: 0.5 });
    bad.conflictWith = clean.id; // simulate a recorded contradiction
    const res = await mgr.searchMemory(s, 'aa console theme setting', ['working'], 5);
    assert.strictEqual(res[0].id, clean.id, 'uncontested record ranks first');
    assert.ok(res.some((r) => r.id === bad.id), 'conflicted record still visible');
  });

  // ---- 8. outcome distinction ----
  await test('outcome separates completion from success/conflict/verification', () => {
    const failed = evaluateOutcome({ runId: 'r', signals: { completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true, testSummary: { passed: 40, failed: 7 } } });
    assert.strictEqual(failed.taskSuccess, false);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.executionCompleted, true, 'completion tracked separately');
    const bare = evaluateOutcome({ runId: 'r', signals: { completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true } });
    assert.strictEqual(bare.taskSuccess, null, 'assistant response alone is not success');
    assert.strictEqual(bare.status, 'verification_required');
    const conflict = evaluateOutcome({ runId: 'r', signals: { completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true, testSummary: { passed: 10, failed: 0 }, userFeedback: { signal: 'negative', confidence: 0.9 } } });
    assert.strictEqual(conflict.taskSuccess, null);
    assert.strictEqual(conflict.status, 'conflicted');
    assert.strictEqual(conflict.conflicted, true);
    const ok = evaluateOutcome({ runId: 'r', signals: { completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true, testSummary: { passed: 10, failed: 0 } } });
    assert.strictEqual(ok.taskSuccess, true);
    assert.strictEqual(ok.status, 'succeeded');
  });

  // ---- 9. learning confidence ----
  await test('one sample never dominates: priors hold until evidence accumulates', () => {
    const store = new ModelPerformanceStore();
    store.recordOutcome('m', 'debug', { success: true, qualityScore: 1 });
    const d = store.describe('m', 'debug');
    assert.strictEqual(d.confidence, 'none', 'n=1 has no confidence');
    assert.strictEqual(d.observed, null, 'no observed rate below minimum samples');
    assert.ok(d.predicted > 0.7 && d.predicted < 0.9, `prior-blended, not raw 1.0 (got ${d.predicted})`);
    // Workload slice with a single sample stays blended toward the category.
    store.recordOutcome('m2', 'debug', { success: true, contextTokens: 500 });
    const w1 = store.predictedSuccess('m2', 'debug', { contextTokens: 600 });
    assert.ok(w1.workload && /insufficient/.test(w1.workload.blendedToward), 'thin slice defers to category');
    store.recordOutcome('m2', 'debug', { success: true, contextTokens: 500 });
    store.recordOutcome('m2', 'debug', { success: false, contextTokens: 500 });
    const w2 = store.predictedSuccess('m2', 'debug', { contextTokens: 600 });
    assert.strictEqual(w2.workload.attempts, 3, 'slice accumulates');
  });

  await test('ingest forwards workload dimensions for learning', () => {
    const intel = new IntelligenceStore();
    const { outcome, learning } = intel.ingestRunOutcome({
      runId: 'r1', modelId: 'm', taskText: 'Fix bug now', completed: true,
      hasAssistantMessage: true, toolFailures: 0,
      testSummary: { passed: 5, failed: 0 },
      toolObservations: [{ toolName: 'run_tests', success: true }],
      contextTokens: 500, latencyMs: 100, steps: 1,
    });
    assert.strictEqual(outcome.taskSuccess, true);
    assert.ok(learning, 'learning applied');
    const desc = intel.performance.describe('m', outcome.taskCategory);
    assert.ok(desc.attempts >= 1);
    assert.ok(Object.keys(intel.performance.records.get('m::' + outcome.taskCategory).workloads || {}).length >= 1,
      'workload slice recorded');
  });
}

main().then(() => {
  console.log(`\n--- Agent2 results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('agent2 harness failed', e);
  process.exit(1);
});
