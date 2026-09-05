'use strict';

/**
 * QA Red Team: Economics & Savings (fixed API contracts)
 */

const assert = require('assert');
const { addBillingFields, getReferenceModel, DEFAULT_PLATFORM_FEE_PCT, SavingsStatus } = require('../backend/src/savings/savings-engine');
const { createModelCallRecord } = require('../backend/src/economics/canonical-record');
const { CostEstimator } = require('../backend/src/cost/cost-estimator');
const { InMemoryModelRegistry } = require('../backend/src/impl/model-registry');
const { InMemoryModelRouter } = require('../backend/src/impl/model-router');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = `${name}\n    ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n    ')}`;
    failures.push(msg);
    console.log(`  ✗ ${name}\n    ${String((e && e.stack) || e).split('\n').slice(0, 3).join('\n    ')}`);
  }
}

function fakeRegistry(models = []) {
  const reg = new InMemoryModelRegistry([], null);
  for (const m of models) {
    reg.models.set(m.id, { ...m });
  }
  return reg;
}

const MODEL_GPT4 = { id: 'gpt-4', name: 'GPT-4', provider: 'openai', status: 'healthy', contextWindow: 128000, quality: 0.9, avgLatencyMs: 2000, reliability: 0.98, inputPer1k: 0.03, outputPer1k: 0.06, cachedPer1k: 0.015, capabilities: ['coding', 'reasoning'] };
const MODEL_GPT35 = { id: 'gpt-3.5', name: 'GPT-3.5', provider: 'openai', status: 'healthy', contextWindow: 16000, quality: 0.7, avgLatencyMs: 800, reliability: 0.95, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0005, capabilities: ['coding'] };
const MODEL_UNPRICED = { id: 'unpriced', name: 'Unpriced', provider: 'mystery', status: 'healthy', contextWindow: 8000, quality: 0.6, avgLatencyMs: 500, reliability: 0.9, inputPer1k: null, outputPer1k: null, cachedPer1k: null, capabilities: ['coding'] };

async function runEconomicsRedTeam() {
  console.log('\n=== Economics Red Team (v2) ===\n');

  // --- Platform Fee ---
  await test('PF-1: platform fee on zero savings is zero', () => {
    const result = addBillingFields({ savings: 0, baselineCost: 10, actualCost: 10, status: SavingsStatus.VERIFIED_MODELED }, 0.25);
    assert.strictEqual(result.platformFee, 0);
    assert.strictEqual(result.customerFinalCost, 10);
  });

  await test('PF-2: platform fee on negative savings (cost increase) is zero', () => {
    const result = addBillingFields({ savings: -5, baselineCost: 10, actualCost: 15, status: SavingsStatus.VERIFIED_MODELED }, 0.25);
    assert.strictEqual(result.platformFee, 0, 'no fee on cost increase');
    assert.strictEqual(result.economicOutcome, 'cost_increase');
  });

  await test('PF-3: platform fee applied exactly once on positive savings', () => {
    const result = addBillingFields({ savings: 10, baselineCost: 20, actualCost: 10, status: SavingsStatus.VERIFIED_MODELED }, 0.25);
    assert.strictEqual(result.platformFee, 2.5, 'fee = 25% of $10');
    assert.strictEqual(result.customerFinalCost, 12.5, 'actual + fee');
    assert.strictEqual(result.customerNetSavings, 7.5, 'baseline - actual - fee');
  });

  await test('PF-4: null savings (insufficient data) produces no platform fee', () => {
    const result = addBillingFields({ savings: null, baselineCost: 10, actualCost: 5, status: SavingsStatus.INSUFFICIENT_PRICING_DATA }, 0.25);
    assert.strictEqual(result.platformFee, 0);
    assert.strictEqual(result.eligibleSavings, 0);
    assert.strictEqual(result.economicOutcome, null);
  });

  await test('PF-5: platform fee with 0% produces zero fee', () => {
    const result = addBillingFields({ savings: 100, baselineCost: 200, actualCost: 100, status: SavingsStatus.VERIFIED_MODELED }, 0);
    assert.strictEqual(result.platformFee, 0);
    assert.strictEqual(result.customerNetSavings, 100);
  });

  await test('PF-6: platform fee with null/NaN pct defaults to 25%', () => {
    const result = addBillingFields({ savings: 10, baselineCost: 20, actualCost: 10, status: SavingsStatus.VERIFIED_MODELED }, 'invalid');
    assert.strictEqual(result.platformFeePct, 0.25, 'default fee applied');
    assert.strictEqual(result.platformFee, 2.5);
  });

  await test('PF-7: incomplete_run status produces no fee', () => {
    const result = addBillingFields({ savings: 10, baselineCost: 20, actualCost: 10, status: SavingsStatus.INCOMPLETE_RUN }, 0.25);
    assert.strictEqual(result.platformFee, 0);
    assert.strictEqual(result.calculationStatus, 'incomplete');
  });

  // --- Reference Model ---
  await test('RM-1: no reference model returns null', () => {
    const rt = {};
    const ref = getReferenceModel(rt, {}, null);
    assert.strictEqual(ref, null);
  });

  await test('RM-2: explicit reference model from registry', () => {
    const reg = fakeRegistry([MODEL_GPT4, MODEL_GPT35]);
    const rt = {};
    const ref = getReferenceModel(rt, reg, 'gpt-4');
    assert.ok(ref, 'reference model found');
    assert.strictEqual(ref.modelId, 'gpt-4');
    assert.strictEqual(ref.source, 'explicit');
  });

  await test('RM-3: explicit reference ID takes precedence over runtime state', () => {
    const reg = fakeRegistry([MODEL_GPT4, MODEL_GPT35]);
    const rt = { referenceModelId: 'gpt-3.5' };
    const ref = getReferenceModel(rt, reg, 'gpt-4');
    assert.ok(ref, 'reference model found');
    assert.strictEqual(ref.modelId, 'gpt-4', 'explicit param wins over runtime');
  });

  await test('RM-4: runtime referenceModelId used when no explicit param', () => {
    const reg = fakeRegistry([MODEL_GPT4, MODEL_GPT35]);
    const rt = { referenceModelId: 'gpt-3.5' };
    const ref = getReferenceModel(rt, reg, null);
    assert.ok(ref, 'reference model found');
    assert.strictEqual(ref.modelId, 'gpt-3.5', 'runtime ref used as fallback');
  });

  // --- Canonical Record ---
  await test('CR-1: cache hit record has zero provider cost', () => {
    const record = createModelCallRecord({
      providerCall: false, modelId: 'gpt-4', provider: 'openai',
      inputTokens: 1000, outputTokens: 0, cachedTokens: 1000,
      providerCostUsd: null, pricing: MODEL_GPT4, runId: 'test-run',
    });
    assert.strictEqual(record.canonicalCostUsd, 0, 'cache hit = $0');
    assert.strictEqual(record.providerCall, false);
  });

  await test('CR-2: provider-reported cost wins over calculated', () => {
    const record = createModelCallRecord({
      providerCall: true, modelId: 'gpt-4', provider: 'openai',
      inputTokens: 1000, outputTokens: 500, cachedTokens: 0,
      usage: { promptTokens: 1000, completionTokens: 500 },
      providerCostUsd: 0.099, pricing: MODEL_GPT4, runId: 'test-run',
    });
    assert.strictEqual(record.canonicalCostUsd, 0.099, 'provider cost wins');
  });

  await test('CR-3: unknown pricing null cost does not become zero', () => {
    const record = createModelCallRecord({
      providerCall: true, modelId: 'mystery', provider: 'mystery',
      inputTokens: 1000, outputTokens: 500, cachedTokens: 0,
      providerCostUsd: null, pricing: MODEL_UNPRICED, runId: 'test-run',
    });
    assert.strictEqual(record.canonicalCostUsd, null, 'null stays null');
  });

  // --- CostEstimator ---
  await test('CE-1: estimateModelCostStrict returns null for unpriced model', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimateModelCostStrict('unpriced', 1000, 500, 0);
    assert.strictEqual(result, null, 'unpriced model returns null');
  });

  await test('CE-2: estimateModelCost falls back to defaults for unknown model', () => {
    const estimator = new CostEstimator();
    const result = estimator.estimateModelCost('totally-unknown', 'openai', 1000, 500, 0);
    assert.ok(result.total >= 0, 'defaults produce non-negative estimate');
  });

  await test('CE-3: negative token counts in estimator - documents current behavior', () => {
    const estimator = new CostEstimator();
    // This documents that negative inputs are NOT guarded - potential P2
    const result = estimator.estimateModelCost('gpt-4', 'openai', -100, 500, 0);
    assert.ok(typeof result.total === 'number', 'result is a number');
    // If total is negative, that's a finding
    if (result.total < 0) {
      console.log('    [FINDING] negative tokens produce negative cost estimate');
    }
  });

  // --- Routing: Unpriced Models ---
  await test('RT-1: unpriced model excluded from routing by default', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const rt = {
      runId: 'test', context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
      model: { currentModel: null, getPricing: () => null, modelLatency: 500 }, policy: {},
    };
    await assert.rejects(
      () => router.route({}, rt, [MODEL_UNPRICED], {}),
      (err) => err.code === 'insufficient_pricing' || err.code === 'no_models'
    );
  });

  await test('RT-2: unpriced model allowed with allowUnknownPricing', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const rt = {
      runId: 'test', context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
      model: { currentModel: null, getPricing: () => null, modelLatency: 500 }, policy: { allowUnknownPricing: true },
    };
    const result = await router.route({}, rt, [MODEL_UNPRICED], {});
    assert.strictEqual(result.selectedModel, 'unpriced');
  });

  await test('RT-3: router handles single candidate without crash', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const rt = {
      runId: 'test', context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
      model: { currentModel: null, getPricing: () => null, modelLatency: 500 }, policy: {},
    };
    const result = await router.route({}, rt, [MODEL_GPT4], {});
    assert.strictEqual(result.selectedModel, 'gpt-4');
  });

  console.log(`\n--- Economics Red Team Results: ${passed} passed, ${failed} failed ---\n`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach(f => console.log(`  ${f}\n`));
  }
  return { passed, failed, failures };
}

runEconomicsRedTeam().catch(e => { console.error(e); process.exit(1); });
