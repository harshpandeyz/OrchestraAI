'use strict';

class ModelRegistry {
  async getModels() {
    throw new Error('getModels() must be implemented');
  }

  async getModel(modelId) {
    throw new Error('getModel() must be implemented');
  }

  async registerModel(model) {
    throw new Error('registerModel() must be implemented');
  }

  async updateModel(modelId, updates) {
    throw new Error('updateModel() must be implemented');
  }

  async unregisterModel(modelId) {
    throw new Error('unregisterModel() must be implemented');
  }

  async getModelsByCapability(capability) {
    throw new Error('getModelsByCapability() must be implemented');
  }

  async getModelsByProvider(provider) {
    throw new Error('getModelsByProvider() must be implemented');
  }

  async healthCheck(modelId) {
    throw new Error('healthCheck() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }

  off(event, handler) {
    throw new Error('off() must be implemented');
  }
}

class ModelRouter {
  async route(task, runtimeState, candidates, policy) {
    throw new Error('route() must be implemented');
  }

  async evaluateCandidates(task, runtimeState, candidates) {
    throw new Error('evaluateCandidates() must be implemented');
  }

  async scoreModel(model, task, runtimeState) {
    throw new Error('scoreModel() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class ContextManager {
  async buildContext(task, runtimeState, policy) {
    throw new Error('buildContext() must be implemented');
  }

  async addContext(runtimeState, items) {
    throw new Error('addContext() must be implemented');
  }

  async removeContext(runtimeState, itemIds) {
    throw new Error('removeContext() must be implemented');
  }

  async compressContext(runtimeState, targetTokens, policy) {
    throw new Error('compressContext() must be implemented');
  }

  async getRelevantContext(runtimeState, query, maxTokens) {
    throw new Error('getRelevantContext() must be implemented');
  }

  async estimateTokens(content) {
    throw new Error('estimateTokens() must be implemented');
  }

  getContextState(runtimeState) {
    throw new Error('getContextState() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class MemoryManager {
  async readWorkingMemory(runtimeState, query, limit) {
    throw new Error('readWorkingMemory() must be implemented');
  }

  async readLongTermMemory(runtimeState, query, limit) {
    throw new Error('readLongTermMemory() must be implemented');
  }

  async writeWorkingMemory(runtimeState, item) {
    throw new Error('writeWorkingMemory() must be implemented');
  }

  async writeLongTermMemory(runtimeState, item) {
    throw new Error('writeLongTermMemory() must be implemented');
  }

  async evictMemory(runtimeState, itemId, scope) {
    throw new Error('evictMemory() must be implemented');
  }

  async searchMemory(runtimeState, query, scopes, limit) {
    throw new Error('searchMemory() must be implemented');
  }

  getMemoryState(runtimeState) {
    throw new Error('getMemoryState() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class CacheManager {
  async get(key) {
    throw new Error('get() must be implemented');
  }

  async set(key, value, ttl) {
    throw new Error('set() must be implemented');
  }

  async invalidate(key) {
    throw new Error('invalidate() must be implemented');
  }

  async invalidatePrefix(prefix) {
    throw new Error('invalidatePrefix() must be implemented');
  }

  async getStats() {
    throw new Error('getStats() must be implemented');
  }

  async warmCache(runtimeState, items) {
    throw new Error('warmCache() must be implemented');
  }

  getCacheState(runtimeState) {
    throw new Error('getCacheState() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class ToolRegistry {
  async getTools() {
    throw new Error('getTools() must be implemented');
  }

  async getTool(name) {
    throw new Error('getTool() must be implemented');
  }

  async registerTool(tool) {
    throw new Error('registerTool() must be implemented');
  }

  async unregisterTool(name) {
    throw new Error('unregisterTool() must be implemented');
  }

  async updateTool(name, updates) {
    throw new Error('updateTool() must be implemented');
  }

  async getToolsByCapability(capability) {
    throw new Error('getToolsByCapability() must be implemented');
  }

  async healthCheck(name) {
    throw new Error('healthCheck() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class ToolExecutor {
  async execute(toolName, params, runtimeState, options = {}) {
    throw new Error('execute() must be implemented');
  }

  async executeParallel(toolCalls, runtimeState, options = {}) {
    throw new Error('executeParallel() must be implemented');
  }

  async validateParams(toolName, params) {
    throw new Error('validateParams() must be implemented');
  }

  getToolState(runtimeState) {
    throw new Error('getToolState() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

class CostEstimatorInterface {
  async estimateModelCost(modelId, provider, inputTokens, outputTokens, cachedTokens) {
    throw new Error('estimateModelCost() must be implemented');
  }

  async estimateToolCost(toolName, estimatedCalls, complexity) {
    throw new Error('estimateToolCost() must be implemented');
  }

  async estimateRetrievalCost(queryCount, resultCount) {
    throw new Error('estimateRetrievalCost() must be implemented');
  }

  async estimateSwitchingCost(fromModel, toModel, contextTokens, cachedTokens) {
    throw new Error('estimateSwitchingCost() must be implemented');
  }

  async estimateTotalCost(estimates) {
    throw new Error('estimateTotalCost() must be implemented');
  }

  recordActualCost(runId, category, estimated, actual, metadata) {
    throw new Error('recordActualCost() must be implemented');
  }

  getCostAccuracy(category) {
    throw new Error('getCostAccuracy() must be implemented');
  }
}

class PolicyEngineInterface {
  evaluateBudget(budgetState) {
    throw new Error('evaluateBudget() must be implemented');
  }

  evaluateLatency(budgetState) {
    throw new Error('evaluateLatency() must be implemented');
  }

  evaluateContext(contextState) {
    throw new Error('evaluateContext() must be implemented');
  }

  evaluateModelHealth(modelState) {
    throw new Error('evaluateModelHealth() must be implemented');
  }

  evaluateModelSwitch(modelState, switchingCost, netBenefit, stickinessManager, runId) {
    throw new Error('evaluateModelSwitch() must be implemented');
  }

  evaluateProvider(provider) {
    throw new Error('evaluateProvider() must be implemented');
  }

  evaluateModel(modelId) {
    throw new Error('evaluateModel() must be implemented');
  }

  evaluateTool(toolName) {
    throw new Error('evaluateTool() must be implemented');
  }

  evaluateCapabilities(requiredCapabilities, modelCapabilities) {
    throw new Error('evaluateCapabilities() must be implemented');
  }

  evaluateRetry(executionState, error) {
    throw new Error('evaluateRetry() must be implemented');
  }

  evaluateTermination(budgetEval, latencyEval, contextEval, modelEval) {
    throw new Error('evaluateTermination() must be implemented');
  }

  getOptimizationTriggers(budgetEval, latencyEval, contextEval, modelEval) {
    throw new Error('getOptimizationTriggers() must be implemented');
  }

  updatePolicy(updates) {
    throw new Error('updatePolicy() must be implemented');
  }
}

class TelemetryCollector {
  recordEvent(runId, event) {
    throw new Error('recordEvent() must be implemented');
  }

  recordMetric(runId, metricName, value, tags = {}) {
    throw new Error('recordMetric() must be implemented');
  }

  recordDecision(runId, decision) {
    throw new Error('recordDecision() must be implemented');
  }

  getRunTelemetry(runId) {
    throw new Error('getRunTelemetry() must be implemented');
  }

  getAggregatedMetrics(timeRange) {
    throw new Error('getAggregatedMetrics() must be implemented');
  }

  flush() {
    throw new Error('flush() must be implemented');
  }
}

class EvaluationEngine {
  async evaluateOutput(runId, output, expected, criteria) {
    throw new Error('evaluateOutput() must be implemented');
  }

  async evaluateStep(runId, stepResult, criteria) {
    throw new Error('evaluateStep() must be implemented');
  }

  async evaluateTrajectory(runId, trajectory, criteria) {
    throw new Error('evaluateTrajectory() must be implemented');
  }

  async compareModels(runId, modelOutputs, criteria) {
    throw new Error('compareModels() must be implemented');
  }

  getEvaluationHistory(runId) {
    throw new Error('getEvaluationHistory() must be implemented');
  }

  on(event, handler) {
    throw new Error('on() must be implemented');
  }
}

module.exports = {
  ModelRegistry,
  ModelRouter,
  ContextManager,
  MemoryManager,
  CacheManager,
  ToolRegistry,
  ToolExecutor,
  CostEstimatorInterface,
  PolicyEngineInterface,
  TelemetryCollector,
  EvaluationEngine
};