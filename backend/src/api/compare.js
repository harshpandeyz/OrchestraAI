'use strict';

// Run comparison: duration, cost, tokens, model path, tool usage, context,
// decisions, status. Built from stored snapshots/summaries + event logs only.

const { buildSnapshot, runSummary } = require('./snapshot');

function summarizeRun(orchestrator, store, eventBus, id) {
  const live = (orchestrator.getRun && orchestrator.getRun(id))
    || (orchestrator.activeRuns && orchestrator.activeRuns.get(id))
    || null;
  let snap = live ? buildSnapshot(orchestrator, id) : store.loadSnapshot(id);
  let summary = live ? runSummary(orchestrator, id) : store.loadRunIndex().find((r) => r && r.id === id);
  if (!snap && !summary) return null;

  const events = (eventBus.eventLogs.get(id) || store.loadEvents(id) || []);
  const tools = {};
  let switches = 0;
  const modelPath = [];
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'model.selected' && e.payload && (e.payload.modelId || e.payload.model)) {
      const m = e.payload.modelId || e.payload.model;
      if (!modelPath.length || modelPath[modelPath.length - 1] !== m) modelPath.push(m);
    }
    if (e.type === 'model.switched') {
      switches++;
      const to = e.payload && (e.payload.toModel || e.payload.toId);
      if (to && modelPath[modelPath.length - 1] !== to) modelPath.push(to);
    }
    if ((e.type === 'tool.completed' || e.type === 'tool.failed') && e.payload) {
      const n = e.payload.tool || e.payload.toolName || 'tool';
      tools[n] = tools[n] || { calls: 0, failures: 0 };
      tools[n].calls++;
      if (e.type === 'tool.failed') tools[n].failures++;
    }
  }

  const created = (summary && summary.createdAt) || (snap && snap.updatedAt);
  const updated = (summary && summary.updatedAt) || (snap && snap.updatedAt);
  let durationMs = null;
  try {
    if (created && updated) durationMs = Math.max(0, new Date(updated).getTime() - new Date(created).getTime());
  } catch { /* leave null */ }

  const economicCost = snap && snap.economics && typeof snap.economics.actualCost === 'number'
    ? snap.economics.actualCost
    : null;
  const costUsd = snap && snap.economics
    ? economicCost
    : snap ? (typeof snap.cost?.spentUsd === 'number' ? snap.cost.spentUsd : null) : (summary && summary.spent) ?? null;
  return {
    id,
    title: (summary && summary.title) || null,
    status: (summary && summary.status) || (snap && snap.status) || 'unknown',
    durationMs,
    costUsd,
    costSource: snap?.economics
      ? (economicCost === null ? 'unknown' : 'canonical provider-call economics')
      : snap?.cost?.source || 'summary',
    tokens: snap ? { used: snap.context.usedTokens, window: snap.context.windowTokens } : null,
    modelPath: modelPath.length ? modelPath : (snap && snap.activeModelId ? [snap.activeModelId] : []),
    switches,
    tools,
    toolCalls: Object.values(tools).reduce((a, t) => a + t.calls, 0),
    decisions: snap ? snap.decisions.length : null,
    cacheHitRate: snap ? snap.cache.hitRate : null,
    createdAt: created || null,
    updatedAt: updated || null,
  };
}

function compareRuns(orchestrator, store, eventBus, idA, idB) {
  const a = summarizeRun(orchestrator, store, eventBus, idA);
  const b = summarizeRun(orchestrator, store, eventBus, idB);
  if (!a || !b) return null;
  const delta = {
    durationMs: a.durationMs !== null && b.durationMs !== null ? b.durationMs - a.durationMs : null,
    costUsd: a.costUsd !== null && b.costUsd !== null ? Math.round((b.costUsd - a.costUsd) * 1e6) / 1e6 : null,
    toolCalls: b.toolCalls - a.toolCalls,
    switches: b.switches - a.switches,
  };
  return { a, b, delta };
}

module.exports = { summarizeRun, compareRuns };
