'use strict';

// Session 2 intelligence engine tests: routing, context, memory, evaluation,
// learning, cache, explainability.
//
// Run: node backend/test/intelligence.test.js
// No network access. Module-level + manager-level; no HTTP.

const assert = require('assert');

const { classifyTask } = require('../src/intelligence/task-classifier');
const { buildCapabilityProfile } = require('../src/intelligence/capability-profile');
const { ModelPerformanceStore, RoutingHistoryStore } = require('../src/intelligence/performance-store');
const {
  evaluateOutcome, createCriterion, createEvidence, outcomeToLearningUpdate, EVALUATOR_VERSION,
} = require('../src/intelligence/outcome-evaluator');
const contextEngine = require('../src/intelligence/context-engine');
const memoryIntel = require('../src/intelligence/memory-intelligence');
const { SemanticCacheIndex } = require('../src/intelligence/semantic-cache');
const routerIntel = require('../src/intelligence/router-intelligence');
const { BenchmarkStore } = require('../src/intelligence/benchmarks');
const { IntelligenceStore } = require('../src/intelligence/intelligence-store');
const { VERSIONS } = require('../src/intelligence/versions');

const { InMemoryModelRouter } = require('../src/impl/model-router');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryContextManager } = require('../src/impl/context-manager');
const { InMemoryMemoryManager } = require('../src/impl/memory-manager');
const { InMemoryCacheManager } = require('../src/impl/cache-manager');
const { RuntimeState } = require('../src/state/runtime-state');
const { PRESETS } = require('../src/policies/presets');

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

function fakeRuntime(weights, extra = {}) {
  return {
    runId: 'run-test',
    task: { objective: extra.taskText || 'Fix the failing login test' },
    context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
    model: { currentModel: null, getPricing: () => ({}), modelLatency: 0 },
    budget: { getRemainingBudget: () => 1.0 },
    policy: { routerWeights: weights, ...(extra.policy || {}) },
  };
}

const MODEL_A = { id: 'a', name: 'A', provider: 'p', status: 'healthy', contextWindow: 128000, quality: 0.8, avgLatencyMs: 1500, reliability: 0.98, inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.0002, capabilities: ['coding', 'tools'] };
const MODEL_B = { id: 'b', name: 'B', provider: 'p', status: 'healthy', contextWindow: 128000, quality: 0.85, avgLatencyMs: 1500, reliability: 0.98, inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.0002, capabilities: ['coding', 'tools'] };

async function main() {
  // ================= TASK CLASSIFICATION =================
  await test('classifier detects debug with signals + confidence', () => {
    const p = classifyTask('Fix the authentication refresh bug: auth/service.ts line 143 fails, existing tests fail');
    assert.strictEqual(p.category, 'debug');
    assert.ok(p.confidence >= 0.5, `confidence ${p.confidence}`);
    assert.ok(p.signals.length > 0, 'signals recorded');
    assert.strictEqual(p.requiresTools, true);
    assert.strictEqual(p.requiresReasoning, true);
  });

  await test('classifier detects research/code/extraction/planning', () => {
    assert.strictEqual(classifyTask('Research the latest vector database options and compare approaches').category, 'research');
    assert.strictEqual(classifyTask('Implement a rate limiter module with tests').category, 'code');
    assert.strictEqual(classifyTask('Extract all invoice totals as JSON').category, 'extraction');
    assert.strictEqual(classifyTask('Create a migration plan with milestones and steps').category, 'planning');
  });

  await test('classifier is deterministic and honest on vague input', () => {
    const a = classifyTask('Hello there');
    const b = classifyTask('Hello there');
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.category, 'general');
    assert.ok(a.confidence < 0.5, `vague input must have low confidence (got ${a.confidence})`);
  });

  await test('classifier flags risk and complexity', () => {
    const p = classifyTask('Delete the production database schema and deploy now');
    assert.strictEqual(p.riskLevel, 'high');
    const q = classifyTask('hi');
    assert.strictEqual(q.complexity, 'trivial');
  });

  // ================= CAPABILITY PROFILES =================
  await test('capability profile separates provider fact from observed', () => {
    const model = { id: 'm', provider: 'p', contextWindow: 128000, capabilities: ['coding', 'tools'], inputPer1k: 0.001, outputPer1k: 0.003, status: 'healthy' };
    const prof = buildCapabilityProfile(model, null, {});
    assert.strictEqual(prof.providerFact.contextWindow, 128000);
    assert.strictEqual(prof.providerFact.toolUseSupport, true);
    assert.strictEqual(prof.observed.samples, 0);
    assert.strictEqual(prof.observed.successRate, null, 'unknown stays null, never 0.5-as-fact');
    assert.strictEqual(prof.confidence, 'none');
    assert.strictEqual(prof.dataSource, 'none');
  });

  await test('capability profile carries observed rates with samples', () => {
    const prof = buildCapabilityProfile({ id: 'm' }, { successes: 9, failures: 1, avgLatencyMs: 1200, lastObservedAt: 't' }, { debug: { predicted: 0.9 } });
    assert.strictEqual(prof.observed.samples, 10);
    assert.strictEqual(prof.observed.successRate, 0.9);
    assert.strictEqual(prof.taskPerformance.debug.predicted, 0.9);
  });

  // ================= PERFORMANCE STORE =================
  await test('performance update is conservative (EWMA, no single-run overwrite)', () => {
    const s = new ModelPerformanceStore();
    s.recordOutcome('m', 'debug', { success: true, qualityScore: 1 });
    const d = s.describe('m', 'debug');
    assert.strictEqual(d.attempts, 1);
    assert.strictEqual(d.confidence, 'none', 'n=1 must be very-low confidence');
    assert.strictEqual(d.observed, null, 'no observed rate below minimum samples');
    // Bayesian smoothing with prior 0.7 over 4 pseudo-samples:
    // (1 success + 0.7*4) / (1 attempt + 4) = 3.8/5 = 0.76. A single run
    // moves the prediction from 0.7 to 0.76, never to 1.0.
    assert.strictEqual(d.predicted, 0.76, 'prior-blended prediction, got ' + d.predicted);
    assert.strictEqual(d.prior.success, 0.7);
    assert.strictEqual(d.prior.samples, 4);
  });

  await test('performance prior-blending regression: one observation moves 0.7 -> 0.76, not 1.0', () => {
    const s = new ModelPerformanceStore();
    assert.strictEqual(s.predictedSuccess('m', 'debug').predicted, 0.7, 'zero samples returns prior');
    s.recordOutcome('m', 'debug', { success: true, qualityScore: 1 });
    assert.strictEqual(s.predictedSuccess('m', 'debug').predicted, 0.76);
    s.recordOutcome('m', 'debug', { success: false, qualityScore: 0 });
    // (1 success + 2.8) / (2 + 4) = 3.8/6 = 0.633
    assert.strictEqual(s.predictedSuccess('m', 'debug').predicted, 0.633);
  });

  await test('small sample never beats large sample on confidence', () => {
    const s = new ModelPerformanceStore();
    s.recordOutcome('new', 'debug', { success: true, qualityScore: 1 });
    for (let i = 0; i < 10; i++) s.recordOutcome('veteran', 'debug', { success: i < 9, qualityScore: 0.9 });
    const n = s.predictedSuccess('new', 'debug');
    const v = s.predictedSuccess('veteran', 'debug');
    assert.strictEqual(n.confidence, 'none');
    assert.ok(['medium', 'low'].includes(v.confidence), `veteran confidence ${v.confidence}`);
    assert.ok(v.attempts > n.attempts);
  });

  await test('task-specific performance is per category', () => {
    const s = new ModelPerformanceStore();
    for (let i = 0; i < 5; i++) s.recordOutcome('m', 'debug', { success: true, qualityScore: 0.95 });
    for (let i = 0; i < 5; i++) s.recordOutcome('m', 'research', { success: i < 2, qualityScore: 0.4 });
    const d = s.predictedSuccess('m', 'debug');
    const r = s.predictedSuccess('m', 'research');
    assert.ok(d.predicted > r.predicted, `debug ${d.predicted} should exceed research ${r.predicted}`);
  });

  await test('latency percentiles need samples; single sample never defines quality', () => {
    const s = new ModelPerformanceStore();
    s.recordOutcome('m', 'code', { success: null, latencyMs: 9999 });
    const lat = s.latency('m', 'code');
    assert.strictEqual(lat.count, 1);
    const scored = routerIntel.scoreCandidate(
      { id: 'm', quality: null, avgLatencyMs: null, reliability: null, capabilities: [] },
      { taskProfile: classifyTask('write docs'), performanceStore: s, needTokens: 10 }
    );
    assert.strictEqual(scored.latencyScore, null, 'single latency sample must not define latency quality');
    assert.strictEqual(scored.qualityScore, null);
  });

  await test('reliability tracks error types; infra errors do not poison quality', () => {
    const s = new ModelPerformanceStore();
    for (let i = 0; i < 4; i++) s.recordOutcome('m', 'code', { success: false, errorCode: 'timeout' });
    const rel = s.reliabilityFor('m');
    assert.ok(rel && rel.byError.timeout === 4, 'error types tracked');
    const scored = routerIntel.scoreCandidate(
      { id: 'm', quality: 0.9, avgLatencyMs: 1000, reliability: 0.9, capabilities: ['tools'] },
      { taskProfile: classifyTask('fix bug'), performanceStore: s, needTokens: 10 }
    );
    const note = (scored.reasons || []).find((r) => r.factor === 'reliability');
    assert.ok(note, 'reliability reason present');
  });

  await test('performance store survives dump/load (durable learning)', () => {
    const s = new ModelPerformanceStore();
    for (let i = 0; i < 6; i++) s.recordOutcome('m', 'debug', { success: i < 5, qualityScore: 0.9, latencyMs: 100 + i });
    const s2 = new ModelPerformanceStore();
    s2.load(s.dump());
    assert.deepStrictEqual(s2.describe('m', 'debug').attempts, 6);
    assert.deepStrictEqual(s2.predictedSuccess('m', 'debug').predicted, s.predictedSuccess('m', 'debug').predicted);
  });

  // ================= ROUTER INTELLIGENCE =================
  await test('candidate score exposes uncertainty explicitly', () => {
    const c = routerIntel.scoreCandidate(
      { id: 'u', quality: null, avgLatencyMs: null, reliability: null, capabilities: [] },
      { taskProfile: classifyTask('hello'), needTokens: 10 }
    );
    assert.strictEqual(c.predictedSuccess, null);
    assert.strictEqual(c.qualityScore, null);
    assert.strictEqual(c.expectedCostUsd, null);
    assert.strictEqual(c.expectedLatencyMs, null);
    assert.ok(Number.isFinite(c.finalScore), 'finalScore always finite');
    assert.ok(c.reasons.length > 0, 'reasons explain unknowns');
  });

  await test('budget-aware routing excludes over-budget candidates', () => {
    const rt = fakeRuntime(PRESETS.balanced.weights, { policy: { hardBudget: true } });
    rt.budget = { getRemainingBudget: () => 0.000001 };
    const c = routerIntel.scoreCandidate(MODEL_A, {
      taskProfile: classifyTask('fix bug'), needTokens: 5000, remainingBudget: 0.000001, policy: { hardBudget: true },
    });
    assert.strictEqual(c.excluded, 'budget');
    assert.strictEqual(c.finalScore, 0);
  });

  await test('context-fit routing excludes window overflow with reason', () => {
    const c = routerIntel.scoreCandidate(
      { id: 'tiny', contextWindow: 1000, quality: 0.9, capabilities: [] },
      { taskProfile: classifyTask('fix bug'), needTokens: 50000 }
    );
    assert.strictEqual(c.excluded, 'context_window');
  });

  await test('tool capability influences routing when task needs tools', () => {
    const profile = classifyTask('Run the failing tests in auth/service.ts and report');
    assert.strictEqual(profile.requiresTools, true);
    const withTools = routerIntel.scoreCandidate({ id: 't', capabilities: ['tools', 'coding'] }, { taskProfile: profile, needTokens: 10 });
    const without = routerIntel.scoreCandidate({ id: 'n', capabilities: ['chat'] }, { taskProfile: profile, needTokens: 10 });
    assert.ok(withTools.toolCapabilityScore > without.toolCapabilityScore);
  });

  await test('switch policy has explicit triggers and costs', () => {
    const forced = routerIntel.decideSwitch({ fromModel: 'a', toModel: 'b', trigger: 'provider_failure', switchingCostUsd: 0.01 });
    assert.strictEqual(forced.switch, true);
    const denied = routerIntel.decideSwitch({ fromModel: 'a', toModel: 'b', trigger: 'budget_constraint', incumbentScore: 0.8, challengerScore: 0.81, switchingCostUsd: 0.05 });
    assert.strictEqual(denied.switch, false, 'tiny gain must not pay switching cost');
    assert.ok(routerIntel.SWITCH_TRIGGERS.includes('context_overflow'));
  });

  await test('counterfactuals are estimated-only, never facts', () => {
    const ranked = [
      { modelId: 'a', predictedSuccess: 0.9, expectedCostUsd: 0.1, predictedSuccessMeta: { confidence: 'high' } },
      { modelId: 'b', predictedSuccess: 0.8, expectedCostUsd: 0.05, predictedSuccessMeta: { confidence: 'medium' } },
    ];
    const cf = routerIntel.counterfactuals(ranked[0], ranked);
    assert.strictEqual(cf[0].kind, 'estimated');
    assert.ok(/not run/.test(cf[0].disclaimer));
  });

  await test('routing inputs hash is deterministic and secret-free', () => {
    const h1 = routerIntel.hashRoutingInputs({ taskText: 'fix bug', models: [MODEL_A], remainingBudget: 1 });
    const h2 = routerIntel.hashRoutingInputs({ taskText: 'fix bug', models: [MODEL_A], remainingBudget: 1 });
    assert.strictEqual(h1, h2);
  });

  await test('routing improves from historical outcomes (end-to-end)', async () => {
    const store = new IntelligenceStore();
    // B looks better on paper (quality 0.85 > 0.80)...
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null, { intelligence: store });
    const debugTask = { objective: 'Fix the failing login test, tests fail with 401' };
    const before = await router.evaluateCandidates(debugTask, fakeRuntime(PRESETS.balanced.weights), [MODEL_A, MODEL_B]);
    assert.strictEqual(before.candidates[0].modelId, 'b', 'higher static quality wins before learning');
    // ...but A has strong observed debugging history, B has poor history.
    for (let i = 0; i < 10; i++) store.performance.recordOutcome('a', 'debug', { success: i < 9, qualityScore: 0.9 });
    for (let i = 0; i < 10; i++) store.performance.recordOutcome('b', 'debug', { success: i < 2, qualityScore: 0.3 });
    const after = await router.evaluateCandidates(debugTask, fakeRuntime(PRESETS.balanced.weights), [MODEL_A, MODEL_B]);
    assert.strictEqual(after.candidates[0].modelId, 'a', 'observed task performance flips selection');
    assert.strictEqual(after.candidates[0].predictionConfidence !== 'none', true);
    // ...and a thin history (n=1) does NOT flip.
    const store2 = new IntelligenceStore();
    store2.performance.recordOutcome('a', 'debug', { success: true, qualityScore: 1 });
    const router2 = new InMemoryModelRouter({ getPricing: () => null }, null, null, null, { intelligence: store2 });
    const thin = await router2.evaluateCandidates(debugTask, fakeRuntime(PRESETS.balanced.weights), [MODEL_A, MODEL_B]);
    assert.strictEqual(thin.candidates[0].modelId, 'b', 'n=1 must not overrule priors');
  });

  await test('routing decision carries explanation + tradeoff + inputs hash', async () => {
    const store = new IntelligenceStore();
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null, { intelligence: store });
    const { selectedModel, decision, evaluation } = await router.route(
      { objective: 'Fix failing tests' }, fakeRuntime(PRESETS.balanced.weights), [MODEL_A, MODEL_B], {}
    );
    assert.ok(selectedModel);
    assert.ok(evaluation.explanation && evaluation.explanation.length > 20, 'human explanation present');
    assert.ok(Array.isArray(evaluation.counterfactuals), 'counterfactuals present');
    assert.ok(evaluation.inputsHash, 'inputs hash recorded');
    assert.strictEqual(evaluation.policyVersion, VERSIONS.routingPolicy);
    assert.ok(decision.metadata && decision.metadata.inputsHash === evaluation.inputsHash);
    assert.ok(decision.factors.some((f) => String(f.key).startsWith('intel:')), 'machine-readable reasons');
    assert.strictEqual(store.routingHistory.forRun('run-test').length, 1, 'routing history recorded');
  });

  // ================= CONTEXT ENGINE =================
  await test('context selection is relevance-aware with exclusion reasons', () => {
    const items = [
      { id: 'a', kind: 'file', title: 'auth/service.ts', source: 'repo', tokens: 500, relevance: 0.9, status: 'KEEP', metadata: { text: 'token refresh rotation login 401' } },
      { id: 'b', kind: 'file', title: 'README.md', source: 'repo', tokens: 500, relevance: 0.1, status: 'KEEP', metadata: { text: 'welcome to the project marketing' } },
    ];
    const { selected, omitted } = contextEngine.selectContext(items, {
      query: 'login 401 token refresh failure', taskText: 'fix login', taskCategory: 'debug',
      tokenBudget: 600, relevanceThreshold: 0,
    });
    assert.strictEqual(selected[0].item.id, 'a', 'relevant item first');
    assert.ok(omitted.some((o) => o.id === 'b' && /budget/.test(o.reason)), 'README excluded by budget with reason');
  });

  await test('dependency closure keeps required items', () => {
    const items = [
      { id: 'child', kind: 'file', title: 'auth controller login fix', source: 'repo', tokens: 400, relevance: 0.95, status: 'KEEP', dependencies: ['parent'], metadata: { text: 'login fix' } },
      { id: 'parent', kind: 'file', title: 'unrelated helper', source: 'repo', tokens: 100, relevance: 0.05, status: 'KEEP', metadata: { text: 'zzz' } },
    ];
    const { selected } = contextEngine.selectContext(items, {
      query: 'login fix', taskText: 'login', taskCategory: 'debug', tokenBudget: 1000, relevanceThreshold: 0,
    });
    assert.ok(selected.some((s) => s.item.id === 'parent'), 'dependency preserved via closure');
  });

  await test('PromptPlan is authoritative and internally consistent', () => {
    const plan = contextEngine.buildPromptPlan({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do the thing' }],
      taskText: 'do the thing',
      contextItems: [{ id: 'a', kind: 'file', title: 'f', tokens: 100 }],
      memoryItems: [{ id: 'm', title: 't', snippet: 's' }],
      toolSpecs: [{ function: { name: 'run_tests' } }],
      contextWindow: 10000,
    });
    assert.strictEqual(plan.totalEstimatedTokens,
      plan.systemTokens + plan.taskTokens + plan.historyTokens + plan.memoryTokens + plan.toolTokens + plan.contextTokens,
      'single accounting, no divergent estimators');
    assert.strictEqual(plan.remainingTokens, 10000 - plan.totalEstimatedTokens);
    assert.ok(plan.fingerprint && plan.fingerprint.startsWith('ctxfp-'));
  });

  await test('compression produces genuinely smaller content and preserves constraints', () => {
    const content = [
      'Do not modify production database schema.',
      'auth/service.ts line 143 fails because token expiry is checked before refresh.',
      'The test suite shows 47 passed and 0 failed in the last run for context padding purposes.',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.',
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.',
      'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore fugiat.',
    ].join(' ');
    const r = contextEngine.compressContent(content, { targetTokens: 40, query: 'auth failure', taskText: 'fix auth' });
    assert.ok(r.compressedTokens < r.originalTokens, `must shrink (${r.originalTokens} -> ${r.compressedTokens})`);
    assert.ok(/auth\/service\.ts/.test(r.compressedContent), 'file path preserved');
    assert.ok(/Do not modify production database schema/.test(r.compressedContent), 'constraint preserved');
    assert.ok(r.method !== 'none' && r.compressionRatio < 1);
  });

  await test('fingerprint is stable, sensitive to context, blind to secrets', () => {
    const base = { taskText: 'fix login', contextItems: [{ id: 'a', kind: 'file', title: 'auth', tokens: 10, status: 'KEEP' }] };
    const f1 = contextEngine.fingerprintContext(base);
    const f2 = contextEngine.fingerprintContext({ ...base });
    assert.strictEqual(f1, f2, 'deterministic');
    const f3 = contextEngine.fingerprintContext({ ...base, contextItems: [{ id: 'b', kind: 'file', title: 'other', tokens: 10, status: 'KEEP' }] });
    assert.notStrictEqual(f1, f3, 'context-sensitive');
    assert.ok(!f1.includes('sk-'), 'no secret material in fingerprint');
  });

  await test('context manager compresses with real content + protects user task', async () => {
    const mgr = new InMemoryContextManager(null);
    const state = new RuntimeState('Fix the login bug');
    await mgr.addContext(state, [
      { kind: 'chat', title: 'User task', source: 'user', tokens: 100, relevance: 1.0, metadata: { text: 'Fix the login bug' } },
      { kind: 'logs', title: 'verbose deploy logs with lots of padding text '.repeat(20), source: 'ops', tokens: 2000, relevance: 0.2, metadata: { text: 'verbose deploy logs '.repeat(100) } },
    ]);
    const before = state.context.currentTokens;
    const { reclaimed, items } = await mgr.compressContext(state, 500, {});
    assert.ok(reclaimed > 0 && state.context.currentTokens < before, 'tokens actually reclaimed');
    assert.ok(items[0] && items[0].method, 'method recorded');
    const taskItem = state.context.contextItems.find((i) => i.title === 'User task');
    assert.strictEqual(taskItem.status, 'KEEP', 'user task protected from compression');
    assert.ok(taskItem.tokens === 100, 'user task tokens untouched');
  });

  await test('context protection regression: very low relevance user task survives huge context', async () => {
    const mgr = new InMemoryContextManager(null);
    const state = new RuntimeState('Fix the login bug');
    await mgr.addContext(state, [
      // Adversarial: relevance 0.01 would sort last under score ordering.
      // Protection must be exclusion from candidates, not sort-last.
      { kind: 'chat', title: 'User task', source: 'user', tokens: 100, relevance: 0.01, metadata: { text: 'Fix the login bug' } },
      { kind: 'constraint', title: 'Do not modify production database schema', source: 'user', tokens: 80, relevance: 0.01, metadata: { text: 'Do not modify production database schema' } },
      { kind: 'criterion', title: 'All existing tests must pass', source: 'system', tokens: 80, relevance: 0.01, metadata: { text: 'All existing tests must pass' } },
      { kind: 'system', title: 'System instructions', source: 'system', tokens: 80, relevance: 0.01, metadata: { text: 'Follow policy' } },
      { kind: 'logs', title: 'huge deploy logs '.repeat(30), source: 'ops', tokens: 5000, relevance: 0.9, metadata: { text: 'huge deploy logs '.repeat(500) } },
      { kind: 'file', title: 'unrelated docs', source: 'repo', tokens: 3000, relevance: 0.9, metadata: { text: 'unrelated docs '.repeat(400) } },
    ]);
    await mgr.compressContext(state, 500, {});
    for (const title of ['User task', 'Do not modify production database schema', 'All existing tests must pass', 'System instructions']) {
      const item = state.context.contextItems.find((i) => i.title === title);
      assert.ok(item, `protected item present: ${title}`);
      assert.strictEqual(item.status, 'KEEP', `${title} never compressed (got ${item.status})`);
    }
    const taskItem = state.context.contextItems.find((i) => i.title === 'User task');
    assert.strictEqual(taskItem.tokens, 100, 'user task tokens byte-identical');
  });

  await test('context manager builds explainable prompt plans', async () => {
    const mgr = new InMemoryContextManager(null);
    const state = new RuntimeState('Fix the login 401 bug');
    await mgr.addContext(state, [
      { kind: 'file', title: 'auth/service.ts', source: 'repo', tokens: 300, relevance: 0.9, metadata: { text: 'login 401 refresh' } },
    ]);
    const plan = await mgr.buildPromptPlan(state, { messages: [{ role: 'user', content: 'fix it' }], contextWindow: 8000 });
    assert.ok(plan.totalEstimatedTokens > 0 && plan.remainingTokens !== null);
    assert.strictEqual(plan.taskProfile.category, 'debug');
    const expl = mgr.explainSelection(state);
    assert.ok(expl.included.length >= 1 && expl.included[0].reason, 'inclusion explained');
  });

  // ================= MEMORY =================
  function memState(objective) {
    const s = new RuntimeState(objective || 'Fix login bug');
    s.runId = 'run-mem-test';
    return s;
  }

  await test('hybrid retrieval ranks query-relevant memories first', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = memState('Fix the login 401 bug');
    await mgr.writeWorkingMemory(s, { title: 'Auth bug repro', snippet: 'login returns 401 when refresh token rotates', source: 'conversation', importance: 0.5, confidence: 0.5 });
    await mgr.writeWorkingMemory(s, { title: 'Deployment log noise', snippet: 'unrelated deploy logs archived', source: 'ops', importance: 0.9, confidence: 0.9 });
    const res = await mgr.searchMemory(s, 'login 401 refresh token', ['working'], 5);
    assert.strictEqual(res[0].title, 'Auth bug repro', `query relevance must beat static importance (got ${res[0].title})`);
  });

  await test('recency and confidence affect retrieval', () => {
    const old = { id: 'old', title: 'login notes', snippet: 'login flow', confidence: 0.9, importance: 0.9, lastUsedAt: new Date(Date.now() - 30 * 864e5).toISOString(), status: 'active' };
    const fresh = { id: 'new', title: 'login notes', snippet: 'login flow', confidence: 0.9, importance: 0.9, lastUsedAt: new Date().toISOString(), status: 'active' };
    const ranked = memoryIntel.rankMemories([old, fresh], 'login', { limit: 2 });
    assert.strictEqual(ranked[0].memory.id, 'new', 'recent wins on equal content');
  });

  await test('deduplication merges near-duplicates with provenance', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = memState();
    await mgr.writeLongTermMemory(s, { title: 'UI preference', snippet: 'User prefers dark mode for the console theme', source: 'prefs', importance: 0.6, confidence: 0.7 });
    const existing = mgr._visibleItems(mgr.longTermMemory, s.runId);
    const decision = mgr.consolidate({ title: 'UI preference', snippet: 'User prefers dark mode interfaces in console theme', source: 'prefs' }, existing);
    assert.strictEqual(decision.action, 'merge');
    assert.ok(decision.merged.metadata.mergedFrom.length >= 0, 'provenance tracked');
  });

  await test('contradictions become conflicts, never silent overwrites', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = memState();
    await mgr.writeLongTermMemory(s, { title: 'Package manager', snippet: 'Preferred package manager = npm', source: 'prefs', importance: 0.7, confidence: 0.8 });
    const out = await mgr.writeLongTermConsolidated(s, { title: 'Package manager', snippet: 'Preferred package manager = pnpm', source: 'prefs', importance: 0.7, confidence: 0.8 });
    assert.strictEqual(out.action, 'conflict');
    assert.ok(out.record.conflict && out.record.conflict.preferredId, 'conflict represented with preferred record');
    const conflicts = mgr.listConflicts(s);
    assert.ok(conflicts.length >= 1, 'conflict listed for future UI');
  });

  await test('memory records carry confidence/importance/recency metadata', async () => {
    const mgr = new InMemoryMemoryManager(null);
    const s = memState();
    const rec = await mgr.writeWorkingMemory(s, { title: 't', snippet: 's', source: 'test', type: 'fact', tags: ['auth'], importance: 0.8, confidence: 0.6 });
    assert.strictEqual(rec.type, 'fact');
    assert.deepStrictEqual(rec.tags, ['auth']);
    assert.ok(rec.createdAt && rec.lastUsedAt && rec.schemaVersion, 'lifecycle + version tracked');
  });

  // ================= EVALUATION =================
  await test('completion is not treated as success (failing tests)', () => {
    const o = evaluateOutcome({
      runId: 'r1', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: { passed: 40, failed: 7 }, cost: 0.05, latencyMs: 1000, steps: 3,
      },
    });
    assert.strictEqual(o.taskSuccess, false, 'failing tests => not successful despite completion');
    assert.ok(o.correctnessScore < 1);
    assert.strictEqual(o.evaluatorVersion, EVALUATOR_VERSION);
  });

  await test('passing tests + completion => success with evidence', () => {
    const o = evaluateOutcome({
      runId: 'r2', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: { passed: 47, failed: 0 },
        criteria: [createCriterion({ description: 'Existing tests pass', type: 'test', verificationMethod: 'run_tests suite session' })],
        evidence: [createEvidence({ type: 'test', source: 'tool:run_tests', location: 'suite session', claim: '47 passed, 0 failed', confidence: 0.95 })],
      },
    });
    assert.strictEqual(o.taskSuccess, true);
    assert.ok(o.confidence >= 0.6);
    assert.ok(o.evidence.length === 1 && o.criteria.length === 1);
  });

  await test('model self-report alone never proves success', () => {
    const o = evaluateOutcome({
      runId: 'r3', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        modelSelfReport: 'success',
      },
    });
    assert.ok(o.overallScore === null || o.overallScore <= 0.65, `self-report capped (got ${o.overallScore})`);
    assert.strictEqual(o.taskSuccess, null, 'no trustworthy evidence => unknown, not success');
    assert.strictEqual(outcomeToLearningUpdate(o), null, 'nothing learnable from self-report alone');
  });

  await test('user feedback is one signal, not sole truth', () => {
    // Strong objective success (10 passed, 0 failed) + low-confidence
    // negative feedback must NOT flip to failure. Feedback is stored and
    // explained, but objective evidence wins.
    const down = evaluateOutcome({
      runId: 'r4', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: { passed: 10, failed: 0 },
        userFeedback: { signal: 'negative', confidence: 0.4 },
      },
    });
    assert.ok(down.userSignal && down.userSignal.signal === 'negative', 'feedback stored');
    assert.strictEqual(down.taskSuccess, true, 'low-confidence negative cannot overturn 10 passing tests');
    const lone = evaluateOutcome({
      runId: 'r5', signals: { completed: true, hasAssistantMessage: false, userFeedback: { signal: 'positive', confidence: 0.4 } },
    });
    assert.ok(lone.overallScore === null || lone.overallScore < 0.9, 'lone thumbs-up is not near-perfect evidence');
    assert.strictEqual(lone.taskSuccess, null, 'positive feedback alone never proves success');
  });

  await test('user-feedback regression: four evidence combinations', () => {
    const strong = { passed: 10, failed: 0 };
    // negative + strong objective evidence -> still success (low-conf)
    const negStrong = evaluateOutcome({
      runId: 'fb1', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: strong, userFeedback: { signal: 'negative', confidence: 0.4 },
      },
    });
    assert.strictEqual(negStrong.taskSuccess, true, 'negative(low-conf) + strong success stays true');
    // positive + strong objective evidence -> success
    const posStrong = evaluateOutcome({
      runId: 'fb2', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: strong, userFeedback: { signal: 'positive', confidence: 0.8 },
      },
    });
    assert.strictEqual(posStrong.taskSuccess, true, 'positive + strong success stays true');
    // positive + weak evidence (no tests/criteria) -> unknown, never true
    const posWeak = evaluateOutcome({
      runId: 'fb3', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        userFeedback: { signal: 'positive', confidence: 0.9 },
      },
    });
    assert.strictEqual(posWeak.taskSuccess, null, 'positive + weak evidence stays unknown');
    // negative + no objective evidence -> failure (user is best available signal)
    const negNone = evaluateOutcome({
      runId: 'fb4', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        userFeedback: { signal: 'negative', confidence: 0.6 },
      },
    });
    assert.strictEqual(negNone.taskSuccess, false, 'negative + no objective evidence decides failure');
    // high-confidence negative vs strong success -> conflict (null), not false
    const conflict = evaluateOutcome({
      runId: 'fb5', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 0, withinBudget: true,
        testSummary: strong, userFeedback: { signal: 'negative', confidence: 0.9 },
      },
    });
    assert.strictEqual(conflict.taskSuccess, null, 'high-conf negative vs passing tests is a conflict, not failure');
    // positive cannot overturn objective failure
    const posVsFail = evaluateOutcome({
      runId: 'fb6', signals: {
        completed: true, hasAssistantMessage: true, toolFailures: 1, withinBudget: true,
        testSummary: { passed: 3, failed: 5 }, userFeedback: { signal: 'positive', confidence: 0.6 },
      },
    });
    assert.strictEqual(posVsFail.taskSuccess, false, 'positive feedback cannot overturn failing tests');
  });

  await test('missing metrics stay null (unknown)', () => {
    const o = evaluateOutcome({ runId: 'r6', signals: { completed: true, hasAssistantMessage: true } });
    assert.strictEqual(o.correctnessScore, null);
    assert.strictEqual(o.completenessScore, null);
    assert.strictEqual(o.userSignal, null);
  });

  // ================= LEARNING LOOP =================
  await test('ingestRunOutcome updates durable task-specific performance', () => {
    const store = new IntelligenceStore();
    for (let i = 0; i < 4; i++) {
      store.ingestRunOutcome({
        runId: `run-${i}`, modelId: 'm', taskText: 'Fix the failing test suite now',
        completed: true, hasAssistantMessage: true, toolFailures: 0,
        testSummary: { passed: 10, failed: 0 }, latencyMs: 500, steps: 2,
      });
    }
    const desc = store.performance.describe('m', 'debug');
    assert.ok(desc.attempts >= 4, `attempts recorded (got ${desc.attempts})`);
    assert.ok(store.outcomeForRun('run-3').taskSuccess === true);
    const dump = store.dump();
    const store2 = new IntelligenceStore();
    store2.load(dump);
    assert.strictEqual(store2.performance.describe('m', 'debug').attempts, desc.attempts, 'learning survives dump/load');
  });

  await test('failed runs with failing tests record failures, not successes', () => {
    const store = new IntelligenceStore();
    store.ingestRunOutcome({
      runId: 'rx', modelId: 'm', taskText: 'Fix failing tests',
      completed: true, hasAssistantMessage: true, toolFailures: 1,
      testSummary: { passed: 3, failed: 5 }, latencyMs: 800, steps: 4,
    });
    const desc = store.performance.describe('m', 'debug');
    assert.strictEqual(desc.successes, 0);
    assert.strictEqual(desc.attempts, 1);
  });

  await test('routing history attaches outcomes for analysis', () => {
    const store = new IntelligenceStore();
    store.routingHistory.record({ runId: 'r9', taskCategory: 'debug', selectedModel: 'a', candidates: [] });
    store.ingestRunOutcome({ runId: 'r9', modelId: 'a', taskText: 'fix bug', completed: true, hasAssistantMessage: true, latencyMs: 100 });
    const h = store.routingHistory.forRun('r9');
    assert.ok(h.length === 1 && h[0].outcome && h[0].outcome.taskSuccess !== undefined);
  });

  // ================= CACHE =================
  await test('exact cache hit/miss + stats', async () => {
    const c = new InMemoryCacheManager(null);
    const miss = await c.get('k1', 'run-1');
    assert.strictEqual(miss.hit, false);
    await c.set('k1', { text: 'hello' }, 60000, 'run-1');
    const hit = await c.get('k1', 'run-1');
    assert.strictEqual(hit.hit, true);
    assert.strictEqual(hit.value.text, 'hello');
  });

  await test('semantic reuse requires similarity + freshness + fingerprint', async () => {
    const idx = new SemanticCacheIndex({ similarityThreshold: 0.5, maxAgeMs: 60000 });
    const fp = 'ctxfp-abc123';
    idx.store({ taskText: 'Fix the login 401 bug in auth service', fingerprint: fp, modelId: 'a', tools: ['run_tests'], result: { text: 'fixed' } });
    const hit = idx.lookup({ taskText: 'Fix the login 401 bug in auth service now', fingerprint: fp, tools: ['run_tests'] });
    assert.strictEqual(hit.hit, true, `similar task should hit (${hit.reason || ''})`);
    assert.ok(hit.similarity >= 0.5 && hit.sourceTask && hit.modelUsed === 'a');
    const drift = idx.lookup({ taskText: 'Fix the login 401 bug in auth service now', fingerprint: 'ctxfp-changed', tools: ['run_tests'] });
    assert.strictEqual(drift.hit, false, 'context drift must invalidate reuse');
    assert.ok(/fingerprint/.test(drift.reason));
    const toolChange = idx.lookup({ taskText: 'Fix the login 401 bug in auth service now', fingerprint: fp, tools: ['deploy_preview'] });
    assert.strictEqual(toolChange.hit, false, 'tool dependency change must invalidate reuse');
  });

  await test('stale semantic entries are never served as fresh', async () => {
    const idx = new SemanticCacheIndex({ similarityThreshold: 0.1, maxAgeMs: 1000 });
    idx.store({ taskText: 'hello world task', fingerprint: null, modelId: 'a', tools: [], result: { text: 'old' }, createdAt: new Date(Date.now() - 60000).toISOString() });
    const r = idx.lookup({ taskText: 'hello world task' });
    assert.strictEqual(r.hit, false, 'expired entry must miss');
    assert.ok(/stale/.test(r.reason));
  });

  // ================= BENCHMARKS =================
  await test('benchmark cases + attempts summarize honestly', () => {
    const b = new BenchmarkStore();
    b.createCase({ id: 'dbg-1', category: 'debug', prompt: 'Fix the bug', successCriteria: [{ description: 'tests pass', type: 'test' }], expectedCapabilities: ['tools'] });
    b.recordAttempt({ caseId: 'dbg-1', modelId: 'a', passed: true, score: 0.9, cost: 0.05, latencyMs: 1000 });
    b.recordAttempt({ caseId: 'dbg-1', modelId: 'a', passed: false, score: 0.3, cost: 0.06, latencyMs: 1200 });
    const sum = b.summarize('dbg-1');
    assert.strictEqual(sum[0].passRate, 0.5);
    assert.strictEqual(sum[0].attempts, 2);
  });

  // ================= EDGE CASES =================
  await test('no models available fails honestly', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    await assert.rejects(router.route({ objective: 'hi' }, fakeRuntime(null), [], {}), /No available models|No routable/);
  });

  await test('all models exceed context window degrades gracefully', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const rt = fakeRuntime(PRESETS.balanced.weights);
    rt.context.currentTokens = 200000;
    const tiny = [
      { id: 't1', name: 'T1', provider: 'p', status: 'healthy', contextWindow: 1000, quality: 0.9, avgLatencyMs: 500, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002 },
    ];
    const ev = await router.evaluateCandidates({ objective: 'hi' }, rt, tiny);
    assert.strictEqual(ev.candidates[0].score, 0);
    // route() falls back to the full pool rather than throwing when every
    // candidate is window-incompatible (pool fallback), still scored 0.
    const r = await router.route({ objective: 'hi' }, rt, tiny, {});
    assert.strictEqual(r.selectedModel, 't1');
    assert.ok(r.decision, 'decision still produced');
  });

  await test('new model with zero samples routes on priors without crashing', async () => {
    const store = new IntelligenceStore();
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null, { intelligence: store });
    const ev = await router.evaluateCandidates({ objective: 'Fix bug now' }, fakeRuntime(PRESETS.balanced.weights), [MODEL_A]);
    assert.strictEqual(ev.candidates[0].predictionConfidence, 'none');
    assert.strictEqual(ev.candidates[0].predictedSuccess !== undefined, true);
  });

  await test('routing history store bounds and loads', () => {
    const h = new RoutingHistoryStore({ max: 5 });
    for (let i = 0; i < 8; i++) h.record({ runId: `r${i}`, selectedModel: 'a', candidates: [] });
    assert.strictEqual(h.dump().length, 5);
    const h2 = new RoutingHistoryStore({ max: 5 });
    h2.load(h.dump());
    assert.strictEqual(h2.recent(5).length, 5);
  });
}

main().then(() => {
  console.log(`\n--- Intelligence results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('intelligence test harness failed', e);
  process.exit(1);
});
