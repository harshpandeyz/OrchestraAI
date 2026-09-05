'use strict';

const assert = require('assert');
const {
  SavingsEngine,
  getReferenceModel,
  getPricingForModel,
  extractStepsFromRun,
  calculateStepBaselineCost,
  calculateStepActualCost,
  determineSavingsStatus,
  validatePricing,
  round6,
} = require('../../src/savings');

const { SavingsStatus } = SavingsEngine;
const { createModelCallRecord } = require('../../src/economics/canonical-record');

function createMockModelRegistry(models) {
  const registry = { models: new Map() };
  for (const m of models) {
    registry.models.set(m.id, { ...m });
  }
  return registry;
}

function createMockRuntimeState(overrides = {}) {
  return {
    runId: 'test-run-1',
    status: overrides.status || 'completed',
    model: {
      currentModel: overrides.currentModel || 'helium-b',
      currentProvider: overrides.currentProvider || 'Provider Y',
    },
    budget: {
      costHistory: overrides.costHistory || [],
    },
    execution: {
      stepHistory: overrides.stepHistory || [],
    },
    context: {
      currentTokens: 0,
    },
  };
}

function createMockEventBus(events = []) {
  return { eventLogs: new Map([[ 'test-run-1', events ]]) };
}

const SEED_MODELS = [
  { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, avgLatencyMs: 1800, reliability: 0.987, inputPer1k: 0.0009, outputPer1k: 0.0027, cachedPer1k: 0.0002, capabilities: ['coding', 'reasoning', 'tools'], pricingSource: 'seed', updatedAt: '2024-01-01T00:00:00.000Z' },
  { id: 'helium-b', name: 'Helium B', provider: 'Provider Y', status: 'healthy', contextWindow: 64000, quality: 0.87, avgLatencyMs: 1600, reliability: 0.973, inputPer1k: 0.0007, outputPer1k: 0.0021, cachedPer1k: 0.0002, capabilities: ['coding', 'tools'], pricingSource: 'seed', updatedAt: '2024-01-01T00:00:00.000Z' },
  { id: 'ferrite-c', name: 'Ferrite C', provider: 'Provider Z', status: 'degraded', contextWindow: 32000, quality: 0.76, avgLatencyMs: 1200, reliability: 0.941, inputPer1k: 0.0003, outputPer1k: 0.0009, cachedPer1k: 0.0001, capabilities: ['chat'], pricingSource: 'seed', updatedAt: '2024-01-01T00:00:00.000Z' },
];

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  // TEST 1: same reference and actual model/pricing → zero savings
  test('TEST 1: same reference and actual model/pricing → zero savings', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ currentModel: 'helium-b' });
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'helium-b', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'helium-b', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.VERIFIED_MODELED);
    assert.strictEqual(result.baselineCost, result.actualCost);
    assert.strictEqual(result.savings, 0);
    assert.strictEqual(result.savingsRate, 0);
  });

  // TEST 2: actual cheaper than reference → positive savings
  test('TEST 2: actual cheaper than reference → positive savings', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.VERIFIED_MODELED);
    assert.ok(result.savings > 0);
    assert.ok(result.savingsRate > 0);
    assert.ok(result.baselineCost > result.actualCost);
  });

  // TEST 3: actual more expensive than reference → cost_increase/no_savings state
  test('TEST 3: actual more expensive than reference → cost_increase state', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'nemotron-x', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'ferrite-c', provider: 'Provider Z', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.COST_INCREASE);
    assert.ok(result.savings < 0);
    assert.ok(result.actualCost > result.baselineCost);
  });

  // TEST 4: multiple execution steps → correct aggregate
  test('TEST 4: multiple execution steps → correct aggregate', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
      { step: 2, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 2000, outputTokens: 1000, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
      { step: 3, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 500, outputTokens: 250, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.VERIFIED_MODELED);
    assert.strictEqual(result.steps.length, 3);
    const stepSum = result.steps.reduce((sum, s) => sum + s.baselineCost, 0);
    assert.ok(Math.abs(result.baselineCost - stepSum) < 1e-10);
  });

  // TEST 5: cached token pricing → correct pricing behavior using existing pricing semantics
  test('TEST 5: cached token pricing → correct pricing behavior', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 500, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.VERIFIED_MODELED);
    const step = result.steps[0];
    assert.ok(step.baselineCost > 0);
    // nemotron-x: input=0.0009, cached=0.0002, output=0.0027
    // baseline: (500/1000)*0.0009 + (500/1000)*0.0002 + (500/1000)*0.0027 = 0.00045 + 0.0001 + 0.00135 = 0.0019
    // actual (ferrite-c): input=0.0003, cached=0.0001, output=0.0009
    // actual: (500/1000)*0.0003 + (500/1000)*0.0001 + (500/1000)*0.0009 = 0.00015 + 0.00005 + 0.00045 = 0.00065
    const expectedBaseline = round6(0.00045 + 0.0001 + 0.00135);
    const expectedActual = round6(0.00015 + 0.00005 + 0.00045);
    assert.strictEqual(step.baselineCost, expectedBaseline);
    assert.strictEqual(step.actualCost, expectedActual);
  });

  // TEST 6: missing reference pricing → insufficient_pricing_data
  test('TEST 6: missing reference pricing → insufficient_pricing_data', () => {
    const models = [
      { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, inputPer1k: null, outputPer1k: null, cachedPer1k: null },
      { id: 'helium-b', name: 'Helium B', provider: 'Provider Y', status: 'healthy', contextWindow: 64000, quality: 0.87, inputPer1k: 0.0007, outputPer1k: 0.0021, cachedPer1k: 0.0002 },
    ];
    const modelRegistry = createMockModelRegistry(models);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'helium-b', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.INSUFFICIENT_PRICING_DATA);
    assert.ok(result.error.includes('missing pricing'));
  });

  // TEST 7: missing/incomplete usage → incomplete_run or appropriate error state
  test('TEST 7: missing/incomplete usage → incomplete_run', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ status: 'executing' });
    const eventBus = createMockEventBus([]);

    const result = SavingsEngine.calculateSavingsForRun(runtimeState, eventBus, modelRegistry);

    assert.strictEqual(result.status, SavingsStatus.INCOMPLETE_RUN);
  });

  // TEST 8: zero baseline → no divide-by-zero
  test('TEST 8: zero baseline → no divide-by-zero, savingsRate = 0', () => {
    const models = [
      { id: 'free-model', name: 'Free Model', provider: 'Provider X', status: 'healthy', contextWindow: 1000, quality: 0.5, inputPer1k: 0, outputPer1k: 0, cachedPer1k: 0 },
      { id: 'helium-b', name: 'Helium B', provider: 'Provider Y', status: 'healthy', contextWindow: 64000, quality: 0.87, inputPer1k: 0.0007, outputPer1k: 0.0021, cachedPer1k: 0.0002 },
    ];
    const modelRegistry = createMockModelRegistry(models);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'helium-b', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'free-model', provider: 'Provider X', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.NO_SAVINGS);
    assert.strictEqual(result.baselineCost, 0);
    assert.strictEqual(result.savingsRate, 0);
  });

  // TEST 9: negative/invalid token values → rejected safely
  test('TEST 9: negative/invalid token values → rejected safely', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: -100, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result.status, SavingsStatus.INSUFFICIENT_PRICING_DATA);
    assert.ok(result.error.includes('negative_token_values'));
  });

  // TEST 10: historical pricing snapshot → calculation remains reproducible
  test('TEST 10: historical pricing snapshot → calculation remains reproducible', () => {
    const models = [
      { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.0002, pricingSource: 'provider', updatedAt: '2024-01-01T00:00:00.000Z', pricingUpdatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'ferrite-c', name: 'Ferrite C', provider: 'Provider Z', status: 'degraded', contextWindow: 32000, quality: 0.76, inputPer1k: 0.0003, outputPer1k: 0.0009, cachedPer1k: 0.0001, pricingSource: 'seed', updatedAt: '2024-01-01T00:00:00.000Z', pricingUpdatedAt: '2024-01-01T00:00:00.000Z' },
    ];
    const modelRegistry = createMockModelRegistry(models);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result1 = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });
    const result2 = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.strictEqual(result1.baselineCost, result2.baselineCost);
    assert.strictEqual(result1.actualCost, result2.actualCost);
    assert.strictEqual(result1.savings, result2.savings);
    assert.strictEqual(result1.savingsRate, result2.savingsRate);
    assert.ok(result1.pricingSnapshot.length > 0);
    assert.ok(result1.pricingSnapshot[0].pricingTimestamp);
  });

  // TEST 11: reference model configured explicitly
  test('TEST 11: reference model configured explicitly', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ currentModel: 'ferrite-c' });
    const eventBus = createMockEventBus([]);

    const explicitRef = 'nemotron-x';
    const result = SavingsEngine.calculateSavingsForRun(runtimeState, eventBus, modelRegistry, explicitRef);

    assert.strictEqual(result.referenceModel.modelId, 'nemotron-x');
    assert.strictEqual(result.referenceModel.source, 'explicit');
  });

  // TEST 12: commercial baselines require an explicit project/run policy
  test('TEST 12: missing reference model never silently selects a strongest model', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ currentModel: 'ferrite-c' });
    const eventBus = createMockEventBus([]);

    const result = SavingsEngine.calculateSavingsForRun(runtimeState, eventBus, modelRegistry, null);

    assert.strictEqual(result.status, SavingsStatus.INSUFFICIENT_PRICING_DATA);
    assert.strictEqual(result.referenceModel, null);
    assert.strictEqual(result.calculationStatus, 'insufficient_data');
  });

  // Additional: verify step breakdown structure
  test('Step breakdown includes all required fields', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];
    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    const step = result.steps[0];
    assert.ok('step' in step);
    assert.ok('provider' in step);
    assert.ok('actualModel' in step);
    assert.ok('referenceModel' in step);
    assert.ok('actualCost' in step);
    assert.ok('baselineCost' in step);
    assert.ok('delta' in step);
    assert.strictEqual(step.delta, round6(step.baselineCost - step.actualCost));
  });

  // Additional: verify pricing snapshot includes required fields
  test('Pricing snapshot includes required fields', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const steps = [
      { step: 1, provider: 'Provider Y', model: 'ferrite-c', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0 },
    ];
    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    assert.ok(result.pricingSnapshot.length > 0);
    const snap = result.pricingSnapshot[0];
    assert.ok('provider' in snap);
    assert.ok('model' in snap);
    assert.ok('inputPer1k' in snap);
    assert.ok('outputPer1k' in snap);
    assert.ok('cachedPer1k' in snap);
    assert.ok('pricingTimestamp' in snap);
    assert.ok('pricingSource' in snap);
  });

  // Additional: run with actual cost from runtime (fallback)
  test('Actual cost from runtime used when pricing unavailable', () => {
    const models = [
      { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, inputPer1k: 0.0009, outputPer1k: 0.0027, cachedPer1k: 0.0002 },
      { id: 'unknown-model', name: 'Unknown', provider: 'Provider X', status: 'healthy', contextWindow: 1000, quality: 0.5, inputPer1k: null, outputPer1k: null, cachedPer1k: null },
    ];
    const modelRegistry = createMockModelRegistry(models);
    const steps = [
      { step: 1, provider: 'Provider X', model: 'unknown-model', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, actualCost: 0.005 },
    ];

    const refModel = { modelId: 'nemotron-x', provider: 'Provider Y', source: 'explicit' };
    const result = SavingsEngine.calculateSavings({ referenceModel: refModel, steps, modelRegistry });

    // baseline for nemotron-x: (1000/1000)*0.0009 + (500/1000)*0.0027 = 0.0009 + 0.00135 = 0.00225
    // actual = 0.005 > baseline, so cost_increase
    assert.strictEqual(result.status, SavingsStatus.COST_INCREASE);
    assert.strictEqual(result.steps[0].actualCost, 0.005);
  });

  test('Unknown canonical pricing cannot become a verified commercial result', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ currentModel: 'ferrite-c' });
    runtimeState.referenceModelId = 'nemotron-x';
    runtimeState.modelCalls = [createModelCallRecord({
      runId: runtimeState.runId, step: 1, provider: 'Provider Z', model: 'ferrite-c',
      usage: { inputTokens: 1000, outputTokens: 500 }, calculatedCostUsd: 0.005,
      costSource: 'unknown_estimate', pricingSnapshot: { modelId: 'ferrite-c', source: 'unknown' },
    })];
    const result = SavingsEngine.calculateSavingsForRun(runtimeState, createMockEventBus([]), modelRegistry);
    assert.strictEqual(result.calculationStatus, 'insufficient_data');
    assert.strictEqual(result.economicOutcome, null);
  });

  test('Canonical historical pricing remains reproducible after registry price change', () => {
    const modelRegistry = createMockModelRegistry(SEED_MODELS);
    const runtimeState = createMockRuntimeState({ currentModel: 'ferrite-c' });
    runtimeState.referenceModelId = 'nemotron-x';
    runtimeState.referencePricingSnapshot = { modelId: 'nemotron-x', inputPer1k: 0.0009, outputPer1k: 0.0027, cachedPer1k: 0.0002, source: 'provider', version: 4, updatedAt: '2024-01-01T00:00:00.000Z' };
    runtimeState.modelCalls = [createModelCallRecord({
      runId: runtimeState.runId, step: 1, provider: 'Provider Z', model: 'ferrite-c',
      usage: { inputTokens: 1000, outputTokens: 500 }, calculatedCostUsd: 0.00075,
      pricingSnapshot: { modelId: 'ferrite-c', inputPer1k: 0.0003, outputPer1k: 0.0009, cachedPer1k: 0.0001, source: 'provider', version: 2 },
      costSource: 'pricing_snapshot',
    })];
    const before = SavingsEngine.calculateSavingsForRun(runtimeState, createMockEventBus([]), modelRegistry);
    modelRegistry.models.get('ferrite-c').inputPer1k = 0.9;
    modelRegistry.models.get('ferrite-c').outputPer1k = 0.9;
    const after = SavingsEngine.calculateSavingsForRun(runtimeState, createMockEventBus([]), modelRegistry);
    assert.strictEqual(after.actualCost, before.actualCost);
    assert.strictEqual(after.pricingSnapshot.find((p) => p.type === 'actual').pricingVersion, 2);
  });

  test('Canonical economics preserves unknown usage/cost and treats cache hits as zero provider cost', () => {
    const unknown = createModelCallRecord({
      runId: 'unknown-run', provider: 'Provider X', model: 'unknown-model',
      usage: {}, calculatedCostUsd: 0.004, costSource: 'unknown_estimate',
    });
    assert.deepStrictEqual(unknown.usage, {
      inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null,
    });
    assert.strictEqual(unknown.usageSource, 'unknown');
    assert.strictEqual(unknown.canonicalCostUsd, null);
    assert.strictEqual(unknown.costSource, 'unknown_estimate');

    const cacheHit = createModelCallRecord({
      runId: 'cache-run', provider: 'Provider X', model: 'cached-model',
      providerCall: false, cacheType: 'local_response', usage: {}, latencyMs: 4,
    });
    assert.strictEqual(cacheHit.canonicalCostUsd, 0);
    assert.strictEqual(cacheHit.usageSource, 'cache_hit');

    const runtimeState = createMockRuntimeState({ currentModel: 'ferrite-c' });
    runtimeState.referenceModelId = 'nemotron-x';
    runtimeState.modelCalls = [unknown];
    const result = SavingsEngine.calculateSavingsForRun(runtimeState, createMockEventBus([]), createMockModelRegistry(SEED_MODELS));
    assert.strictEqual(result.calculationStatus, 'insufficient_data');
    assert.strictEqual(result.platformFee, 0);
    assert.strictEqual(result.economicOutcome, null);
  });

  console.log(`\n--- Savings Engine Tests: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
