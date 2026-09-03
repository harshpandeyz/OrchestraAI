'use strict';

const { CostCategory } = require('../core/types');

class SwitchingCostCalculator {
  constructor(options = {}) {
    this.baseContextReconstructionCost = options.baseContextReconstructionCost || 0.005;
    this.cacheLossCostPerToken = options.cacheLossCostPerToken || 0.000001;
    this.tokenResendCostPerToken = options.tokenResendCostPerToken || 0.0000005;
    this.providerOverheadCost = options.providerOverheadCost || 0.001;
    this.latencyPenaltyMs = options.latencyPenaltyMs || 500;
    this.stateTranslationCost = options.stateTranslationCost || 0.0005;
    this.restartRetryCost = options.restartRetryCost || 0.002;
    this.riskPenaltyMultiplier = options.riskPenaltyMultiplier || 1.2;
  }

  calculate(contextState, modelState, fromModel, toModel, options = {}) {
    const costs = {
      contextReconstruction: 0,
      cacheLoss: 0,
      tokenResend: 0,
      providerOverhead: 0,
      latencyPenalty: 0,
      stateTranslation: 0,
      restartRetry: 0,
      riskPenalty: 0,
      total: 0,
      breakdown: {}
    };

    const contextUtilization = contextState.getUtilization();
    const cachedTokens = contextState.cacheablePrefixTokens || 0;
    const totalTokens = contextState.currentTokens || 0;

    costs.contextReconstruction = this.baseContextReconstructionCost * (1 + contextUtilization);
    costs.breakdown.contextReconstruction = costs.contextReconstruction;

    if (cachedTokens > 0) {
      costs.cacheLoss = cachedTokens * this.cacheLossCostPerToken;
      costs.breakdown.cacheLoss = costs.cacheLoss;
    }

    if (totalTokens > 0) {
      costs.tokenResend = totalTokens * this.tokenResendCostPerToken;
      costs.breakdown.tokenResend = costs.tokenResend;
    }

    const fromProvider = modelState.currentProvider;
    const toProvider = options.toProvider;
    if (fromProvider && toProvider && fromProvider !== toProvider) {
      costs.providerOverhead = this.providerOverheadCost;
      costs.breakdown.providerOverhead = costs.providerOverhead;
    }

    const expectedLatencyIncrease = (options.toModelLatency || 0) - (modelState.modelLatency || 0);
    if (expectedLatencyIncrease > 0) {
      costs.latencyPenalty = (expectedLatencyIncrease / 1000) * 0.0001;
      costs.breakdown.latencyPenalty = costs.latencyPenalty;
    }

    costs.stateTranslation = this.stateTranslationCost;
    costs.breakdown.stateTranslation = costs.stateTranslation;

    if (options.requiresRestart) {
      costs.restartRetry = this.restartRetryCost;
      costs.breakdown.restartRetry = costs.restartRetry;
    }

    const baseTotal = Object.values(costs.breakdown).reduce((a, b) => a + b, 0);
    costs.riskPenalty = baseTotal * (this.riskPenaltyMultiplier - 1);
    costs.breakdown.riskPenalty = costs.riskPenalty;

    // Explicit USD total: every component above is dollars-per-switch
    // (context rebuild + cache loss + token resend + provider overhead +
    // latency penalty + state translation + restart risk). Never NaN/negative.
    costs.total = Number.isFinite(baseTotal + costs.riskPenalty)
      ? Math.max(0, baseTotal + costs.riskPenalty)
      : 0;

    return costs;
  }

  // Net benefit in explicit ROUTER-SCORE units (never raw mixed units).
  //
  //   qualityGain:      score delta, already ~[-1, 1]         (weight 1)
  //   costSavingUsd:    $0.01 ~= 1 score unit, weight 0.2
  //                     (mirrors the router's costScore $/0.01 scale)
  //   latencyGainMs:    5000ms ~= 1 score unit, weight 0.15
  //                     (mirrors the router's latencyScore ms/5000 scale)
  //   switchingCostUsd: $0.01 ~= 1 score unit, weight 0.2
  //                     (same dollar scale as savings, so a switch must earn
  //                     back its own dollar cost in score terms)
  //
  // Previously this added milliseconds to dollars to score deltas raw, which
  // made every latency difference dominate and forced constant switching.
  calculateNetBenefit(qualityGain, costSavingUsd, latencyGainMs, switchingCostUsd) {
    const q = Number.isFinite(Number(qualityGain)) ? Number(qualityGain) : 0;
    const c = Number.isFinite(Number(costSavingUsd)) ? Number(costSavingUsd) / 0.01 : 0;
    const l = Number.isFinite(Number(latencyGainMs)) ? Number(latencyGainMs) / 5000 : 0;
    const s = Number.isFinite(Number(switchingCostUsd)) ? Number(switchingCostUsd) / 0.01 : 0;
    const net = q + 0.2 * c + 0.15 * l - 0.2 * s;
    return Number.isFinite(net) ? Math.max(-10, Math.min(10, net)) : 0;
  }

  shouldSwitch(netBenefit, threshold = 0) {
    if (!Number.isFinite(netBenefit) || !Number.isFinite(threshold)) return false;
    return netBenefit > threshold;
  }
}

class ModelStickinessManager {
  constructor(options = {}) {
    this.stickinessThreshold = options.stickinessThreshold || 0.7;
    this.switchingThreshold = options.switchingThreshold || 0.15;
    this.cooldownPeriodMs = options.cooldownPeriodMs || 60000;
    this.maxSwitchesPerTask = options.maxSwitchesPerTask || 5;
    this.hysteresisFactor = options.hysteresisFactor || 1.5;
    this.lastSwitchTime = new Map();
    this.switchCounts = new Map();
  }

  canSwitch(runId, currentModel, candidateModel, netBenefit, switchingCost) {
    const lastSwitch = this.lastSwitchTime.get(runId) || 0;
    const timeSinceLastSwitch = Date.now() - lastSwitch;
    const switchCount = this.switchCounts.get(runId) || 0;

    // Defensive coercion: callers must pass same-unit numbers. A cost object
    // is unwrapped via .total instead of silently producing NaN hysteresis.
    // +Infinity benefit means "benefit already decided upstream; enforce only
    // cooldown and switch-count limits" (used by the orchestrator, where the
    // router has already scored the switch).
    const cost = (switchingCost && typeof switchingCost === 'object')
      ? switchingCost.total
      : switchingCost;
    const benefitRaw = Number(netBenefit);
    const benefit = benefitRaw === Infinity ? Infinity
      : (Number.isFinite(benefitRaw) ? benefitRaw : 0);
    const costNum = Number.isFinite(Number(cost)) ? Math.max(0, Number(cost)) : 0;

    if (switchCount >= this.maxSwitchesPerTask) {
      return { allowed: false, reason: 'max_switches_exceeded' };
    }

    if (timeSinceLastSwitch < this.cooldownPeriodMs) {
      return { allowed: false, reason: 'cooldown_active', remainingMs: this.cooldownPeriodMs - timeSinceLastSwitch };
    }

    const requiredBenefit = costNum * this.hysteresisFactor;
    if (benefit < requiredBenefit) {
      return { allowed: false, reason: 'insufficient_benefit', requiredBenefit, netBenefit: benefit };
    }

    return { allowed: true };
  }

  recordSwitch(runId) {
    this.lastSwitchTime.set(runId, Date.now());
    this.switchCounts.set(runId, (this.switchCounts.get(runId) || 0) + 1);
  }

  getSwitchCount(runId) {
    return this.switchCounts.get(runId) || 0;
  }

  getTimeSinceLastSwitch(runId) {
    const lastSwitch = this.lastSwitchTime.get(runId);
    return lastSwitch ? Date.now() - lastSwitch : Infinity;
  }

  reset(runId) {
    this.lastSwitchTime.delete(runId);
    this.switchCounts.delete(runId);
  }
}

module.exports = {
  SwitchingCostCalculator,
  ModelStickinessManager
};