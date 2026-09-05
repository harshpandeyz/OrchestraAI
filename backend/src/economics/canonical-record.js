'use strict';

const crypto = require('crypto');
const { round6 } = require('../cost/breakdown');

const RECORD_VERSION = 'model-call-economic-v1';

function finiteNonNegative(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nullableNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function usageSourceFor(input, usage) {
  if (input.usageSource) return String(input.usageSource);
  if (!input.providerCall && input.cacheType) return 'cache_hit';
  const required = [usage.inputTokens, usage.outputTokens];
  if (required.every((value) => value !== null)) return 'provider_reported';
  if (required.some((value) => value !== null)) return 'provider_reported_partial';
  return 'unknown';
}

function pricingSnapshot(pricing = {}, capturedAt = new Date().toISOString()) {
  const snapshot = {
    modelId: pricing.modelId || null,
    inputPer1k: pricing.inputPer1k ?? null,
    outputPer1k: pricing.outputPer1k ?? null,
    cachedPer1k: pricing.cachedPer1k ?? null,
    source: pricing.source || 'unknown',
    updatedAt: pricing.updatedAt || null,
    capturedAt,
    version: pricing.version || null,
  };
  if (!snapshot.version) {
    snapshot.version = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  }
  return snapshot;
}

function promptComposition(plan = {}) {
  const contextItems = Array.isArray(plan.contextItems) ? plan.contextItems : [];
  const evidenceKinds = new Set(['tool_result', 'search', 'test', 'file', 'logs', 'evidence']);
  const evidence = contextItems.filter((item) => evidenceKinds.has(item.kind)).reduce((n, item) => n + finiteNonNegative(item.tokens), 0);
  const contextTotal = finiteNonNegative(plan.contextTokens);
  return {
    system: finiteNonNegative(plan.systemTokens),
    task: finiteNonNegative(plan.taskTokens),
    history: finiteNonNegative(plan.historyTokens),
    memory: finiteNonNegative(plan.memoryTokens),
    tools: finiteNonNegative(plan.toolTokens),
    evidence,
    other: Math.max(0, contextTotal - evidence),
    estimatedTotal: finiteNonNegative(plan.totalEstimatedTokens),
    estimateBasis: 'prompt_plan_estimate',
  };
}

function createModelCallRecord(input = {}) {
  const usage = {
    inputTokens: nullableNonNegative(input.usage?.inputTokens),
    outputTokens: nullableNonNegative(input.usage?.outputTokens),
    cachedTokens: nullableNonNegative(input.usage?.cachedTokens),
    reasoningTokens: nullableNonNegative(input.usage?.reasoningTokens),
  };
  // NB: Number(null)/Number('') coerce to 0, so explicit null/empty inputs
  // must map to null (unknown) — never to a fictitious zero charge.
  const calculatedCostUsd = nullableNonNegative(input.calculatedCostUsd) !== null
    ? round6(nullableNonNegative(input.calculatedCostUsd)) : null;
  const providerCostUsd = nullableNonNegative(input.providerCostUsd) !== null
    ? round6(nullableNonNegative(input.providerCostUsd)) : null;
  const providerCall = input.providerCall !== false;
  const costSource = providerCall
    ? (input.costSource || (providerCostUsd !== null ? 'provider_reported' : calculatedCostUsd !== null ? 'pricing_snapshot' : 'unknown'))
    : (input.cacheType ? `${input.cacheType}_cache_hit` : 'no_provider_call');
  const canonicalCostUsd = providerCall
    ? (providerCostUsd ?? (costSource === 'unknown' || costSource === 'unknown_estimate' ? null : calculatedCostUsd ?? null))
    : 0;
  return {
    recordVersion: RECORD_VERSION,
    callId: input.callId || `call-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    runId: input.runId || null,
    step: Number.isFinite(Number(input.step)) ? Number(input.step) : null,
    provider: input.provider || null,
    model: input.model || null,
    requestId: input.requestId || null,
    providerRequestId: input.providerRequestId || input.requestId || null,
    providerMetadata: input.providerMetadata || null,
    providerCall,
    cacheType: input.cacheType || null,
    usage,
    usageSource: usageSourceFor({ ...input, providerCall }, usage),
    composition: promptComposition(input.plan),
    pricingSnapshot: pricingSnapshot(input.pricingSnapshot || {}, input.capturedAt),
    providerCostUsd,
    calculatedCostUsd,
    canonicalCostUsd,
    costSource,
    latencyMs: nullableNonNegative(input.latencyMs),
    observedAt: input.observedAt || new Date().toISOString(),
  };
}

module.exports = { RECORD_VERSION, createModelCallRecord, pricingSnapshot, promptComposition };
