'use strict';

// Real context engine (§12–§16, §22).
//
// - scoreContextItem: explicit, explainable multi-factor score.
// - selectContext: relevance-aware knapsack under a token budget that
//   preserves dependency closure (a kept item keeps its dependencies).
// - buildPromptPlan: ONE authoritative compilation consumed by router, budget,
//   provider adapter, telemetry and frontend (§14).
// - compressItem: deterministic, task-aware compression that produces ACTUAL
//   smaller content (§15–§16) — never just rewrites token accounting.
// - fingerprintContext: stable hash for cache/replay/comparison (§22), secrets
//   excluded by construction (only ids/kinds/titles/hashes feed it).

const crypto = require('crypto');
const { VERSIONS } = require('./versions');

const DEFAULT_WEIGHTS = Object.freeze({
  relevance: 0.35,
  dependency: 0.15,
  recency: 0.12,
  importance: 0.18,
  taskRequirement: 0.20,
  tokenCostPenalty: 0.25, // subtracted: penaltyPerK * tokens/1000
  penaltyPerKTokens: 0.02,
});

const KIND_TASK_AFFINITY = {
  debug: { file: 0.9, logs: 0.95, test: 0.9, tool_result: 0.85, chat: 0.7, search: 0.6, memory: 0.6 },
  code: { file: 0.9, tool_result: 0.8, chat: 0.7, search: 0.7, test: 0.7, memory: 0.55, logs: 0.5 },
  research: { search: 0.95, memory: 0.7, chat: 0.65, file: 0.5, tool_result: 0.5, test: 0.3, logs: 0.3 },
  analysis: { file: 0.8, memory: 0.75, tool_result: 0.75, chat: 0.65, search: 0.6, test: 0.5, logs: 0.6 },
  extraction: { file: 0.85, tool_result: 0.8, search: 0.7, chat: 0.6, memory: 0.5, test: 0.4, logs: 0.4 },
  planning: { memory: 0.85, chat: 0.8, file: 0.7, search: 0.65, tool_result: 0.6, test: 0.4, logs: 0.4 },
  writing: { memory: 0.75, chat: 0.8, file: 0.6, search: 0.6, tool_result: 0.4, test: 0.3, logs: 0.3 },
  general: { chat: 0.8, memory: 0.65, file: 0.6, search: 0.6, tool_result: 0.6, test: 0.5, logs: 0.5 },
};

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 1);
}

// Deterministic lexical overlap (Jaccard over token sets). No embeddings at
// selection time (§37: no embedding call per context item).
function lexicalOverlap(query, itemText) {
  const q = new Set(tokenize(query));
  const d = new Set(tokenize(itemText));
  if (!q.size || !d.size) return 0;
  let inter = 0;
  for (const w of q) if (d.has(w)) inter++;
  return inter / (q.size + d.size - inter);
}

function recencyScore(createdAt, nowMs) {
  if (!createdAt) return 0.5;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageMin = Math.max(0, (nowMs - t) / 60000);
  if (ageMin <= 15) return 1;
  if (ageMin <= 60) return 0.8;
  if (ageMin <= 240) return 0.6;
  if (ageMin <= 1440) return 0.4;
  return 0.2;
}

function scoreContextItem(item, ctx = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };
  const query = ctx.query || ctx.taskText || '';
  const taskCategory = ctx.taskCategory || 'general';
  const nowMs = ctx.nowMs || Date.now();

  const itemText = `${item.title || ''} ${item.source || ''} ${(item.metadata && item.metadata.text) || item.content || ''}`;
  const lexical = query ? lexicalOverlap(query, itemText) : 0.3;
  const baseRelevance = Number.isFinite(Number(item.relevance)) ? Math.max(0, Math.min(1, Number(item.relevance))) : 0.5;
  const relevance = query ? (0.6 * lexical + 0.4 * baseRelevance) : baseRelevance;

  const depIds = item.dependencies || (item.metadata && item.metadata.dependsOn) || [];
  const depSet = ctx.dependencyHits instanceof Set ? ctx.dependencyHits : new Set();
  const dependency = depIds.length
    ? (depIds.some((d) => depSet.has(d)) ? 0.9 : 0.4)
    : 0.5;

  const recency = recencyScore(item.createdAt || (item.metadata && item.metadata.createdAt), nowMs);
  const importance = Number.isFinite(Number(item.importance)) ? Math.max(0, Math.min(1, Number(item.importance))) : baseRelevance;

  const affinity = (KIND_TASK_AFFINITY[taskCategory] || KIND_TASK_AFFINITY.general)[item.kind] ?? 0.5;
  const taskRequirement = ctx.requiredKinds && ctx.requiredKinds.includes(item.kind) ? 1 : affinity;

  const tokens = Math.max(0, Number(item.tokens) || 0);
  const tokenPenalty = Math.min(0.5, (tokens / 1000) * (weights.penaltyPerKTokens || 0));

  const raw = relevance * weights.relevance
    + dependency * weights.dependency
    + recency * weights.recency
    + importance * weights.importance
    + taskRequirement * weights.taskRequirement
    - tokenPenalty * weights.tokenCostPenalty;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;

  const why = [];
  if (relevance >= 0.6) why.push(`high lexical/task relevance (${relevance.toFixed(2)})`);
  else if (relevance <= 0.25) why.push(`low task relevance (${relevance.toFixed(2)})`);
  if (dependency >= 0.9) why.push('dependency match');
  if (recency >= 0.8) why.push('recent');
  else if (recency <= 0.3) why.push('stale');
  if (importance >= 0.8) why.push('high importance');
  if (taskRequirement >= 0.85) why.push(`required for ${taskCategory}`);
  if (tokenPenalty >= 0.1) why.push(`token-cost penalty (${tokens} tokens)`);

  return {
    id: item.id,
    score,
    components: {
      relevance: Math.round(relevance * 1000) / 1000,
      dependency: Math.round(dependency * 1000) / 1000,
      recency: Math.round(recency * 1000) / 1000,
      importance: Math.round(importance * 1000) / 1000,
      taskRequirement: Math.round(taskRequirement * 1000) / 1000,
      tokenCostPenalty: Math.round(tokenPenalty * 1000) / 1000,
    },
    explanation: why.join(' + ') || 'neutral score',
    weights: { ...weights },
    scoringVersion: VERSIONS.contextScoring,
  };
}

// Budgeted selection with dependency closure. Returns selected + omitted with
// reasons (§13). Deterministic: sort by (score desc, tokens asc, id asc).
function selectContext(items, opts = {}) {
  const budget = Math.max(0, Number(opts.tokenBudget) || 0) || Infinity;
  const threshold = Number.isFinite(Number(opts.relevanceThreshold)) ? Number(opts.relevanceThreshold) : 0;
  const ctx = { query: opts.query, taskText: opts.taskText, taskCategory: opts.taskCategory, weights: opts.weights, requiredKinds: opts.requiredKinds, nowMs: opts.nowMs };
  const depSet = new Set((items || []).map((i) => i.id));
  const scored = (items || []).map((item) => ({ item, s: scoreContextItem(item, { ...ctx, dependencyHits: depSet }) }));
  scored.sort((a, b) => b.s.score - a.s.score || (a.item.tokens || 0) - (b.item.tokens || 0) || String(a.item.id).localeCompare(String(b.item.id)));

  const byId = new Map((items || []).map((i) => [i.id, i]));
  const selected = [];
  const omitted = [];
  let used = 0;

  const fits = (it) => (used + (Number(it.tokens) || 0)) <= budget;

  for (const { item, s } of scored) {
    if (item.status && item.status !== 'KEEP') {
      omitted.push({ id: item.id, title: item.title, reason: `status ${item.status}`, score: s.score });
      continue;
    }
    if (s.score < threshold) {
      omitted.push({ id: item.id, title: item.title, reason: `below relevance threshold (${s.score} < ${threshold}): ${s.explanation}`, score: s.score });
      continue;
    }
    if (!fits(item)) {
      omitted.push({ id: item.id, title: item.title, reason: `token budget exceeded (needs ${item.tokens}, ${Math.max(0, budget - used)} left)`, score: s.score });
      continue;
    }
    selected.push({ item, score: s });
    used += Number(item.tokens) || 0;
    // Dependency closure: pull in referenced items even if scored lower.
    const deps = item.dependencies || (item.metadata && item.metadata.dependsOn) || [];
    for (const depId of deps) {
      const dep = byId.get(depId);
      if (!dep || selected.some((x) => x.item.id === depId) || omitted.some((x) => x.id === depId)) continue;
      if (!fits(dep)) {
        omitted.push({ id: dep.id, title: dep.title, reason: `dependency of ${item.id} but token budget exceeded`, score: scoreContextItem(dep, { ...ctx, dependencyHits: depSet }).score });
        continue;
      }
      selected.push({ item: dep, score: scoreContextItem(dep, { ...ctx, dependencyHits: depSet }) });
      used += Number(dep.tokens) || 0;
    }
  }
  return { selected, omitted, usedTokens: used, tokenBudget: budget === Infinity ? null : budget };
}

// ---------- PromptPlan (§14) ----------

function estimateTokensFor(content) {
  return Math.ceil(String(content || '').length / 4);
}

function buildPromptPlan(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const contextItems = Array.isArray(input.contextItems) ? input.contextItems : [];
  const memoryItems = Array.isArray(input.memoryItems) ? input.memoryItems : [];
  const toolSpecs = Array.isArray(input.toolSpecs) ? input.toolSpecs : [];
  const contextWindow = Number.isFinite(Number(input.contextWindow)) && Number(input.contextWindow) > 0
    ? Number(input.contextWindow) : null;

  const systemTokens = estimateTokensFor((input.system || messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')));
  const taskTokens = estimateTokensFor(input.taskText || messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'));
  const historyTokens = estimateTokensFor((input.history || []).map((m) => m.content).join('\n'));
  const memoryTokens = memoryItems.reduce((n, m) => n + estimateTokensFor(`${m.title || ''} ${m.snippet || ''}`), 0);
  const toolTokens = toolSpecs.reduce((n, t) => n + estimateTokensFor(JSON.stringify(t).slice(0, 2000)), 0);
  const contextTokens = contextItems.reduce((n, i) => n + (Number(i.tokens) || 0), 0);
  const totalEstimatedTokens = systemTokens + taskTokens + historyTokens + memoryTokens + toolTokens + contextTokens;
  const remainingTokens = contextWindow !== null ? Math.max(0, contextWindow - totalEstimatedTokens) : null;

  return {
    messages: messages.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 8000) })),
    contextItems: contextItems.map((i) => ({ id: i.id, kind: i.kind, title: i.title, tokens: i.tokens, selected: i.selected !== false })),
    memoryItems: memoryItems.map((m) => ({ id: m.id, title: m.title })),
    toolSpecs: toolSpecs.map((t) => (t && t.function && t.function.name) || t.name || 'tool'),
    systemTokens, taskTokens, historyTokens, memoryTokens, toolTokens,
    contextTokens,
    totalEstimatedTokens,
    contextWindow,
    remainingTokens,
    fits: remainingTokens === null ? null : remainingTokens > 0,
    omittedItems: Array.isArray(input.omittedItems) ? input.omittedItems : [],
    fingerprint: fingerprintContext({ taskText: input.taskText, contextItems, memoryItems, toolSpecs, policy: input.policy }),
    planVersion: VERSIONS.contextScoring,
  };
}

// ---------- Compression (§15–§16) ----------

const PRESERVE_PATTERNS = [
  /[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|rb|php|css|html)(:\d+)?/g, // file paths + line refs
  /\bline \d+\b/gi,
  /\b(function|class|const|let|var|def|fn) [A-Za-z_$][\w$]*/g, // identifiers
  /\b\d+\.\d+\.\d+\b/g, // versions
  /\b\d+ (passed|failed|errors?|warnings?)\b/gi, // test counts
  /error[:\s][^\n]{0,200}/gi, // error messages
  /do not [^\n.]{0,200}|never [^\n.]{0,200}|must not [^\n.]{0,200}|required[^\n.]{0,200}/gi, // constraints
];

function extractPreserved(content) {
  const text = String(content || '');
  const kept = [];
  for (const re of PRESERVE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null && kept.length < 40) {
      kept.push(m[0].trim());
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return [...new Set(kept)].slice(0, 40);
}

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

// Deterministic compression: keeps preserved spans verbatim, then fills with
// highest query-overlap sentences until the token target is met. Returns real
// smaller content (or method 'none' when already within budget).
function compressContent(content, opts = {}) {
  const text = String(content || '');
  const originalTokens = estimateTokensFor(text);
  const targetTokens = Math.max(16, Number(opts.targetTokens) || Math.floor(originalTokens * 0.4));
  const query = opts.query || opts.taskText || '';
  if (originalTokens <= targetTokens) {
    return {
      originalContent: text, compressedContent: text,
      originalTokens, compressedTokens: originalTokens,
      compressionRatio: 1, method: 'none', confidence: 1,
      informationLossRisk: 0, preserved: extractPreserved(text).length,
    };
  }
  const strategy = opts.strategy || 'structured';
  const preserved = extractPreserved(text);
  const header = preserved.length ? `Key facts preserved verbatim:\n${preserved.map((p) => `- ${p}`).join('\n')}\n\n` : '';
  const headerTokens = estimateTokensFor(header);
  const budget = Math.max(32, targetTokens - headerTokens);

  let body = '';
  if (strategy === 'truncate') {
    body = text.slice(0, Math.max(64, budget * 4));
  } else {
    const sentences = sentencesOf(text);
    const scored = sentences.map((s) => ({ s, overlap: query ? lexicalOverlap(query, s) : 0, len: s.length }));
    scored.sort((a, b) => b.overlap - a.overlap || a.len - b.len);
    const picked = [];
    let used = 0;
    for (const c of scored) {
      const t = estimateTokensFor(c.s);
      if (used + t > budget) continue;
      picked.push(c);
      used += t;
    }
    // Restore original order for readability.
    picked.sort((a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s));
    body = picked.map((p) => p.s).join(' ');
    if (!body) body = text.slice(0, Math.max(64, budget * 4));
  }
  const compressedContent = `${header}${strategy === 'structured' ? 'Summary:\n' : ''}${body}`.slice(0, Math.max(128, targetTokens * 4 + 512));
  const compressedTokens = estimateTokensFor(compressedContent);
  const ratio = originalTokens > 0 ? Math.round((compressedTokens / originalTokens) * 1000) / 1000 : 1;
  return {
    originalContent: text,
    compressedContent,
    originalTokens,
    compressedTokens,
    compressionRatio: ratio,
    method: strategy === 'truncate' ? 'truncate' : 'structured summary',
    confidence: preserved.length ? 0.8 : 0.6,
    informationLossRisk: ratio > 0.8 ? 0.2 : ratio > 0.5 ? 0.4 : 0.6,
    preserved,
  };
}

function compressItem(item, opts = {}) {
  const content = (item.metadata && item.metadata.text) || item.content || `${item.title || ''} ${item.source || ''}`;
  const r = compressContent(content, opts);
  return {
    id: item.id,
    ...r,
    compressionVersion: VERSIONS.compression,
  };
}

// ---------- Fingerprint (§22) ----------

function fingerprintContext(input = {}) {
  // Logical identity, not object identity: item/memory ids are per-run
  // instance allocations (random), so including them would make two runs
  // with the same logical prompt fingerprint differently and cross-run
  // reuse (e.g. semantic cache) could never hit. kind/title/tokens/status
  // carry the logical content; secrets never feed the fingerprint.
  const canon = {
    task: String(input.taskText || input.task || '').slice(0, 2000),
    context: (input.contextItems || []).map((i) => `${i.kind}:${i.title}:${i.tokens}:${i.status || 'KEEP'}`).sort().join('|'),
    memory: (input.memoryItems || []).map((m) => `${m.title || ''}`).sort().join('|'),
    tools: (input.toolSpecs || []).map((t) => (t && t.function && t.function.name) || t.name || String(t)).sort().join('|'),
    policy: input.policy ? JSON.stringify(input.policy).slice(0, 1000) : '',
  };
  // Secrets never feed the fingerprint: only ids/kinds/titles/counts.
  return `ctxfp-${crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16)}`;
}

module.exports = {
  DEFAULT_WEIGHTS,
  KIND_TASK_AFFINITY,
  lexicalOverlap,
  scoreContextItem,
  selectContext,
  buildPromptPlan,
  estimateTokensFor,
  compressContent,
  compressItem,
  extractPreserved,
  fingerprintContext,
};
