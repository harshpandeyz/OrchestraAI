# ARCHITECTURE.md — OrchestraAI Adaptive Agent Runtime and Economic Control Plane

## Overview

This document describes the architecture of the **Adaptive Agent Runtime** — a production-grade orchestration layer that dynamically optimizes AI agent execution. The orchestrator acts as the control plane, making runtime decisions about model selection, context management, tool usage, budget enforcement, and failure recovery. The current V1 also includes the tenant-scoped API, canonical model-call economics, authenticated SSE console, provider adapters, persistence, and BYOK platform billing described in `README.md` and `CONTRACTS.md`.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        RUNTIME ORCHESTRATOR                      │
│  (Orchestrator + DecisionEngine + PolicyEngine + StateMachine)  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  MODEL LAYER  │  │ CONTEXT LAYER │  │  TOOL LAYER   │
│               │  │               │  │               │
│ ModelRegistry │  │ContextManager │  │ ToolRegistry  │
│ ModelRouter   │  │MemoryManager  │  │ ToolExecutor  │
│               │  │CacheManager   │  │               │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                 ┌───────────────────┐
                 │ EXECUTION ENGINE  │
                 │ (Orchestrator)    │
                 └────────┬──────────┘
                          ▼
                 ┌───────────────────┐
                 │  TELEMETRY BUS    │
                 │ (EventBus + SSE)  │
                 └────────┬──────────┘
                          ▼
                 ┌───────────────────┐
                 │   STATE UPDATE    │
                 │ (RuntimeState)    │
                 └────────┬──────────┘
                          │
                          ▼
                 ┌───────────────────┐
                 │  RE-EVALUATE      │
                 │ (DecisionEngine)  │
                 └───────────────────┘
```

## Module Responsibilities

### Core Modules (`src/core/`)
| Module | Responsibility |
|--------|----------------|
| `types.js` | Shared type definitions (enums, constants) |
| `orchestrator.js` | Main orchestration logic, task lifecycle, decision triggers |
| `state-machine.js` | Explicit state transitions for agent lifecycle |

### State Management (`src/state/`)
| Module | Responsibility |
|--------|----------------|
| `runtime-state.js` | `RuntimeState` aggregate + all sub-states (Task, Model, Context, Memory, Tools, Budget, Execution, Policy) |

### Events (`src/events/`, `src/services/sse-service.js`)
| Module | Responsibility |
|--------|----------------|
| `event-bus.js` | Sequenced SSE bus: replay via `?since=`, gap detection, bounded buffers, subscriber lifecycle |
| `event-contract.js` | Canonical wire-event vocabulary + envelope shape (enforced against the console by test) |
| `sse-service.js` | HTTP serving of run streams: framing, replay, gap frames, live subscription |

### Decisions (`src/decisions/`)
| Module | Responsibility |
|--------|----------------|
| `decision-engine.js` | Structured `Decision` objects with factors, alternatives, rationale |
| `switching-cost.js` | `SwitchingCostCalculator` + `ModelStickinessManager` (cooldown, hysteresis) |

### Policies (`src/policies/`)
| Module | Responsibility |
|--------|----------------|
| `policy-engine.js` | Budget, latency, context, model health, capability evaluation |

### Cost (`src/cost/`)
| Module | Responsibility |
|--------|----------------|
| `cost-estimator.js` | Multi-category cost estimation (input, output, cached, tools, switching, retry, evaluation, orchestration) |

### Checkpoint (`src/checkpoint/`)
| Module | Responsibility |
|--------|----------------|
| `checkpoint-manager.js` | Versioned `ExecutionCheckpoint` (schema version, integrity hash, control snapshot), `CheckpointManager`, `RecoveryManager` with validation + shared `planRecovery` semantics |
| `src/core/recovery-service.js` | Authoritative run-level recovery: validate → inspect last side effect → consult idempotency → restore cursor/state → resume. Used by manual retry and (via the same `planRecovery` rules) restart reconciliation |

### Telemetry (`src/telemetry/`)
| Module | Responsibility |
|--------|----------------|
| `telemetry-collector.js` | Structured telemetry events, metrics, run summaries |

### Interfaces (`src/interfaces/`)
| Module | Responsibility |
|--------|----------------|
| `index.js` | Abstract base classes for all pluggable runtime components |

### Implementations (`src/impl/`)
| Module | Responsibility |
|--------|----------------|
| `model-registry.js` | Model catalog with health, capability, and immutable pricing metadata |
| `model-router.js` | Scoring-based routing with switching cost awareness |
| `context-manager.js` | Context building, compression, relevance scoring |
| `memory-manager.js` | Working + long-term memory with eviction |
| `cache-manager.js` | Run-local and tenant/project-scoped cache with hit/miss tracking and invalidation |
| `tool-registry.js` | Tool catalog with health monitoring |
| `tool-executor.js` | Sequential + parallel tool execution with validation |

## Runtime Lifecycle

```
CREATED → PLANNING → CONTEXT_BUILD → MODEL_SELECT → EXECUTING
                                                         │
                              ┌──────────────────────────┘
                              ▼
                       WAITING_FOR_TOOL → EXECUTING
                              │
                              ▼
                       OBSERVING → REOPTIMIZING → (MODEL_SELECT | CONTEXT_BUILD | EXECUTING)
                              │
                              ▼
                        COMPLETED | FAILED | CANCELLED
                              │
                        (FAILED → RETRYING → EXECUTING)
```

### State Transitions (Enforced by StateMachine)

| From State | Allowed Transitions |
|------------|---------------------|
| CREATED | PLANNING, CANCELLED |
| PLANNING | CONTEXT_BUILD, FAILED, CANCELLED |
| CONTEXT_BUILD | MODEL_SELECT, FAILED, CANCELLED |
| MODEL_SELECT | EXECUTING, FAILED, CANCELLED |
| EXECUTING | WAITING_FOR_TOOL, OBSERVING, REOPTIMIZING, COMPLETED, FAILED, CANCELLED, PAUSED |
| WAITING_FOR_TOOL | EXECUTING, RETRYING, FAILED, CANCELLED |
| OBSERVING | EXECUTING, REOPTIMIZING, COMPLETED, FAILED, CANCELLED |
| REOPTIMIZING | EXECUTING, MODEL_SELECT, CONTEXT_BUILD, FAILED, CANCELLED |
| RETRYING | EXECUTING, PLANNING, FAILED, CANCELLED |
| PAUSED | EXECUTING, CANCELLED |
| COMPLETED | RETRYING (same-run continuation episodes only) |
| FAILED | RETRYING, CANCELLED |
| CANCELLED | (terminal) |

### Recovery (checkpoint-based resume, not re-run)

```
failure → load last COMPLETED checkpoint → validate (schema/version/run/freshness/integrity)
  → restore runtime + conversation state → set cursor to last completed step
  → inspect last tool side effect → consult idempotency records
  → plan: resume | retry_step | skip_completed | ask_user | mark_unknown | unrecoverable
  → resume from cursor (budget, tokens, event seq preserved) → new checkpoint → finalize
```

- `resume`: nothing in flight; continue after the cursor.
- `retry_step`: in-flight tool is idempotent/read-only; safe to re-run.
- `skip_completed`: idempotency proves the side effect finished; never re-execute.
- `ask_user` / `mark_unknown`: destructive or ambiguous outcome; the run stays
  FAILED with `execution.recovery_blocked` (auditable, operator-resolvable).
- `unrecoverable`: no valid checkpoint and unsafe to restart blindly.
- Concurrent retries are serialized (exactly one winner); step numbers and
  step-scoped idempotency keys never reset, so retries cannot duplicate
  irreversible tool calls or double-count economics.

## Data Flow

### 1. Run Creation
```
POST /api/runs → Orchestrator.createRun() → RuntimeState → EventBus.emit(TASK_CREATED)
```

### 2. Execution Start
```
POST /api/runs/:id/messages → Orchestrator.startRun() 
  → PLANNING → CONTEXT_BUILD (ContextManager.buildContext)
  → MODEL_SELECT (ModelRouter.route)
  → EXECUTING loop
```

### 3. Execution Step
```
EXECUTING → _executeStep()
  → Tool decision → WAITING_FOR_TOOL → ToolExecutor.execute() → ToolResult
  → OR Model call → OBSERVING → ModelResponse
  → Checkpoint (STEP_COMPLETE)
  → _checkOptimizationTriggers()
```

### 4. Optimization Triggers
```
Budget warning/critical → BUDGET_WARNING/BUDGET_EXCEEDED events → _handleBudgetExceeded()
Context limit → CONTEXT_LIMIT_WARNING → ContextManager.compressContext()
Model degraded/unavailable → MODEL_HEALTH_CHANGED → _handleModelFailover()
Latency exceeded → LATENCY_WARNING → Model switch or early termination
```

### 5. Completion/Failure
```
COMPLETED → RUN_COMPLETED event
FAILED → RUN_FAILED event (with error)
CANCELLED → RUN_CANCELLED event
```

## Event Model

All events follow the envelope:
```json
{
  "seq": 123,
  "runId": "run-abc123",
  "type": "model.switched",
  "ts": "2026-01-15T10:30:00.000Z",
  "payload": { "fromModel": "model-a", "toModel": "model-b", "reason": "budget optimization" }
}
```

### Event Categories

| Category | Events |
|----------|--------|
| **Task** | `task.created`, `task.started`, `task.updated`, `planning` |
| **Context** | `context.built`, `context.added`, `context.removed`, `context.compressed`, `context.limit_warning` |
| **Model** | `model.selected`, `model.switch_requested`, `model.switched`, `model.retained`, `model.switch_rejected`, `model.health_changed`, `model.price_changed`, `model.unavailable` |
| **Cache** | `cache.hit`, `cache.miss`, `cache.invalidated` |
| **Memory** | `memory.read`, `memory.written`, `memory.evicted` |
| **Tools** | `tool.selected`, `tool.started`, `tool.completed`, `tool.failed` |
| **Execution** | `execution.started`, `execution.step_started`, `execution.step_completed`, `execution.failed`, `execution.retry`, `execution.paused`, `execution.resumed`, `execution.completed` |
| **Routing** | `routing.evaluated` |
| **Budget** | `budget.warning`, `budget.exceeded`, `cost.updated` |
| **Optimization** | `optimization.triggered`, `optimization.completed` |
| **Run** | `run.completed`, `run.failed`, `run.cancelled`, `price.updated`, `change.recorded` |
| **Response** | `response.delta`, `response.done` |

## Decision Model

All decisions are structured, never free-text chain-of-thought:

```json
{
  "decisionId": "decision-abc123",
  "timestamp": "2026-01-15T10:30:00.000Z",
  "decisionType": "model_switch",
  "currentStateRef": "run-abc123",
  "decision": "SWITCH TO model-b",
  "candidatesConsidered": [
    { "id": "model-a", "deltaCost": 0, "deltaLatency": 0, "score": 0.85 },
    { "id": "model-b", "deltaCost": -0.004, "deltaLatency": -200, "score": 0.87 }
  ],
  "selectedCandidate": { "modelId": "model-b" },
  "score": 0.87,
  "constraints": { "budget": 0.1, "latencyMs": 300000 },
  "factors": [
    { "key": "quality_gain", "label": "Quality improvement", "status": "pass", "detail": "+0.02" },
    { "key": "switch_cost", "label": "Switching cost", "status": "warn", "detail": "$0.009" }
  ],
  "reason": "Net benefit 0.015 exceeds hysteresis threshold",
  "expectedCost": 0.009,
  "expectedLatency": 1200,
  "expectedQuality": 0.87,
  "switchingCost": 0.009,
  "confidence": 0.8,
  "status": "executed"
}
```

### Decision Types
- `model_selection`, `model_switch`, `model_retention`
- `context_compression`, `context_retrieval`
- `tool_selection`, `tool_enable`, `tool_disable`
- `retry`, `fallback`, `pause`, `resume`, `terminate`, `checkpoint`

## Interfaces (Extension Points for Sessions 2–4)

| Interface | Implemented By | Consumed By |
|-----------|----------------|-------------|
| `ModelRegistry` | Session 2 | Orchestrator, ModelRouter |
| `ModelRouter` | Session 2 | Orchestrator |
| `ContextManager` | Session 3 | Orchestrator |
| `MemoryManager` | Session 3 | Orchestrator |
| `CacheManager` | Session 3 | Orchestrator |
| `ToolRegistry` | Session 3 | Orchestrator, ToolExecutor |
| `ToolExecutor` | Session 3 | Orchestrator |
| `CostEstimatorInterface` | Session 2 | Orchestrator |
| `PolicyEngineInterface` | Session 1 (core) | Orchestrator |
| `TelemetryCollector` | Session 1 (core) | Frontend (Session 4) |
| `EvaluationEngine` | Session 5 | Orchestrator |

## Key Architectural Decisions

### 1. Orchestrator as Control Plane
The orchestrator contains **no provider-specific logic**. It only calls interfaces. All provider/model logic lives in `ModelRegistry`/`ModelRouter` (Session 2).

### 2. Switching Cost is First-Class
Model switches are never free. `SwitchingCostCalculator` accounts for:
- Context reconstruction
- Cache loss
- Token resend
- Provider overhead
- Latency penalty
- State translation
- Restart/retry cost
- Risk penalty

### 3. Model Stickiness with Hysteresis
- Cooldown period between switches (default 60s)
- Max switches per task (default 5)
- Hysteresis factor (default 1.5x switching cost)
- Prevents A→B→A oscillation

### 4. Optimization is State-Aware
Router receives full `RuntimeState` (task, context, memory, cache, tools, budget, policy, telemetry) — not just the prompt.

### 5. Checkpoint/Recovery with Idempotency
Every state mutation creates a checkpoint with an idempotency key. Recovery restores exact state without duplicate side effects.

### 6. Structured Telemetry
Every significant action emits a telemetry event with runId, stepId, model, tokens, cache info, tool, latency, cost, decision, reason, status, error.

### 7. Cheap Deterministic Checks First
Orchestrator evaluates budget/latency/context/model health synchronously before invoking expensive routing/optimization.

## Operational assumptions

1. **Single-process runtime** — runs are isolated in memory while active; the V1 deployment does not provide distributed execution or consensus.
2. **Atomic JSON persistence** — tenant records, terminal run summaries, economics, intelligence and audit data use the configured runtime data directory. Event replay is an in-memory per-run buffer.
3. **SSE for real-time events** — the frontend consumes authenticated snapshots plus replayable `EventSource` streams.
4. **Deterministic idempotency keys** — `{runId}:{operation}:{stepNumber}` is used for runtime mutations and paid-side-effect guards.
5. **Cost estimation is forecasting** — pre-call estimates are not actual spend; canonical post-call economics use provider usage/cost or an immutable captured pricing snapshot.

## Current V1 boundaries

1. **No distributed execution** — concurrent runs are supported within one process, but horizontal coordination is outside this V1.
2. **In-flight recovery is unsupported** — terminal summaries survive restart; interrupted active runs are marked failed and are not silently resumed.
3. **Execution tools are restricted in production** — safe read-only tools may run inside tenant-scoped workspaces; high-risk shell, patch, git, network and browser automation are denied unless a separately isolated executor is provided.
4. **Production authentication fails closed** — sessions/bearer tokens and tenant ownership checks protect private APIs; a production `DATA_ENCRYPTION_KEY` is required for stored provider credentials.
5. **Tool concurrency is bounded** — parallel work uses an explicit concurrency limit and does not imply durable distributed scheduling.

## Performance Characteristics

- **Orchestrator overhead**: ~1-5ms per decision cycle
- **EventBus**: O(1) emit, O(n) replay (n ≤ 500 buffer)
- **State mutations**: O(1) for most operations
- **Context compression**: O(n) where n = context items
- **Memory**: ~10-50KB per run state

## Testing

Run tests with:
```bash
node backend/test/runtime.test.js
```

Covers all 15 required scenarios:
1. Basic task lifecycle
2. Model selection interface
3. Model switching
4. Switching rejected (cost too high)
5. Budget exceeded
6. Model unavailable
7. Context limit reached
8. Cache invalidation
9. Tool failure
10. Retry
11. Checkpoint/idempotency semantics (durable resume is not promised)
12. Duplicate event/idempotency
13. Model oscillation prevention
14. Concurrent tool completion
15. State transition validity
