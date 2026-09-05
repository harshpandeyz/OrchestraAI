'use strict';

// Normalized model capability profiles (§5).
//
// Three layers are kept strictly separate:
//
//   PROVIDER FACT  — context window, pricing, declared capabilities (from
//                    discovery / registry metadata). Never learned.
//   OBSERVED       — success rates, latency percentiles, reliability, all with
//                    sample counts. Only from real execution evidence.
//   PREDICTED      — task-specific success estimates derived from observed
//                    data + priors. Always labelled with confidence.
//
// Unknown is null — never 0.5-as-fact. Consumers render null as "unknown".

const { VERSIONS } = require('./versions');

function isKnown(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// Capability inference from the registry's declared capability strings.
// Deterministic mapping; unknown strings are preserved verbatim.
function normalizeCapabilities(declared) {
  const list = Array.isArray(declared) ? declared.map(String) : [];
  const has = (...names) => names.some((n) => list.includes(n));
  return {
    declared: list.slice(),
    toolUseSupport: has('tools', 'tool_use', 'function_calling') ? true
      : has('chat', 'text') && !has('tools') ? false : null,
    structuredOutputSupport: has('structured', 'structured_output', 'json_mode') ? true : null,
    visionSupport: has('vision', 'image') ? true : null,
    reasoningSupport: has('reasoning', 'think', 'extended_thinking') ? true : null,
  };
}

function buildCapabilityProfile(model, observed = null, taskPerformance = null) {
  const caps = normalizeCapabilities(model && model.capabilities);
  const samples = observed ? ((observed.successes || 0) + (observed.failures || 0)) : 0;
  return {
    modelId: (model && model.id) || null,
    provider: (model && model.provider) || null,
    versions: {
      profile: VERSIONS.performanceEstimator,
      routingPolicy: VERSIONS.routingPolicy,
    },
    providerFact: {
      contextWindow: (model && Number.isFinite(Number(model.contextWindow)) && Number(model.contextWindow) > 0)
        ? Number(model.contextWindow) : null,
      contextSource: (model && model.contextSource) || (model && model.contextWindow ? 'provider' : 'unknown'),
      capabilities: caps.declared,
      toolUseSupport: caps.toolUseSupport,
      structuredOutputSupport: caps.structuredOutputSupport,
      visionSupport: caps.visionSupport,
      reasoningSupport: caps.reasoningSupport,
      pricing: {
        inputPer1k: isKnown(model && model.inputPer1k) ? Number(model.inputPer1k) : null,
        outputPer1k: isKnown(model && model.outputPer1k) ? Number(model.outputPer1k) : null,
        cachedPer1k: isKnown(model && model.cachedPer1k) ? Number(model.cachedPer1k) : null,
        source: (model && (model.pricingSource || model.source)) || 'unknown',
      },
      status: (model && model.status) || 'unknown',
    },
    observed: observed ? {
      successes: observed.successes || 0,
      failures: observed.failures || 0,
      samples,
      successRate: samples > 0 ? (observed.successes || 0) / samples : null,
      avgLatencyMs: Number.isFinite(observed.avgLatencyMs) ? observed.avgLatencyMs : null,
      latencyP50: Number.isFinite(observed.p50) ? observed.p50
        : Number.isFinite(observed.avgLatencyMs) ? observed.avgLatencyMs : null,
      latencyP75: Number.isFinite(observed.p75) ? observed.p75 : null,
      latencyP95: Number.isFinite(observed.p95) ? observed.p95 : null,
      reliability: samples >= 3 ? (observed.successes || 0) / samples : null,
      lastObservedAt: observed.lastObservedAt || null,
      lastErrorCode: observed.lastErrorCode || null,
    } : {
      successes: 0, failures: 0, samples: 0, successRate: null,
      avgLatencyMs: null, latencyP50: null, latencyP75: null, latencyP95: null,
      reliability: null, lastObservedAt: null, lastErrorCode: null,
    },
    // Task-specific observed rates (model x category). Null when no samples.
    taskPerformance: taskPerformance && typeof taskPerformance === 'object' ? taskPerformance : {},
    confidence: samples >= 50 ? 'high' : samples >= 10 ? 'medium' : samples >= 3 ? 'low' : 'none',
    dataSource: samples > 0 ? 'observed' : 'none',
    lastUpdated: new Date().toISOString(),
  };
}

// Lightweight comparison payload for the frontend (Session 4 consumes data,
// never computes). All rates carry sample counts + confidence.
function compareProfiles(profiles) {
  return (profiles || []).map((p) => ({
    modelId: p.modelId,
    provider: p.provider,
    contextWindow: p.providerFact.contextWindow,
    pricing: p.providerFact.pricing,
    capabilities: p.providerFact.capabilities,
    toolUseSupport: p.providerFact.toolUseSupport,
    observed: {
      samples: p.observed.samples,
      successRate: p.observed.successRate,
      reliability: p.observed.reliability,
      latencyP50: p.observed.latencyP50,
      latencyP75: p.observed.latencyP75,
      latencyP95: p.observed.latencyP95,
    },
    taskPerformance: p.taskPerformance,
    confidence: p.confidence,
    dataSource: p.dataSource,
  }));
}

module.exports = { buildCapabilityProfile, compareProfiles, normalizeCapabilities, isKnown };
