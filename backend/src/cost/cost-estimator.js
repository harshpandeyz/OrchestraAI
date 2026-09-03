'use strict';

const { CostCategory } = require('../core/types');

class CostEstimator {
  constructor(pricingProvider = null, options = {}) {
    this.pricingProvider = pricingProvider;
    this.costHistory = [];
    this.maxHistory = options.maxHistory || 1000;
    this.defaultPricing = {
      inputPer1k: 0.001,
      outputPer1k: 0.003,
      cachedPer1k: 0.0002,
      toolBaseCost: 0.001,
      retrievalBaseCost: 0.0005,
      switchingBaseCost: 0.005,
      retryBaseCost: 0.002,
      evaluationBaseCost: 0.001,
      orchestrationOverheadPerStep: 0.0001
    };
  }

  setPricingProvider(provider) {
    this.pricingProvider = provider;
  }

  // Attach a ModelRegistry as the ONE authoritative pricing source. When
  // attached, per-model rates always come from the registry; the built-in
  // defaults are only a fallback for unknown models. This keeps router
  // estimates and recorded costs in agreement.
  attachRegistry(modelRegistry) {
    this.modelRegistry = modelRegistry;
    return this;
  }

  resolveModelPricing(modelId) {
    if (this.modelRegistry && typeof this.modelRegistry.getPricing === 'function') {
      try {
        const p = this.modelRegistry.getPricing(modelId);
        if (p && (p.inputPer1k != null || p.outputPer1k != null)) {
          return {
            inputPer1k: p.inputPer1k ?? this.defaultPricing.inputPer1k,
            outputPer1k: p.outputPer1k ?? this.defaultPricing.outputPer1k,
            cachedPer1k: p.cachedPer1k ?? this.defaultPricing.cachedPer1k,
            source: 'registry',
          };
        }
      } catch { /* fall through to defaults */ }
    }
    return { ...this.defaultPricing, source: 'default' };
  }

  async getModelPricing(modelId, provider) {
    if (this.pricingProvider && typeof this.pricingProvider.getPricing === 'function') {
      return await this.pricingProvider.getPricing(modelId, provider);
    }
    return this.defaultPricing;
  }

  estimateModelCost(modelId, provider, inputTokens, outputTokens, cachedTokens = 0) {
    const pricing = this.resolveModelPricing(modelId);
    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    
    const inputCost = (uncachedInput / 1000) * pricing.inputPer1k;
    const cachedCost = (cachedTokens / 1000) * pricing.cachedPer1k;
    const outputCost = (outputTokens / 1000) * pricing.outputPer1k;
    
    return {
      [CostCategory.INPUT_TOKENS]: inputCost,
      [CostCategory.CACHED_INPUT_TOKENS]: cachedCost,
      [CostCategory.UNCACHED_INPUT_TOKENS]: inputCost,
      [CostCategory.OUTPUT_TOKENS]: outputCost,
      total: inputCost + cachedCost + outputCost,
      breakdown: {
        inputTokens,
        outputTokens,
        cachedTokens,
        uncachedTokens: uncachedInput,
        pricingSource: pricing.source,
        inputPer1k: pricing.inputPer1k,
        outputPer1k: pricing.outputPer1k,
        cachedPer1k: pricing.cachedPer1k,
      }
    };
  }

  estimateToolCost(toolName, estimatedCalls = 1, complexity = 'medium') {
    const multipliers = { low: 0.5, medium: 1, high: 2 };
    const multiplier = multipliers[complexity] || 1;
    const cost = this.defaultPricing.toolBaseCost * estimatedCalls * multiplier;
    
    return {
      [CostCategory.TOOL_EXECUTION]: cost,
      total: cost,
      breakdown: { toolName, estimatedCalls, complexity }
    };
  }

  estimateRetrievalCost(queryCount = 1, resultCount = 10) {
    const cost = this.defaultPricing.retrievalBaseCost * queryCount * (resultCount / 10);
    
    return {
      [CostCategory.RETRIEVAL]: cost,
      total: cost,
      breakdown: { queryCount, resultCount }
    };
  }

  estimateSwitchingCost(fromModel, toModel, contextTokens, cachedTokens) {
    const baseCost = this.defaultPricing.switchingBaseCost;
    const contextCost = (contextTokens / 1000) * 0.001;
    const cacheCost = (cachedTokens / 1000) * 0.0005;
    
    return {
      [CostCategory.SWITCHING]: baseCost + contextCost + cacheCost,
      total: baseCost + contextCost + cacheCost,
      breakdown: { fromModel, toModel, contextTokens, cachedTokens }
    };
  }

  estimateRetryCost(previousAttemptCost, retryCount) {
    const cost = this.defaultPricing.retryBaseCost * retryCount + previousAttemptCost * 0.5;
    
    return {
      [CostCategory.RETRY]: cost,
      total: cost,
      breakdown: { previousAttemptCost, retryCount }
    };
  }

  estimateEvaluationCost(evaluationType = 'basic') {
    const multipliers = { basic: 1, detailed: 2, comprehensive: 5 };
    const cost = this.defaultPricing.evaluationBaseCost * (multipliers[evaluationType] || 1);
    
    return {
      [CostCategory.EVALUATION]: cost,
      total: cost,
      breakdown: { evaluationType }
    };
  }

  estimateOrchestrationOverhead(stepCount) {
    const cost = this.defaultPricing.orchestrationOverheadPerStep * stepCount;
    
    return {
      [CostCategory.ORCHESTRATION_OVERHEAD]: cost,
      total: cost,
      breakdown: { stepCount }
    };
  }

  estimateTotalCost(estimates) {
    const categories = Object.values(CostCategory);
    const total = {};
    let grandTotal = 0;

    for (const estimate of estimates) {
      for (const category of categories) {
        if (estimate[category] !== undefined) {
          total[category] = (total[category] || 0) + estimate[category];
          grandTotal += estimate[category];
        }
      }
    }

    return {
      ...total,
      total: grandTotal
    };
  }

  recordActualCost(runId, category, estimated, actual, metadata = {}) {
    const record = {
      runId,
      category,
      estimated,
      actual,
      variance: actual - estimated,
      variancePct: estimated > 0 ? ((actual - estimated) / estimated) * 100 : 0,
      timestamp: new Date().toISOString(),
      ...metadata
    };
    
    this.costHistory.push(record);
    if (this.costHistory.length > this.maxHistory) {
      this.costHistory.shift();
    }
    
    return record;
  }

  getCostAccuracy(category = null) {
    let records = this.costHistory;
    if (category) {
      records = records.filter(r => r.category === category);
    }
    
    if (records.length === 0) return null;
    
    const avgVariancePct = records.reduce((sum, r) => sum + Math.abs(r.variancePct), 0) / records.length;
    const avgVariance = records.reduce((sum, r) => sum + Math.abs(r.variance), 0) / records.length;
    
    return {
      sampleCount: records.length,
      avgVariancePct,
      avgVariance,
      records: records.slice(-10)
    };
  }

  getHistory(limit = 50) {
    return this.costHistory.slice(-limit);
  }
}

module.exports = {
  CostEstimator
};