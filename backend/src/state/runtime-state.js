'use strict';

const { TaskStatus, ModelStatus, EventType, DecisionType, DecisionStatus, CheckpointType, CostCategory } = require('../core/types');

function generateId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return new Date().toISOString();
}

class TaskState {
  constructor(objective, taskType = 'general', priority = 'normal', complexity = 'medium') {
    this.taskId = generateId('task');
    this.objective = objective;
    this.taskType = taskType;
    this.complexity = complexity;
    this.priority = priority;
    this.status = TaskStatus.CREATED;
    this.progress = 0;
    this.successProbability = 0.5;
    this.createdAt = now();
    this.updatedAt = now();
    this.metadata = {};
  }

  updateStatus(status) {
    this.status = status;
    this.updatedAt = now();
  }

  updateProgress(progress) {
    this.progress = Math.max(0, Math.min(1, progress));
    this.updatedAt = now();
  }

  toJSON() {
    return { ...this };
  }
}

class ModelState {
  constructor() {
    this.currentModel = null;
    this.currentProvider = null;
    this.candidateModels = [];
    this.modelCapabilities = new Map();
    this.modelContextLimit = 0;
    this.modelPricingSnapshot = new Map();
    this.modelHealth = ModelStatus.HEALTHY;
    this.modelLatency = 0;
    this.modelReliability = 1.0;
    this.modelSelectionReason = '';
    this.lastModelChange = null;
    this.modelSwitchCount = 0;
    this.modelStickinessScore = 1.0;
  }

  setCurrentModel(modelId, provider, reason) {
    // Initial selection is NOT a switch: 0 switches after first selection,
    // A->B = 1, B->C = 2. Re-setting the same model never increments.
    const prev = this.currentModel;
    this.currentModel = modelId;
    this.currentProvider = provider;
    this.modelSelectionReason = reason;
    this.lastModelChange = now();
    if (prev !== null && prev !== undefined && prev !== modelId) {
      this.modelSwitchCount += 1;
    }
  }

  updateHealth(health) {
    this.modelHealth = health;
  }

  updateLatency(latencyMs) {
    this.modelLatency = latencyMs;
  }

  updateReliability(reliability) {
    this.modelReliability = Math.max(0, Math.min(1, reliability));
  }

  addCandidate(model) {
    const existing = this.candidateModels.find(c => c.id === model.id);
    if (existing) {
      Object.assign(existing, model);
    } else {
      this.candidateModels.push(model);
    }
  }

  setPricing(modelId, pricing) {
    this.modelPricingSnapshot.set(modelId, pricing);
  }

  getPricing(modelId) {
    return this.modelPricingSnapshot.get(modelId) || {};
  }

  toJSON() {
    return {
      currentModel: this.currentModel,
      currentProvider: this.currentProvider,
      candidateModels: this.candidateModels,
      modelContextLimit: this.modelContextLimit,
      modelHealth: this.modelHealth,
      modelLatency: this.modelLatency,
      modelReliability: this.modelReliability,
      modelSelectionReason: this.modelSelectionReason,
      lastModelChange: this.lastModelChange,
      modelSwitchCount: this.modelSwitchCount,
      modelStickinessScore: this.modelStickinessScore
    };
  }
}

class ContextItem {
  constructor(id, kind, title, source, tokens, relevance = 0.5, status = 'KEEP') {
    this.id = id;
    this.kind = kind;
    this.title = title;
    this.source = source;
    this.tokens = tokens;
    this.relevance = relevance;
    this.status = status;
    this.metadata = {};
  }
}

class ContextState {
  constructor(maxTokens = 128000) {
    this.currentTokens = 0;
    this.maximumTokens = maxTokens;
    this.tokenBudget = maxTokens;
    this.contextItems = [];
    this.compressedItems = [];
    this.discardedItems = [];
    this.contextVersion = 0;
    this.cacheablePrefixTokens = 0;
    this.cacheState = 'COLD';
    this.relevanceThreshold = 0.3;
  }

  addItem(item) {
    this.contextItems.push(item);
    this.currentTokens += item.tokens;
    this.contextVersion++;
  }

  removeItem(itemId) {
    const idx = this.contextItems.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      const item = this.contextItems.splice(idx, 1)[0];
      this.currentTokens -= item.tokens;
      this.discardedItems.push(item);
      this.contextVersion++;
      return item;
    }
    return null;
  }

  compressItem(itemId, compressedTokens) {
    const idx = this.contextItems.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      const item = this.contextItems[idx];
      const reclaimed = item.tokens - compressedTokens;
      item.tokens = compressedTokens;
      item.status = 'COMPRESSED';
      this.currentTokens -= reclaimed;
      this.compressedItems.push({ ...item, reclaimedTokens: reclaimed });
      this.contextVersion++;
      return reclaimed;
    }
    return 0;
  }

  updateCacheState(state) {
    this.cacheState = state;
  }

  setCacheablePrefix(tokens) {
    this.cacheablePrefixTokens = tokens;
  }

  getUtilization() {
    return this.maximumTokens > 0 ? this.currentTokens / this.maximumTokens : 0;
  }

  isNearLimit(threshold = 0.8) {
    return this.getUtilization() >= threshold;
  }

  toJSON() {
    return {
      currentTokens: this.currentTokens,
      maximumTokens: this.maximumTokens,
      tokenBudget: this.tokenBudget,
      contextItems: this.contextItems,
      compressedItems: this.compressedItems,
      discardedItems: this.discardedItems,
      contextVersion: this.contextVersion,
      cacheablePrefixTokens: this.cacheablePrefixTokens,
      cacheState: this.cacheState
    };
  }
}

class MemoryState {
  constructor() {
    this.workingMemoryRefs = [];
    this.persistentMemoryRefs = [];
    this.memoryReads = 0;
    this.memoryWrites = 0;
  }

  addWorkingMemory(ref) {
    this.workingMemoryRefs.push(ref);
  }

  addPersistentMemory(ref) {
    this.persistentMemoryRefs.push(ref);
  }

  recordRead() {
    this.memoryReads++;
  }

  recordWrite() {
    this.memoryWrites++;
  }

  toJSON() {
    return {
      workingMemoryRefs: this.workingMemoryRefs,
      persistentMemoryRefs: this.persistentMemoryRefs,
      memoryReads: this.memoryReads,
      memoryWrites: this.memoryWrites
    };
  }
}

class ToolState {
  constructor() {
    this.availableTools = new Map();
    this.activeTools = new Set();
    this.recentToolCalls = [];
    this.toolHealth = new Map();
    this.toolFailures = new Map();
    this.toolLatency = new Map();
    this.toolCosts = new Map();
  }

  registerTool(name, config) {
    this.availableTools.set(name, { name, ...config, status: 'enabled' });
    this.toolHealth.set(name, 1.0);
    this.toolFailures.set(name, 0);
    this.toolLatency.set(name, 0);
    this.toolCosts.set(name, 0);
  }

  enableTool(name) {
    const tool = this.availableTools.get(name);
    if (tool) {
      tool.status = 'enabled';
      this.activeTools.add(name);
    }
  }

  disableTool(name) {
    const tool = this.availableTools.get(name);
    if (tool) {
      tool.status = 'disabled';
      this.activeTools.delete(name);
    }
  }

  recordCall(name, result) {
    this.recentToolCalls.push({ name, ...result, timestamp: now() });
    if (this.recentToolCalls.length > 100) {
      this.recentToolCalls.shift();
    }
    if (result.latencyMs) {
      this.toolLatency.set(name, result.latencyMs);
    }
    if (result.cost) {
      this.toolCosts.set(name, (this.toolCosts.get(name) || 0) + result.cost);
    }
    if (!result.success) {
      this.toolFailures.set(name, (this.toolFailures.get(name) || 0) + 1);
      this.toolHealth.set(name, Math.max(0, (this.toolHealth.get(name) || 1) - 0.1));
    } else {
      this.toolHealth.set(name, Math.min(1, (this.toolHealth.get(name) || 0.9) + 0.01));
    }
  }

  getTool(name) {
    return this.availableTools.get(name);
  }

  toJSON() {
    return {
      availableTools: Array.from(this.availableTools.values()),
      activeTools: Array.from(this.activeTools),
      recentToolCalls: this.recentToolCalls.slice(-10),
      toolHealth: Object.fromEntries(this.toolHealth),
      toolFailures: Object.fromEntries(this.toolFailures),
      toolLatency: Object.fromEntries(this.toolLatency),
      toolCosts: Object.fromEntries(this.toolCosts)
    };
  }
}

class BudgetState {
  constructor(maxCost = 0.1, maxLatencyMs = 300000) {
    this.maximumCost = maxCost;
    this.currentSpend = 0;
    this.estimatedRemainingCost = 0;
    this.maximumLatency = maxLatencyMs;
    this.elapsedLatency = 0;
    this.costBreakdown = new Map();
    this.costHistory = [];
  }

  addCost(category, amount, metadata = {}) {
    this.currentSpend += amount;
    this.costBreakdown.set(category, (this.costBreakdown.get(category) || 0) + amount);
    this.costHistory.push({ category, amount, timestamp: now(), ...metadata });
  }

  getRemainingBudget() {
    return Math.max(0, this.maximumCost - this.currentSpend);
  }

  getProjectedTotal() {
    return this.currentSpend + this.estimatedRemainingCost;
  }

  isBudgetExceeded() {
    return this.currentSpend >= this.maximumCost;
  }

  isBudgetWarning(threshold = 0.8) {
    return this.currentSpend >= this.maximumCost * threshold;
  }

  addLatency(ms) {
    this.elapsedLatency += ms;
  }

  isLatencyExceeded() {
    return this.elapsedLatency >= this.maximumLatency;
  }

  toJSON() {
    return {
      maximumCost: this.maximumCost,
      currentSpend: this.currentSpend,
      estimatedRemainingCost: this.estimatedRemainingCost,
      remainingBudget: this.getRemainingBudget(),
      maximumLatency: this.maximumLatency,
      elapsedLatency: this.elapsedLatency,
      costBreakdown: Object.fromEntries(this.costBreakdown),
      costHistory: this.costHistory.slice(-50)
    };
  }
}

class ExecutionState {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 0;
    this.stepHistory = [];
    this.retries = 0;
    this.failures = 0;
    this.executionStatus = 'idle';
    this.checkpoints = [];
    this.lastCheckpoint = null;
  }

  startStep(stepInfo) {
    this.currentStep++;
    this.stepHistory.push({ ...stepInfo, step: this.currentStep, startedAt: now(), status: 'running' });
  }

  completeStep(result) {
    const step = this.stepHistory[this.stepHistory.length - 1];
    if (step) {
      step.completedAt = now();
      step.status = 'completed';
      step.result = result;
    }
  }

  failStep(error) {
    const step = this.stepHistory[this.stepHistory.length - 1];
    if (step) {
      step.completedAt = now();
      step.status = 'failed';
      step.error = error;
    }
    this.failures++;
  }

  recordRetry() {
    this.retries++;
  }

  addCheckpoint(checkpoint) {
    this.checkpoints.push(checkpoint);
    this.lastCheckpoint = checkpoint;
  }

  getLastCheckpoint() {
    return this.lastCheckpoint;
  }

  toJSON() {
    return {
      currentStep: this.currentStep,
      totalSteps: this.totalSteps,
      stepHistory: this.stepHistory.slice(-20),
      retries: this.retries,
      failures: this.failures,
      executionStatus: this.executionStatus,
      checkpoints: this.checkpoints.slice(-10),
      lastCheckpoint: this.lastCheckpoint
    };
  }
}

class PolicyState {
  constructor() {
    this.allowedProviders = [];
    this.allowedModels = [];
    this.allowedTools = [];
    this.blockedProviders = [];
    this.blockedModels = [];
    this.blockedTools = [];
    this.privacyConstraints = {};
    this.costConstraints = { maxCost: 0.1, warningThreshold: 0.8 };
    this.latencyConstraints = { maxLatencyMs: 300000, warningThresholdMs: 240000 };
    this.capabilityRequirements = [];
    this.modelStickinessThreshold = 0.7;
    this.modelSwitchingThreshold = 0.15;
    this.contextUtilizationThreshold = 0.8;
    this.maxRetries = 3;
    this.retryBackoffMs = 1000;
  }

  isProviderAllowed(provider) {
    if (this.blockedProviders.includes(provider)) return false;
    if (this.allowedProviders.length > 0 && !this.allowedProviders.includes(provider)) return false;
    return true;
  }

  isModelAllowed(modelId) {
    if (this.blockedModels.includes(modelId)) return false;
    if (this.allowedModels.length > 0 && !this.allowedModels.includes(modelId)) return false;
    return true;
  }

  isToolAllowed(toolName) {
    if (this.blockedTools.includes(toolName)) return false;
    if (this.allowedTools.length > 0 && !this.allowedTools.includes(toolName)) return false;
    return true;
  }

  toJSON() {
    return {
      allowedProviders: this.allowedProviders,
      allowedModels: this.allowedModels,
      allowedTools: this.allowedTools,
      blockedProviders: this.blockedProviders,
      blockedModels: this.blockedModels,
      blockedTools: this.blockedTools,
      privacyConstraints: this.privacyConstraints,
      costConstraints: this.costConstraints,
      latencyConstraints: this.latencyConstraints,
      capabilityRequirements: this.capabilityRequirements,
      modelStickinessThreshold: this.modelStickinessThreshold,
      modelSwitchingThreshold: this.modelSwitchingThreshold,
      contextUtilizationThreshold: this.contextUtilizationThreshold,
      maxRetries: this.maxRetries,
      retryBackoffMs: this.retryBackoffMs
    };
  }
}

class RuntimeState {
  constructor(taskObjective, config = {}) {
    this.runId = generateId('run');
    this.task = new TaskState(taskObjective, config.taskType, config.priority, config.complexity);
    this.model = new ModelState();
    this.context = new ContextState(config.maxContextTokens);
    this.memory = new MemoryState();
    this.tools = new ToolState();
    this.budget = new BudgetState(config.maxCost, config.maxLatencyMs);
    this.execution = new ExecutionState();
    this.policy = new PolicyState();
    this.status = TaskStatus.CREATED;
    this.createdAt = now();
    this.updatedAt = now();
    this.metadata = {};
    // Resource ownership (Session 1 auth): principal id that created the run.
    // Null = pre-auth / public legacy run.
    this.ownerId = typeof config.ownerId === 'string' ? config.ownerId.slice(0, 128) : null;
    this.orgId = typeof config.orgId === 'string' ? config.orgId.slice(0, 128) : null;
    this.projectId = typeof config.projectId === 'string' ? config.projectId.slice(0, 128) : null;
    this.referenceModelId = typeof config.referenceModelId === 'string' ? config.referenceModelId.slice(0, 200) : null;
    this.referencePricingSnapshot = config.referencePricingSnapshot && typeof config.referencePricingSnapshot === 'object'
      ? { ...config.referencePricingSnapshot } : null;
    // Filled exactly once when the run reaches a terminal state. The server
    // persists this frozen result so historical pricing or policy changes
    // cannot rewrite the economics later.
    this.economics = config.economics && typeof config.economics === 'object'
      ? JSON.parse(JSON.stringify(config.economics)) : null;
    this.privacyMode = ['metadata_only', 'standard', 'zero_retention'].includes(config.privacyMode) ? config.privacyMode : 'standard';
    this.executionMode = config.mode === 'live' ? 'live' : 'demo';
    this.modelCalls = [];
    this._eventSeq = 0;
  }

  addModelCall(record) {
    if (!record || typeof record !== 'object') return null;
    this.modelCalls.push(record);
    if (this.modelCalls.length > 200) this.modelCalls.shift();
    this.updatedAt = now();
    return record;
  }

  getEventSeq() {
    return ++this._eventSeq;
  }

  updateStatus(status) {
    this.status = status;
    this.task.updateStatus(status);
    this.updatedAt = now();
  }

  toSnapshot() {
    return {
      runId: this.runId,
      status: this.status,
      task: this.task.toJSON(),
      model: this.model.toJSON(),
      context: this.context.toJSON(),
      memory: this.memory.toJSON(),
      tools: this.tools.toJSON(),
      budget: this.budget.toJSON(),
      execution: this.execution.toJSON(),
      policy: this.policy.toJSON(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: this.metadata,
      ownerId: this.ownerId || null,
      orgId: this.orgId || null,
      projectId: this.projectId || null,
      referenceModelId: this.referenceModelId || null,
      referencePricingSnapshot: this.referencePricingSnapshot || null,
      economics: this.economics || null,
      privacyMode: this.privacyMode,
      executionMode: this.executionMode,
      modelCalls: this.modelCalls.slice(-200),
    };
  }
}

module.exports = {
  TaskState,
  ModelState,
  ContextState,
  ContextItem,
  MemoryState,
  ToolState,
  BudgetState,
  ExecutionState,
  PolicyState,
  RuntimeState,
  generateId,
  now
};
