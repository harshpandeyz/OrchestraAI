'use strict';

// Hybrid memory retrieval, deduplication and conflict handling (§17–§20).
//
// Retrieval: lexical (token Jaccard) + task/category affinity stand in for
// semantic similarity without an embedding service (§37: no embedding call per
// query path by default). An optional semanticScore hook lets a future
// Session-1-provided embedding index contribute without changing the API:
// pass { semanticScores: Map<id, 0..1> } and it is blended at the configured
// semantic weight. Weights are configurable, never hardcoded blindly.
//
// MemoryRecord extends the CONTRACTS MemoryItem with type/tags/confidence/
// provenance fields (§17) while remaining wire-compatible (id/scope/title/
// snippet/source/createdAt/lastUsedAt/importance/confidence/status).

const { VERSIONS } = require('./versions');
const { lexicalOverlap } = require('./context-engine');

const MEMORY_TYPES = Object.freeze([
  'preference', 'fact', 'project_context', 'technical_decision',
  'lesson', 'prior_solution', 'constraint', 'working_memory',
]);

const DEFAULT_RETRIEVAL_WEIGHTS = Object.freeze({
  semantic: 0.35,
  lexical: 0.20,
  task: 0.15,
  confidence: 0.10,
  importance: 0.10,
  recency: 0.10,
});

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 1);
}

function recencyScore(lastUsedAt, nowMs) {
  if (!lastUsedAt) return 0.5;
  const t = Date.parse(lastUsedAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageMin = Math.max(0, (nowMs - t) / 60000);
  if (ageMin <= 30) return 1;
  if (ageMin <= 180) return 0.8;
  if (ageMin <= 1440) return 0.6;
  if (ageMin <= 10080) return 0.4;
  return 0.2;
}

function taskAffinity(memory, taskCategory) {
  if (!taskCategory) return 0.5;
  const tags = [...(memory.tags || []), String(memory.type || '')].map((s) => String(s).toLowerCase());
  const text = `${memory.title || ''} ${memory.snippet || ''}`.toLowerCase();
  if (tags.includes(String(taskCategory).toLowerCase())) return 0.9;
  if (text.includes(String(taskCategory).toLowerCase())) return 0.7;
  return 0.5;
}

function createMemoryRecord(input = {}) {
  return {
    id: input.id || `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    scope: input.scope === 'longterm' ? 'longterm' : 'working',
    type: MEMORY_TYPES.includes(input.type) ? input.type : 'working_memory',
    title: String(input.title || '').slice(0, 300),
    snippet: String(input.snippet || input.content || '').slice(0, 2000),
    content: typeof input.content === 'string' ? input.content.slice(0, 4000) : undefined,
    source: String(input.source || 'runtime').slice(0, 200),
    sourceRunId: input.sourceRunId || input.runId || null,
    projectId: input.projectId || null,
    workspaceId: input.workspaceId || null,
    importance: Number.isFinite(Number(input.importance)) ? Math.max(0, Math.min(1, Number(input.importance))) : 0.5,
    confidence: Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0.5,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    lastUsedAt: input.lastUsedAt || new Date().toISOString(),
    lastValidatedAt: input.lastValidatedAt || null,
    expiresAt: input.expiresAt || null,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
    embeddingReference: input.embeddingReference || null,
    supersedes: input.supersedes || null,
    supersededBy: input.supersededBy || null,
    status: input.status || 'active',
    schemaVersion: VERSIONS.memorySchema,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

function scoreMemory(memory, query, opts = {}) {
  const weights = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...(opts.weights || {}) };
  const nowMs = opts.nowMs || Date.now();
  const text = `${memory.title || ''} ${memory.snippet || ''}`;
  const lexical = query ? lexicalOverlap(query, text) : 0.3;
  const semantic = opts.semanticScores && opts.semanticScores instanceof Map && opts.semanticScores.has(memory.id)
    ? Math.max(0, Math.min(1, Number(opts.semanticScores.get(memory.id))))
    : lexical * 0.6; // honest fallback: lexical-derived proxy, labelled as such
  const task = taskAffinity(memory, opts.taskCategory);
  const confidence = Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.5;
  const importance = Number.isFinite(Number(memory.importance)) ? Number(memory.importance) : 0.5;
  const recency = recencyScore(memory.lastUsedAt || memory.createdAt, nowMs);
  const expired = memory.expiresAt && Date.parse(memory.expiresAt) < nowMs;

  const score = expired ? 0 : Math.round((
    semantic * weights.semantic + lexical * weights.lexical + task * weights.task +
    confidence * weights.confidence + importance * weights.importance + recency * weights.recency
  ) * 1000) / 1000;

  return {
    id: memory.id,
    score,
    components: {
      semantic: Math.round(semantic * 1000) / 1000,
      lexical: Math.round(lexical * 1000) / 1000,
      task: Math.round(task * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      importance: Math.round(importance * 1000) / 1000,
      recency: Math.round(recency * 1000) / 1000,
    },
    semanticSource: opts.semanticScores && opts.semanticScores.has(memory.id) ? 'embedding-index' : 'lexical-proxy',
    expired: !!expired,
    explanation: expired ? 'expired' : [
      lexical >= 0.3 ? `lexical match ${lexical.toFixed(2)}` : 'weak lexical match',
      task >= 0.7 ? `task-relevant (${opts.taskCategory})` : null,
      importance >= 0.8 ? 'high importance' : null,
      recency <= 0.3 ? 'stale' : recency >= 0.8 ? 'recent' : null,
    ].filter(Boolean).join(' + ') || 'neutral',
    retrievalVersion: VERSIONS.memoryRetrieval,
  };
}

function rankMemories(memories, query, opts = {}) {
  const scored = (memories || [])
    .filter((m) => m && m.status === 'active')
    .map((m) => ({ memory: m, s: scoreMemory(m, query, opts) }));
  scored.sort((a, b) => b.s.score - a.s.score ||
    String(a.memory.id).localeCompare(String(b.memory.id)));
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || scored.length || 10));
  return scored.slice(0, limit);
}

// ---------- Deduplication (§19) ----------

function similarity(a, b) {
  const ta = `${a.title || ''} ${a.snippet || ''}`;
  const tb = `${b.title || ''} ${b.snippet || ''}`;
  return lexicalOverlap(ta, tb);
}

// Returns { action: 'create'|'merge'|'supersede'|'reject', target?, merged? }.
// Never silently overwrites: merges keep provenance, contradictions become
// conflicts instead of merges (§20).
function consolidateCandidate(candidate, existing, opts = {}) {
  const threshold = Number.isFinite(Number(opts.duplicateThreshold)) ? Number(opts.duplicateThreshold) : 0.55;
  let best = null;
  let bestSim = 0;
  for (const e of existing || []) {
    if (!e || e.status !== 'active') continue;
    const sim = similarity(candidate, e);
    if (sim > bestSim) { bestSim = sim; best = e; }
  }
  if (!best || bestSim < threshold) return { action: 'create', similarity: Math.round(bestSim * 1000) / 1000 };
  if (isContradiction(candidate, best)) {
    return { action: 'conflict', target: best, similarity: Math.round(bestSim * 1000) / 1000 };
  }
  const merged = {
    ...best,
    snippet: best.snippet.length >= candidate.snippet.length ? best.snippet : candidate.snippet,
    importance: Math.max(best.importance || 0, candidate.importance || 0),
    confidence: Math.round(Math.min(0.95, Math.max(best.confidence || 0, candidate.confidence || 0) + 0.05) * 1000) / 1000,
    updatedAt: new Date().toISOString(),
    lastValidatedAt: new Date().toISOString(),
    tags: [...new Set([...(best.tags || []), ...(candidate.tags || [])])].slice(0, 20),
    metadata: { ...(best.metadata || {}), mergedFrom: [...((best.metadata && best.metadata.mergedFrom) || []), candidate.id].slice(-10) },
  };
  return { action: 'merge', target: best, merged, similarity: Math.round(bestSim * 1000) / 1000 };
}

const CONTRADICTION_PAIRS = [
  [/\b(dark|light)\b.*\b(mode|theme|ui)\b/, /\b(light|dark)\b.*\b(mode|theme|ui)\b/],
];

function isContradiction(a, b) {
  const ta = `${a.title || ''} ${a.snippet || ''}`.toLowerCase();
  const tb = `${b.title || ''} ${b.snippet || ''}`.toLowerCase();
  // Generic: same preference key, different value ("package manager = npm" vs
  // "= pnpm"; "prefers X" vs "prefers Y" on the same subject).
  const keyOf = (t) => {
    const m = t.match(/(prefer\w*|package manager|theme|ui|mode|default|owner)\b[^=:\n]{0,40}[=:]\s*([a-z0-9_./-]+)/);
    return m ? { key: m[1], value: m[2] } : null;
  };
  const ka = keyOf(ta);
  const kb = keyOf(tb);
  if (ka && kb && ka.key === kb.key && ka.value !== kb.value) return true;
  // Direct negation on near-duplicate text.
  if (similarity(a, b) > 0.6) {
    const neg = (t) => /\b(not|never|don't|doesn't|disabled|off)\b/.test(t);
    if (neg(ta) !== neg(tb)) return true;
  }
  for (const [ra, rb] of CONTRADICTION_PAIRS) {
    if (ra.test(ta) && rb.test(tb)) {
      const va = (ta.match(/(dark|light)/) || [])[1];
      const vb = (tb.match(/(dark|light)/) || [])[1];
      if (va && vb && va !== vb) return true;
    }
  }
  return false;
}

// Represent a conflict without resolving it silently (§20). Retrieval prefers
// the newer project-scoped record but BOTH stay visible for future UI.
function describeConflict(a, b) {
  const pick = (r) => ({ id: r.id, scope: r.scope, snippet: r.snippet, confidence: r.confidence, updatedAt: r.updatedAt || r.createdAt, source: r.source });
  const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
  const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
  const preferred = tb >= ta ? b : a;
  return {
    kind: 'memory_conflict',
    records: [pick(a), pick(b)],
    preferredId: preferred.id,
    reason: 'contradictory values for the same key; newer project-scoped preference preferred, both retained',
  };
}

module.exports = {
  MEMORY_TYPES,
  DEFAULT_RETRIEVAL_WEIGHTS,
  createMemoryRecord,
  scoreMemory,
  rankMemories,
  consolidateCandidate,
  isContradiction,
  describeConflict,
  similarity,
};
