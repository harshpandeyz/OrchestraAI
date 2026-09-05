'use strict';

// Runtime presets: friendly names over real router policy weights.
// Each preset maps to actual scoring weights consumed by InMemoryModelRouter
// (quality/cost/latency/reliability/contextFit) plus honest constraints.
// No fake "model modes" — the user sees consequences, not coefficients.

const PRESETS = {
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Best overall trade-off.',
    consequence: 'OrchestraAI weighs quality, cost and latency evenly.',
    weights: { qualityWeight: 0.4, costWeight: 0.2, latencyWeight: 0.15, reliabilityWeight: 0.15, contextFitWeight: 0.1 },
    policy: { allowSwitching: true, allowCompaction: true, minReliability: 0 },
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    blurb: 'Prefer lower latency.',
    consequence: 'OrchestraAI will prefer lower-latency models, even when they cost slightly more.',
    weights: { qualityWeight: 0.25, costWeight: 0.1, latencyWeight: 0.4, reliabilityWeight: 0.15, contextFitWeight: 0.1 },
    policy: { allowSwitching: true, allowCompaction: true, minReliability: 0 },
  },
  economical: {
    id: 'economical',
    label: 'Economical',
    blurb: 'Prefer lower cost.',
    consequence: 'OrchestraAI will prefer cheaper models, even when they respond slightly slower.',
    weights: { qualityWeight: 0.3, costWeight: 0.4, latencyWeight: 0.1, reliabilityWeight: 0.1, contextFitWeight: 0.1 },
    policy: { allowSwitching: true, allowCompaction: true, minReliability: 0 },
  },
  reasoning: {
    id: 'reasoning',
    label: 'Reasoning',
    blurb: 'Prefer higher-quality reasoning capability.',
    consequence: 'OrchestraAI will prefer higher-quality models, even when they cost more or respond slower.',
    weights: { qualityWeight: 0.6, costWeight: 0.08, latencyWeight: 0.07, reliabilityWeight: 0.15, contextFitWeight: 0.1 },
    policy: { allowSwitching: true, allowCompaction: true, minReliability: 0 },
  },
  longcontext: {
    id: 'longcontext',
    label: 'Long context',
    blurb: 'Prefer context capacity.',
    consequence: 'OrchestraAI will strongly prefer models whose context window fits your work, even at higher cost.',
    weights: { qualityWeight: 0.25, costWeight: 0.1, latencyWeight: 0.1, reliabilityWeight: 0.15, contextFitWeight: 0.4 },
    policy: { allowSwitching: true, allowCompaction: true, minReliability: 0 },
  },
};

function validPreset(id) {
  return Object.prototype.hasOwnProperty.call(PRESETS, String(id || '').toLowerCase());
}

function getPreset(id) {
  const key = String(id || 'balanced').toLowerCase();
  return PRESETS[key] || PRESETS.balanced;
}

function listPresets() {
  return Object.values(PRESETS).map((p) => ({
    id: p.id, label: p.label, blurb: p.blurb, consequence: p.consequence,
  }));
}

module.exports = { PRESETS, validPreset, getPreset, listPresets };
