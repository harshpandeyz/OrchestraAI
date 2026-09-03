// Shared frontend types mirroring CONTRACTS.md (Sessions 1–3). Do not mutate independently.
export type RunStatus = 'idle' | 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export interface Run { id: string; title: string; taskMode: string; status: RunStatus | string; createdAt: string; updatedAt: string; activeModelId: string | null; budget: number; spent: number; }
export interface Factor { key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail?: string }
export interface Decision { kind: string; decision: string; timestamp: string; factors: Factor[]; alternatives?: { id: string; deltaCost?: number; deltaLatency?: number; score?: number; note?: string }[] }
export interface ModelInfo { id: string; name: string; provider: string; status: 'healthy' | 'degraded' | 'down' | string; contextWindow: number; quality: number; avgLatencyMs: number; reliability: number; inputPer1k: number; outputPer1k: number; cachedPer1k: number; capabilities: string[] }
export interface MemoryItem { id: string; scope: 'working' | 'longterm'; title: string; snippet: string; source: string; createdAt: string; lastUsedAt: string; importance: number; confidence: number; status: string }
export interface ContextItem { id: string; kind: string; title: string; source: string; tokens: number; relevance: number; status: 'KEEP' | 'COMPRESSED' | 'ARCHIVED' | 'REMOVED' | string }
export interface TraceEvent { seq: number; ts: string; type: string; label: string; status: string; durationMs?: number; costUsd?: number }
export interface ChangeRecord { seq: number; ts: string; kind: 'added' | 'removed' | 'updated' | 'retained' | string; label: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; ts: string; meta?: any }
export interface SeriesSample { t: string; step: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; latencyMs: number; cacheHitRate: number; contextUtil: number; model: string | null }
export interface RuntimeSnapshot {
  runId: string; lastSeq: number; updatedAt: string; status: RunStatus | string; internalStatus?: string; activeModelId: string | null;
  context: { usedTokens: number; windowTokens: number; segments: { key: string; label: string; tokensPct: number }[]; items: ContextItem[] };
  cache: { hitRate: number; cachedTokens: number; uncachedTokens: number; savedUsd: number; state: string; recent: { type: string; ts: string; detail: string }[] };
  memory: { working: MemoryItem[]; longterm: MemoryItem[] };
  tools: { name: string; description: string; status: string; calls: number; avgLatencyMs: number; successRate: number; lastStatus?: string }[];
  cost: { spentUsd: number; budgetUsd: number; projectedUsd: number; breakdown: { key: string; label: string; usd: number }[] };
  latency: { currentStepMs: number; avgStepMs: number; modelMs: number; toolMs: number; totalMs: number; samples: number[] };
  routing: { currentId: string; candidates: { modelId: string; score: number; costUsd: number; latencyMs: number; factors: Record<string, number> }[]; decision: Decision | null };
  trace: TraceEvent[]; decisions: Decision[]; changes: ChangeRecord[]; messages: ChatMessage[];
  series?: SeriesSample[];
  meta?: { mode: string; provider: string | null; model: string | null; tokens: { input: number; output: number; cached: number }; budgetRemaining: number };
}
export interface StreamEnvelope { seq: number; runId: string; type: string; ts: string; payload: any }
export type ConnStatus = 'connected' | 'reconnecting' | 'disconnected' | 'idle';
