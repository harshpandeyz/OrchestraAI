'use strict';

// Principled candidate scoring + expected-utility routing (§4, §23–§30).
//
// ModelCandidateScore (§4): every metric nullable when unknown. finalScore is
// the only non-null number (falls back through documented neutral priors for
// the blend, while the per-metric nulls stay visible for explainability).
//
// Expected utility (§23):
//   utility = predictedSuccess * value - costPenalty - latencyPenalty - riskPenalty
// Weights configurable via policy.routerUtility. Defaults are documented and
// modest: success dominates, cost/latency/risk are penalties in score units.
//
// Budget (§24): hard budget excludes (expectedCost > remaining -> excluded
// with reason); soft budget penalizes. Never silently violates constraints.
// Latency (§25): observed p50 from the performance store beats static
// avgLatencyMs; single samples never define "latency quality".
// Reliability (§26): by error type; infra errors (timeout/rate_limit) do not
// reduce the quality component.
// Uncertainty (§27): smoothed predicted success + confidence; low-n models are
// pulled toward the prior instead of winning on 1/1.
// Switching (§28): explicit triggers + expected benefit vs switching cost.
// Counterfactuals (§29): estimated-only, labelled as such.
// Explanations (§30): DecisionReason[] { factor, direction, contribution,
// humanExplanation }.

const crypto = require('crypto');
const { VERSIONS } = require('./versions');
const { classifyTask } = require('./task-classifier');

const UTILITY_DEFAULTS = Object.freeze({
  valuePerSuccess: 1.0,
  costPerDollar: 0.8,    // score units per $1 of expected cost
  latencyPerSecond: 0.02, // score units per second of expected latency
  riskWeight: 0.15,
  unknownPenalty: 0.02,  // small penalty per unknown metric (honest caution)
});

function isKnown(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function clamp01(v, fallback = null) {
  if (!isKnown(v)) return fallback;
  return Math.max(0, Math.min(1, Number(v)));
}

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}

function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

// Tool capability: does the model support the tools the task likely needs?
// Deterministic from declared capabilities + task profile (no hidden ranking).
function toolCapabilityScore(model, taskProfile) {
  const caps = Array.isArray(model.capabilities) ? model.capabilities.map(String) : [];
  if (!taskProfile || taskProfile.requiresTools !== true) {
    return { score: caps.includes('tools') ? 0.8 : null, reason: 'task needs no tools' };
  }
  if (caps.includes('tools')) return { score: 0.9, reason: 'declares tool support' };
  if (caps.includes('structured')) return { score: 0.5, reason: 'structured output only, no tool calling' };
  return { score: 0.2, reason: 'no declared tool support' };
}

// Context fit: real — ratio of need vs window, with headroom reservation.
function contextFitScore(model, needTokens, reserveRatio = 0.15) {
  const window = Number(model.contextWindow) || 0;
  const need = Math.max(0, Number(needTokens) || 0);
  if (!(window > 0)) return { score: null, reason: 'context window unknown' };
  if (need <= 0) return { score: 0.8, reason: 'no context pressure measured' };
  if (need > window) return { score: 0, reason: `need ~${need} > window ${window}`, excluded: true };
  const util = need / window;
  const fit = util <= (1 - reserveRatio) ? 1 - util * 0.3 : Math.max(0.1, 1 - util);
  return { score: round3(fit), reason: `utilization ${(util * 100).toFixed(0)}% of ${window}` };
}

function normalizeCost(expectedCostUsd, scalePerDollar = 5) {
  if (!isKnown(expectedCostUsd) || Number(expectedCostUsd) < 0) return null;
  return round3(Math.max(0, 1 - Number(expectedCostUsd) * scalePerDollar));
}

function normalizeLatency(expectedLatencyMs) {
  if (!isKnown(expectedLatencyMs) || Number(expectedLatencyMs) < 0) return null;
  return round3(Math.max(0, 1 - Number(expectedLatencyMs) / 8000));
}

function estimateCostUsd(model, inputTokens, outputTokens = 1000, cachedTokens = 0) {
  const rate = (v) => (isKnown(v) && Number(v) >= 0 ? Number(v) : null);
  const inputRate = rate(model.inputPer1k);
  const outputRate = rate(model.outputPer1k);
  const cachedRate = rate(model.cachedPer1k);
  if (inputRate === null || outputRate === null || (Number(cachedTokens) > 0 && cachedRate === null)) return null;
  const uncached = Math.max(0, (Number(inputTokens) || 0) - (Number(cachedTokens) || 0));
  return round4(
    (uncached / 1000) * inputRate +
    (Math.max(0, Number(cachedTokens) || 0) / 1000) * (cachedRate ?? 0) +
    (outputTokens / 1000) * outputRate
  );
}

function expectedLatencyMs(model, perfLatency) {
  if (perfLatency && Number.isFinite(perfLatency.p50) && (perfLatency.count || 0) >= 3) return perfLatency.p50;
  if (perfLatency && Number.isFinite(perfLatency.mean) && (perfLatency.count || 0) >= 3) return perfLatency.mean;
  if (isKnown(model.avgLatencyMs)) return Number(model.avgLatencyMs);
  return null;
}

// Full candidate scoring. Pure function of (model, taskProfile, runtime
// signals, performanceStore, policy). Never throws on missing data.
function scoreCandidate(model, ctx = {}) {
  const taskProfile = ctx.taskProfile || classifyTask(ctx.taskText || '');
  const perf = ctx.performanceStore || null;
  const needTokens = Number(ctx.needTokens) || 0;
  const inputTokens = needTokens;
  const policy = ctx.policy || {};
  const utility = { ...UTILITY_DEFAULTS, ...(policy.routerUtility || {}) };

  // Task-specific empirical performance (preferred) -> registry statics.
  let predicted = null;
  let predMeta = { attempts: 0, confidence: 'none', observed: null };
  let perfLatency = null;
  if (perf && typeof perf.predictedSuccess === 'function') {
    try {
      // Workload-aware when the store supports it (context-size slice blends
      // toward the category rate at low n); plain category rate otherwise.
      const p = perf.predictedSuccess.length >= 3
        ? perf.predictedSuccess(model.id, taskProfile.category, { contextTokens: needTokens })
        : perf.predictedSuccess(model.id, taskProfile.category);
      predicted = p.predicted;
      predMeta = { attempts: p.attempts, confidence: p.confidence, observed: p.observed, workload: p.workload || null };
      perfLatency = perf.latency(model.id, taskProfile.category);
    } catch { /* performance is advisory */ }
  }

  const qualityScore = clamp01(model.quality, null);
  const taskFitScore = predicted !== null ? round3(predicted)
    : (qualityScore !== null && taskProfile.confidence >= 0.5 ? round3(0.5 + qualityScore * 0.3) : null);
  const reliabilityRaw = clamp01(model.reliability, null);
  // Infra errors must not poison quality: if recent failures are all
  // timeout/rate_limit/provider-outage, keep reliability but flag it.
  let reliabilityScore = reliabilityRaw;
  let reliabilityNote = null;
  if (perf && typeof perf.reliabilityFor === 'function') {
    try {
      const rel = perf.reliabilityFor(model.id);
      if (rel && rel.samples >= 3) {
        const infra = ['timeout', 'rate_limit', 'rate-limit', 'provider_outage', 'overloaded', 'cancelled'];
        const infraCount = Object.entries(rel.byError || {}).filter(([k]) => infra.includes(k)).reduce((a, [, v]) => a + v, 0);
        reliabilityScore = round3(1 - rel.failureRate);
        if (infraCount === (rel.failures ?? rel.samples * rel.failureRate) && rel.failureRate > 0) {
          reliabilityNote = 'failures are infrastructure-class; quality untouched';
        }
      }
    } catch { /* advisory */ }
  }

  const ctxFit = contextFitScore(model, needTokens);
  const tool = toolCapabilityScore(model, taskProfile);
  const expCost = estimateCostUsd(model, inputTokens, 1000, Math.min(inputTokens, Number(ctx.cachedTokens) || 0));
  const expLat = expectedLatencyMs(model, perfLatency);
  const costScore = normalizeCost(expCost);
  const latencyScore = normalizeLatency(expLat);

  // Budget awareness (§24).
  const rawRemaining = ctx.remainingBudget;
  const hasRemaining = rawRemaining !== null && rawRemaining !== undefined && rawRemaining !== '' && Number.isFinite(Number(rawRemaining));
  const remaining = hasRemaining ? Number(rawRemaining) : null;
  let budgetExcluded = false;
  let budgetPenalty = 0;
  let budgetReason = null;
  if (hasRemaining && expCost !== null) {
    if (expCost > remaining) {
      if (policy.hardBudget === true || remaining <= 0.01) {
        budgetExcluded = true;
        budgetReason = `expected $${expCost} exceeds remaining $${remaining}`;
      } else {
        budgetPenalty = Math.min(0.4, (expCost - remaining) * 5);
        budgetReason = `expected $${expCost} near remaining $${remaining} (soft penalty)`;
      }
    }
  }

  // Expected utility (§23). predictedSuccess is empirical-or-null: the
  // task-specific estimate when a performance store exists (prior-blended at
  // low n), otherwise honestly unknown — static quality is reported
  // separately and never masquerades as a success prediction.
  const pSuccess = taskFitScore !== null ? taskFitScore : predicted;
  const unknowns = [qualityScore, taskFitScore, reliabilityScore, ctxFit.score, costScore, latencyScore, tool.score].filter((v) => v === null).length;
  let utilityValue = null;
  if (pSuccess !== null) {
    utilityValue = pSuccess * utility.valuePerSuccess
      - (expCost !== null ? expCost * utility.costPerDollar : 0.05)
      - (expLat !== null ? (expLat / 1000) * utility.latencyPerSecond : 0.02)
      - ((1 - (reliabilityScore !== null ? reliabilityScore : 0.7)) * utility.riskWeight)
      - unknowns * utility.unknownPenalty
      - budgetPenalty;
    utilityValue = round4(utilityValue);
  }

  // finalScore: utility when available (it already blends success/cost/
  // latency/risk), else neutral-prior blend consistent with the legacy router
  // weights so behavior degrades gracefully instead of collapsing.
  const NEUTRAL = 0.5;
  let finalScore;
  if (utilityValue !== null) {
    finalScore = round3(Math.max(0, Math.min(1, 0.5 + utilityValue * 0.6)));
    if (ctxFit.excluded || budgetExcluded) finalScore = 0;
  } else {
    const w = ctx.weights || { quality: 0.4, cost: 0.2, latency: 0.15, reliability: 0.15, contextFit: 0.1 };
    finalScore = round3(
      (qualityScore === null ? NEUTRAL : qualityScore) * (w.quality ?? 0.4) +
      (costScore === null ? NEUTRAL : costScore) * (w.cost ?? 0.2) +
      (latencyScore === null ? NEUTRAL : latencyScore) * (w.latency ?? 0.15) +
      (reliabilityScore === null ? NEUTRAL : reliabilityScore) * (w.reliability ?? 0.15) +
      (ctxFit.score === null ? NEUTRAL : ctxFit.score) * (w.contextFit ?? 0.1)
    );
    if (ctxFit.excluded || budgetExcluded) finalScore = 0;
  }

  const reasons = [];
  const R = (factor, direction, contribution, humanExplanation) => reasons.push({ factor, direction, contribution, humanExplanation });
  if (taskFitScore !== null) R('task_fit', taskFitScore >= 0.7 ? 'for' : taskFitScore <= 0.4 ? 'against' : 'neutral', round3(taskFitScore - 0.5), predMeta.attempts >= 3 ? `observed ${taskProfile.category} success ${predMeta.observed} (n=${predMeta.attempts}, ${predMeta.confidence} confidence)` : `prior-blended ${taskProfile.category} estimate ${taskFitScore} (n=${predMeta.attempts}, ${predMeta.confidence} confidence)`);
  else R('task_fit', 'neutral', 0, 'no task-fit evidence; treated as unknown');
  if (qualityScore !== null) R('quality', qualityScore >= 0.8 ? 'for' : qualityScore <= 0.5 ? 'against' : 'neutral', round3((qualityScore - 0.5) * 0.4), `registry quality ${qualityScore}`);
  else R('quality', 'neutral', 0, 'quality unknown');
  if (expCost !== null) R('cost', 'neutral', round3(-expCost * utility.costPerDollar), `expected $${expCost}`);
  else R('cost', 'neutral', 0, 'pricing unknown');
  if (expLat !== null) R('latency', expLat <= 2000 ? 'for' : expLat >= 5000 ? 'against' : 'neutral', round3(-(expLat / 1000) * utility.latencyPerSecond), perfLatency && perfLatency.count >= 3 ? `observed p50 ${expLat}ms (n=${perfLatency.count})` : `static latency ${expLat}ms`);
  else R('latency', 'neutral', 0, 'latency unknown');
  if (reliabilityScore !== null) R('reliability', reliabilityScore >= 0.95 ? 'for' : reliabilityScore <= 0.8 ? 'against' : 'neutral', round3((reliabilityScore - 0.8) * 0.3), reliabilityNote || `reliability ${reliabilityScore}`);
  else R('reliability', 'neutral', 0, 'reliability unknown');
  if (ctxFit.score !== null) R('context_fit', ctxFit.excluded ? 'against' : ctxFit.score >= 0.7 ? 'for' : 'neutral', ctxFit.excluded ? -0.5 : round3((ctxFit.score - 0.5) * 0.2), ctxFit.reason);
  if (tool.score !== null) R('tool_support', tool.score >= 0.8 ? 'for' : tool.score <= 0.3 ? 'against' : 'neutral', round3((tool.score - 0.5) * 0.15), tool.reason);
  if (budgetReason) R('budget', budgetExcluded ? 'against' : 'neutral', budgetExcluded ? -1 : round3(-budgetPenalty), budgetReason);
  if (pSuccess !== null && predMeta.confidence === 'none') R('risk', 'neutral', round3(-utility.unknownPenalty * unknowns), `${unknowns} unknown metric(s); estimate pulled toward prior`);

  return {
    modelId: model.id,
    name: model.name || model.id,
    provider: model.provider || null,
    predictedSuccess: pSuccess,
    predictedSuccessMeta: { ...predMeta, estimatorVersion: VERSIONS.performanceEstimator },
    qualityScore,
    taskFitScore,
    reliabilityScore,
    contextFitScore: ctxFit.score,
    costScore,
    latencyScore,
    toolCapabilityScore: tool.score,
    expectedCostUsd: expCost,
    expectedLatencyMs: expLat,
    finalScore,
    // Legacy-compatible aliases (Session 1 snapshot/tests read these):
    score: finalScore,
    quality: qualityScore === null ? null : qualityScore,
    cost: costScore === null ? null : costScore,
    latency: latencyScore === null ? null : latencyScore,
    reliability: reliabilityScore === null ? null : reliabilityScore,
    contextFit: ctxFit.score === null ? null : ctxFit.score,
    switchCost: Number(ctx.switchCosts && ctx.switchCosts[model.id]) || 0,
    avgLatencyMs: isKnown(model.avgLatencyMs) ? Number(model.avgLatencyMs) : null,
    outputPer1k: isKnown(model.outputPer1k) ? Number(model.outputPer1k) : null,
    estimatedCost: expCost,
    excluded: ctxFit.excluded ? 'context_window' : budgetExcluded ? 'budget' : null,
    exclusionReason: ctxFit.excluded ? ctxFit.reason : budgetExcluded ? budgetReason : null,
    reasons,
    taskProfile: { category: taskProfile.category, complexity: taskProfile.complexity, confidence: taskProfile.confidence },
  };
}

function rankCandidates(models, ctx = {}) {
  const scored = (models || []).map((m) => scoreCandidate(m, ctx));
  scored.sort((a, b) => {
    if ((a.excluded && !b.excluded)) return 1;
    if ((!a.excluded && b.excluded)) return -1;
    return b.finalScore - a.finalScore || String(a.modelId).localeCompare(String(b.modelId));
  });
  return scored;
}

// Deterministic routing-input hash for reproducibility (§39). Secrets never
// included: ids, categories, budgets, windows, policy versions only.
function hashRoutingInputs(input = {}) {
  const canon = {
    task: String(input.taskText || '').slice(0, 2000),
    category: input.taskCategory || '',
    models: (input.models || []).map((m) => `${m.id}:${m.provider}:${m.contextWindow}:${m.outputPer1k}:${m.status}`).sort().join('|'),
    perf: input.perfDigest || '',
    budget: `${input.remainingBudget}:${input.hardBudget}`,
    policy: input.policyVersion || VERSIONS.routingPolicy,
    need: input.needTokens || 0,
  };
  return `route-${crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16)}`;
}

// ---------- Model switching policy (§28) ----------

const SWITCH_TRIGGERS = Object.freeze([
  'provider_failure', 'context_overflow', 'tool_compatibility_failure',
  'repeated_unsuccessful_trajectory', 'quality_prediction_collapse',
  'budget_constraint', 'latency_threshold',
]);

function decideSwitch(input = {}) {
  const { fromModel, toModel, trigger, incumbentScore, challengerScore, switchingCostUsd, expectedBenefit } = input;
  if (!SWITCH_TRIGGERS.includes(trigger) && trigger !== 'manual' && trigger !== 'initial') {
    return { switch: false, reason: `unknown trigger ${trigger}` };
  }
  if (!fromModel) return { switch: true, toModel, trigger, reason: 'no incumbent; initial selection', confidence: 1 };
  if (fromModel === toModel) return { switch: false, reason: 'challenger is incumbent' };
  // Forced triggers bypass benefit comparison (but still record cost).
  if (['provider_failure', 'context_overflow', 'tool_compatibility_failure'].includes(trigger)) {
    return {
      switch: true, fromModel, toModel, trigger,
      reason: `${trigger}: incumbent cannot continue; failing over`,
      expectedBenefit: expectedBenefit ?? null,
      expectedCost: switchingCostUsd ?? 0,
      confidence: 0.9,
    };
  }
  const gain = Number(challengerScore) - Number(incumbentScore);
  const costUnits = 0.2 * ((Number(switchingCostUsd) || 0) / 0.01);
  const net = gain - costUnits;
  const minGain = Number(input.minGain) || 0.03;
  if (!Number.isFinite(gain) || net <= 0 || gain < minGain) {
    return { switch: false, fromModel, toModel, trigger, reason: `net benefit ${Number.isFinite(net) ? net.toFixed(3) : 'unknown'} does not cover switching cost $${switchingCostUsd}`, expectedCost: switchingCostUsd ?? 0, confidence: 0.7 };
  }
  return {
    switch: true, fromModel, toModel, trigger,
    reason: `expected gain ${gain.toFixed(3)} exceeds switching cost $${switchingCostUsd}`,
    expectedBenefit: round4(gain), expectedCost: switchingCostUsd ?? 0, confidence: 0.75,
  };
}

// ---------- Counterfactual comparison (§29) ----------

function counterfactuals(selected, ranked, opts = {}) {
  const limit = Math.max(1, Math.min(5, Number(opts.limit) || 2));
  return ranked
    .filter((c) => c.modelId !== (selected && selected.modelId))
    .slice(0, limit)
    .map((c) => ({
      modelId: c.modelId,
      kind: 'estimated', // NEVER 'observed' unless actually run
      estimatedSuccess: c.predictedSuccess,
      estimatedCost: c.expectedCostUsd,
      estimatedLatencyMs: c.expectedLatencyMs,
      confidence: (c.predictedSuccessMeta && c.predictedSuccessMeta.confidence) || 'none',
      disclaimer: 'estimate from historical performance + priors; this model was not run',
    }));
}

function explainSelection(selected, ranked, opts = {}) {
  const alt = ranked.find((c) => c.modelId !== selected.modelId && !c.excluded) || ranked.find((c) => c.modelId !== selected.modelId);
  const lines = [];
  lines.push(`Selected ${selected.modelId || selected.name} (predicted success ${selected.predictedSuccess === null ? 'unknown' : `${(selected.predictedSuccess * 100).toFixed(0)}%`}, expected cost ${selected.expectedCostUsd === null ? 'unknown' : `$${selected.expectedCostUsd}`}).`);
  for (const r of (selected.reasons || []).slice(0, 6)) {
    lines.push(`- ${r.factor}: ${r.humanExplanation}`);
  }
  let tradeoff = null;
  if (alt) {
    tradeoff = {
      alternativeId: alt.modelId,
      alternativeSuccess: alt.predictedSuccess,
      alternativeCost: alt.expectedCostUsd,
      deltaSuccess: selected.predictedSuccess !== null && alt.predictedSuccess !== null ? round3(selected.predictedSuccess - alt.predictedSuccess) : null,
      deltaCost: selected.expectedCostUsd !== null && alt.expectedCostUsd !== null ? round4(selected.expectedCostUsd - alt.expectedCostUsd) : null,
    };
    if (tradeoff.deltaSuccess !== null && tradeoff.deltaCost !== null) {
      lines.push(`Trade-off vs ${alt.modelId}: ${tradeoff.deltaCost >= 0 ? '+' : ''}$${tradeoff.deltaCost} for ${tradeoff.deltaSuccess >= 0 ? '+' : ''}${(tradeoff.deltaSuccess * 100).toFixed(1)}pp estimated success.`);
    }
  }
  return { summary: lines.join('\n'), tradeoff };
}

module.exports = {
  UTILITY_DEFAULTS,
  SWITCH_TRIGGERS,
  scoreCandidate,
  rankCandidates,
  hashRoutingInputs,
  decideSwitch,
  counterfactuals,
  explainSelection,
  toolCapabilityScore,
  contextFitScore,
  estimateCostUsd,
};
