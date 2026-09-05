'use strict';

const TaskStatus = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  CONTEXT_BUILD: 'context_build',
  MODEL_SELECT: 'model_select',
  EXECUTING: 'executing',
  WAITING_FOR_TOOL: 'waiting_for_tool',
  OBSERVING: 'observing',
  REOPTIMIZING: 'reoptimizing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
  PAUSING: 'pausing',
  RESUMING: 'resuming',
  RETRYING: 'retrying'
});

const ModelStatus = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable'
});

const EventType = Object.freeze({
  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_UPDATED: 'task.updated',
  PLANNING: 'planning',
  CONTEXT_BUILT: 'context.built',
  CONTEXT_ADDED: 'context.added',
  CONTEXT_REMOVED: 'context.removed',
  CONTEXT_COMPRESSED: 'context.compressed',
  CONTEXT_LIMIT_WARNING: 'context.limit_warning',
  MODEL_DISCOVERED: 'model.discovered',
  MODEL_UPDATED: 'model.updated',
  MODEL_PRICE_CHANGED: 'model.price_changed',
  MODEL_HEALTH_CHANGED: 'model.health_changed',
  MODEL_UNAVAILABLE: 'model.unavailable',
  MODEL_SELECTED: 'model.selected',
  MODEL_SWITCH_REQUESTED: 'model.switch_requested',
  MODEL_SWITCHED: 'model.switched',
  MODEL_RETAINED: 'model.retained',
  MODEL_SWITCH_REJECTED: 'model.switch_rejected',
  CACHE_HIT: 'cache.hit',
  CACHE_MISS: 'cache.miss',
  CACHE_INVALIDATED: 'cache.invalidated',
  MEMORY_READ: 'memory.read',
  MEMORY_WRITTEN: 'memory.written',
  MEMORY_EVICTED: 'memory.evicted',
  TOOL_SELECTED: 'tool.selected',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  EXECUTION_STARTED: 'execution.started',
  EXECUTION_STEP_STARTED: 'execution.step_started',
  EXECUTION_STEP_COMPLETED: 'execution.step_completed',
  EXECUTION_FAILED: 'execution.failed',
  EXECUTION_RETRY: 'execution.retry',
  EXECUTION_PAUSED: 'execution.paused',
  EXECUTION_RESUMED: 'execution.resumed',
  EXECUTION_COMPLETED: 'execution.completed',
  ROUTING_EVALUATED: 'routing.evaluated',
  COST_UPDATED: 'cost.updated',
  BUDGET_WARNING: 'budget.warning',
  BUDGET_EXCEEDED: 'budget.exceeded',
  OPTIMIZATION_TRIGGERED: 'optimization.triggered',
  OPTIMIZATION_COMPLETED: 'optimization.completed',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',
  PRICE_UPDATED: 'price.updated',
  CHANGE_RECORDED: 'change.recorded',
  RESPONSE_DELTA: 'response.delta',
  RESPONSE_DONE: 'response.done',
  MODEL_CALL_COMPLETED: 'model.call_completed',
  // Session 3 — agent execution, approvals, changesets, verification,
  // episodes, plans, recovery (extends the canonical vocabulary).
  PLAN_CREATED: 'plan.created',
  PLAN_UPDATED: 'plan.updated',
  TOOL_APPROVAL_REQUIRED: 'tool.approval_required',
  TOOL_APPROVED: 'tool.approved',
  TOOL_DENIED: 'tool.denied',
  TOOL_TIMED_OUT: 'tool.timed_out',
  CHANGESET_CREATED: 'changeset.created',
  CHANGESET_APPROVAL_REQUIRED: 'changeset.approval_required',
  CHANGESET_APPLIED: 'changeset.applied',
  CHANGESET_ROLLED_BACK: 'changeset.rolled_back',
  VERIFICATION_STARTED: 'verification.started',
  VERIFICATION_PASSED: 'verification.passed',
  VERIFICATION_FAILED: 'verification.failed',
  EXECUTION_RECOVERY_STARTED: 'execution.recovery_started',
  EXECUTION_RECOVERED: 'execution.recovered',
  EXECUTION_RECOVERY_BLOCKED: 'execution.recovery_blocked',
  EPISODE_STARTED: 'episode.started',
  EPISODE_COMPLETED: 'episode.completed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided'
});

const DecisionType = Object.freeze({
  MODEL_SELECTION: 'model_selection',
  MODEL_SWITCH: 'model_switch',
  MODEL_RETENTION: 'model_retention',
  CONTEXT_COMPRESSION: 'context_compression',
  CONTEXT_RETRIEVAL: 'context_retrieval',
  TOOL_SELECTION: 'tool_selection',
  TOOL_ENABLE: 'tool_enable',
  TOOL_DISABLE: 'tool_disable',
  RETRY: 'retry',
  FALLBACK: 'fallback',
  PAUSE: 'pause',
  RESUME: 'resume',
  TERMINATE: 'terminate',
  CHECKPOINT: 'checkpoint'
});

const DecisionStatus = Object.freeze({
  PENDING: 'pending',
  EXECUTED: 'executed',
  REJECTED: 'rejected',
  FAILED: 'failed'
});

const CheckpointType = Object.freeze({
  MODEL_EXECUTION: 'model_execution',
  TOOL_EXECUTION: 'tool_execution',
  MODEL_SWITCH: 'model_switch',
  CONTEXT_UPDATE: 'context_update',
  MEMORY_UPDATE: 'memory_update',
  STEP_COMPLETE: 'step_complete'
});

const CostCategory = Object.freeze({
  INPUT_TOKENS: 'input_tokens',
  OUTPUT_TOKENS: 'output_tokens',
  CACHED_INPUT_TOKENS: 'cached_input_tokens',
  UNCACHED_INPUT_TOKENS: 'uncached_input_tokens',
  TOOL_EXECUTION: 'tool_execution',
  RETRIEVAL: 'retrieval',
  SWITCHING: 'switching',
  RETRY: 'retry',
  EVALUATION: 'evaluation',
  ORCHESTRATION_OVERHEAD: 'orchestration_overhead'
});

module.exports = {
  TaskStatus,
  ModelStatus,
  EventType,
  DecisionType,
  DecisionStatus,
  CheckpointType,
  CostCategory
};
