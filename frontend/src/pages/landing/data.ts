// Illustrative demo datasets for the marketing page ONLY.
//
// These values are hand-written product-story props, not measurements.
// Every visual that renders them carries a visible "Illustrative demo
// data" label. Never import this module from console (product) code.

export interface ModelCandidate {
  id: string;
  name: string;
  tag: string;
  quality: number; // 0-100 illustrative score
  latencyMs: number; // illustrative
  costUsd: number; // illustrative per-example-task cost
  reliability: number; // 0-100 illustrative score
  decision: number; // 0-100 illustrative net-benefit score
  note: string;
  selected?: boolean;
  standby?: boolean;
}

export const HERO_REQUEST = 'Refactor authentication and run the tests.';

export const HERO_CANDIDATES: ModelCandidate[] = [
  { id: 'a', name: 'GPT-class', tag: 'reasoning depth', quality: 91, latencyMs: 620, costUsd: 0.012, reliability: 98, decision: 82, note: 'Strong quality, slower on this task shape' },
  { id: 'b', name: 'Claude-class', tag: 'selected', quality: 94, latencyMs: 420, costUsd: 0.009, reliability: 99, decision: 96, note: 'Best net benefit after switching cost', selected: true },
  { id: 'c', name: 'Gemini-class', tag: 'standby · failover', quality: 90, latencyMs: 380, costUsd: 0.006, reliability: 97, decision: 78, note: 'Healthy standby if the leader degrades', standby: true },
];

export const DECISION_FACTORS = [
  { key: 'quality', label: 'Quality', detail: 'capability + context fit clear the floor', weight: 92, state: 'pass' },
  { key: 'cost', label: 'Cost', detail: 'total task cost, not per-token sticker', weight: 64, state: 'pass' },
  { key: 'latency', label: 'Latency', detail: 'observed p50, not advertised', weight: 71, state: 'pass' },
  { key: 'reliability', label: 'Reliability', detail: 'health-gated, cooldown armed', weight: 84, state: 'pass' },
  { key: 'switch', label: 'Switch cost', detail: 'hysteresis holds — no oscillation', weight: 32, state: 'hold' },
] as const;

export interface PipelineStage {
  id: string;
  label: string;
  detail: string;
  status: 'done' | 'running' | 'queued';
}

// Execution-trace story beats (statuses cycle in the visual).
export const EXEC_STAGES: PipelineStage[] = [
  { id: 'task', label: 'TASK', detail: 'Refactor auth + run tests · budget $0.10', status: 'done' },
  { id: 'context', label: 'CONTEXT', detail: '3 files · 1 memory · bounded evidence', status: 'done' },
  { id: 'model', label: 'MODEL', detail: 'Claude-class · net benefit 96', status: 'done' },
  { id: 'tools', label: 'TOOLS', detail: 'search → read → run_tests', status: 'running' },
  { id: 'test', label: 'TEST', detail: '2 failing assertions isolated', status: 'queued' },
  { id: 'result', label: 'RESULT', detail: 'patch + proof list', status: 'queued' },
  { id: 'evidence', label: 'EVIDENCE', detail: 'cost $0.009 · 420ms · verified', status: 'queued' },
];

export const COST_BARS = [
  { name: 'GPT-class', value: 100, selected: false },
  { name: 'Claude-class', value: 64, selected: true },
  { name: 'Gemini-class', value: 45, selected: false },
  { name: 'DeepSeek-class', value: 34, selected: false },
];

// 24 illustrative points, 0-100 routing-efficiency index.
export const EFFICIENCY_SERIES = [
  42, 45, 44, 49, 52, 51, 55, 58, 57, 61, 60, 64, 63, 67, 66, 70, 72, 71, 75, 74, 78, 80, 79, 83,
];

// Illustrative per-minute latencies (ms) for overlay comparison.
export const LATENCY_FAST = [410, 390, 400, 380, 370, 375, 360, 355, 350, 348, 345, 340];
export const LATENCY_SLOW = [620, 640, 610, 660, 640, 690, 670, 700, 690, 720, 710, 740];

// Illustrative routing mix (shares sum to 100).
export const ROUTE_MIX = [
  { name: 'Claude-class', share: 38, color: '#0a85ff' },
  { name: 'GPT-class', share: 27, color: '#6366f1' },
  { name: 'Gemini-class', share: 21, color: '#06b6d4' },
  { name: 'DeepSeek-class', share: 14, color: '#0e9f6e' },
];

export const FAILOVER_BEATS = [
  { t: '09:41:02', label: 'primary healthy', state: 'ok' },
  { t: '09:41:37', label: 'latency degrading', state: 'warn' },
  { t: '09:42:10', label: 'cooldown armed', state: 'warn' },
  { t: '09:42:44', label: 'failover → standby', state: 'fire' },
  { t: '09:42:45', label: 'execution continues', state: 'ok' },
] as const;

export const ANALYTICS_HEADLINE = [
  { k: 'Requests', v: '12,482' },
  { k: 'Avg latency', v: '410ms' },
  { k: 'Models used', v: '7' },
  { k: 'Failovers', v: '3' },
];
