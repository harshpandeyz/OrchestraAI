'use strict';

const { TaskStatus, ModelStatus, CostCategory } = require('../core/types');

class PolicyEngine {
  constructor(policyState, options = {}) {
    this.policy = policyState;
    this.config = {
      budgetWarningThreshold: options.budgetWarningThreshold || 0.8,
      budgetCriticalThreshold: options.budgetCriticalThreshold || 0.95,
      latencyWarningThreshold: options.latencyWarningThreshold || 0.8,
      contextWarningThreshold: options.contextWarningThreshold || 0.8,
      maxRetries: options.maxRetries || 3,
      retryBackoffMs: options.retryBackoffMs || 1000,
      modelStickinessThreshold: options.modelStickinessThreshold || 0.7,
      modelSwitchingThreshold: options.modelSwitchingThreshold || 0.15,
      ...options
    };
  }

  evaluateBudget(budgetState) {
    const remaining = budgetState.getRemainingBudget();
    const spent = budgetState.currentSpend;
    const max = budgetState.maximumCost;
    const ratio = max > 0 ? spent / max : 0;

    return {
      isExceeded: budgetState.isBudgetExceeded(),
      isWarning: budgetState.isBudgetWarning(this.config.budgetWarningThreshold),
      isCritical: ratio >= this.config.budgetCriticalThreshold,
      remaining,
      ratio,
      canContinue: !budgetState.isBudgetExceeded()
    };
  }

  evaluateLatency(budgetState) {
    const elapsed = budgetState.elapsedLatency;
    const max = budgetState.maximumLatency;
    const ratio = max > 0 ? elapsed / max : 0;

    return {
      isExceeded: budgetState.isLatencyExceeded(),
      isWarning: ratio >= this.config.latencyWarningThreshold,
      elapsed,
      ratio,
      canContinue: !budgetState.isLatencyExceeded()
    };
  }

  evaluateContext(contextState) {
    const utilization = contextState.getUtilization();
    const isNearLimit = contextState.isNearLimit(this.config.contextWarningThreshold);

    return {
      utilization,
      isNearLimit,
      isCritical: utilization >= 0.95,
      currentTokens: contextState.currentTokens,
      maxTokens: contextState.maximumTokens,
      canContinue: utilization < 1.0
    };
  }

  evaluateModelHealth(modelState) {
    return {
      isHealthy: modelState.modelHealth === ModelStatus.HEALTHY,
      isDegraded: modelState.modelHealth === ModelStatus.DEGRADED,
      isUnavailable: modelState.modelHealth === ModelStatus.UNAVAILABLE,
      latency: modelState.modelLatency,
      reliability: modelState.modelReliability,
      canContinue: modelState.modelHealth !== ModelStatus.UNAVAILABLE
    };
  }

  evaluateModelSwitch(modelState, switchingCost, netBenefit, stickinessManager, runId) {
    const stickinessCheck = stickinessManager.canSwitch(
      runId,
      modelState.currentModel,
      null,
      netBenefit,
      switchingCost.total
    );

    const switchCount = modelState.modelSwitchCount;
    const timeSinceLastSwitch = stickinessManager.getTimeSinceLastSwitch(runId);

    return {
      allowed: stickinessCheck.allowed,
      reason: stickinessCheck.reason,
      switchCount,
      timeSinceLastSwitch,
      netBenefit,
      switchingCost: switchingCost.total,
      requiredBenefit: switchingCost.total * (stickinessManager.hysteresisFactor || 1.5),
      ...stickinessCheck
    };
  }

  evaluateProvider(provider) {
    return this.policy.isProviderAllowed(provider);
  }

  evaluateModel(modelId) {
    return this.policy.isModelAllowed(modelId);
  }

  evaluateTool(toolName) {
    return this.policy.isToolAllowed(toolName);
  }

  evaluateCapabilities(requiredCapabilities, modelCapabilities) {
    const missing = requiredCapabilities.filter(c => !modelCapabilities.includes(c));
    return {
      satisfied: missing.length === 0,
      missing,
      available: modelCapabilities
    };
  }

  evaluateRetry(executionState, error) {
    const shouldRetry = executionState.retries < this.config.maxRetries;
    const backoffMs = this.config.retryBackoffMs * Math.pow(2, executionState.retries);

    return {
      shouldRetry,
      retryCount: executionState.retries,
      maxRetries: this.config.maxRetries,
      backoffMs,
      error: String(error)
    };
  }

  evaluateTermination(budgetEval, latencyEval, contextEval, modelEval) {
    const shouldTerminate = 
      budgetEval.isExceeded ||
      latencyEval.isExceeded ||
      contextEval.isCritical ||
      modelEval.isUnavailable;

    const reasons = [];
    if (budgetEval.isExceeded) reasons.push('budget_exceeded');
    if (latencyEval.isExceeded) reasons.push('latency_exceeded');
    if (contextEval.isCritical) reasons.push('context_critical');
    if (modelEval.isUnavailable) reasons.push('model_unavailable');

    return {
      shouldTerminate,
      reasons,
      canContinue: !shouldTerminate
    };
  }

  getOptimizationTriggers(budgetEval, latencyEval, contextEval, modelEval) {
    const triggers = [];

    if (budgetEval.isWarning) triggers.push({ type: 'budget_warning', severity: 'warning' });
    if (budgetEval.isCritical) triggers.push({ type: 'budget_critical', severity: 'critical' });
    if (latencyEval.isWarning) triggers.push({ type: 'latency_warning', severity: 'warning' });
    if (contextEval.isNearLimit) triggers.push({ type: 'context_limit', severity: 'warning' });
    if (contextEval.isCritical) triggers.push({ type: 'context_critical', severity: 'critical' });
    if (modelEval.isDegraded) triggers.push({ type: 'model_degraded', severity: 'warning' });
    if (modelEval.isUnavailable) triggers.push({ type: 'model_unavailable', severity: 'critical' });

    return triggers;
  }

  updatePolicy(updates) {
    Object.assign(this.policy, updates);
    Object.assign(this.config, updates);
  }
}

module.exports = {
  PolicyEngine
};