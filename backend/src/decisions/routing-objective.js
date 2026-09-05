'use strict';

// Deterministic, explainable routing objective (Agent 2).
//
// Primary economic quantity: expected TOTAL task cost in USD, not the
// nominal one-call price and not a weighted score. The weighted score stays
// as the quality/cost/latency/reliability ranking signal; the objective is
// the money the run is expected to spend if this candidate is selected.
//
//   expectedTotalCostUsd =
//       providerCost(input, output, cached)
//     + expectedRetryCost(reliability, bounded retries)
//     + switchingCostUsd(incumbent -> candidate)
//     + expectedToolContinuationCost(policy-provided, else 0)
//     + latencyPenaltyUsd (only when policy prices latency, else 0)
//
//   costPerSuccessUsd = expectedTotalCostUsd / max(successForObjective, floor)
//   objectiveValue    = costPerSuccessUsd when success is known,
//                       otherwise expectedTotalCostUsd (lower wins).
//
// successForObjective prefers empirical predictedSuccess, then taskFit,
// then registry quality — each step is recorded so the explanation can say
// which one was used. Nothing here trains a model; every term is a closed
// deterministic formula over inputs the caller already has.
//
// All functions are pure. Unknown pricing yields null (never 0).

const SUCCESS_FLOOR = 0.05;

function isKnownRate(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
}

// Provider one-call cost. Returns null when pricing is incomplete (unknown
// stays unknown; the caller excludes or penalizes, never prices at $0).
function estimateProviderCostUsd(model, { inputTokens = 0, outputTokens = 1000, cachedTokens = 0 } = {}) {
  if (!model || typeof model !== 'object') return null;
  const inputRate = isKnownRate(model.inputPer1k) ? Number(model.inputPer1k) : null;
  const outputRate = isKnownRate(model.outputPer1k) ? Number(model.outputPer1k) : null;
  const cachedRate = isKnownRate(model.cachedPer1k) ? Number(model.cachedPer1k) : null;
  const cached = Math.max(0, Math.min(Number(inputTokens) || 0, Number(cachedTokens) || 0));
  if (inputRate === null || outputRate === null || (cached > 0 && cachedRate === null)) return null;
  const uncached = Math.max(0, (Number(inputTokens) || 0) - cached);
  const total =
    (uncached / 1000) * inputRate +
    (cached / 1000) * (cachedRate ?? 0) +
    (Math.max(0, Number(outputTokens) || 0) / 1000) * outputRate;
  return Number.isFinite(total) ? Math.max(0, Math.round(total * 1e6) / 1e6) : null;
}

// Bounded expected retry spend from reliability: E[cost] = providerCost *
// (E[attempts] - 1), E[attempts] = sum_{k=0..maxRetries} (1-r)^k.
// Unknown reliability -> null (no invented retry cost).
function estimateRetryCostUsd(providerCostUsd, reliability, maxRetries = 2) {
  if (providerCostUsd === null || providerCostUsd === undefined) return null;
  const r = Number(reliability);
  if (!Number.isFinite(r) || r < 0 || r > 1) return null;
  const n = Math.max(0, Math.min(5, Math.floor(Number(maxRetries) || 0)));
  let expectedAttempts = 0;
  for (let k = 0; k <= n; k++) expectedAttempts += Math.pow(1 - r, k);
  const retry = Math.max(0, Number(providerCostUsd) * (expectedAttempts - 1));
  return Math.round(retry * 1e6) / 1e6;
}

// Expected tool/continuation spend. Only policy-provided numbers are used:
// policy.expectedToolCalls + policy.toolCostPerCall, or a flat
// policy.expectedContinuationCostUsd. Absent policy input the term is 0 and
// the breakdown says so (never invent tool dollars).
function estimateToolContinuationCostUsd(policy = {}) {
  if (Number.isFinite(Number(policy.expectedContinuationCostUsd)) && Number(policy.expectedContinuationCostUsd) >= 0) {
    return { cost: Number(policy.expectedContinuationCostUsd), basis: 'policy.expectedContinuationCostUsd' };
  }
  const calls = Number(policy.expectedToolCalls);
  const perCall = Number(policy.toolCostPerCall);
  if (Number.isFinite(calls) && calls > 0 && Number.isFinite(perCall) && perCall >= 0) {
    return { cost: Math.round(calls * perCall * 1e6) / 1e6, basis: 'policy.expectedToolCalls*toolCostPerCall' };
  }
  return { cost: 0, basis: 'no policy tool-cost input; assumed 0' };
}

// Latency penalty in USD. Only applied when the policy explicitly prices
// latency (policy.latencyCostPerMsUsd > 0) or sets a latency target with a
// price. Otherwise 0 with an honest basis note.
function estimateLatencyPenaltyUsd(expectedLatencyMs, policy = {}) {
  const rate = Number(policy.latencyCostPerMsUsd);
  const lat = Number(expectedLatencyMs);
  if (Number.isFinite(rate) && rate > 0 && Number.isFinite(lat) && lat > 0) {
    return { cost: Math.round(lat * rate * 1e6) / 1e6, basis: 'policy.latencyCostPerMsUsd' };
  }
  return { cost: 0, basis: 'latency not priced by policy; no penalty' };
}

function successForObjective(candidate = {}) {
  const pick = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const predicted = pick(candidate.predictedSuccess);
  if (predicted !== null) return { value: Math.max(SUCCESS_FLOOR, Math.min(1, predicted)), basis: 'predictedSuccess' };
  const taskFit = pick(candidate.taskFitScore);
  if (taskFit !== null) return { value: Math.max(SUCCESS_FLOOR, Math.min(1, taskFit)), basis: 'taskFitScore' };
  const quality = pick(candidate.quality);
  if (quality !== null) return { value: Math.max(SUCCESS_FLOOR, Math.min(1, quality)), basis: 'registry quality (no empirical prediction)' };
  return { value: null, basis: 'success unknown' };
}

// Full objective for one scored candidate. Pure; never throws on missing data.
function computeObjective(candidate = {}, ctx = {}) {
  const switchingCostUsd = Number.isFinite(Number(ctx.switchCosts && ctx.switchCosts[candidate.modelId]))
    ? Math.max(0, Number(ctx.switchCosts[candidate.modelId]))
    : (Number.isFinite(Number(candidate.switchCost)) ? Math.max(0, Number(candidate.switchCost)) : 0);
  const provider = candidate.expectedCostBreakdown && Number.isFinite(Number(candidate.expectedCostBreakdown.provider))
    ? Number(candidate.expectedCostBreakdown.provider)
    : null;
  const retry = candidate.expectedCostBreakdown && candidate.expectedCostBreakdown.retry !== null &&
    candidate.expectedCostBreakdown.retry !== undefined && Number.isFinite(Number(candidate.expectedCostBreakdown.retry))
    ? Number(candidate.expectedCostBreakdown.retry)
    : null;
  const tool = estimateToolContinuationCostUsd(ctx.policy || {});
  const lat = estimateLatencyPenaltyUsd(
    candidate.expectedLatencyMs !== null && candidate.expectedLatencyMs !== undefined
      ? candidate.expectedLatencyMs : candidate.avgLatencyMs,
    ctx.policy || {},
  );
  const parts = { provider, retry, switching: switchingCostUsd, toolContinuation: tool.cost, latencyPenalty: lat.cost };
  const known = [provider, retry].every((v) => v === null || Number.isFinite(Number(v)));
  const expectedTotalCostUsd = (provider === null || retry === null)
    ? null
    : Math.round((provider + retry + switchingCostUsd + tool.cost + lat.cost) * 1e6) / 1e6;
  const success = successForObjective(candidate);
  const costPerSuccessUsd = (expectedTotalCostUsd === null || success.value === null)
    ? null
    : Math.round((expectedTotalCostUsd / success.value) * 1e6) / 1e6;
  const objectiveValue = costPerSuccessUsd !== null ? costPerSuccessUsd : expectedTotalCostUsd;
  return {
    modelId: candidate.modelId,
    expectedTotalCostUsd,
    costPerSuccessUsd,
    objectiveValue, // lower wins; null = unpriced (never competes on cost)
    successBasis: success.basis,
    successUsed: success.value,
    breakdown: {
      ...parts,
      toolBasis: tool.basis,
      latencyBasis: lat.basis,
    },
  };
}

// Attach objectives to an evaluated candidate list (additive; returns a new
// array, input untouched). Switch costs map modelId -> USD.
function attachObjectives(candidates = [], ctx = {}) {
  return (candidates || []).map((c) => ({ ...c, objective: computeObjective(c, ctx) }));
}

// Deterministic winner: lowest objectiveValue; null objectives sort last;
// ties break by score desc, then modelId asc. Excluded candidates never win.
function selectByObjective(candidates = []) {
  const eligible = (candidates || []).filter((c) => !c.excluded);
  const pool = eligible.length ? eligible : (candidates || []);
  if (!pool.length) return null;
  const val = (c) => (c.objective && c.objective.objectiveValue !== null && c.objective.objectiveValue !== undefined
    ? Number(c.objective.objectiveValue) : Infinity);
  const sorted = pool.slice().sort((a, b) =>
    val(a) - val(b) ||
    (Number(b.score) || 0) - (Number(a.score) || 0) ||
    String(a.modelId).localeCompare(String(b.modelId)));
  return sorted[0] || null;
}

const OBJECTIVE_FORMULA = 'min over eligible models of expectedTotalCostUsd / max(predictedSuccess, 0.05) ' +
  '(= expectedTotalCostUsd when success is unknown); expectedTotalCostUsd = provider(input,output,cached) ' +
  '+ bounded-retry(reliability) + switching(incumbent->candidate) + tool/continuation(policy, else 0) ' +
  '+ latency-penalty (only when policy prices latency, else 0). Lower wins.';

module.exports = {
  SUCCESS_FLOOR,
  OBJECTIVE_FORMULA,
  isKnownRate,
  estimateProviderCostUsd,
  estimateRetryCostUsd,
  estimateToolContinuationCostUsd,
  estimateLatencyPenaltyUsd,
  successForObjective,
  computeObjective,
  attachObjectives,
  selectByObjective,
};
