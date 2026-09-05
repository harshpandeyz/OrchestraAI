'use strict';

const { CostCategory } = require('../core/types');
const { normalizeModelCost, round6 } = require('../cost/breakdown');

const SavingsStatus = Object.freeze({
  VERIFIED_MODELED: 'verified_modeled',
  NO_SAVINGS: 'no_savings',
  COST_INCREASE: 'cost_increase',
  INSUFFICIENT_PRICING_DATA: 'insufficient_pricing_data',
  INCOMPLETE_RUN: 'incomplete_run',
});

const DEFAULT_PLATFORM_FEE_PCT = 0.25;

function normalizeFeePct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_PLATFORM_FEE_PCT;
}

// The savings result is the single source consumed by billing and the UI.
// Billing never recomputes baseline, provider cost, or savings independently.
function addBillingFields(result, platformFeePct) {
  const feePct = normalizeFeePct(platformFeePct);
  const amount = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const baseline = amount(result.baselineCost);
  const actual = amount(result.actualCost);
  const savings = amount(result.savings);
  const eligible = result.status === SavingsStatus.VERIFIED_MODELED && savings !== null
    ? Math.max(0, savings) : 0;
  const platformFee = round6(eligible * feePct);
  const calculationStatus = result.status === SavingsStatus.INCOMPLETE_RUN
    ? 'incomplete'
    : result.status === SavingsStatus.INSUFFICIENT_PRICING_DATA ? 'insufficient_data' : 'verified_modeled';
  const economicOutcome = calculationStatus !== 'verified_modeled' ? null
    : savings === null ? null : eligible > 0 ? 'saved' : savings === 0 ? 'unchanged' : 'cost_increase';
  return {
    ...result,
    baselineCost: baseline,
    actualCost: actual,
    savings,
    calculationStatus,
    economicOutcome,
    platformFeePct: feePct,
    eligibleSavings: round6(eligible),
    platformFee,
    customerFinalCost: actual === null ? null : round6(actual + platformFee),
    customerNetSavings: baseline === null || actual === null ? null : round6(baseline - actual - platformFee),
    economicsStatus: result.status === SavingsStatus.VERIFIED_MODELED ? 'verified_modeled' : 'not_eligible',
    invoiceStatus: 'not_invoice_reconciled',
  };
}

function getReferenceModel(runtimeState, modelRegistry, explicitReferenceModelId = null) {
  const requested = explicitReferenceModelId || runtimeState?.referenceModelId || null;
  if (requested) {
    const model = modelRegistry.models?.get(requested);
    return { modelId: requested, provider: model?.provider || null, source: 'explicit' };
  }
  // A commercial baseline must be an explicit project/run policy. Selecting a
  // strongest model here would silently change customer economics.
  return null;
}

function getPricingForModel(modelRegistry, modelId) {
  const model = modelRegistry.models?.get(modelId);
  if (!model) return null;
  return {
    inputPer1k: model.inputPer1k ?? null,
    outputPer1k: model.outputPer1k ?? null,
    cachedPer1k: model.cachedPer1k ?? null,
    source: model.pricingSource || 'seed',
    version: model.pricingVersion || 1,
    updatedAt: model.pricingUpdatedAt || model.updatedAt || null,
  };
}

function validatePricing(pricing, requiredComponents = ['inputPer1k', 'outputPer1k']) {
  const missing = [];
  for (const comp of requiredComponents) {
    if (pricing[comp] === null || pricing[comp] === undefined || !Number.isFinite(pricing[comp])) {
      missing.push(comp);
    }
  }
  return missing;
}

function tokenValue(value, { required = false } = {}) {
  if (value === null || value === undefined || value === '') return required ? null : 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function normalizeHistoricalPricingSnapshot(snapshot, provider, model) {
  if (!snapshot) return null;
  return {
    provider: snapshot.provider || provider,
    model: snapshot.model || snapshot.modelId || model,
    inputPer1k: snapshot.inputPer1k ?? null,
    outputPer1k: snapshot.outputPer1k ?? null,
    cachedPer1k: snapshot.cachedPer1k ?? null,
    pricingTimestamp: snapshot.pricingTimestamp || snapshot.updatedAt || snapshot.capturedAt || null,
    pricingSource: snapshot.pricingSource || snapshot.source || 'unknown',
    pricingVersion: snapshot.pricingVersion || snapshot.version || null,
  };
}

function calculateStepBaselineCost(step, referencePricing, referenceModelId) {
  const inputTokens = tokenValue(step.inputTokens, { required: true });
  const outputTokens = tokenValue(step.outputTokens, { required: true });
  const cachedTokens = tokenValue(step.cachedTokens);
  const reasoningTokens = tokenValue(step.reasoningTokens);

  if ([inputTokens, outputTokens, cachedTokens, reasoningTokens].some((value) => Number.isNaN(value))) {
    return { valid: false, error: 'negative_token_values', step: step.step };
  }
  if (inputTokens === null || outputTokens === null) {
    return { valid: false, error: 'insufficient_usage_data', missing: [inputTokens === null ? 'inputTokens' : null, outputTokens === null ? 'outputTokens' : null].filter(Boolean), step: step.step };
  }

  const missing = validatePricing(referencePricing, ['inputPer1k', 'outputPer1k']);
  if (missing.length > 0) {
    return { valid: false, error: 'insufficient_pricing_data', missing, step: step.step };
  }

  const normalized = normalizeModelCost({
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    pricing: referencePricing,
    provider: step.provider,
    model: referenceModelId,
  });

  return {
    valid: true,
    step: step.step,
    provider: step.provider,
    actualModel: step.model,
    referenceModel: referenceModelId,
    baselineCost: normalized.totalUsd,
    baselineBreakdown: normalized,
    pricingSnapshot: {
      provider: step.provider,
      model: referenceModelId,
      inputPer1k: referencePricing.inputPer1k,
      outputPer1k: referencePricing.outputPer1k,
      cachedPer1k: referencePricing.cachedPer1k,
      pricingTimestamp: referencePricing.updatedAt || new Date().toISOString(),
      pricingSource: referencePricing.source,
      pricingVersion: referencePricing.version || null,
    },
  };
}

function calculateStepActualCost(step, modelRegistry) {
  const actualModelId = step.model;
  const actualPricing = getPricingForModel(modelRegistry, actualModelId);

  const inputTokens = tokenValue(step.inputTokens, { required: true });
  const outputTokens = tokenValue(step.outputTokens, { required: true });
  const cachedTokens = tokenValue(step.cachedTokens);
  const reasoningTokens = tokenValue(step.reasoningTokens);

  if ([inputTokens, outputTokens, cachedTokens, reasoningTokens].some((value) => Number.isNaN(value))) {
    return { valid: false, error: 'negative_token_values', step: step.step };
  }
  if (inputTokens === null || outputTokens === null) {
    return { valid: false, error: 'insufficient_usage_data', missing: [inputTokens === null ? 'inputTokens' : null, outputTokens === null ? 'outputTokens' : null].filter(Boolean), step: step.step };
  }

  // A canonical call explicitly marked unknown cannot be re-priced from the
  // mutable current registry. Doing so would turn an unknown historical call
  // into a verified commercial result after a later catalog refresh.
  if (step.costSource === 'unknown' || step.costSource === 'unknown_estimate') {
    return { valid: false, error: 'insufficient_pricing_data', step: step.step, model: actualModelId };
  }

  let actualCost = 0;
  let actualBreakdown = null;
  let pricingSnapshot = null;

  // Historical runs carry the canonical cost and the pricing snapshot that
  // existed at call time. Never re-price a historical call from today's
  // mutable registry.
  if (Number.isFinite(step.canonicalCostUsd) && step.canonicalCostUsd >= 0
      && step.costSource !== 'unknown' && step.costSource !== 'unknown_estimate') {
    actualCost = Number(step.canonicalCostUsd);
    actualBreakdown = {
      totalUsd: actualCost,
      currency: 'USD',
      provider: step.provider,
      model: actualModelId,
      providerReported: step.costSource === 'provider_reported',
      canonical: true,
    };
    pricingSnapshot = normalizeHistoricalPricingSnapshot(step.pricingSnapshot, step.provider, actualModelId);
  }

  // Provider-reported usage economics are authoritative whenever the adapter
  // returned them. Registry pricing remains the reproducible fallback for
  // providers that do not report a charge on the response.
  if (pricingSnapshot) {
    // Canonical historical value already won above.
  } else if (Number.isFinite(step.providerCostUsd) && step.providerCostUsd >= 0) {
    actualCost = Number(step.providerCostUsd);
    actualBreakdown = {
      totalUsd: actualCost,
      currency: 'USD',
      provider: step.provider,
      model: actualModelId,
      providerReported: true,
    };
    pricingSnapshot = {
      provider: step.provider,
      model: actualModelId,
      inputPer1k: actualPricing?.inputPer1k ?? null,
      outputPer1k: actualPricing?.outputPer1k ?? null,
      cachedPer1k: actualPricing?.cachedPer1k ?? null,
      pricingTimestamp: actualPricing?.updatedAt || new Date().toISOString(),
      pricingSource: 'provider_reported',
      pricingVersion: actualPricing?.version || null,
      note: 'Provider-reported charge is authoritative for this call',
    };
  } else if (actualPricing && actualPricing.inputPer1k !== null && actualPricing.outputPer1k !== null) {
    const normalized = normalizeModelCost({
      inputTokens,
      cachedTokens,
      outputTokens,
      reasoningTokens,
      pricing: actualPricing,
      provider: step.provider,
      model: actualModelId,
    });
    actualCost = normalized.totalUsd;
    actualBreakdown = normalized;
    pricingSnapshot = {
      provider: step.provider,
      model: actualModelId,
      inputPer1k: actualPricing.inputPer1k,
      outputPer1k: actualPricing.outputPer1k,
      cachedPer1k: actualPricing.cachedPer1k,
      pricingTimestamp: actualPricing.updatedAt || new Date().toISOString(),
      pricingSource: actualPricing.source,
      pricingVersion: actualPricing.version || null,
    };
  } else if (step.costSource !== 'unknown' && step.costSource !== 'unknown_estimate'
      && Number.isFinite(step.actualCost) && step.actualCost >= 0) {
    actualCost = Number(step.actualCost);
    actualBreakdown = {
      totalUsd: actualCost,
      currency: 'USD',
      provider: step.provider,
      model: actualModelId,
      fallback: true,
    };
    pricingSnapshot = {
      provider: step.provider,
      model: actualModelId,
      inputPer1k: null,
      outputPer1k: null,
      cachedPer1k: null,
      pricingTimestamp: new Date().toISOString(),
      pricingSource: 'fallback_actual_cost',
      note: 'Used actual cost from runtime; per-token pricing unavailable',
    };
  } else {
    return { valid: false, error: 'insufficient_pricing_data', step: step.step, model: actualModelId };
  }

  return {
    valid: true,
    step: step.step,
    provider: step.provider,
    actualModel: actualModelId,
    referenceModel: null,
    actualCost,
    actualBreakdown,
    pricingSnapshot,
  };
}

function extractStepsFromRun(runtimeState, eventBus, modelRegistry, orchestratorOrControl = null) {
  const runId = runtimeState.runId;
  const events = eventBus?.eventLogs?.get(runId) || [];
  const steps = [];

  // Canonical model-call records are the only source for commercial
  // economics. Telemetry/series/events may explain a run but cannot rebuild
  // its cost or create duplicate calls.
  return (runtimeState.modelCalls || [])
    .filter((call) => call && call.providerCall !== false)
    .map((call) => ({
      callId: call.callId,
      step: call.step,
      provider: call.provider,
      model: call.model,
      inputTokens: call.usage?.inputTokens ?? null,
      outputTokens: call.usage?.outputTokens ?? null,
      cachedTokens: call.usage?.cachedTokens ?? null,
      reasoningTokens: call.usage?.reasoningTokens ?? null,
      providerCostUsd: call.providerCostUsd,
      calculatedCostUsd: call.calculatedCostUsd,
      canonicalCostUsd: call.canonicalCostUsd,
      costSource: call.costSource,
      pricingSnapshot: call.pricingSnapshot,
      actualCost: call.canonicalCostUsd ?? null,
      executionStatus: 'completed',
    }));
}

function determineSavingsStatus(baselineCost, actualCost, savings) {
  if (baselineCost <= 0) {
    return SavingsStatus.NO_SAVINGS;
  }
  if (savings > 0) {
    return SavingsStatus.VERIFIED_MODELED;
  }
  if (savings === 0) {
    return SavingsStatus.VERIFIED_MODELED;
  }
  return SavingsStatus.COST_INCREASE;
}

function calculateSavings({
  referenceModel,
  steps,
  modelRegistry,
  explicitReferenceModelId = null,
  referencePricingSnapshot = null,
  platformFeePct,
}) {
  if (!referenceModel) {
    return addBillingFields({
      status: SavingsStatus.INSUFFICIENT_PRICING_DATA,
      referenceModel: null,
      baselineCost: null,
      actualCost: null,
      savings: null,
      savingsRate: null,
      currency: 'USD',
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
      steps: [],
      breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
      pricingSnapshot: [],
      error: 'No reference model available',
    }, platformFeePct);
  }

  const referencePricing = referencePricingSnapshot || getPricingForModel(modelRegistry, referenceModel.modelId);
  if (!referencePricing) {
    return addBillingFields({
      status: SavingsStatus.INSUFFICIENT_PRICING_DATA,
      referenceModel: referenceModel.modelId,
      baselineCost: null,
      actualCost: null,
      savings: null,
      savingsRate: null,
      currency: 'USD',
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
      steps: [],
      breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
      pricingSnapshot: [],
      error: `Reference model ${referenceModel.modelId} not found in registry`,
    }, platformFeePct);
  }

  const missingRefPricing = validatePricing(referencePricing, ['inputPer1k', 'outputPer1k']);
  if (missingRefPricing.length > 0) {
    return addBillingFields({
      status: SavingsStatus.INSUFFICIENT_PRICING_DATA,
      referenceModel: referenceModel.modelId,
      baselineCost: null,
      actualCost: null,
      savings: null,
      savingsRate: null,
      currency: 'USD',
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
      steps: [],
      breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
      pricingSnapshot: [],
      error: `Reference model ${referenceModel.modelId} missing pricing: ${missingRefPricing.join(', ')}`,
    }, platformFeePct);
  }

  let totalBaselineCost = 0;
  let totalActualCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalReasoningTokens = 0;
  const stepBreakdowns = [];
  const pricingSnapshots = [];

  for (const step of steps) {
    if (!step.model || !step.provider) {
      continue;
    }

    const baselineResult = calculateStepBaselineCost(step, referencePricing, referenceModel.modelId);
    const actualResult = calculateStepActualCost(step, modelRegistry);

    if (!baselineResult.valid) {
      return addBillingFields({
        status: SavingsStatus.INSUFFICIENT_PRICING_DATA,
        referenceModel: referenceModel.modelId,
        baselineCost: null,
        actualCost: null,
        savings: null,
        savingsRate: null,
        currency: 'USD',
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
        steps: [],
        breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
        pricingSnapshot: [],
        error: `Step ${step.step}: ${baselineResult.error}${baselineResult.missing ? ` (missing: ${baselineResult.missing.join(', ')})` : ''}`,
      }, platformFeePct);
    }

    if (!actualResult.valid) {
      return addBillingFields({
        status: SavingsStatus.INSUFFICIENT_PRICING_DATA,
        referenceModel: referenceModel.modelId,
        baselineCost: null,
        actualCost: null,
        savings: null,
        savingsRate: null,
        currency: 'USD',
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
        steps: [],
        breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
        pricingSnapshot: [],
        error: `Step ${step.step} (actual model ${actualResult.model}): ${actualResult.error}`,
      }, platformFeePct);
    }

    totalBaselineCost += baselineResult.baselineCost;
    totalActualCost += actualResult.actualCost;
    totalInputTokens += Number(step.inputTokens) || 0;
    totalOutputTokens += Number(step.outputTokens) || 0;
    totalCachedTokens += Number(step.cachedTokens) || 0;
    totalReasoningTokens += Number(step.reasoningTokens) || 0;

    const delta = baselineResult.baselineCost - actualResult.actualCost;

    stepBreakdowns.push({
      step: step.step,
      provider: step.provider,
      actualModel: step.model,
      referenceModel: referenceModel.modelId,
      actualCost: round6(actualResult.actualCost),
      baselineCost: round6(baselineResult.baselineCost),
      delta: round6(delta),
    });

    if (baselineResult.pricingSnapshot) {
      pricingSnapshots.push({
        type: 'reference',
        step: step.step,
        ...baselineResult.pricingSnapshot,
      });
    }
    if (actualResult.pricingSnapshot) {
      pricingSnapshots.push({
        type: 'actual',
        step: step.step,
        ...actualResult.pricingSnapshot,
      });
    }
  }

  const savings = totalBaselineCost - totalActualCost;
  const savingsRate = totalBaselineCost > 0 ? round6(savings / totalBaselineCost) : 0;
  const status = determineSavingsStatus(totalBaselineCost, totalActualCost, savings);

  return addBillingFields({
    status,
    referenceModel: {
      modelId: referenceModel.modelId,
      provider: referenceModel.provider,
      source: referenceModel.source,
    },
    baselineCost: round6(totalBaselineCost),
    actualCost: round6(totalActualCost),
    savings: round6(savings),
    savingsRate,
    currency: 'USD',
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCachedTokens,
      reasoningTokens: totalReasoningTokens,
    },
    steps: stepBreakdowns,
    breakdown: {
      modelRouting: 0,
      contextCompression: 0,
      caching: 0,
      retryAvoidance: 0,
    },
    pricingSnapshot: pricingSnapshots,
  }, platformFeePct);
}

function calculateSavingsForRun(runtimeState, eventBus, modelRegistry, explicitReferenceModelId = null, orchestrator = null, options = {}) {
  if (!runtimeState || runtimeState.status !== 'completed') {
    return addBillingFields({
      status: SavingsStatus.INCOMPLETE_RUN,
      referenceModel: null,
      baselineCost: null,
      actualCost: null,
      savings: null,
      savingsRate: null,
      currency: 'USD',
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
      steps: [],
      breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
      pricingSnapshot: [],
      error: `Run is not completed (status: ${runtimeState?.status || 'unknown'})`,
    }, options.platformFeePct);
  }

  const referenceModel = getReferenceModel(runtimeState, modelRegistry, explicitReferenceModelId || runtimeState.referenceModelId || null);
  const steps = extractStepsFromRun(runtimeState, eventBus, modelRegistry, orchestrator);

  // A completed run without an explicit commercial baseline is an
  // insufficient-data result, even when it has no provider steps to inspect.
  // Do this before the empty-step guard so the UI never implies that a
  // missing policy is merely an incomplete execution.
  if (!referenceModel) {
    return calculateSavings({
      referenceModel: null,
      steps,
      modelRegistry,
      explicitReferenceModelId,
      referencePricingSnapshot: runtimeState.referencePricingSnapshot || null,
      platformFeePct: options.platformFeePct,
    });
  }

  if (steps.length === 0) {
    return addBillingFields({
      status: SavingsStatus.INCOMPLETE_RUN,
      referenceModel: referenceModel ? { modelId: referenceModel.modelId, provider: referenceModel.provider, source: referenceModel.source } : null,
      baselineCost: null,
      actualCost: null,
      savings: null,
      savingsRate: null,
      currency: 'USD',
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null },
      steps: [],
      breakdown: { modelRouting: 0, contextCompression: 0, caching: 0, retryAvoidance: 0 },
      pricingSnapshot: [],
      error: 'No execution steps with token usage found',
    }, options.platformFeePct);
  }

  return calculateSavings({
    referenceModel,
    steps,
    modelRegistry,
    explicitReferenceModelId,
    referencePricingSnapshot: runtimeState.referencePricingSnapshot || null,
    platformFeePct: options.platformFeePct,
  });
}

module.exports = {
  SavingsEngine: {
    calculateSavings,
    calculateSavingsForRun,
    SavingsStatus,
    addBillingFields,
    DEFAULT_PLATFORM_FEE_PCT,
  },
  getReferenceModel,
  getPricingForModel,
  extractStepsFromRun,
  calculateStepBaselineCost,
  calculateStepActualCost,
  determineSavingsStatus,
  validatePricing,
  round6,
  SavingsStatus,
  addBillingFields,
  DEFAULT_PLATFORM_FEE_PCT,
};
