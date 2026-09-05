// Shared frontend types mirroring CONTRACTS.md (Sessions 1–3). Do not mutate independently.
export type RunStatus = 'idle' | 'planning' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type CalculationStatus = 'verified_modeled' | 'insufficient_data' | 'incomplete';
export type EconomicOutcome = 'saved' | 'unchanged' | 'cost_increase';
export type EconomicState = EconomicOutcome | 'insufficient_data' | 'incomplete';
export interface Run { id: string; title: string; taskMode: string; status: RunStatus | string; createdAt: string; updatedAt: string; activeModelId: string | null; budget: number; spent: number; orgId?: string | null; projectId?: string | null; privacyMode?: 'metadata_only' | 'standard' | 'zero_retention' | string; }
export interface Factor { key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail?: string }
export interface Decision { kind: string; decision: string; timestamp: string; factors: Factor[]; alternatives?: { id: string; deltaCost?: number; deltaLatency?: number; score?: number; note?: string }[] }
export type Provenance = 'provider' | 'observed' | 'demo' | 'unknown' | string;
export interface ModelInfo { id: string; name: string; provider: string; status: 'healthy' | 'degraded' | 'down' | 'unknown' | string; contextWindow: number | null; quality: number | null; avgLatencyMs: number | null; reliability: number | null; inputPer1k: number | null; outputPer1k: number | null; cachedPer1k: number | null; capabilities: string[]; qualitySource?: Provenance; latencySource?: Provenance; reliabilitySource?: Provenance; pricingSource?: Provenance; contextSource?: Provenance; healthSource?: Provenance; source?: string; observed?: { samples: number; lastObservedAt: string | null; lastErrorCode: string | null } | null }
export interface ProviderInfo { id: string; label: string; supported: boolean; configured: boolean; source: 'stored' | 'env' | null; keyMasked: string | null; updatedAt: string | null; lastVerifiedAt: string | null; connected: boolean; healthy: boolean | null; lastCheckedAt: string | null; lastError: string | null; lastLatencyMs: number | null; modelCount: number | null }
export interface HealthResponse { ok: boolean; service?: string; version?: string; mode?: string; provider?: string; providerConfigured?: boolean; providers?: ProviderInfo[]; discovery?: { enabled?: boolean; at?: string | null; error?: string | null }; runs?: number }
export interface RuntimeConfigResponse { mode: string; provider: string; maxSteps: number; runTimeoutMs: number; defaultBudgetUsd: number; platformFeePct: number; discoveryEnabled: boolean; runtime?: RuntimeSettings }
export interface ModelChange { ts: string; kind: string; label: string; ids?: string[] }
export interface CompareRunSummary { id: string; title: string | null; status: string; durationMs: number | null; costUsd: number | null; costSource: string; tokens: { used: number; window: number } | null; modelPath: string[]; switches: number; tools: Record<string, { calls: number; failures: number }>; toolCalls: number; decisions: number | null; cacheHitRate: number | null; createdAt: string | null; updatedAt: string | null }
export interface CompareResponse { a: CompareRunSummary; b: CompareRunSummary; delta: { durationMs: number | null; costUsd: number | null; toolCalls: number; switches: number } }
export interface EvaluationRecord { id: string; runId: string; model?: string | null; modelId?: string | null; provider?: string | null; name?: string; category?: string; score?: number; pass?: boolean; passed?: boolean; cost?: number; latencyMs?: number; steps?: number; toolCalls?: number; toolFailures?: number; ts?: string; timestamp?: string; [key: string]: unknown }
export interface SessionRecord { sessionId: string; title?: string | null; status: string; projectId?: string | null; createdAt: string; updatedAt: string }
export interface CacheOverview { hits: number; misses: number; hitRate: number; cachedTokens: number; providerCostOnLocalHit: number }
export interface AlertRecord { id: string; severity: string; source: string; title: string; at?: string | null }
export interface UserInfo { id: string; email: string; name: string; orgId: string; role: string; createdAt?: string }
export interface ProjectInfo { id: string; orgId: string; ownerId?: string; name: string; referenceModelId: string | null; policy: 'quality_first' | 'balanced' | 'maximum_savings' | 'lowest_latency' | 'custom' | string; privacyMode: 'metadata_only' | 'standard' | 'zero_retention' | string; createdAt?: string; updatedAt?: string }
export interface ProjectCreateOptions { referenceModelId?: string | null; policy?: ProjectInfo['policy']; privacyMode?: ProjectInfo['privacyMode'] }
export interface PrincipalInfo { id: string; role: string; orgId?: string; source?: string }
export interface ApprovalRecord { id: string; actionType?: string; title?: string; description?: string; detail?: string; riskLevel?: string; risk?: string; reason?: string; tool?: string; affectedResources?: string[]; expiresAt?: string; status?: string }
export interface ChangeSetView { id: string; files: Array<{ path: string } | string>; additions?: number; deletions?: number; status?: string }
export interface VerificationRecord { kind: string; passed: boolean; summary: string; at?: string }
export interface EpisodeView { episodeId: string; parentEpisodeId?: string | null; status: string; steps?: number; toolCalls?: number }
export interface RuntimePreset { id: string; label: string; blurb: string; consequence: string }
export interface RuntimeSettings { defaultPreset: string; defaultBudgetUsd: number; maxSteps: number; allowSwitching: boolean; allowCompaction: boolean; toolPolicy: 'auto' | 'readonly'; qualityFloor?: number | null; latencyTargetMs?: number | null; hardBudget?: boolean }
export interface NewRunOptions { title?: string; taskMode?: string; preset?: string; budget?: number; preferredModel?: string | null; allowSwitching?: boolean; allowCompaction?: boolean; toolPolicy?: 'auto' | 'readonly'; maxSteps?: number }
export interface MemoryItem { id: string; scope: 'working' | 'longterm'; title: string; snippet: string; source: string; createdAt: string; lastUsedAt: string; importance: number; confidence: number; status: string }
export interface ContextItem { id: string; kind: string; title: string; source: string; tokens: number; relevance: number; status: 'KEEP' | 'COMPRESSED' | 'ARCHIVED' | 'REMOVED' | string }
export interface TraceEvent { seq: number; ts: string; type: string; label: string; status: string; durationMs?: number; costUsd?: number }
export interface ChangeRecord { seq: number; ts: string; kind: 'added' | 'removed' | 'updated' | 'retained' | string; label: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; ts: string; meta?: { streaming?: boolean; [key: string]: unknown } }
export interface SeriesSample { t: string; step: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; latencyMs: number; cacheHitRate: number; contextUtil: number; model: string | null }
export interface RoutingCandidate {
  modelId: string; score: number; costUsd: number | null; latencyMs: number | null; factors: Record<string, number>;
  predictedSuccess?: number | null; taskFitScore?: number | null; toolCapabilityScore?: number | null;
  expectedCostUsd?: number | null; expectedLatencyMs?: number | null; taskCategory?: string | null;
  expectedCostBreakdown?: { provider: number | null; retry: number | null; switching: number | null };
  predictionConfidence?: string; predictionSamples?: number;
  reasons?: { factor: string; direction?: string; contribution?: number; humanExplanation?: string; detail?: string }[];
  excluded?: string; exclusionReason?: string | null;
}
export interface PricingSnapshot {
  provider: string | null; model: string | null; inputPer1k: number | null; outputPer1k: number | null; cachedPer1k: number | null;
  pricingTimestamp?: string | null; pricingSource?: string; pricingVersion?: number | string | null; version?: number | string | null;
}
export interface TokenUsage { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null; }
export interface TokenComposition { system: number; task: number; history: number; memory: number; tools: number; evidence: number; other: number; estimatedTotal: number; estimateBasis?: string; }
export interface CanonicalModelCall {
  recordVersion: string; callId: string; runId: string; step: number; provider: string | null; model: string | null;
  requestId?: string | null; providerRequestId?: string | null; providerMetadata?: Record<string, unknown>;
  providerCall: boolean; cacheType?: 'local_response' | 'semantic' | 'provider_native' | 'none' | string;
  usage: TokenUsage; composition?: TokenComposition; pricingSnapshot?: PricingSnapshot | null;
  providerCostUsd?: number | null; calculatedCostUsd?: number | null; canonicalCostUsd: number | null; costSource: string; usageSource?: string;
  latencyMs?: number | null; observedAt: string;
}
export interface EconomicStep {
  step: number; provider: string | null; model: string | null; actualModel?: string | null; referenceModel?: string | null;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null;
  providerCostUsd?: number | null; calculatedCostUsd?: number | null; canonicalCostUsd?: number | null; actualCost: number | null;
  baselineCost: number | null; pricingSnapshot?: PricingSnapshot | null; costSource?: string; executionStatus?: string;
}
export interface ExecutionView {
  runId?: string; status?: string; pause?: string; currentAction?: { type: string; label: string; status: string } | null;
  plan?: { runId: string; version: number; updatedAt: string; steps: { id: string; description: string; status: string; dependencies: string[] }[] } | null;
  readySteps?: { id: string; description: string; status: string }[];
  pendingApprovals?: ApprovalRecord[];
  waitingForApproval?: boolean;
  changesets?: { id: string; files: { path: string }[] | string[]; additions?: number; deletions?: number; status?: string }[];
  changes?: unknown[]; files?: string[]; tests?: { kind: string; passed: boolean; summary: string; at?: string }[];
  lastChangeset?: unknown; verifications?: { kind: string; passed: boolean; summary: string; at?: string }[];
  episodes?: { episodeId: string; parentEpisodeId?: string | null; status: string; steps?: number; toolCalls?: number }[];
  currentEpisode?: { episodeId: string; status: string } | null;
  constraints?: { forbidPaths?: string[]; onlyPaths?: string[]; branch?: string | null; notes?: string[] };
  toolHealth?: Record<string, { calls: number; successRate: number; timeoutRate?: number }> | unknown;
  observations?: unknown[]; recovery?: unknown[]; result?: unknown;
}
export interface IntelligenceView {
  versions?: Record<string, string> | null;
  taskProfile?: { category: string; confidence?: number; signals?: string[] } | null;
  outcome?: { taskSuccess: boolean | null; overallScore: number | null; confidence: number; reasons?: { factor: string; detail: string }[]; evaluatorVersion?: string } | null;
}
export interface RuntimeSnapshot {
  runId: string; lastSeq: number; updatedAt: string; status: RunStatus | string; internalStatus?: string; activeModelId: string | null;
  context: { usedTokens: number; windowTokens: number; segments: { key: string; label: string; tokensPct: number }[]; items: ContextItem[] };
  cache: { hitRate: number; hits?: number | null; misses?: number | null; cachedTokens: number; uncachedTokens: number; savedUsd: number; state: string; recent: { type: string; ts: string; detail: string }[] };
  memory: { working: MemoryItem[]; longterm: MemoryItem[] };
  tools: { name: string; description: string; status: string; calls: number; avgLatencyMs: number; successRate: number; lastStatus?: string }[];
  cost: { spentUsd: number; budgetUsd: number; projectedUsd: number; source?: string; breakdown: { key: string; label: string; usd: number }[] };
  latency: { currentStepMs: number; avgStepMs: number; modelMs: number; toolMs: number; totalMs: number; samples: number[] };
  routing: { currentId: string; candidates: RoutingCandidate[]; decision: Decision | null; explanation?: string | null; tradeoff?: string | null; counterfactuals?: unknown[]; taskProfile?: unknown; inputsHash?: string | null; policyVersion?: string | null };
  trace: TraceEvent[]; decisions: Decision[]; changes: ChangeRecord[]; messages: ChatMessage[]; approvals?: ApprovalRecord[]; toolPolicy?: 'auto' | 'readonly' | string;
  series?: SeriesSample[];
  execution?: ExecutionView | null;
  intelligence?: IntelligenceView | null;
  modelCalls?: CanonicalModelCall[];
  meta?: { mode: string; provider: string | null; model: string | null; preset?: string; toolPolicy?: 'auto' | 'readonly' | string; tokens: { input: number; output: number; cached: number }; budgetRemaining: number; privacyMode?: string };
  economics?: SavingsResult;
}
export interface SavingsResult {
  status: string; calculationStatus?: CalculationStatus; economicOutcome?: EconomicOutcome | null; economicsStatus?: string; invoiceStatus?: string; referenceModel?: { modelId: string; provider?: string; source?: string } | string | null;
  baselineCost: number | null; actualCost: number | null; savings: number | null; savingsRate: number | null; eligibleSavings?: number | null; platformFeePct?: number; platformFee?: number | null;
  customerFinalCost?: number | null; customerNetSavings?: number | null; usage?: TokenUsage; steps?: EconomicStep[]; pricingSnapshot?: PricingSnapshot[]; error?: string;
}
export interface TrendPoint { period: string; baseline: number; optimized: number; savings: number; runs: number; }
export interface AnalyticsSummary { period: string; runCount: number; baselineCost: number | null; optimizedProviderCost: number | null; eligibleSavings: number | null; platformFee: number | null; customerFinalCost: number | null; customerNetSavings: number | null; savingsRate: number | null; invoiceStatus: string; dataQuality?: AnalyticsAggregateQuality; }
export interface AnalyticsBreakdown { model?: string; provider?: string; cost: number; baseline: number; modeledSavings: number; runs: number; }
export interface RecentRunEconomics { runId: string; title: string; date: string; status: string; calculationStatus?: CalculationStatus; economicOutcome?: EconomicOutcome | null; baselineCost: number | null; optimizedProviderCost: number | null; platformFee: number | null; customerNetSavings: number | null; }
export interface AnalyticsDataQuality { totalRuns: number; verifiedCount: number; insufficientCount: number; incompleteCount: number; noSavingsCount: number; costIncreaseCount: number; coverageRate: number; label: string; }
export type AnalyticsAggregateQuality = Omit<AnalyticsDataQuality, 'totalRuns' | 'label'>;
export interface AnalyticsOverview { summary: AnalyticsSummary; spendTrend: TrendPoint[]; savingsTrend: { period: string; savings: number; rate: number }[]; modelBreakdown: AnalyticsBreakdown[]; providerBreakdown: AnalyticsBreakdown[]; tokenComposition: Record<string, number>; cacheImpact: { hits: number; misses: number; hitRate: number }; recentRuns: RecentRunEconomics[]; dataQuality: AnalyticsDataQuality; }
export interface BillingLineItem { period: string; currency: string; status: string; calculationStatus: CalculationStatus; economicOutcome: EconomicOutcome | null; economicsStatus: string; invoiceStatus: string; baselineCost: number | null; optimizedProviderCost: number | null; eligibleSavings: number | null; modeledSavings: number | null; platformFeePct: number; platformFee: number | null; customerFinalCost: number | null; customerNetSavings: number | null; source: string; reconciliation: string; }
export interface BillingAggregate extends Omit<AnalyticsSummary, 'invoiceStatus' | 'dataQuality'> { currency: string; dataQuality: AnalyticsAggregateQuality; positiveModeledSavings: number; negativeModeledImpact: number; invoiceStatus: string; source: string; }
export interface BillingResponse { billing: BillingAggregate; lineItems: BillingLineItem[]; note: string; }
export interface SavingsRunRow { runId: string; title: string; status: string; date: string; economics: SavingsResult; }
export interface WaterfallRow { key: string; label: string; amount: number | null; kind: string; }
// Provider/event payloads are versioned at the event boundary and intentionally
// open-ended; feature DTOs above remain strongly typed once data is consumed.
export type StreamPayload = Record<string, any>;
export interface StreamEnvelope { seq: number; runId: string; type: string; ts: string; payload: StreamPayload }
export type ConnStatus = 'connected' | 'reconnecting' | 'disconnected' | 'idle';
