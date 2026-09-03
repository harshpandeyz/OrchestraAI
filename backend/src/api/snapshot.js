'use strict';

// Snapshot adapter — the REST snapshot and the SSE stream describe the SAME
// runtime state. This builder is the single place that maps internal
// RuntimeState + per-run control records to the frontend `RuntimeSnapshot`
// contract (CONTRACTS.md). The frontend never reconstructs panels from raw
// events; SSE deltas only patch what this snapshot defines.

const { eventBus } = require('../events/event-bus');
const { frontendStatus } = require('../core/orchestrator');

const COST_LABELS = {
  input_tokens: 'Model input',
  output_tokens: 'Model output',
  cached_input_tokens: 'Cached input',
  uncached_input_tokens: 'Uncached input',
  tool_execution: 'Tools',
  retrieval: 'Retrieval',
  switching: 'Switching',
  retry: 'Retries',
  evaluation: 'Evaluation',
  orchestration_overhead: 'Overhead',
};

function lastSeqFor(runId) {
  const log = eventBus.eventLogs.get(runId) || [];
  return log.length ? log[log.length - 1].seq : 0;
}

function mapDecision(d) {
  if (!d) return null;
  const factors = (d.factors || []).map((f) => ({
    key: f.key, label: f.label, status: f.status, detail: f.detail,
  }));
  const alternatives = (d.candidatesConsidered || []).slice(0, 3).map((c) => ({
    id: c.modelId || c.id, score: c.score,
    deltaCost: c.deltaCost, deltaLatency: c.deltaLatency,
    note: c.note || '',
  }));
  return {
    kind: d.decisionType || d.kind || 'model',
    decision: d.decision,
    timestamp: d.timestamp,
    factors,
    alternatives,
  };
}

function buildSnapshot(orchestrator, runId) {
  const runtimeState = orchestrator.activeRuns.get(runId);
  if (!runtimeState) return null;
  const ctrl = orchestrator.control(runId) || {};
  const registry = orchestrator.modelRegistry;

  const promptTokens = ctrl.lastPromptTokens || 0;
  const usedTokens = Math.max(runtimeState.context.currentTokens || 0, promptTokens);
  const windowTokens = runtimeState.context.maximumTokens || 0;

  // Context composition segments by kind.
  const byKind = new Map();
  for (const item of runtimeState.context.contextItems || []) {
    byKind.set(item.kind, (byKind.get(item.kind) || 0) + (item.tokens || 0));
  }
  const segments = Array.from(byKind.entries()).map(([key, tokens]) => ({
    key, label: key, tokensPct: usedTokens > 0 ? Math.round((tokens / usedTokens) * 1000) / 10 : 0,
  }));

  // Cache: per-run stats (never global, never invented).
  const cacheStats = orchestrator.cacheManager && orchestrator.cacheManager.statsFor
    ? orchestrator.cacheManager.statsFor(runId)
    : { hitRate: 0, hits: 0, misses: 0, recent: [] };
  const cachedTokens = orchestrator.cacheManager && orchestrator.cacheManager.cachedTokensFor
    ? orchestrator.cacheManager.cachedTokensFor(runId)
    : 0;
  const pricing = registry && typeof registry.getPricing === 'function'
    ? registry.getPricing(runtimeState.model.currentModel) : null;
  const per1k = (pricing && pricing.inputPer1k) || 0;
  const cachedPer1k = (pricing && pricing.cachedPer1k) ?? per1k;
  const savedUsd = Math.max(0, Math.round((((per1k - cachedPer1k) * cachedTokens) / 1000) * 1e6) / 1e6);
  const cacheState = cacheStats.hitRate > 0.7 ? 'WARM' : cacheStats.hitRate > 0.3 ? 'COOLING' : 'COLD';

  // Memory: run-visible items only.
  const memory = orchestrator.memoryManager && typeof orchestrator.memoryManager.getMemoryState === 'function'
    ? orchestrator.memoryManager.getMemoryState(runtimeState)
    : { working: [], longterm: [] };

  // Tools: ONE catalog (registry) overlaid with per-run stats. A tool on
  // GET /api/tools is always present here.
  const toolsJson = runtimeState.tools.toJSON();
  const callsByTool = new Map();
  for (const call of toolsJson.recentToolCalls || []) {
    if (!callsByTool.has(call.name)) callsByTool.set(call.name, []);
    callsByTool.get(call.name).push(call);
  }
  const tools = (toolsJson.availableTools || []).map((t) => {
    const calls = callsByTool.get(t.name) || [];
    const latencies = calls.map((c) => c.latencyMs || 0).filter(Boolean);
    const ok = calls.filter((c) => c.success !== false).length;
    const last = calls[calls.length - 1];
    return {
      name: t.name,
      description: t.description || '',
      status: t.status || 'enabled',
      calls: calls.length,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : (t.avgLatencyMs || 0),
      successRate: calls.length ? Math.round((ok / calls.length) * 1000) / 1000 : (t.successRate ?? 1),
      lastStatus: last ? (last.success === false ? 'failed' : 'success') : 'idle',
    };
  });

  // Cost: every category the budget tracked, labelled for the UI.
  const breakdown = Object.entries(toolsJson.costBreakdown || toolsJson.budget?.costBreakdown || {}).map(([key, usd]) => ({
    key, label: COST_LABELS[key] || key, usd: Math.round(Number(usd) * 1e6) / 1e6,
  }));
  const budget = runtimeState.budget.toJSON();
  const rawBreakdown = budget.costBreakdown || {};
  const costBreakdown = Object.entries(rawBreakdown).map(([key, usd]) => ({
    key, label: COST_LABELS[key] || key, usd: Math.round(Number(usd) * 1e6) / 1e6,
  }));

  const latency = ctrl.latency || {};
  const routing = ctrl.routing || { candidates: [], decision: null };
  const candidates = (routing.candidates || []).map((c) => ({
    modelId: c.modelId, score: Math.round((c.score || 0) * 1000) / 1000,
    costUsd: Math.round((c.estimatedCost || 0) * 1e6) / 1e6,
    latencyMs: c.avgLatencyMs || 0,
    factors: { quality: c.quality || 0, cost: c.cost || 0, latency: c.latency || 0, reliability: c.reliability || 0, contextFit: c.contextFit || 0, switchCost: c.switchCost || 0 },
  }));

  return {
    runId,
    lastSeq: lastSeqFor(runId),
    updatedAt: runtimeState.updatedAt,
    status: frontendStatus(runtimeState.status),
    internalStatus: runtimeState.status,
    activeModelId: runtimeState.model.currentModel,
    context: {
      usedTokens, windowTokens, segments,
      items: (runtimeState.context.contextItems || []).map((i) => ({
        id: i.id, kind: i.kind, title: i.title, source: i.source,
        tokens: i.tokens, relevance: i.relevance, status: i.status,
      })),
    },
    cache: {
      hitRate: Math.round((cacheStats.hitRate || 0) * 100) / 100,
      cachedTokens,
      uncachedTokens: Math.max(0, usedTokens - cachedTokens),
      savedUsd,
      state: cacheState,
      recent: (cacheStats.recent || []).slice(0, 20),
    },
    memory: {
      working: (memory.working || []).map(stripMemory),
      longterm: (memory.longterm || []).map(stripMemory),
    },
    tools,
    cost: {
      spentUsd: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
      budgetUsd: runtimeState.budget.maximumCost,
      projectedUsd: Math.round(runtimeState.budget.getProjectedTotal() * 1e6) / 1e6,
      breakdown: costBreakdown.length ? costBreakdown : breakdown,
    },
    latency: {
      currentStepMs: latency.currentStepMs || 0,
      avgStepMs: Math.round(latency.avgStepMs || 0),
      modelMs: latency.modelMs || 0,
      toolMs: latency.toolMs || 0,
      totalMs: latency.totalMs || runtimeState.budget.elapsedLatency || 0,
      samples: (latency.samples || []).slice(-40),
    },
    routing: {
      currentId: runtimeState.model.currentModel,
      candidates,
      decision: mapDecision(routing.decision),
    },
    trace: (ctrl.trace || []).slice(-200),
    decisions: (ctrl.decisions || []).slice(-50).map(mapDecision),
    changes: (ctrl.changes || []).slice(-100),
    messages: (ctrl.messages || []).slice(-200),
    // Time-series for charts (appended per model call; backend-owned).
    series: (ctrl.series || []).slice(-200),
    meta: {
      mode: ctrl.mode || 'demo',
      provider: ctrl.providerId || null,
      model: runtimeState.model.currentModel,
      tokens: ctrl.tokens || { input: 0, output: 0, cached: 0 },
      budgetRemaining: Math.round(runtimeState.budget.getRemainingBudget() * 1e6) / 1e6,
    },
  };
}

function stripMemory(m) {
  return {
    id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
    createdAt: m.createdAt, lastUsedAt: m.lastUsedAt,
    importance: m.importance, confidence: m.confidence, status: m.status,
  };
}

function runSummary(orchestrator, runId) {
  const runtimeState = orchestrator.activeRuns.get(runId);
  if (!runtimeState) return null;
  return {
    id: runtimeState.runId,
    title: runtimeState.task.objective,
    taskMode: runtimeState.task.taskType,
    status: frontendStatus(runtimeState.status),
    internalStatus: runtimeState.status,
    createdAt: runtimeState.createdAt,
    updatedAt: runtimeState.updatedAt,
    activeModelId: runtimeState.model.currentModel,
    budget: runtimeState.budget.maximumCost,
    spent: Math.round(runtimeState.budget.currentSpend * 1e6) / 1e6,
  };
}

module.exports = { buildSnapshot, runSummary, lastSeqFor };
