// OrchestraAI console telemetry view-model.
// Derives every live metric from the existing RuntimeSnapshot — no second
// state source, no fake data. Bounded series, memoized by callers.
import { useMemo } from 'react';
import type { RuntimeSnapshot } from '../types';

export const TELEMETRY_MAX_POINTS = 60;

export interface LatencyTelemetry {
  current: number | null;
  average: number | null;
  samples: number[];
  series: number[];
}

export interface CostTelemetry {
  spent: number | null;
  budget: number | null;
  projected: number | null;
  remaining: number | null;
  utilization: number | null;
  series: number[];
}

export interface ContextTelemetry {
  used: number | null;
  window: number | null;
  utilization: number | null;
  series: number[];
  compressed: boolean;
}

export interface RoutingTelemetry {
  selectedId: string | null;
  candidates: RuntimeSnapshot['routing']['candidates'];
  decision: RuntimeSnapshot['routing']['decision'];
  explanation: string | null;
  tradeoff: string | null;
  taskProfile: unknown;
}

export interface ToolHealthItem {
  name: string;
  description: string;
  status: string;
  lastStatus: string;
  calls: number;
  avgLatencyMs: number;
  successRate: number;
  active: boolean;
  failed: boolean;
}

export interface RuntimeTelemetry {
  status: string;
  live: boolean;
  terminal: boolean;
  busy: boolean;
  currentModel: string | null;
  latency: LatencyTelemetry;
  cost: CostTelemetry;
  context: ContextTelemetry;
  cache: { hitRate: number | null; savedUsd: number | null; state: string; recentCount: number };
  routing: RoutingTelemetry;
  tools: { active: ToolHealthItem[]; recent: ToolHealthItem[]; all: ToolHealthItem[]; totalCalls: number };
  steps: { completed: number; total: number | null };
  tokens: { input: number | null; output: number | null; cached: number | null };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bound(arr: number[], max = TELEMETRY_MAX_POINTS): number[] {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n ? s / n : null;
}

export function deriveTelemetry(snap: RuntimeSnapshot | null | undefined): RuntimeTelemetry | null {
  if (!snap) return null;
  const status = String(snap.status || 'idle');
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const busy = status === 'running' || status === 'planning' || status === 'waiting';

  // Latency: prefer explicit samples, fall back to series latencyMs.
  const rawSamples = Array.isArray(snap.latency?.samples) ? snap.latency.samples.filter((v) => Number.isFinite(v)) : [];
  const seriesLatency = Array.isArray(snap.series) ? snap.series.map((s) => s.latencyMs).filter((v) => Number.isFinite(v)) : [];
  const latencySeries = bound(seriesLatency.length >= 2 ? seriesLatency : rawSamples.length ? rawSamples : seriesLatency);
  const latencySamples = bound(rawSamples);
  const current = num(snap.latency?.currentStepMs) ?? (latencySeries.length ? latencySeries[latencySeries.length - 1] : null);
  const average = num(snap.latency?.avgStepMs) ?? avg(latencySamples) ?? avg(latencySeries);

  // Cost
  const spent = num(snap.cost?.spentUsd);
  const budget = num(snap.cost?.budgetUsd);
  const projected = num(snap.cost?.projectedUsd);
  const remaining = spent !== null && budget !== null ? Math.max(0, budget - spent) : null;
  const utilization = spent !== null && budget !== null && budget > 0 ? Math.min(1, spent / budget) : null;
  const costSeries = bound((snap.series || []).map((s) => (Number.isFinite(s.cost) ? s.cost : 0)));

  // Context
  const used = num(snap.context?.usedTokens);
  const window = num(snap.context?.windowTokens);
  const cUtil = used !== null && window ? used / window : null;
  const contextSeries = bound(
    (snap.series || []).map((s) => (Number.isFinite(s.contextUtil) && window ? s.contextUtil * window : NaN)).filter((v) => Number.isFinite(v)),
  );
  const compressed = (snap.changes || []).some((c) => /compress/i.test(String(c.label || '')));

  // Tools
  const all: ToolHealthItem[] = (snap.tools || []).map((t) => {
    const last = String(t.lastStatus || '');
    return {
      name: t.name,
      description: t.description || '',
      status: t.status,
      lastStatus: last,
      calls: t.calls || 0,
      avgLatencyMs: t.avgLatencyMs || 0,
      successRate: typeof t.successRate === 'number' ? t.successRate : 1,
      active: last === 'running',
      failed: ['failed', 'timed_out', 'cancelled'].includes(last),
    };
  });
  const active = all.filter((t) => t.active);
  const recent = all.filter((t) => t.calls > 0 && !t.active).slice(0, 6);
  const totalCalls = all.reduce((a, t) => a + (t.calls || 0), 0);

  // Steps: completed trace steps vs plan length when known.
  const completed = (snap.trace || []).filter((t) => /step_completed|tool\.completed|tool\.finished|response\.done/.test(t.type)).length;
  const planSteps = snap.execution?.plan?.steps?.length ?? null;

  // Tokens from meta when available.
  const tokens = {
    input: num(snap.meta?.tokens?.input),
    output: num(snap.meta?.tokens?.output),
    cached: num(snap.meta?.tokens?.cached),
  };

  return {
    status,
    live: busy,
    terminal,
    busy,
    currentModel: snap.activeModelId || snap.routing?.currentId || null,
    latency: { current, average, samples: latencySamples, series: latencySeries },
    cost: { spent, budget, projected, remaining, utilization, series: costSeries },
    context: { used, window, utilization: cUtil, series: contextSeries, compressed },
    cache: {
      hitRate: num(snap.cache?.hitRate),
      savedUsd: num(snap.cache?.savedUsd),
      state: String(snap.cache?.state || 'UNKNOWN'),
      recentCount: (snap.cache?.recent || []).length,
    },
    routing: {
      selectedId: snap.routing?.currentId || snap.activeModelId || null,
      candidates: snap.routing?.candidates || [],
      decision: snap.routing?.decision || null,
      explanation: snap.routing?.explanation ?? null,
      tradeoff: snap.routing?.tradeoff ?? null,
      taskProfile: snap.routing?.taskProfile ?? null,
    },
    tools: { active, recent, all, totalCalls },
    steps: { completed, total: planSteps },
    tokens,
  };
}

export function useRuntimeTelemetry(snap: RuntimeSnapshot | null | undefined): RuntimeTelemetry | null {
  return useMemo(() => deriveTelemetry(snap), [
    snap?.status,
    snap?.activeModelId,
    snap?.updatedAt,
    snap?.lastSeq,
    // Structural inputs: JSON-identity changes each snapshot, but memo still
    // bounds chart work because deriveTelemetry itself is cheap (<1ms) and
    // charts memo on their bounded series.
    snap,
  ]);
}

/** Bounded chart series selector — last N points only. */
export function useChartSeries(values: number[] | undefined, max = TELEMETRY_MAX_POINTS): number[] {
  return useMemo(() => {
    if (!values || !values.length) return [];
    const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return clean.length > max ? clean.slice(clean.length - max) : clean;
  }, [values, max]);
}
