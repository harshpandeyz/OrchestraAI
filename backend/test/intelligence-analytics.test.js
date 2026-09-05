'use strict';

const assert = require('assert');
const { buildIntelligence, VALUE_FORMULA } = require('../src/intelligence-analytics');

// Empty input → honest INSUFFICIENT_DATA, no fabricated rows.
{
  const r = buildIntelligence({
    runs: [], economicsByRun: new Map(), snapshotsByRun: new Map(),
    models: [], observedByModel: new Map(), intelligence: null,
    mode: 'demo', options: {},
  });
  assert.strictEqual(r.meta.provenance, 'INSUFFICIENT_DATA');
  assert.strictEqual(r.leaderboard.state, 'INSUFFICIENT_DATA');
  assert.strictEqual(r.leaderboard.rows.length, 0);
  assert.strictEqual(r.benchmarks.note, 'No validated benchmark data.');
  assert.strictEqual(r.languages.state, 'INSUFFICIENT_DATA');
  assert.strictEqual(r.images.state, 'INSUFFICIENT_DATA');
  assert.ok(VALUE_FORMULA.includes('value ='));
}

// Populated demo traffic → DEMO provenance, real aggregation, defined formula.
{
  const runs = [
    { id: 'r1', title: 'Fix auth', taskMode: 'debug', status: 'completed', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T01:00:00.000Z', activeModelId: 'model-a', projectId: null },
    { id: 'r2', title: 'Write docs', taskMode: 'general', status: 'completed', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T01:00:00.000Z', activeModelId: 'model-b', projectId: null },
  ];
  const econ = (actual, baseline) => ({
    status: 'verified_modeled', calculationStatus: 'verified_modeled', economicOutcome: actual < baseline ? 'saved' : 'unchanged',
    baselineCost: baseline, actualCost: actual, savings: baseline - actual,
    steps: [{ actualModel: 'model-a', provider: 'openrouter', actualCost: actual, baselineCost: baseline, inputTokens: 100, outputTokens: 50, cachedTokens: 10 }],
  });
  const economicsByRun = new Map([['r1', econ(0.01, 0.03)], ['r2', econ(0.02, 0.02)]]);
  const snapshotsByRun = new Map([
    ['r1', { activeModelId: 'model-a', meta: { provider: 'openrouter' }, context: { usedTokens: 2000, windowTokens: 8000, items: [] }, cache: { hits: 2, misses: 1, cachedTokens: 100, savedUsd: 0.001 }, tools: [{ name: 'read', description: '', calls: 2, avgLatencyMs: 100, successRate: 1 }], latency: { totalMs: 1200 }, routing: { candidates: [{ modelId: 'model-a' }] }, trace: [], intelligence: { taskProfile: { category: 'debug' }, outcome: { taskSuccess: true } } }],
    ['r2', { activeModelId: 'model-b', meta: { provider: 'openrouter' }, context: { usedTokens: 1000, windowTokens: 8000, items: [] }, cache: { hits: 0, misses: 2, cachedTokens: 0, savedUsd: 0 }, tools: [], latency: { totalMs: 800 }, routing: { candidates: [] }, trace: [], intelligence: { taskProfile: { category: 'general' }, outcome: { taskSuccess: true } } }],
  ]);
  const models = [
    { id: 'model-a', provider: 'openrouter', status: 'healthy', quality: 0.9, qualitySource: 'demo', avgLatencyMs: 1000, latencySource: 'demo', reliability: 0.95, reliabilitySource: 'demo', pricingSource: 'demo', capabilities: ['coding'] },
    { id: 'model-b', provider: 'openrouter', status: 'healthy', quality: 0.8, qualitySource: 'demo', avgLatencyMs: 800, latencySource: 'demo', reliability: 0.9, reliabilitySource: 'demo', pricingSource: 'demo', capabilities: [] },
  ];
  const r = buildIntelligence({
    runs, economicsByRun, snapshotsByRun, models,
    observedByModel: new Map(), intelligence: null, mode: 'demo', options: { granularity: 'daily', range: '30d' },
  });
  assert.strictEqual(r.meta.provenance, 'DEMO');
  assert.strictEqual(r.meta.runCount, 2);
  assert.ok(r.topModels.series.length >= 1);
  assert.ok(r.topModels.totals.length >= 1);
  assert.ok(r.leaderboard.rows.length >= 1);
  assert.ok(r.leaderboard.rows[0].explanation.length > 0);
  assert.ok(r.leaderboard.formula.includes('costEfficiency'));
  assert.strictEqual(r.cost.stats.count, 2);
  assert.ok(r.marketShare.providers.length >= 1);
  assert.ok(r.marketShare.note.includes('Not external market statistics'));
  assert.strictEqual(r.benchmarks.state, 'INSUFFICIENT_DATA');
  assert.ok(r.executionFlow.stages.length === 8);
  assert.strictEqual(r.executionFlow.stages[0].label, 'Incoming Task');
  // Filters narrow the slice honestly.
  const filtered = buildIntelligence({
    runs, economicsByRun, snapshotsByRun, models,
    observedByModel: new Map(), intelligence: null, mode: 'demo',
    options: { filters: { model: 'model-a' } },
  });
  assert.strictEqual(filtered.meta.runCount, 1);
}

console.log('--- Intelligence analytics tests: passed ---');
