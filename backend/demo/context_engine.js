'use strict';

/**
 * Context Engine — manages what information enters the model context.
 *
 * Components:
 *   ContextItem       – canonical item stored in runtime state
 *   ContextBuilder    – constructs the actual model input
 *   ContextRanker     – multi-dimensional scoring & tier assignment
 *   ContextBudgetManager – token budget enforcement per model
 *   ContextCompressor – summarisation / dedup / structural compression
 *   ContextGarbageCollector – stale / duplicate / irrelevant detection
 *   ContextManager    – top-level façade used by orchestrator
 */

// ── enums ──────────────────────────────────────────────────────────────────────

const ContextItemType = Object.freeze({
  SYSTEM_INSTRUCTION: 'SYSTEM_INSTRUCTION',
  USER_MESSAGE:       'USER_MESSAGE',
  TOOL_RESULT:        'TOOL_RESULT',
  RETRIEVED_DOCUMENT: 'RETRIEVED_DOCUMENT',
  CODE_FILE:          'CODE_FILE',
  LOG:                'LOG',
  MEMORY:             'MEMORY',
  MODEL_OUTPUT:       'MODEL_OUTPUT',
  TASK_STATE:         'TASK_STATE',
  SUMMARY:            'SUMMARY',
  OTHER:              'OTHER',
});

const ContextItemStatus = Object.freeze({
  KEEP:       'KEEP',
  COMPRESSED: 'COMPRESSED',
  ARCHIVED:   'ARCHIVED',
  REMOVED:    'REMOVED',
});

const ContextTier = Object.freeze({
  MANDATORY:     0,
  HIGH_RELEVANCE: 1,
  SUPPORTING:    2,
  OPTIONAL:      3,
  ARCHIVED:      4,
});

// ── ContextItem ────────────────────────────────────────────────────────────────

let _itemSeq = 0;

class ContextItem {
  constructor({
    id,
    type         = ContextItemType.OTHER,
    source       = '',
    content      = null,
    reference    = null,
    tokenCount   = 0,
    relevanceScore  = 0,
    importanceScore = 0,
    recencyScore    = 0,
    dependencyScore = 0,
    freshness       = 1,
    createdAt    = new Date(),
    lastUsedAt   = new Date(),
    expiresAt    = null,
    sensitivity  = 'public',
    cacheable    = true,
    compressionState = 'none',
    parentId     = null,
    relatedIds   = [],
    taskId       = null,
    sessionId    = null,
    status       = ContextItemStatus.KEEP,
    metadata     = {},
  }) {
    this.id = id || `ctx-${Date.now().toString(36)}-${++_itemSeq}`;
    this.type = type;
    this.source = source;
    this.content = content;
    this.reference = reference;
    this.tokenCount = tokenCount;
    this.relevanceScore = relevanceScore;
    this.importanceScore = importanceScore;
    this.recencyScore = recencyScore;
    this.dependencyScore = dependencyScore;
    this.freshness = freshness;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
    this.expiresAt = expiresAt;
    this.sensitivity = sensitivity;
    this.cacheable = cacheable;
    this.compressionState = compressionState;
    this.parentId = parentId;
    this.relatedIds = relatedIds;
    this.taskId = taskId;
    this.sessionId = sessionId;
    this.status = status;
    this.metadata = metadata;
    this.tier = ContextTier.OPTIONAL;
  }

  computeScore(weights = ContextRanker.DEFAULT_WEIGHTS) {
    return (
      this.relevanceScore  * weights.relevance  +
      this.importanceScore * weights.importance  +
      this.recencyScore    * weights.recency     +
      this.dependencyScore * weights.dependency  +
      this.freshness       * weights.freshness
    );
  }

  use() {
    this.lastUsedAt = new Date();
    this.recencyScore = Math.min(1, this.recencyScore + 0.05);
  }

  isExpired() {
    return this.expiresAt !== null && new Date() > this.expiresAt;
  }
}

// ── ContextBudgetManager ───────────────────────────────────────────────────────

class ContextBudgetManager {
  constructor({
    modelContextLimit = 0,
    systemReservePct  = 0.10,
    outputReservePct  = 0.20,
    safetyMarginPct   = 0.05,
  } = {}) {
    this.modelContextLimit = modelContextLimit;
    this.systemReservePct = systemReservePct;
    this.outputReservePct = outputReservePct;
    this.safetyMarginPct  = safetyMarginPct;
  }

  setModelContextLimit(limit) {
    this.modelContextLimit = limit;
  }

  getSystemReserve()  { return Math.floor(this.modelContextLimit * this.systemReservePct); }
  getOutputReserve()  { return Math.floor(this.modelContextLimit * this.outputReservePct); }
  getSafetyMargin()   { return Math.floor(this.modelContextLimit * this.safetyMarginPct); }

  getInputBudget() {
    if (this.modelContextLimit <= 0) return 0;
    return Math.floor(
      this.modelContextLimit * (1 - this.systemReservePct - this.outputReservePct - this.safetyMarginPct)
    );
  }

  getRemainingBudget(usedTokens) {
    return Math.max(0, this.getInputBudget() - usedTokens);
  }

  wouldExceedBudget(currentTokens, additionalTokens) {
    return currentTokens + additionalTokens > this.getInputBudget();
  }
}

// ── ContextRanker ──────────────────────────────────────────────────────────────

class ContextRanker {
  static DEFAULT_WEIGHTS = Object.freeze({
    relevance:  0.35,
    importance: 0.25,
    recency:    0.15,
    dependency: 0.15,
    freshness:  0.10,
  });

  constructor(weights) {
    this.weights = { ...ContextRanker.DEFAULT_WEIGHTS, ...weights };
    this.costPenaltyPerToken = 0.00005;
    this.duplicationPenalty  = 0.2;
  }

  setWeights(w) { Object.assign(this.weights, w); }

  rank(items) {
    const seen = new Map();
    const scored = items.map(item => {
      let score = item.computeScore(this.weights);
      score -= item.tokenCount * this.costPenaltyPerToken;

      const dedupKey = `${item.source}:${item.type}`;
      if (seen.has(dedupKey)) score -= this.duplicationPenalty;
      else seen.set(dedupKey, true);

      return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  assignTiers(rankedItems) {
    const n = rankedItems.length || 1;
    for (let i = 0; i < rankedItems.length; i++) {
      const pct = i / n;
      if (pct < 0.10)      rankedItems[i].item.tier = ContextTier.MANDATORY;
      else if (pct < 0.30) rankedItems[i].item.tier = ContextTier.HIGH_RELEVANCE;
      else if (pct < 0.60) rankedItems[i].item.tier = ContextTier.SUPPORTING;
      else if (pct < 0.85) rankedItems[i].item.tier = ContextTier.OPTIONAL;
      else                 rankedItems[i].item.tier = ContextTier.ARCHIVED;
    }
  }
}

// ── ContextCompressor ──────────────────────────────────────────────────────────

class ContextCompressor {
  constructor({ summarizationThreshold = 1500, compressionRatio = 0.30 } = {}) {
    this.summarizationThreshold = summarizationThreshold;
    this.compressionRatio = compressionRatio;
  }

  compress(items, budget) {
    let reclaimed = 0;
    const out = [];
    for (const item of items) {
      if (item.tokenCount > this.summarizationThreshold && item.status === ContextItemStatus.KEEP) {
        const summaryTokens = Math.max(50, Math.floor(item.tokenCount * this.compressionRatio));
        const summary = new ContextItem({
          id: `${item.id}-summary`,
          type: ContextItemType.SUMMARY,
          source: `summary of ${item.source}`,
          content: `[Summary of ${item.source}: ${item.tokenCount} tokens → ${summaryTokens} tokens]`,
          tokenCount: summaryTokens,
          relevanceScore: item.relevanceScore * 0.9,
          importanceScore: item.importanceScore,
          recencyScore: item.recencyScore,
          dependencyScore: item.dependencyScore,
          freshness: item.freshness,
          createdAt: item.createdAt,
          lastUsedAt: item.lastUsedAt,
          taskId: item.taskId,
          sessionId: item.sessionId,
          status: ContextItemStatus.KEEP,
          metadata: { ...item.metadata, originalId: item.id, compressed: true },
        });
        item.status = ContextItemStatus.COMPRESSED;
        item.compressionState = 'compressed';
        reclaimed += item.tokenCount - summaryTokens;
        out.push(summary);
      } else {
        out.push(item);
      }
    }
    return { compressedItems: out, reclaimedTokens: reclaimed };
  }

  deduplicate(items) {
    const seen = new Map();
    const unique = [];
    for (const item of items) {
      const hash = `${item.source}:${item.type}:${item.tokenCount}`;
      if (!seen.has(hash)) {
        seen.set(hash, item);
        unique.push(item);
      } else {
        item.status = ContextItemStatus.REMOVED;
        item.compressionState = 'deduplicated';
      }
    }
    return unique;
  }
}

// ── ContextGarbageCollector ────────────────────────────────────────────────────

class ContextGarbageCollector {
  constructor({ stalenessThreshold = 0.15, lowImportanceThreshold = 0.2 } = {}) {
    this.stalenessThreshold = stalenessThreshold;
    this.lowImportanceThreshold = lowImportanceThreshold;
  }

  collect(items) {
    const actions = [];
    for (const item of items) {
      if (item.status === ContextItemStatus.REMOVED) continue;

      if (item.isExpired()) {
        actions.push({ action: 'REMOVE', item, reason: 'expired' });
        continue;
      }
      if (item.relevanceScore < this.stalenessThreshold &&
          item.importanceScore < this.lowImportanceThreshold &&
          item.dependencyScore < 0.2) {
        actions.push({ action: 'ARCHIVE', item, reason: 'low relevance and importance' });
        continue;
      }
      actions.push({ action: 'KEEP', item, reason: 'default' });
    }
    return actions;
  }
}

// ── ContextBuilder ─────────────────────────────────────────────────────────────

class ContextBuilder {
  constructor() {
    this.ranker       = new ContextRanker();
    this.compressor   = new ContextCompressor();
    this.gc           = new ContextGarbageCollector();
    this.budget       = new ContextBudgetManager();
  }

  setModelContextLimit(limit) { this.budget.setModelContextLimit(limit); }

  build(items) {
    const gcActions = this.gc.collect(items);
    for (const a of gcActions) {
      if (a.action === 'REMOVE')  a.item.status = ContextItemStatus.REMOVED;
      if (a.action === 'ARCHIVE') a.item.status = ContextItemStatus.ARCHIVED;
    }

    let active = items.filter(i => i.status !== ContextItemStatus.REMOVED);
    active = this.compressor.deduplicate(active);

    const ranked = this.ranker.rank(active);
    this.ranker.assignTiers(ranked);

    const budget = this.budget.getInputBudget();
    let usedTokens = 0;
    const selected = [];

    for (const { item } of ranked) {
      if (item.tier === ContextTier.MANDATORY || item.status === ContextItemStatus.ARCHIVED) {
        if (item.status !== ContextItemStatus.ARCHIVED) {
          usedTokens += item.tokenCount;
          selected.push(item);
        }
        continue;
      }
      if (usedTokens + item.tokenCount <= budget) {
        usedTokens += item.tokenCount;
        selected.push(item);
      } else if (item.tokenCount > this.compressor.summarizationThreshold) {
        const { compressedItems, reclaimedTokens } = this.compressor.compress([item], budget - usedTokens);
        if (compressedItems.length > 0 && usedTokens + compressedItems[0].tokenCount <= budget) {
          usedTokens += compressedItems[0].tokenCount;
          selected.push(compressedItems[0]);
        }
      }
    }

    const segments = this._segments(selected);

    return { items: selected, usedTokens, windowTokens: this.budget.modelContextLimit, segments };
  }

  _segments(items) {
    const total = items.reduce((s, i) => s + i.tokenCount, 0) || 1;
    const map = {};
    for (const item of items) {
      const key = this._segKey(item.type);
      map[key] = (map[key] || 0) + item.tokenCount;
    }
    return Object.entries(map).map(([key, tokens]) => ({
      key,
      label: this._segLabel(key),
      tokensPct: Math.round((tokens / total) * 100),
    }));
  }

  _segKey(type) {
    if ([ContextItemType.USER_MESSAGE, ContextItemType.MODEL_OUTPUT].includes(type)) return 'conv';
    if (type === ContextItemType.RETRIEVED_DOCUMENT) return 'retr';
    if (type === ContextItemType.MEMORY) return 'mem';
    if (type === ContextItemType.TOOL_RESULT) return 'tool';
    if (type === ContextItemType.SYSTEM_INSTRUCTION) return 'sys';
    return 'other';
  }

  _segLabel(key) {
    const labels = { conv: 'Conversation', retr: 'Retrieved data', mem: 'Memory', tool: 'Tool results', sys: 'System', other: 'Other' };
    return labels[key] || 'Other';
  }
}

// ── ContextManager ─────────────────────────────────────────────────────────────

class ContextManager {
  constructor() {
    this.builder = new ContextBuilder();
    this.items = new Map();
    this.taskItems = new Map();
    this._changeLog = [];
  }

  init(modelContextLimit) {
    this.builder.setModelContextLimit(modelContextLimit);
  }

  addItem(item) {
    if (!(item instanceof ContextItem)) item = new ContextItem(item);
    this.items.set(item.id, item);
    if (item.taskId) {
      if (!this.taskItems.has(item.taskId)) this.taskItems.set(item.taskId, new Set());
      this.taskItems.get(item.taskId).add(item.id);
    }
    this._changeLog.push({ kind: 'added', label: item.title || item.source, ts: new Date().toISOString() });
    return item;
  }

  removeItem(id) {
    const item = this.items.get(id);
    if (!item) return;
    item.status = ContextItemStatus.REMOVED;
    this.items.delete(id);
    if (item.taskId && this.taskItems.has(item.taskId)) {
      this.taskItems.get(item.taskId).delete(id);
    }
    this._changeLog.push({ kind: 'removed', label: item.title || item.source, ts: new Date().toISOString() });
  }

  updateItem(id, patch) {
    const item = this.items.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    this._changeLog.push({ kind: 'updated', label: item.title || item.source, ts: new Date().toISOString() });
    return item;
  }

  getActiveItems() {
    return Array.from(this.items.values()).filter(i =>
      i.status !== ContextItemStatus.REMOVED && !i.isExpired()
    );
  }

  getItemsByTask(taskId) {
    const ids = this.taskItems.get(taskId) || new Set();
    return Array.from(ids).map(id => this.items.get(id)).filter(Boolean);
  }

  buildContext() {
    const active = this.getActiveItems();
    return this.builder.build(active);
  }

  getChanges() { return this._changeLog.slice(-200); }
  clearChanges() { this._changeLog = []; }
}

module.exports = {
  ContextItem,
  ContextItemType,
  ContextItemStatus,
  ContextTier,
  ContextBudgetManager,
  ContextRanker,
  ContextCompressor,
  ContextGarbageCollector,
  ContextBuilder,
  ContextManager,
};
