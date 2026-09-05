'use strict';

const assert = require('assert');
const { buildAnalytics } = require('../src/analytics');

const economics = (status, overrides = {}) => ({
  status,
  calculationStatus: ['verified_modeled', 'no_savings', 'cost_increase'].includes(status) ? 'verified_modeled' : status === 'incomplete_run' ? 'incomplete' : 'insufficient_data',
  economicOutcome: status === 'verified_modeled' ? 'saved' : status === 'no_savings' ? 'unchanged' : status === 'cost_increase' ? 'cost_increase' : null,
  baselineCost: status === 'verified_modeled' ? 1 : null,
  actualCost: status === 'verified_modeled' ? 0.6 : null,
  savings: status === 'verified_modeled' ? 0.4 : null,
  eligibleSavings: status === 'verified_modeled' ? 0.4 : 0,
  platformFee: status === 'verified_modeled' ? 0.1 : 0,
  customerFinalCost: status === 'verified_modeled' ? 0.7 : null,
  customerNetSavings: status === 'verified_modeled' ? 0.3 : null,
  steps: status === 'verified_modeled' ? [{ actualModel: 'model-a', provider: 'openai', actualCost: 0.6, baselineCost: 1, inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 0 }] : [],
  ...overrides,
});

const runs = [
  { id: 'saved', title: 'Saved task', status: 'completed', updatedAt: '2026-09-01T00:00:00.000Z', snapshot: { cache: { hits: 7, misses: 3 } } },
  { id: 'flat', title: 'No savings task', status: 'completed', updatedAt: '2026-09-02T00:00:00.000Z', snapshot: { cache: { hits: 1, misses: 1 } } },
  { id: 'up', title: 'Cost increase task', status: 'completed', updatedAt: '2026-09-03T00:00:00.000Z', snapshot: { cache: { hits: 0, misses: 2 } } },
  { id: 'unknown', title: 'Unknown pricing task', status: 'completed', updatedAt: '2026-09-03T00:00:00.000Z', snapshot: { cache: { hits: 5, misses: 0 } } },
  { id: 'partial', title: 'Incomplete task', status: 'failed', updatedAt: '2026-09-04T00:00:00.000Z', snapshot: { cache: { hits: 0, misses: 4 } } },
];

const rows = new Map([
  ['saved', economics('verified_modeled')],
  ['flat', economics('no_savings', { baselineCost: 1, actualCost: 1, savings: 0, eligibleSavings: 0, platformFee: 0, customerFinalCost: 1, customerNetSavings: 0 })],
  ['up', economics('cost_increase', { baselineCost: 1, actualCost: 1.4, savings: -0.4, eligibleSavings: 0, platformFee: 0, customerFinalCost: 1.4, customerNetSavings: -0.4 })],
  ['unknown', economics('insufficient_pricing_data')],
  ['partial', economics('incomplete_run')],
]);

const result = buildAnalytics(runs, rows);
assert.strictEqual(result.dataQuality.totalRuns, 5);
assert.strictEqual(result.dataQuality.verifiedCount, 1);
assert.strictEqual(result.dataQuality.insufficientCount, 1);
assert.strictEqual(result.dataQuality.incompleteCount, 1);
assert.strictEqual(result.dataQuality.noSavingsCount, 1);
assert.strictEqual(result.dataQuality.costIncreaseCount, 1);
assert.strictEqual(result.dataQuality.label, 'mixed_or_insufficient');
assert.strictEqual(result.spendTrend.reduce((n, point) => n + point.negativeImpact, 0), -0.4);
assert.strictEqual(result.cacheImpact.hits, 13);
assert.strictEqual(result.cacheImpact.misses, 10);
assert.strictEqual(result.summary.customerNetSavings, -0.1);

console.log('--- Analytics tests: passed ---');
