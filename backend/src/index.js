'use strict';

const { TaskStatus, ModelStatus, EventType, DecisionType, DecisionStatus, CheckpointType, CostCategory } = require('./core/types');
const { RuntimeState, TaskState, ModelState, ContextState, ContextItem, MemoryState, ToolState, BudgetState, ExecutionState, PolicyState, generateId, now } = require('./state/runtime-state');
const { EventBus, EventEnvelope, eventBus } = require('./events/event-bus');
const { Decision, DecisionFactor, DecisionAlternative, DecisionEngine } = require('./decisions/decision-engine');
const { SwitchingCostCalculator, ModelStickinessManager } = require('./decisions/switching-cost');
const { PolicyEngine } = require('./policies/policy-engine');
const { CostEstimator } = require('./cost/cost-estimator');
const { ExecutionCheckpoint, CheckpointManager, RecoveryManager } = require('./checkpoint/checkpoint-manager');
const { TelemetryEvent, TelemetryCollector } = require('./telemetry/telemetry-collector');
const { StateMachine, STATE_TRANSITIONS, TERMINAL_STATES } = require('./core/state-machine');
const { Orchestrator } = require('./core/orchestrator');
const { 
  ModelRegistry, ModelRouter, ContextManager, MemoryManager, CacheManager, 
  ToolRegistry, ToolExecutor, CostEstimatorInterface, PolicyEngineInterface, 
  TelemetryCollector: TelemetryCollectorInterface, EvaluationEngine 
} = require('./interfaces');
const { InMemoryModelRegistry } = require('./impl/model-registry');
const { InMemoryModelRouter } = require('./impl/model-router');
const { InMemoryContextManager } = require('./impl/context-manager');
const { InMemoryMemoryManager } = require('./impl/memory-manager');
const { InMemoryCacheManager } = require('./impl/cache-manager');
const { InMemoryToolRegistry } = require('./impl/tool-registry');
const { InMemoryToolExecutor } = require('./impl/tool-executor');
const { loadConfig, redact } = require('./config');
const { createLogger } = require('./logger');
const { ProviderRegistry, ProviderError, DemoProviderAdapter, OpenRouterAdapter, OpenAIAdapter, AnthropicAdapter } = require('./providers/provider-adapter');
const { DiscoveryService } = require('./providers/model-discovery');
const { buildSnapshot, runSummary } = require('./api/snapshot');
const { FileStore } = require('./persistence');
const { EvaluationStore, buildEvaluation, scoreEvidence } = require('./evals');

module.exports = {
  // Types
  TaskStatus,
  ModelStatus,
  EventType,
  DecisionType,
  DecisionStatus,
  CheckpointType,
  CostCategory,
  
  // State
  RuntimeState,
  TaskState,
  ModelState,
  ContextState,
  ContextItem,
  MemoryState,
  ToolState,
  BudgetState,
  ExecutionState,
  PolicyState,
  generateId,
  now,
  
  // Events
  EventBus,
  EventEnvelope,
  eventBus,
  
  // Decisions
  Decision,
  DecisionFactor,
  DecisionAlternative,
  DecisionEngine,
  SwitchingCostCalculator,
  ModelStickinessManager,
  
  // Policies
  PolicyEngine,
  
  // Cost
  CostEstimator,
  
  // Checkpoint
  ExecutionCheckpoint,
  CheckpointManager,
  RecoveryManager,
  
  // Telemetry
  TelemetryEvent,
  TelemetryCollector,
  
  // State Machine
  StateMachine,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  
  // Orchestrator
  Orchestrator,
  
  // Interfaces
  ModelRegistry,
  ModelRouter,
  ContextManager,
  MemoryManager,
  CacheManager,
  ToolRegistry,
  ToolExecutor,
  CostEstimatorInterface,
  PolicyEngineInterface,
  TelemetryCollectorInterface,
  EvaluationEngine,
  
  // Implementations
  InMemoryModelRegistry,
  InMemoryModelRouter,
  InMemoryContextManager,
  InMemoryMemoryManager,
  InMemoryCacheManager,
  InMemoryToolRegistry,
  InMemoryToolExecutor,

  // Session 5 integration
  loadConfig,
  redact,
  createLogger,
  ProviderRegistry,
  ProviderError,
  DemoProviderAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  DiscoveryService,
  buildSnapshot,
  runSummary,
  FileStore,
  EvaluationStore,
  buildEvaluation,
  scoreEvidence,
};