'use strict';
// Deterministic simulation of an agent execution sequence.
// Emits Session-1 event envelope payloads; the frontend ONLY visualizes these.
// Uses Context / Memory / Cache engines for real state management.
const { MODELS, TOOLS } = require('./data');
const { contextManager, memoryManager, cacheManager } = require('./engines');
const { ContextItem, ContextItemType, ContextItemStatus } = require('./context_engine');
const { MemoryScope } = require('./memory_engine');

let seq = 0;
const now = () => new Date().toISOString();

// ── helpers ────────────────────────────────────────────────────────────────────

function kindForSource(source) {
  if (source === 'read_file' || source === 'search_code') return 'file';
  if (source === 'run_tests') return 'test';
  if (source === 'conversation') return 'chat';
  if (source === 'ops') return 'logs';
  return 'other';
}

// ── baseState ──────────────────────────────────────────────────────────────────

function baseState(run) {
  const contextResult = contextManager.buildContext();
  const contextItems = contextResult.items.map(item => ({
    id: item.id,
    kind: kindForSource(item.source),
    title: item.content || item.source,
    source: item.source,
    tokens: item.tokenCount,
    relevance: item.relevanceScore,
    status: item.status,
  }));

  const workingMemories = memoryManager.getWorkingMemories();
  const longtermMemories = memoryManager.getLongTermMemories();
  const memory = {
    working: workingMemories.map(m => ({
      id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
      createdAt: m.createdAt.toISOString ? m.createdAt.toISOString() : m.createdAt,
      lastUsedAt: m.lastUsedAt.toISOString ? m.lastUsedAt.toISOString() : m.lastUsedAt,
      importance: m.importance, confidence: m.confidence, status: m.status,
    })),
    longterm: longtermMemories.map(m => ({
      id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
      createdAt: m.createdAt.toISOString ? m.createdAt.toISOString() : m.createdAt,
      lastUsedAt: m.lastUsedAt.toISOString ? m.lastUsedAt.toISOString() : m.lastUsedAt,
      importance: m.importance, confidence: m.confidence, status: m.status,
    })),
  };

  const cacheHitRate = cacheManager.getHitRate();
  const cachedTokens = cacheManager.getCachedTokens();
  const savedUsd = cacheManager.getSavedCost();
  const cacheState = cacheManager.state;
  const recentCacheEvents = cacheManager.getRecentEvents(5);

  return {
    runId: run.id, lastSeq: seq, updatedAt: now(), status: run.status,
    activeModelId: 'nemotron-x',
    context: {
      usedTokens: contextResult.usedTokens,
      windowTokens: contextResult.windowTokens,
      segments: contextResult.segments,
      items: contextItems,
    },
    cache: {
      hitRate: Math.round(cacheHitRate * 100) / 100,
      cachedTokens,
      uncachedTokens: Math.max(0, contextResult.usedTokens - cachedTokens),
      savedUsd: Math.round(savedUsd * 10000) / 10000,
      state: cacheState,
      recent: recentCacheEvents.map(e => ({ type: e.type, ts: e.ts, detail: e.detail })),
    },
    memory,
    tools: TOOLS.map(t => ({ ...t, lastStatus: 'idle' })),
    cost: {
      spentUsd: 0.031, budgetUsd: 0.1, projectedUsd: 0.074,
      breakdown: [
        { key: 'in', label: 'Model input', usd: 0.012 },
        { key: 'out', label: 'Model output', usd: 0.009 },
        { key: 'cache', label: 'Cached input', usd: -Math.round(savedUsd * 10000) / 10000 },
        { key: 'tools', label: 'Tools', usd: 0.004 },
        { key: 'retr', label: 'Retrieval', usd: 0.003 },
        { key: 'retry', label: 'Retries', usd: 0.007 },
        { key: 'switch', label: 'Switching', usd: 0.009 },
      ],
    },
    latency: { currentStepMs: 1800, avgStepMs: 1650, modelMs: 1800, toolMs: 2800, totalMs: 21400, samples: [1200, 1600, 1800, 2400, 1900, 2800, 1700] },
    routing: {
      currentId: 'nemotron-x',
      candidates: [
        { modelId: 'nemotron-x', score: 0.91, costUsd: 0.021, latencyMs: 1800, factors: { quality: 0.91, cost: 0.7, latency: 0.75, reliability: 0.987, contextFit: 1, switchCost: 0 } },
        { modelId: 'helium-b', score: 0.87, costUsd: 0.017, latencyMs: 1600, factors: { quality: 0.87, cost: 0.8, latency: 0.8, reliability: 0.973, contextFit: 0.9, switchCost: 0.009 } },
        { modelId: 'ferrite-c', score: 0.76, costUsd: 0.009, latencyMs: 1200, factors: { quality: 0.76, cost: 0.95, latency: 0.9, reliability: 0.941, contextFit: 0.4, switchCost: 0.009 } },
      ],
      decision: {
        kind: 'model', decision: 'KEEP CURRENT MODEL', timestamp: now(),
        factors: [
          { key: 'capability', label: 'Required coding capability', status: 'pass' },
          { key: 'context', label: 'Context fits', status: 'pass' },
          { key: 'reliability', label: 'High observed reliability', status: 'pass' },
          { key: 'cache', label: 'Cache currently warm', status: 'pass' },
          { key: 'budget', label: 'Within budget', status: 'pass' },
        ],
        alternatives: [{ id: 'helium-b', deltaCost: -0.004, deltaLatency: -200, score: 0.87, note: 'Potential saving $0.004; switching cost $0.009' }],
      },
    },
    trace: [
      { seq: 1, ts: now(), type: 'task.created', label: 'Task created', status: 'done' },
      { seq: 2, ts: now(), type: 'context.built', label: 'Context built', status: 'done' },
      { seq: 3, ts: now(), type: 'model.selected', label: 'Model selected: Nemotron X', status: 'done' },
    ],
    decisions: [],
    changes: contextManager.getChanges().map((c, i) => ({ seq: i + 1, ts: c.ts, kind: c.kind, label: c.label })).slice(-100),
    messages: [
      { id: 'm1', role: 'user', content: 'Fix authentication bug.', ts: now() },
      { id: 'm2', role: 'assistant', content: 'Planning the fix: I will inspect the auth service, reproduce with tests, then patch.', ts: now() },
    ],
  };
}

// ── planExecution ──────────────────────────────────────────────────────────────

function planExecution(run, userText) {
  const steps = [];
  const emit = (type, payload) => steps.push({ type, payload });

  emit('task.created', { title: run.title });
  emit('planning', { note: 'Planning...' });
  emit('model.selected', { modelId: 'nemotron-x', reason: 'high coding capability', factors: ['coding capability', 'context fits', 'cache warm', 'budget available'] });

  // Context built — engine computes real state
  const ctxBefore = contextManager.buildContext();
  emit('context.built', { usedTokens: ctxBefore.usedTokens, windowTokens: ctxBefore.windowTokens });

  // Tool: read_file → add result to context
  emit('tool.selected', { tool: 'read_file', detail: 'Reading auth/service.ts...' });

  const readFileItem = new ContextItem({
    type: ContextItemType.CODE_FILE, source: 'read_file',
    content: 'auth/service.ts (full read)', tokenCount: 8210,
    relevanceScore: 0.94, importanceScore: 0.90, recencyScore: 0.95,
    dependencyScore: 0.90, freshness: 1.0, taskId: run.id,
  });
  contextManager.addItem(readFileItem);

  // Tool: run_tests → add result to context
  emit('tool.started', { tool: 'run_tests', detail: 'Running tests...' });

  const testResult = new ContextItem({
    type: ContextItemType.TOOL_RESULT, source: 'run_tests',
    content: '2 failing assertions in session refresh flow', tokenCount: 3120,
    relevanceScore: 0.91, importanceScore: 0.80, recencyScore: 0.95,
    dependencyScore: 0.70, freshness: 1.0, taskId: run.id,
  });
  contextManager.addItem(testResult);

  // Memory write — record test failure
  const memWritten = memoryManager.addToWorking({
    title: 'Test failure details',
    snippet: '2 failing assertions in session refresh flow — session.spec:45, session.spec:67',
    source: 'tool:run_tests',
    importance: 0.85,
    confidence: 0.90,
    taskId: run.id,
  });
  emit('memory.write', { id: memWritten.id, scope: 'working', title: memWritten.title });

  emit('tool.finished', { tool: 'run_tests', status: 'failed', durationMs: 2800, detail: 'Test failed...' });

  // Cache miss for test result (first time)
  cacheManager.retrieveSemantic('test failure session', '');

  emit('routing.evaluated', { note: 'Re-evaluating...', candidates: ['nemotron-x', 'helium-b'] });
  emit('model.retained', { modelId: 'nemotron-x', reason: 'Switch cost too high' });

  // Second test run — cache hit this time
  emit('tool.started', { tool: 'run_tests', detail: 'Running tests again...' });
  const cachedResult = cacheManager.retrieveSemantic('test failure session', '');

  emit('tool.finished', { tool: 'run_tests', status: 'success', durationMs: 2400 });

  // Context compression — engine compresses stale conversation items
  const { compressedItems, reclaimedTokens } = contextManager.builder.compressor.compress(
    contextManager.getActiveItems(),
    contextManager.builder.budget.getRemainingBudget(ctxBefore.usedTokens)
  );
  if (reclaimedTokens > 0) {
    emit('context.compressed', { reclaimedTokens, detail: `Context compressed −${(reclaimedTokens / 1000).toFixed(1)}k tokens` });
  } else {
    emit('context.compressed', { reclaimedTokens: 0, detail: 'No compression needed' });
  }

  // Cache hit — auth file span reused
  cacheManager.retrievePrompt('system prompt', userText, 'nemotron-x');
  emit('cache.hit', { detail: 'auth/service.ts span reused', savedUsd: 0.013 });

  // Memory promotion — important working memory → long-term
  const promoted = memoryManager.writer.promote('w1');
  if (promoted) {
    emit('memory.write', { id: promoted.id, scope: 'longterm', title: promoted.title });
  }

  emit('cost.updated', { spentUsd: 0.031, projectedUsd: 0.074 });

  // Response
  const answer = `Fixed the refresh-token rotation bug in auth/service.ts for "${userText.slice(0, 80)}".\n\n- Root cause: rotated refresh token invalidated the pending session.\n- Change: persist rotated token before revoking the old one; added regression test.\n- Verified: run_tests SUCCESS (2.4s). Cache saved $0.013.`;

  const chunks = answer.match(/.{1,60}(\s|$)/g) || [answer];
  chunks.forEach(c => emit('response.delta', { delta: c }));
  emit('response.done', { full: answer });

  // Final context state
  const ctxAfter = contextManager.buildContext();
  emit('context.built', { usedTokens: ctxAfter.usedTokens, windowTokens: ctxAfter.windowTokens });

  emit('run.completed', { summary: 'Completed.' });
  return steps;
}

module.exports = { baseState, planExecution, MODELS, nextSeq: () => ++seq, currentSeq: () => seq };
