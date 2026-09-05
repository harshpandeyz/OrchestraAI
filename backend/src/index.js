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
const { Orchestrator, frontendStatus, summarizeToolResult } = require('./core/orchestrator');
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
// Session 3 — agent execution capabilities.
const { ExecutionController, attachExecution } = require('./execution/controller');
const ToolSystem = require('./execution/tool-system');
const ExecutionPolicy = require('./execution/execution-policy');
const Approvals = require('./execution/approvals');
const Changesets = require('./execution/changesets');
const Environment = require('./execution/environment');
const PlansEpisodes = require('./execution/plans-episodes');
const Recovery = require('./execution/recovery');
const { resolveRunConfig, attachRunConfig, runConfigFor } = require('./run-config');
const { IdempotencyStore, STATES: IdempotencyStates } = require('./idempotency');
const { loadAuthConfig, authenticate, requireRole, canAccessRun } = require('./auth');
const { resolveProviderRuntime } = require('./provider-runtime');
const { loadLimits } = require('./limits');
const { appVersion } = require('./version');
const { normalizeModelCost } = require('./cost/breakdown');

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
  frontendStatus,
  summarizeToolResult,
  
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
  // Session 3 — agent execution engine
  ExecutionController,
  attachExecution,
  ToolSystem,
  ExecutionPolicy,
  Approvals,
  Changesets,
  Environment,
  PlansEpisodes,
  Recovery,
  // Session 1 foundation
  resolveRunConfig,
  attachRunConfig,
  runConfigFor,
  IdempotencyStore,
  IdempotencyStates,
  loadAuthConfig,
  authenticate,
  requireRole,
  canAccessRun,
  resolveProviderRuntime,
  loadLimits,
  appVersion,
  normalizeModelCost,
};