'use strict';

// ModelRouter — routing layer that considers task type, capabilities, context,
// pricing, health, performance, cache state, reliability, budget, switching cost,
// and produces explainable decisions compatible with Session 1 Decision contract.

const { ModelRegistry } = require('./model_registry');
const { PricingSource } = require('./pricing_source');
const { ModelHealthMonitor } = require('./model_health');
const { ModelPerformanceTracker } = require('./model_performance');
const { BenchmarkFramework } = require('./benchmark_framework');
const { RollingWindow } = require('./rolling_window');

const SCORE_WEIGHTS = {
  QUALITY_FIRST: { quality: 0.5, cost: 0.1, latency: 0.15, reliability: 0.15, contextFit: 0.1, switchingCost: 0 },
  COST_FIRST: { quality: 0.2, cost: 0.4, latency: 0.15, reliability: 0.15, contextFit: 0.1, switchingCost: 0 },
  LATENCY_FIRST: { quality: 0.2, cost: 0.1, latency: 0.5, reliability: 0.1, contextFit: 0.1, switchingCost: 0 },
  BALANCED: { quality: 0.35, cost: 0.25, latency: 0.2, reliability: 0.15, contextFit: 0.1, switchingCost: 0.05 },
};

const STATUS_PASS = 'pass';
const STATUS_WARN = 'warn';
const STATUS_FAIL = 'fail';

class ModelRouter {
  constructor(options = {}) {
    this.registry = options.registry || new ModelRegistry();
    this.pricing = options.pricing || new PricingSource(this.registry);
    this.health = options.health || new ModelHealthMonitor(this.registry);
    this.performance = options.performance || new ModelPerformanceTracker(this.registry);
    this.benchmark = options.benchmark || new BenchmarkFramework(this.registry, this.performance);
    this.costEstimator = options.costEstimator || new (require('./cost_estimator'))({
      registry: this.registry,
      pricing: this.pricing,
    });
    this.scoreWeights = { ...SCORE_WEIGHTS.BALANCED };
    this.stickinessConfig = { minSwitchBenefit: 0.05, minBenefitRatio: 0.1 };
    this.decisionHistory = [];
    this.maxHistorySize = 20;
  }

  // ---- Main routing entry point ----

  route(requirements) {
    const {
      taskType,
      taskComplexity,
      requiredCapabilities,
      currentModelId,
      excludeModels,
      includeModels,
      policyConstraints,
    } = requirements || {};

    // Step 1: Eligibility filtering
    const candidates = this._filterCandidates(
      requiredCapabilities,
      currentModelId,
      excludeModels || [],
      includeModels || [],
      policyConstraints || {},
    );

    if (candidates.length === 0) {
      return this._noModelDecision('No models match the requirements');
    }

    // Step 2: Cheap scoring for all candidates
    const scored = this._cheapScore(candidates, requirements);

    // Step 3: Select finalists (top 3 or all if fewer)
    const finalists = this._selectFinalists(scored);

    // Step 4: Detailed scoring for finalists
    const detailed = this._detailedScore(finalists, requirements);

    // Step 5: Apply stickiness and switching cost
    const switched = this._applyStickiness(detailed, currentModelId);

    // Step 6: Generate fallback candidates
    const fallbacks = this._getFallbacks(switched, currentModelId);

    // Step 7: Build the Decision object
    return this._buildDecision(switched, fallbacks, currentModelId, requirements);
  }

  // ---- Step 1: Eligibility filtering ----

  _filterCandidates(requiredCapabilities, currentModelId, excludeModels, includeModels, policyConstraints) {
    const allModels = this.registry.listModels({ status: 'active' });
    const excludedSet = new Set(excludeModels);
    let filtered = allModels.filter(m => !excludedSet.has(m.id));

    if (includeModels && includeModels.length > 0) {
      const includedSet = new Set(includeModels);
      filtered = filtered.filter(m => includedSet.has(m.id));
    }

    // Capability filtering
    if (requiredCapabilities && requiredCapabilities.minCapabilities && requiredCapabilities.minCapabilities.length > 0) {
      filtered = filtered.filter(m => {
        const caps = m.capabilities || {};
        return requiredCapabilities.minCapabilities.every(c => caps[c]);
      });
    }

    // Context limit filtering
    if (requiredCapabilities && requiredCapabilities.minContext !== undefined) {
      filtered = filtered.filter(m => m.limits.context_window >= requiredCapabilities.minContext);
    }

    // Budget filtering
    if (requiredCapabilities && requiredCapabilities.maxCost !== undefined) {
      filtered = filtered.filter(m => {
        const price = this.pricing.getCurrentPrice(m.id);
        return price && price.input_price <= requiredCapabilities.maxCost;
      });
    }

    // Latency constraint filtering
    if (requiredCapabilities && requiredCapabilities.maxLatency !== undefined) {
      filtered = filtered.filter(m => {
        const h = this.health.getHealth(m.id);
        return h && h.latency <= requiredCapabilities.maxLatency;
      });
    }

    // Policy constraints
    if (policyConstraints && policyConstraints.allowedProviders) {
      filtered = filtered.filter(m => policyConstraints.allowedProviders.includes(m.provider.provider_id));
    }

    return filtered;
  }

  // ---- Step 2: Cheap scoring ----

  _cheapScore(candidates, requirements) {
    const taskType = requirements.taskType || 'general';
    const caps = this._taskToCapabilities(taskType);

    return candidates.map(model => {
      const price = this.pricing.getCurrentPrice(model.id) || { input_price: 0, output_price: 0, currency: 'USD' };
      const health = this.health.getHealth(model.id) || { availability: 1, latency: 0, error_rate: 0 };
      const perf = this.performance.getPerformance(model.id) || { quality_score: 0, sample_count: 0, confidence: 0 };

      // Context fit: can the model handle typical task context?
      const requiredContext = requiredCapabilities?.minContext || 0;
      const contextFit = model.limits.context_window >= requiredContext ? 1 : 0.5;

      // Switching cost
      const switchingCost = currentModelId && model.id === currentModelId ? 0 : this._estimateSwitchingCost(model);

      // Capability fit: how many of the task's required caps does this model have?
      const modelCaps = model.capabilities || {};
      const matchedCaps = caps.filter(c => modelCaps[c]);
      const capabilityFit = caps.length > 0 ? matchedCaps.length / caps.length : 1;

      // Apply weight configuration
      const w = this.scoreWeights;
      const quality = perf.quality_score || 0;

      // Normalized cost score (lower price = higher score)
      const costScore = price.input_price > 0 ? 1 / (price.input_price / 0.001 + 1) : 1;

      // Normalized latency score (lower latency = higher score)
      const latencyScore = health.latency > 0 ? 1 / (health.latency / 1000 + 1) : 1;

      // Reliability score
      const reliability = health.availability || 0;

      const score =
        quality * w.quality +
        costScore * w.cost +
        latencyScore * w.latency +
        reliability * w.reliability +
        capabilityFit * w.contextFit +
        (1 - switchingCost) * (1 - w.switchingCost);

      return {
        model,
        score,
        price,
        health,
        perf,
        contextFit,
        capabilityFit,
        switchingCost,
      };
    }).sort((a, b) => b.score - a.score);
  }

  // ---- Step 3: Select finalists for detailed scoring ----

  _selectFinalists(scored) {
    const n = Math.min(3, scored.length);
    return scored.slice(0, n);
  }

  // ---- Step 4: Detailed scoring ----

  _detailedScore(finalists, requirements) {
    return finalists.map(f => {
      const model = f.model;
      const caps = model.capabilities || {};
      const price = this.pricing.getCurrentPrice(model.id) || { input_price: 0.001, output_price: 0.003 };
      const health = this.health.getHealth(model.id) || {};
      const perf = this.performance.getPerformance(model.id) || {};

      // Context-aware check
      const requiredContext = requirements.requiredCapabilities?.minContext || 0;
      const contextFit = model.limits.context_window >= requiredContext ? 1 : 0;

      // Capability mismatch
      const taskCaps = this._taskToCapabilities(requirements.taskType || 'general');
      const missing = taskCaps.filter(c => !caps[c]);
      const capabilityMismatch = taskCaps.length > 0 ? missing.length / taskCaps.length : 0;

      // Reliability from observed performance
      const reliability = perf.quality_score !== undefined ? perf.quality_score : (health.availability || 0.5);

      // Latency score
      const latencyScore = health.latency ? 1 / Math.max(health.latency / 1000, 0.1) : 1;

      // Cost score
      const costScore = 1 / Math.max(price.input_price / 1000, 0.001);

      return {
        model,
        contextFit,
        capabilityMismatch,
        reliability,
        latencyScore,
        costScore,
        price,
        health,
        perf,
      };
    });
  }

  // ---- Step 5: Apply stickiness ----

  _applyStickiness(scored, currentModelId) {
    if (!currentModelId) {
      return { model: scored.length > 0 ? scored[0].model.id : null, isSwitch: false };
    }

    const current = scored.find(s => s.model.id === currentModelId);
    if (!current) {
      // Current model not in candidates — must switch if better available
      return scored.length > 0 ? { model: scored[0].model.id, isSwitch: true, currentModelId } : { model: null, isSwitch: false };
    }

    // Current model is in the candidate list
    const topAlternative = scored[0];

    // Current model is already top-ranked
    if (topAlternative.model.id === currentModelId) {
      return { model: currentModelId, isSwitch: false, currentModelId, currentScore: topAlternative.score };
    }

    // Calculate score difference (benefit of switching)
    const scoreDifference = topAlternative.score - current.score;

    // Stickiness: don't switch if benefit is too small
    if (scoreDifference < this.stickinessConfig.minSwitchBenefit) {
      // Keep current model if it already has a high score
      if (current.score > 0.75) {
        return { model: currentModelId, isSwitch: false, currentModelId, currentScore: current.score };
      }
    }

    // Switch to better model
    return {
      model: topAlternative.model.id,
      isSwitch: true,
      currentModelId,
      currentScore: current.score,
      recommendedModel: topAlternative.model.id,
      scoreDifference,
    };
  }

  // ---- Step 6: Generate fallbacks ----

  _getFallbacks(switched, currentModelId) {
    const fallbacks = [];

    if (!switched) return fallbacks;

    const { isSwitch, currentModelId: currentId, recommendedModel, currentScore, scoreDifference } = switched;

    // If switching, the current model is a fallback
    if (isSwitch && currentId) {
      fallbacks.push({
        id: currentId,
        reason: 'current_model_retained_as_fallback',
        deltaCost: 0,
        deltaLatency: 0,
        score: currentScore || 0,
        note: 'Current model — retained for comparison',
      });
    }

    // Add recommended model as primary fallback
    if (recommendedModel) {
      fallbacks.unshift({
        id: recommendedModel,
        reason: 'recommended_primary',
        deltaCost: 0,
        deltaLatency: 0,
        score: 1,
        note: 'Recommended model based on scoring',
      });
    }

    return fallbacks.slice(0, 3);
  }

  // ---- Build Decision object (Session 1 compatible) ----

  _buildDecision(switched, fallbacks, currentModelId, requirements) {
    if (!switched || !switched.model) {
      return {
        kind: 'model',
        decision: 'NO_MODEL_AVAILABLE',
        factors: [{ key: 'availability', label: 'No models available', status: STATUS_FAIL }],
        alternatives: [],
        timestamp: new Date(),
      };
    }

    const modelId = switched.model;
    const modelInfo = this.registry.getModel(modelId) || {};
    const isSwitch = switched.isSwitch || false;
    const currentId = currentModelId || null;
    const scoreDifference = switched.scoreDifference || 0;

    // Determine decision
    let decision;
    if (isSwitch) {
      decision = 'SWITCH_MODEL';
    } else {
      decision = 'KEEP CURRENT MODEL';
    }

    // Build factors from detailed scoring
    const detailed = this._detailedScore([{ model: this.registry.getModel(modelId) || {} }], requirements);
    const detail = detailed[0] || {};

    const factorStatus = (pass) => pass ? STATUS_PASS : STATUS_WARN;

    // Compute delta cost and latency for alternatives
    const currentPrice = currentId ? this.pricing.getCurrentPrice(currentId) : null;
    const recommendedPrice = this.pricing.getCurrentPrice(modelId);

    const deltaCost = currentPrice && recommendedPrice
      ? recommendedPrice.input_price - currentPrice.input_price
      : 0;

    const deltaLatency = currentPrice && recommendedPrice
      ? (currentPrice.latency || 0) - (recommendedPrice.latency || 0) // negative = better
      : 0;

    // Determine factor statuses
    const qualityStatus = currentScore > 0.7 ? STATUS_PASS : currentScore > 0.5 ? STATUS_WARN : STATUS_FAIL;
    const priceStatus = deltaCost !== undefined && deltaCost < 0 ? STATUS_PASS : deltaCost !== undefined && deltaCost > 0.001 ? STATUS_WARN : STATUS_FAIL;
    const latencyStatus = deltaLatency !== undefined && deltaLatency > 0 ? STATUS_WARN : STATUS_PASS;
    const reliabilityStatus = detail.reliability > 0.7 ? STATUS_PASS : STATUS_WARN;
    const contextStatus = detail.contextFit > 0 ? STATUS_PASS : STATUS_FAIL;
    const switchCostStatus = scoreDifference < 0.1 ? STATUS_WARN : STATUS_PASS;

    const factors = [
      { key: 'capability_fit', label: 'Capability fit', status: factorStatus(detail.capabilityMismatch < 0.5), detail: undefined },
      { key: 'quality', label: 'Quality score', status: factorStatus(qualityStatus), detail: (detail.perf?.quality_score || 0).toFixed(2) },
      { key: 'price', label: 'Price', status: factorStatus(priceStatus), detail: this._formatDeltaPrice(deltaCost) },
      { key: 'latency', label: 'Latency', status: factorStatus(latencyStatus), detail: deltaLatency !== undefined ? `${deltaLatency}ms saved` : undefined },
      { key: 'reliability', label: 'Reliability', status: factorStatus(reliabilityStatus), detail: undefined },
      { key: 'context_fit', label: 'Context fit', status: factorStatus(contextStatus), detail: undefined },
      { key: 'switching_cost', label: 'Switching cost', status: factorStatus(switchCostStatus), detail: scoreDifference.toFixed(2) },
    ];

    // Build alternatives from fallbacks
    const alternatives = fallbacks.map(f => ({
      id: f.id,
      deltaCost: f.deltaCost,
      deltaLatency: f.deltaLatency,
      score: f.score,
      note: f.note,
    }));

    return {
      kind: 'model',
      decision,
      factors,
      alternatives,
      timestamp: new Date(),
      payload: {
        selectedModelId: modelId,
        currentModelId: currentId,
        scoreDifference,
        isSwitch,
        score: modelInfo.performance?.quality_score || 0,
      },
    };
  }

  _formatDeltaPrice(deltaCost) {
    if (deltaCost === undefined || deltaCost === 0) return 'no change';
    if (deltaCost < 0) return `save $${Math.abs(deltaCost).toFixed(4)}/1k input`;
    return `cost $${deltaCost.toFixed(4)}/1k input more`;
  }

  // ---- Helper: map task type to required capabilities ----

  _taskToCapabilities(taskType) {
    const mapping = {
      code: ['coding', 'tool_calling'],
      debug: ['coding', 'reasoning', 'tool_calling'],
      research: ['reasoning', 'tool_calling', 'text'],
      general: ['text'],
    };
    return mapping[taskType] || ['text'];
  }

  // ---- Estimate switching cost ----

  _estimateSwitchingCost(model) {
    const price = this.pricing.getCurrentPrice(model.id) || { input_price: 0.001 };
    return Math.min(0.1, (price.input_price || 0) / 10);
  }
}

// ---- Convenience factory ----

function createRouter(options = {}) {
  return new ModelRouter(options);
}

module.exports = { ModelRouter, createRouter, SCORE_WEIGHTS };