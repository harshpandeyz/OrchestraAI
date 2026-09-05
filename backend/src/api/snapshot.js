'use strict';

// Snapshot adapter — the REST snapshot and the SSE stream describe the SAME
// runtime state. This builder is the single place that maps internal
// RuntimeState + per-run control records to the frontend `RuntimeSnapshot`
// contract (CONTRACTS.md). The frontend never reconstructs panels from raw
// events; SSE deltas only patch what this snapshot defines.

const { eventBus } = require('../events/event-bus');
const { frontendStatus } = require('../core/orchestrator');
const { persistedSnapshot } = require('../privacy');

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
  provider_reconciliation: 'Provider usage reconciliation',
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
  const meta = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
  return {
    kind: d.decisionType || d.kind || 'model',
    decision: d.decision,
    timestamp: d.timestamp,
    factors,
    alternatives,
    // Session 2 intelligence explanation (additive; absent on old decisions).
    ...(meta.explanation ? { explanation: meta.explanation } : {}),
    ...(meta.inputsHash ? { inputsHash: meta.inputsHash } : {}),
    ...(meta.policyVersion ? { policyVersion: meta.policyVersion } : {}),
    ...(meta.taskProfile ? { taskProfile: meta.taskProfile } : {}),
    ...(Array.isArray(meta.counterfactuals) ? { counterfactuals: meta.counterfactuals } : {}),
  };
}

function buildSnapshot(orchestrator, runId) {
  // Live runs first, then retired terminal history (Session 1 lifecycle).
  const runtimeState = (orchestrator.getRun && orchestrator.getRun(runId))
    || (orchestrator.activeRuns && orchestrator.activeRuns.get(runId))
    || null;
  if (!runtimeState) return null;
  const ctrl = (orchestrator.control && orchestrator.control(runId)) || {};
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
      // Canonical tool outcome preserved (timed_out/cancelled/needs_approval
      // are NOT collapsed into generic failure).
      lastStatus: last
        ? (['timed_out', 'cancelled', 'needs_approval', 'denied', 'disabled'].includes(last.status) ? last.status
          : last.success === false ? 'failed' : 'success')
        : 'idle',
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
    // Unknown pricing is not a zero-cost candidate. Keep null visible in the
    // console and let the router's explicit unknown-pricing path explain it.
    costUsd: Number.isFinite(Number(c.estimatedCost)) ? Math.round(Number(c.estimatedCost) * 1e6) / 1e6 : null,
    latencyMs: c.avgLatencyMs ?? c.latencyMs ?? null, // null = not measured, never 0-as-fact
    factors: { quality: c.quality || 0, cost: c.cost || 0, latency: c.latency || 0, reliability: c.reliability || 0, contextFit: c.contextFit || 0, switchCost: c.switchCost || 0 },
    // Session 2 intelligence overlay (nullable = unknown; additive).
    predictedSuccess: c.predictedSuccess ?? null,
    taskFitScore: c.taskFitScore ?? null,
    toolCapabilityScore: c.toolCapabilityScore ?? null,
    expectedCostUsd: c.expectedCostUsd ?? (Number.isFinite(Number(c.estimatedCost)) ? c.estimatedCost : null),
    ...(c.expectedCostBreakdown ? { expectedCostBreakdown: c.expectedCostBreakdown } : {}),
    expectedLatencyMs: c.expectedLatencyMs ?? c.avgLatencyMs ?? null,
    taskCategory: c.taskCategory || null,
    predictionConfidence: c.predictionConfidence || 'none',
    predictionSamples: c.predictionSamples || 0,
    reasons: Array.isArray(c.reasons) ? c.reasons : [],
    ...(c.excluded ? { excluded: c.excluded, exclusionReason: c.exclusionReason || null } : {}),
  }));

  const snapshot = {
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
      hits: Number.isFinite(Number(cacheStats.hits)) ? Number(cacheStats.hits) : null,
      misses: Number.isFinite(Number(cacheStats.misses)) ? Number(cacheStats.misses) : null,
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
      // OBSERVED token counts × registry rates when known; ESTIMATED when any
      // model cost used fallback pricing (never presented as metered).
      source: ctrl.pricingUnknown
        ? 'estimated (provider pricing unknown for one or more models)'
        : 'metered (usage × provider pricing)',
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
      // Session 2 routing intelligence (additive; null when not recorded).
      explanation: routing.explanation || null,
      tradeoff: routing.tradeoff || null,
      counterfactuals: Array.isArray(routing.counterfactuals) ? routing.counterfactuals : [],
      taskProfile: routing.taskProfile || null,
      inputsHash: routing.inputsHash || null,
      policyVersion: routing.policyVersion || null,
    },
    trace: (ctrl.trace || []).slice(-200),
    decisions: (ctrl.decisions || []).slice(-50).map(mapDecision),
    changes: (ctrl.changes || []).slice(-100),
    messages: (ctrl.messages || []).slice(-200),
    // Time-series for charts (appended per model call; backend-owned).
    series: (ctrl.series || []).slice(-200),
    // Canonical economic ledger. Every cost/savings/billing projection refers
    // back to these model-call records rather than reconstructing from trace
    // or telemetry side effects.
    modelCalls: (runtimeState.modelCalls || []).slice(-200),
    economics: runtimeState.economics || null,
    // Session 3 execution view (plan/approvals/episodes/changesets/    // verification/pause). Null when the execution controller is absent;
    // Session 4 renders "Agent is waiting for approval / running tests /
    // modified N files / recovered" from these fields without
    // reverse-engineering internals.
    execution: executionView(orchestrator, runId),
    // Session 2 intelligence summary (versions, task profile, outcome).
    // Null-guarded: snapshots never break when intelligence is absent.
    intelligence: intelligenceView(orchestrator, runId),
    meta: {
      mode: ctrl.mode || 'demo',
      privacyMode: runtimeState.privacyMode || 'standard',
      provider: ctrl.providerId || null,
      model: runtimeState.model.currentModel,
      preset: ctrl.preset || (runtimeState.policy && runtimeState.policy.preset) || 'balanced',
      tokens: ctrl.tokens || { input: 0, output: 0, cached: 0 },
      budgetRemaining: Math.round(runtimeState.budget.getRemainingBudget() * 1e6) / 1e6,
    },
    ownership: { ownerId: runtimeState.ownerId || null, orgId: runtimeState.orgId || null, projectId: runtimeState.projectId || null },
  };
  return persistedSnapshot(snapshot, runtimeState.privacyMode);
}

function stripMemory(m) {
  return {
    id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
    createdAt: m.createdAt, lastUsedAt: m.lastUsedAt,
    importance: m.importance, confidence: m.confidence, status: m.status,
  };
}

// Session 3 execution summary for the snapshot. Artifact references only
// (artifactId/type/size/hash) — never huge blobs in the payload.
function executionView(orchestrator, runId) {
  try {
    const controller = orchestrator && orchestrator.__session3;
    if (!controller || typeof controller.executionView !== 'function') return null;
    const view = controller.executionView(runId);
    if (!view) return null;
    return {
      status: view.status,
      pause: view.pause,
      currentAction: view.currentAction,
      plan: view.plan,
      readySteps: view.readySteps,
      pendingApprovals: (view.pendingApprovals || []).map((a) => ({
        id: a.id, actionType: a.actionType, title: a.title,
        riskLevel: a.riskLevel, affectedResources: a.affectedResources,
        expiresAt: a.expiresAt, status: a.status,
      })),
      changesets: (view.changesets || []).map((c) => ({
        id: c.id, files: c.files, additions: c.additions,
        deletions: c.deletions, status: c.status, riskLevel: c.riskLevel,
      })),
      verifications: (view.verifications || []).map((v) => ({ kind: v.kind, passed: v.passed, summary: v.summary, at: v.at })),
      episodes: (view.episodes || []).map((e) => ({
        episodeId: e.episodeId, parentEpisodeId: e.parentEpisodeId,
        status: e.status, steps: e.steps, toolCalls: e.toolCalls,
        startedAt: e.startedAt, completedAt: e.completedAt,
      })),
      currentEpisode: view.currentEpisode,
      constraints: view.constraints,
      toolHealth: view.toolHealth,
      recovery: view.recovery,
      // Pending-approval headline for "Agent is waiting for approval".
      waitingForApproval: (view.pendingApprovals || []).length > 0,
    };
  } catch {
    return null;
  }
}

// Session 2 intelligence summary for the snapshot. Versions for
// reproducibility, the routing task profile, and the run's outcome
// evaluation (null until the run ends and is ingested).
function intelligenceView(orchestrator, runId) {
  try {
    const intel = orchestrator && orchestrator.intelligence;
    const ctrl = (orchestrator.control && orchestrator.control(runId)) || {};
    const versions = (() => {
      try {
        return require('../intelligence/versions').VERSIONS;
      } catch {
        return null;
      }
    })();
    if (!intel && !versions) return null;
    const outcome = intel && typeof intel.outcomeForRun === 'function' ? intel.outcomeForRun(runId) : null;
    return {
      versions,
      taskProfile: (ctrl.routing && ctrl.routing.taskProfile) || null,
      outcome: outcome ? {
        taskSuccess: outcome.taskSuccess,
        overallScore: outcome.overallScore,
        confidence: outcome.confidence,
        reasons: outcome.reasons || [],
        evaluatorVersion: outcome.evaluatorVersion,
      } : null,
    };
  } catch {
    return null;
  }
}

function runSummary(orchestrator, runId) {  const runtimeState = (orchestrator.getRun && orchestrator.getRun(runId))
    || (orchestrator.activeRuns && orchestrator.activeRuns.get(runId))
    || null;
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
    ownerId: runtimeState.ownerId || null,
    orgId: runtimeState.orgId || null,
    projectId: runtimeState.projectId || null,
    privacyMode: runtimeState.privacyMode || 'standard',
    economics: runtimeState.economics || null,
  };
}

module.exports = { buildSnapshot, runSummary, lastSeqFor, executionView };
