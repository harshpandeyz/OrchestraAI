// Orchestra Intelligence — frontend data contracts.
// Mirror backend/src/intelligence-analytics.js. Provenance is authoritative:
// LIVE | DEMO | OBSERVED | VERIFIED | INSUFFICIENT_DATA | ILLUSTRATIVE (landing demo only).

export type Provenance =
  | 'LIVE' | 'DEMO' | 'OBSERVED' | 'VERIFIED'
  | 'INSUFFICIENT_DATA' | 'ILLUSTRATIVE' | 'UNKNOWN' | string;

export type SectionState = 'READY' | 'INSUFFICIENT_DATA' | 'LOADING' | 'ERROR';

export interface IntelligenceMeta {
  generatedAt: string;
  mode: string;
  provenance: Provenance;
  runCount: number;
  verifiedCount: number;
  coverageRate: number;
  granularity: 'daily' | 'weekly' | 'monthly' | string;
  range: string;
  from: string | null;
  to: string | null;
  filters: { model: string | null; provider: string | null; taskCategory: string | null; projectId: string | null };
  valueScoreFormula: string;
  note: string;
}

export interface TopModelsSection {
  provenance: Provenance; state: SectionState; granularity: string;
  note: string; series: { period: string; total: number; totalCost: number; perModel: Record<string, number>; perModelCost: Record<string, number> }[];
  totals: { model: string; provider: string; calls: number; runs: number; cost: number; baseline: number; modeledSavings: number }[];
  models: string[];
}

export interface LeaderboardRow {
  model: string; provider: string; status: string; capabilities: string[];
  quality: number | null; qualityProvenance: Provenance;
  successRate: number | null; successProvenance: Provenance; successSamples: number;
  reliability: number | null; reliabilityProvenance: Provenance;
  avgLatencyMs: number | null; p50: number | null; p95: number | null;
  latencySamples: number; latencyProvenance: Provenance;
  totalCost: number | null; runs: number; calls: number;
  costPerTask: number | null; costPerSuccessfulTask: number | null; pricingProvenance: Provenance;
  contextEfficiency: number | null; cacheEfficiency: number | null;
  inputTokens: number; outputTokens: number; cachedTokens: number;
  valueScore: number | null;
  valueComponents?: { quality: number; success: number; reliability: number; costEfficiency: number; latencyEfficiency: number };
  explanation: string; provenance: Provenance;
}

export interface LeaderboardSection {
  provenance: Provenance; state: SectionState; formula: string; note: string; rows: LeaderboardRow[];
}

export interface TaskCategory {
  key: string; label: string; classifierCategories: string[];
  bestQuality: string | null; bestValue: string | null; lowestCost: string | null;
  fastest: string | null; mostReliable: string | null;
  state: SectionState; note?: string;
}

export interface TasksSection { provenance: Provenance; state: SectionState; note: string; categories: TaskCategory[] }

export interface CostSection {
  provenance: Provenance; state: SectionState; note: string;
  stats: null | {
    count: number; total: number; average: number; median: number; p95: number; min: number; max: number;
    inputTokens: number; outputTokens: number; cachedTokens: number; baselineCost: number;
  };
  series: { period: string; total: number; average: number; median: number; p95: number; runs: number }[];
  distribution: null | { buckets: { from: number; to: number }[]; min: number; max: number };
}

export interface MarketShareSection {
  provenance: Provenance; state: SectionState; note: string;
  providers: { provider: string; calls: number; cost: number; shareByCalls: number; shareByCost: number }[];
  models: { model: string; provider: string; calls: number; cost: number; shareByCalls: number; shareByCost: number }[];
  workloads: { workload: string; runs: number; share: number }[];
}

export interface BenchmarksSection {
  provenance: Provenance; state: SectionState; note: string;
  cases: { id: string; category: string; prompt: string; createdAt: string }[];
  summaries: { caseId: string; category: string; results: { modelId: string; attempts: number; passRate: number | null; avgCost: number | null; avgLatencyMs: number | null }[] }[];
}

export interface LatencySection {
  provenance: Provenance; state: SectionState; note: string;
  perModel: { model: string; provider: string; p50: number | null; p95: number | null; mean: number | null; samples: number; timeToFirstToken: null; timeToFirstTokenNote: string; provenance: Provenance }[];
}

export interface ContextSection {
  provenance: Provenance; state: SectionState; note: string;
  stats: null | { runs: number; avgUsedTokens: number; avgWindowTokens: number; avgUtilization: number | null; compressionRatio: number | null; compressedItems: number; totalItems: number; cacheReuseSavedUsd: number; note: string };
  perRun: { runId: string; title: string; usedTokens: number | null; windowTokens: number | null; utilization: number | null; items: number; cachedTokens: number; savedUsd: number }[];
}

export interface ToolsSection {
  provenance: Provenance; state: SectionState; note: string;
  summary: null | { totalCalls: number; runsWithTools: number; totalRuns: number; callsPerRun: number };
  perTool: { tool: string; description: string; calls: number; runs: number; callsPerRun: number; successRate: number | null; avgLatencyMs: number | null; retryRate: null; retryNote: string; provenance: Provenance }[];
  compatibilityNote?: string; compatibility?: unknown[];
}

export interface WorkloadsSection {
  provenance: Provenance; state: SectionState; note: string;
  perWorkload: { workload: string; runs: number; totalCost: number | null; avgCost: number | null; avgLatencyMs: number | null; successRate: number | null; successSamples: number; savingsOpportunity: number; provenance: Provenance }[];
}

export interface LanguagesSection {
  provenance: Provenance; state: SectionState; note: string;
  natural: unknown[]; programming: unknown[];
}

export interface ImagesSection {
  provenance: Provenance; state: SectionState; note: string;
  capableModels: { model: string; provider: string; capabilities: string[] }[];
  volume: null; cost?: null; latency?: null; success?: null;
}

export interface ExecutionFlowSection {
  provenance: Provenance; state: SectionState; note: string;
  stages: { key: string; label: string; detail: string; value: number | null }[];
}

export interface Intelligence {
  meta: IntelligenceMeta;
  topModels: TopModelsSection;
  leaderboard: LeaderboardSection;
  tasks: TasksSection;
  cost: CostSection;
  marketShare: MarketShareSection;
  benchmarks: BenchmarksSection;
  latency: LatencySection;
  context: ContextSection;
  tools: ToolsSection;
  workloads: WorkloadsSection;
  languages: LanguagesSection;
  images: ImagesSection;
  executionFlow: ExecutionFlowSection;
}

export type IntelligenceSectionKey =
  | 'topModels' | 'leaderboard' | 'tasks' | 'cost' | 'marketShare'
  | 'benchmarks' | 'latency' | 'context' | 'tools' | 'workloads'
  | 'languages' | 'images' | 'executionFlow';

export interface IntelligenceFilters {
  granularity: 'daily' | 'weekly' | 'monthly';
  range: '7d' | '30d' | '90d' | 'all';
  model: string | null;
  provider: string | null;
  taskCategory: string | null;
  scale: 'linear' | 'log';
}
