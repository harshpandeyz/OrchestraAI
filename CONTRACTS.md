# CONTRACTS.md — Session 1 Interfaces for Sessions 2, 3, 4

This document defines the exact contracts that **Session 2 (Model Intelligence)**, **Session 3 (Context/Memory/Cache)**, and **Session 4 (Frontend)** must implement or consume.

---

## For Session 2 — Model Intelligence

### Must Implement: `ModelRegistry`

```javascript
class ModelRegistry {
  // Returns all registered models
  async getModels(): Promise<Model[]>
  
  // Returns single model by ID
  async getModel(modelId: string): Promise<Model | null>
  
  // Registers a new model
  async registerModel(model: Model): Promise<Model>
  
  // Updates model metadata (price, status, capabilities)
  async updateModel(modelId: string, updates: Partial<Model>): Promise<Model | null>
  
  // Removes a model
  async unregisterModel(modelId: string): Promise<boolean>
  
  // Filter by capability (e.g., 'coding', 'reasoning', 'tools')
  async getModelsByCapability(capability: string): Promise<Model[]>
  
  // Filter by provider
  async getModelsByProvider(provider: string): Promise<Model[]>
  
  // Health check for a specific model
  async healthCheck(modelId: string): Promise<{ modelId: string, status: ModelStatus, healthy: boolean }>
  
  // Event subscription for model changes
  on(event: 'model.registered' | 'model.updated' | 'model.unregistered' | 'price.changed' | 'health.changed', handler: Function): void
  off(event: string, handler: Function): void
}
```

#### Model Shape (returned by all methods)
```typescript
interface Model {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  provider: string;              // Provider name (e.g., 'openai', 'anthropic')
  status: 'healthy' | 'degraded' | 'unavailable';  // Current health
  contextWindow: number;         // Max context tokens
  quality: number;               // 0-1 quality score
  avgLatencyMs: number;          // Observed average latency
  reliability: number;           // 0-1 reliability score
  inputPer1k: number;            // $ per 1K input tokens
  outputPer1k: number;           // $ per 1K output tokens
  cachedPer1k: number;           // $ per 1K cached input tokens
  capabilities: string[];        // e.g., ['coding', 'reasoning', 'tools']
  registeredAt?: string;         // ISO timestamp
  updatedAt?: string;            // ISO timestamp
}
```

### Must Implement: `ModelRouter`

```javascript
class ModelRouter {
  // Main routing decision: given task + runtime state + candidates, select best model
  async route(task: TaskState, runtimeState: RuntimeState, candidates: Model[], policy: PolicyState): Promise<{
    selectedModel: string;
    decision: Decision;           // Structured decision with rationale
    evaluation: {                 // Full evaluation details
      candidates: ScoredCandidate[];
      currentScore: number;
    };
  }>
  
  // Score all candidates (used by orchestrator for routing.evaluated event)
  async evaluateCandidates(task: TaskState, runtimeState: RuntimeState, candidates: Model[]): Promise<{
    candidates: ScoredCandidate[];
    currentScore: number;
  }>
  
  // Score a single model against task + state
  async scoreModel(model: Model, task: TaskState, runtimeState: RuntimeState): Promise<ModelScore>
  
  on(event: 'routing.completed' | 'model.scored', handler: Function): void
}
```

#### ScoredCandidate (returned in evaluation)
```typescript
interface ScoredCandidate {
  modelId: string;
  name: string;
  provider: string;
  score: number;                 // 0-1 composite score
  quality: number;               // Quality component
  cost: number;                  // Cost efficiency component
  latency: number;               // Latency component
  reliability: number;           // Reliability component
  contextFit: number;            // Context window fit component
  switchCost: number;            // Switching cost penalty
  avgLatencyMs: number;
  outputPer1k: number;
  estimatedCost: number;         // Estimated $ for next call
}
```

#### ModelScore (returned by scoreModel)
```typescript
interface ModelScore {
  total: number;                 // Composite score
  quality: number;
  cost: number;
  latency: number;
  reliability: number;
  contextFit: number;
  switchCost: number;
}
```

### Must Implement: `CostEstimatorInterface`

```javascript
class CostEstimatorInterface {
  async estimateModelCost(modelId: string, provider: string, inputTokens: number, outputTokens: number, cachedTokens: number): Promise<CostBreakdown>
  async estimateToolCost(toolName: string, estimatedCalls: number, complexity: 'low' | 'medium' | 'high'): Promise<CostBreakdown>
  async estimateRetrievalCost(queryCount: number, resultCount: number): Promise<CostBreakdown>
  async estimateSwitchingCost(fromModel: string, toModel: string, contextTokens: number, cachedTokens: number): Promise<CostBreakdown>
  async estimateTotalCost(estimates: CostBreakdown[]): Promise<CostBreakdown>
  recordActualCost(runId: string, category: CostCategory, estimated: number, actual: number, metadata: object): CostRecord
  getCostAccuracy(category?: CostCategory): AccuracyReport
}
```

#### CostBreakdown
```typescript
interface CostBreakdown {
  [CostCategory.INPUT_TOKENS]?: number;
  [CostCategory.OUTPUT_TOKENS]?: number;
  [CostCategory.CACHED_INPUT_TOKENS]?: number;
  [CostCategory.UNCACHED_INPUT_TOKENS]?: number;
  [CostCategory.TOOL_EXECUTION]?: number;
  [CostCategory.RETRIEVAL]?: number;
  [CostCategory.SWITCHING]?: number;
  [CostCategory.RETRY]?: number;
  [CostCategory.EVALUATION]?: number;
  [CostCategory.ORCHESTRATION_OVERHEAD]?: number;
  total: number;
  breakdown: object;
}
```

### Events Session 2 Can Emit
- `model.registered` — new model added
- `model.updated` — model metadata changed
- `model.unregistered` — model removed
- `price.changed` — pricing updated (registry-internal; bridged per-run as `price.updated`)
- `health.changed` — health status changed
- `routing.completed` — routing decision made
- `model.scored` — individual model scored

### Session 5 canonicalization note
- On the wire (REST/SSE) the canonical price event is **`price.updated`** (`{ modelId, pricing, prev, source }`).
- `price.changed` remains the **in-process** `ModelRegistry` subscription name only.
- Legacy frontend aliases still accepted (never emitted): `tool.finished` (= `tool.completed`), `memory.write` (= `memory.written`).

### Events Session 2 Must Consume
- None required (but can listen to `task.created`, `context.built` for context-aware routing)

---

## For Session 3 — Context / Memory / Cache / Tools

### Must Implement: `ContextManager`

```javascript
class ContextManager {
  // Build initial context for a task
  async buildContext(task: TaskState, runtimeState: RuntimeState, policy: PolicyState): Promise<ContextState>
  
  // Add context items (files, search results, tool outputs)
  async addContext(runtimeState: RuntimeState, items: ContextItem[]): Promise<ContextItem[]>
  
  // Remove context items by ID
  async removeContext(runtimeState: RuntimeState, itemIds: string[]): Promise<ContextItem[]>
  
  // Compress context to fit within token budget
  async compressContext(runtimeState: RuntimeState, targetTokens: number, policy: PolicyState): Promise<{ reclaimed: number, items: CompressedItem[] }>
  
  // Retrieve relevant context for a query
  async getRelevantContext(runtimeState: RuntimeState, query: string, maxTokens: number): Promise<ContextItem[]>
  
  // Estimate token count for content
  async estimateTokens(content: string): Promise<number>
  
  // Get current context snapshot
  getContextState(runtimeState: RuntimeState): ContextSnapshot
  
  on(event: 'context.added' | 'context.removed' | 'context.compressed' | 'context.limit_warning', handler: Function): void
}
```

#### ContextItem
```typescript
interface ContextItem {
  id: string;
  kind: 'file' | 'chat' | 'test' | 'logs' | 'search' | 'memory' | 'tool_result';
  title: string;
  source: string;
  tokens: number;
  relevance: number;      // 0-1
  status: 'KEEP' | 'COMPRESSED' | 'ARCHIVED' | 'REMOVED';
  metadata?: object;
}
```

#### ContextSnapshot (for frontend)
```typescript
interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  segments: { key: string, label: string, tokensPct: number }[];
  items: ContextItem[];
}
```

### Must Implement: `MemoryManager`

```javascript
class MemoryManager {
  async readWorkingMemory(runtimeState: RuntimeState, query: string, limit: number): Promise<MemoryItem[]>
  async readLongTermMemory(runtimeState: RuntimeState, query: string, limit: number): Promise<MemoryItem[]>
  async writeWorkingMemory(runtimeState: RuntimeState, item: MemoryItemInput): Promise<MemoryItem>
  async writeLongTermMemory(runtimeState: RuntimeState, item: MemoryItemInput): Promise<MemoryItem>
  async evictMemory(runtimeState: RuntimeState, itemId: string, scope: 'working' | 'longterm'): Promise<boolean>
  async searchMemory(runtimeState: RuntimeState, query: string, scopes: ('working' | 'longterm')[], limit: number): Promise<MemoryItem[]>
  getMemoryState(runtimeState: RuntimeState): { working: MemoryItem[], longterm: MemoryItem[] }
  on(event: 'memory.read' | 'memory.written' | 'memory.evicted', handler: Function): void
}
```

#### MemoryItem
```typescript
interface MemoryItem {
  id: string;
  scope: 'working' | 'longterm';
  title: string;
  snippet: string;           // Safe for display (no secrets)
  source: string;
  createdAt: string;         // ISO timestamp
  lastUsedAt: string;        // ISO timestamp
  importance: number;        // 0-1
  confidence: number;        // 0-1
  status: 'active' | 'archived' | 'evicted';
  metadata?: object;
}

interface MemoryItemInput {
  id?: string;
  title: string;
  snippet: string;
  source: string;
  importance?: number;
  confidence?: number;
  metadata?: object;
}
```

### Must Implement: `CacheManager`

```javascript
class CacheManager {
  async get(key: string): Promise<{ hit: boolean, value: any, metadata?: object }>
  async set(key: string, value: any, ttlMs?: number): Promise<{ success: boolean, key: string }>
  async invalidate(key: string): Promise<{ success: boolean, key: string }>
  async invalidatePrefix(prefix: string): Promise<{ success: boolean, count: number, prefix: string }>
  async getStats(): Promise<CacheStats>
  async warmCache(runtimeState: RuntimeState, items: { key: string, value: any, ttl?: number }[]): Promise<{ warmed: number }>
  getCacheState(runtimeState: RuntimeState): CacheSnapshot
  on(event: 'cache.hit' | 'cache.miss' | 'cache.invalidated', handler: Function): void
}
```

#### CacheStats
```typescript
interface CacheStats {
  hitRate: number;
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  size: number;
  maxSize: number;
  cachedTokens: number;
  state: 'WARM' | 'COOLING' | 'COLD';
}
```

#### CacheSnapshot (for frontend)
```typescript
interface CacheSnapshot {
  hitRate: number;
  cachedTokens: number;
  uncachedTokens: number;
  savedUsd: number;
  state: 'WARM' | 'COOLING' | 'COLD';
  recent: { type: string, ts: string, detail: string }[];
}
```

### Must Implement: `ToolRegistry`

```javascript
class ToolRegistry {
  async getTools(): Promise<Tool[]>
  async getTool(name: string): Promise<Tool | null>
  async registerTool(tool: Tool): Promise<Tool>
  async unregisterTool(name: string): Promise<boolean>
  async updateTool(name: string, updates: Partial<Tool>): Promise<Tool | null>
  async getToolsByCapability(capability: string): Promise<Tool[]>
  async healthCheck(name: string): Promise<{ name: string, status: string, healthy: boolean, successRate: number, avgLatencyMs: number }>
  on(event: 'tool.registered' | 'tool.updated' | 'tool.unregistered' | 'tool.health_changed', handler: Function): void
}
```

#### Tool
```typescript
interface Tool {
  id: string;
  name: string;
  description: string;
  parameters: { type: 'object', properties: object, required: string[] };
  status: 'enabled' | 'disabled';
  capabilities: string[];
  costPerCall: number;
  avgLatencyMs: number;
  successRate: number;
  registeredAt: string;
  metadata?: object;
}
```

### Must Implement: `ToolExecutor`

```javascript
class ToolExecutor {
  // Execute single tool
  async execute(toolName: string, params: object, runtimeState: RuntimeState, options?: { timeoutMs?: number }): Promise<ToolResult>
  
  // Execute multiple tools in parallel with concurrency limit
  async executeParallel(toolCalls: { toolName: string, params: object }[], runtimeState: RuntimeState, options?: { maxParallel?: number }): Promise<ToolResult[]>
  
  // Validate parameters against tool schema
  async validateParams(toolName: string, params: object): Promise<{ valid: boolean, error?: string }>
  
  // Get tool execution state for frontend
  getToolState(runtimeState: RuntimeState): ToolStateSnapshot
  
  on(event: 'tool.started' | 'tool.completed' | 'tool.failed', handler: Function): void
}
```

#### ToolResult
```typescript
interface ToolResult {
  toolName: string;
  success: boolean;
  result?: any;
  error?: string;
  latencyMs: number;
  cost: number;
  timestamp: string;
}
```

#### ToolStateSnapshot (for frontend)
```typescript
interface ToolStateSnapshot {
  name: string;
  description: string;
  status: string;
  calls: number;
  avgLatencyMs: number;
  successRate: number;
  lastStatus?: 'idle' | 'running' | 'success' | 'failed';
}
```

### Events Session 3 Can Emit
- `context.added`, `context.removed`, `context.compressed`, `context.limit_warning`
- `memory.read`, `memory.written`, `memory.evicted`
- `cache.hit`, `cache.miss`, `cache.invalidated`
- `tool.started`, `tool.completed`, `tool.failed`
- `tool.registered`, `tool.updated`, `tool.unregistered`, `tool.health_changed`

### Events Session 3 Must Consume
- `task.created` — initialize context/memory for new task
- `model.selected` — cache warming opportunity
- `model.switched` — cache invalidation (context rebuild)
- `execution.step_completed` — potential memory writes
- `tool.completed` — cache tool results

---

## For Session 4 — Frontend

### REST API (Provided by Session 1 Server)

| Endpoint | Method | Response |
|----------|--------|----------|
| `/api/health` | GET | `{ ok, service, version }` |
| `/api/models` | GET | `{ models: Model[] }` |
| `/api/tools` | GET | `{ tools: Tool[] }` |
| `/api/memory` | GET | `{ items: MemoryItem[] }` (query: `scope`, `q`) |
| `/api/evaluations` | GET | `{ evaluations: [] }` |
| `/api/runs` | GET | `{ runs: RunSummary[] }` |
| `/api/runs` | POST | `{ run: Run }` — body: `{ title?, taskMode?, budget?, maxLatencyMs?, maxContextTokens?, policy?, tools?, memory? }` |
| `/api/runs/:id` | GET | `{ run: RunSummary }` |
| `/api/runs/:id/state` | GET | `{ state: RuntimeStateSnapshot, lastSeq: number }` |
| `/api/runs/:id/events` | GET (SSE) | Event stream (see below) |
| `/api/runs/:id/messages` | POST | `{ accepted: true }` — body: `{ content }` |
| `/api/runs/:id/cancel` | POST | `{ run: RunSummary }` |
| `/api/runs/:id/retry` | POST | `{ accepted: true }` |
| `/api/runs/:id/telemetry` | GET | `{ telemetry: { events: [], metrics: [] } }` |

#### RunSummary
```typescript
interface RunSummary {
  id: string;
  title: string;
  taskMode: 'code' | 'debug' | 'research' | 'general';
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  activeModelId: string | null;
  budget: number;
  spent: number;
}
```

#### RuntimeStateSnapshot (complete state for frontend)
```typescript
interface RuntimeStateSnapshot {
  runId: string;
  lastSeq: number;
  updatedAt: string;
  status: TaskStatus;
  activeModelId: string | null;
  context: ContextSnapshot;
  cache: CacheSnapshot;
  memory: { working: MemoryItem[], longterm: MemoryItem[] };
  tools: ToolStateSnapshot[];
  cost: { spentUsd: number, budgetUsd: number, projectedUsd: number, breakdown: CostBreakdownItem[] };
  latency: { currentStepMs: number, avgStepMs: number, modelMs: number, toolMs: number, totalMs: number, samples: number[] };
  routing: { currentId: string, candidates: ScoredCandidate[], decision: Decision | null };
  trace: { seq: number, ts: string, type: string, label: string, status: string, durationMs?: number, costUsd?: number }[];
  decisions: Decision[];
  changes: { seq: number, ts: string, kind: 'added' | 'removed' | 'updated' | 'retained', label: string }[];
  messages: { id: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, ts: string, meta?: object }[];
}
```

### SSE Event Stream

**Endpoint**: `GET /api/runs/:id/events?since=<seq>`

**Headers**: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`

**Format**:
```
event: <EventType>
data: {"seq":123,"runId":"run-abc","type":"model.switched","ts":"2026-01-15T10:30:00.000Z","payload":{...}}

: ping
```

**Keepalive**: `: ping\n\n` every 15 seconds

**Resync**: Client calls `GET /api/runs/:id/state` → gets `lastSeq` → reconnects with `?since=<lastSeq>`

**Freshness**: Frontend marks:
- `LIVE` — stream open, last event < 30s ago
- `STALE` — gap > 30s or resync needed
- `DISCONNECTED` — EventSource error

### Event Types Frontend Consumes

| Event | Payload | UI Usage |
|-------|---------|----------|
| `task.created` | `{ title, userText }` | Show task start |
| `planning` | `{ note }` | Planning indicator |
| `context.built` | `{ usedTokens, windowTokens }` | Context bar |
| `context.compressed` | `{ reclaimedTokens, items }` | Context change animation |
| `model.selected` | `{ modelId, reason, factors }` | Model badge + "Why?" |
| `model.switched` | `{ fromModel, toModel, reason, factors }` | Model switch animation |
| `model.retained` | `{ modelId, reason, factors }` | "Kept current model" toast |
| `routing.evaluated` | `{ note, candidates }` | Routing panel |
| `tool.selected` | `{ tool, detail }` | Tool spinner |
| `tool.started` | `{ tool, detail }` | Tool running |
| `tool.completed` | `{ tool, status, durationMs, cost, result }` | Tool result |
| `tool.failed` | `{ tool, status, durationMs, error }` | Tool error |
| `response.delta` | `{ delta }` | Streaming response |
| `response.done` | `{ full }` | Complete response |
| `cache.hit` | `{ detail, savedUsd }` | Cache indicator |
| `cache.miss` | `{ detail }` | Cache indicator |
| `cache.invalidated` | `{ key, pattern }` | Cache status |
| `memory.read` | `{ scope, query, count }` | Memory panel |
| `memory.written` | `{ scope, itemId, title }` | Memory panel |
| `memory.evicted` | `{ scope, itemId, title }` | Memory panel |
| `cost.updated` | `{ spentUsd, projectedUsd }` | Cost bar |
| `budget.warning` | `{ spent, budget, ratio }` | Warning banner |
| `budget.exceeded` | `{ spent, budget }` | Error state |
| `run.completed` | `{ summary }` | Completion screen |
| `run.failed` | `{ error }` | Error screen |
| `run.cancelled` | `{ reason }` | Cancelled state |
| `price.updated` | `{ modelId, pricing }` | Model pricing update |
| `change.recorded` | `{ kind, label }` | Change log |

### Frontend Data Dependencies

| Frontend Component | Depends On | Must Not Modify Directly |
|--------------------|------------|--------------------------|
| Model Selector | `/api/models`, `model.*` events | ModelRegistry |
| Routing Panel | `routing.evaluated`, `routing.decision` | ModelRouter internals |
| Context View | `context.*` events, `state.context` | ContextManager internals |
| Cache View | `cache.*` events, `state.cache` | CacheManager internals |
| Memory View | `/api/memory`, `memory.*` events, `state.memory` | MemoryManager internals |
| Tool Panel | `/api/tools`, `tool.*` events, `state.tools` | ToolRegistry/Executor internals |
| Cost Bar | `cost.updated`, `state.cost` | CostEstimator internals |
| Latency Chart | `state.latency` | — |
| Decision Log | `state.decisions`, `routing.decision` | DecisionEngine internals |
| Trace/Timeline | `state.trace` | — |

---

## Data Ownership Rules

| Data | Owner | Readers | Writers |
|------|-------|---------|---------|
| Model catalog | Session 2 (ModelRegistry) | Session 1, 4 | Session 2 only |
| Model scores | Session 2 (ModelRouter) | Session 1, 4 | Session 2 only |
| Context items | Session 3 (ContextManager) | Session 1, 4 | Session 3 only |
| Memory items | Session 3 (MemoryManager) | Session 1, 4 | Session 3 only |
| Cache entries | Session 3 (CacheManager) | Session 1, 4 | Session 3 only |
| Tool catalog | Session 3 (ToolRegistry) | Session 1, 4 | Session 3 only |
| Tool executions | Session 3 (ToolExecutor) | Session 1, 4 | Session 3 only |
| Cost estimates | Session 2 (CostEstimator) | Session 1, 4 | Session 2 only |
| Actual costs | Session 1 (Orchestrator) | Session 4 | Session 1 only |
| RuntimeState | Session 1 (Orchestrator) | Session 4 | Session 1 only |
| Decisions | Session 1 (DecisionEngine) | Session 4 | Session 1 only |
| Checkpoints | Session 1 (CheckpointManager) | Session 1 | Session 1 only |
| Telemetry | Session 1 (TelemetryCollector) | Session 4 | Session 1 only |

---

## Integration Checklist for Session 2

- [ ] Implement `ModelRegistry` with persistent storage
- [ ] Implement `ModelRouter` with production scoring algorithm
- [ ] Implement `CostEstimatorInterface` with provider pricing APIs
- [ ] Emit `price.changed` when provider pricing updates
- [ ] Emit `health.changed` when model health changes
- [ ] Register models with all required fields (including `cachedPer1k`)
- [ ] Support capability-based filtering

## Integration Checklist for Session 3

- [ ] Implement `ContextManager` with vector search / RAG
- [ ] Implement `MemoryManager` with persistent storage + embeddings
- [ ] Implement `CacheManager` with Redis / distributed cache
- [ ] Implement `ToolRegistry` with dynamic tool discovery
- [ ] Implement `ToolExecutor` with sandboxed execution
- [ ] Handle `model.switched` → invalidate relevant cache prefixes
- [ ] Handle `task.created` → warm cache with relevant context
- [ ] Handle `execution.step_completed` → write important results to memory

## Integration Checklist for Session 4

- [ ] Consume `/api/runs/:id/state` for initial snapshot
- [ ] Consume `/api/runs/:id/events` SSE stream for live updates
- [ ] Implement resync logic using `lastSeq` and `?since=`
- [ ] Display `LIVE`/`STALE`/`DISCONNECTED` connection status
- [ ] Render all event types listed above
- [ ] Show structured decisions (factors, alternatives) not raw text
- [ ] Never call Session 2/3 internal APIs directly
- [ ] Use only REST + SSE contracts defined here