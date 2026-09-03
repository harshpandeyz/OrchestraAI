'use strict';

/**
 * Memory Engine — manages working memory and long-term memory.
 *
 * Components:
 *   MemoryItem               – canonical memory record
 *   MemoryImportanceScorer   – multi-factor importance scoring
 *   WorkingMemoryManager     – short-lived, bounded task memory
 *   LongTermMemoryManager    – persisted knowledge store
 *   MemoryRetriever          – relevance-based retrieval
 *   MemoryWriter             – scope-aware writes + promotions
 *   MemoryManager            – top-level façade
 */

// ── enums ──────────────────────────────────────────────────────────────────────

const MemoryScope = Object.freeze({ WORKING: 'working', LONGTERM: 'longterm' });
const MemoryStatus = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived', EVICTED: 'evicted' });

// ── MemoryItem ─────────────────────────────────────────────────────────────────

let _memSeq = 0;

class MemoryItem {
  constructor({
    id,
    scope      = MemoryScope.WORKING,
    title      = '',
    snippet    = '',
    source     = '',
    createdAt  = new Date(),
    lastUsedAt = new Date(),
    importance = 0.5,
    confidence = 0.5,
    status     = MemoryStatus.ACTIVE,
    taskId     = null,
    sessionId  = null,
    metadata   = {},
  }) {
    this.id = id || `mem-${Date.now().toString(36)}-${++_memSeq}`;
    this.scope = scope;
    this.title = title;
    this.snippet = snippet;
    this.source = source;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
    this.importance = importance;
    this.confidence = confidence;
    this.status = status;
    this.taskId = taskId;
    this.sessionId = sessionId;
    this.metadata = metadata;
  }

  isActive() { return this.status === MemoryStatus.ACTIVE; }
  archive()  { this.status = MemoryStatus.ARCHIVED; }
  evict()    { this.status = MemoryStatus.EVICTED; }

  use() {
    this.lastUsedAt = new Date();
    this.importance = Math.min(1, this.importance + 0.02);
    this.metadata.useCount = (this.metadata.useCount || 0) + 1;
  }
}

// ── MemoryImportanceScorer ─────────────────────────────────────────────────────

class MemoryImportanceScorer {
  constructor(weights = {}) {
    this.weights = {
      recency:          0.20,
      frequency:        0.25,
      sourceReliability: 0.20,
      userExplicit:     0.35,
      ...weights,
    };
  }

  score(memory, _ctx = {}) {
    const ageDays = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
    const recencyScore = Math.max(0, 1 - ageDays / 30);

    const useCount = memory.metadata.useCount || 0;
    const frequencyScore = Math.min(1, useCount / 10);

    const sourceReliability = memory.metadata.sourceReliability || 0.5;
    const userExplicit = memory.metadata.userExplicit || memory.importance;

    return Math.min(1,
      recencyScore      * this.weights.recency +
      frequencyScore    * this.weights.frequency +
      sourceReliability * this.weights.sourceReliability +
      userExplicit      * this.weights.userExplicit
    );
  }
}

// ── WorkingMemoryManager ───────────────────────────────────────────────────────

class WorkingMemoryManager {
  constructor(maxItems = 50) {
    this.memories = new Map();
    this.maxItems = maxItems;
    this.scorer = new MemoryImportanceScorer();
    this._evictionLog = [];
  }

  add(memory) {
    if (!(memory instanceof MemoryItem)) {
      memory = new MemoryItem({ ...memory, scope: MemoryScope.WORKING });
    }
    if (this.memories.size >= this.maxItems) this._evictLowest();
    this.memories.set(memory.id, memory);
    return memory;
  }

  get(id) { return this.memories.get(id) || null; }

  list() { return Array.from(this.memories.values()).filter(m => m.isActive()); }

  remove(id) {
    const m = this.memories.get(id);
    if (m) {
      m.evict();
      this.memories.delete(id);
      this._evictionLog.push({ id, ts: new Date().toISOString() });
    }
  }

  _evictLowest() {
    let lowest = null, lowestScore = Infinity;
    for (const m of this.memories.values()) {
      const s = this.scorer.score(m);
      if (s < lowestScore) { lowestScore = s; lowest = m; }
    }
    if (lowest) this.remove(lowest.id);
  }

  getEvictions() { return this._evictionLog.slice(-50); }
  clear() { this.memories.clear(); }
}

// ── LongTermMemoryManager ──────────────────────────────────────────────────────

class LongTermMemoryManager {
  constructor() {
    this.memories = new Map();
    this.scorer = new MemoryImportanceScorer();
  }

  add(memory) {
    if (!(memory instanceof MemoryItem)) {
      memory = new MemoryItem({ ...memory, scope: MemoryScope.LONGTERM });
    }
    this.memories.set(memory.id, memory);
    return memory;
  }

  get(id) { return this.memories.get(id) || null; }

  list(filter = {}) {
    let items = Array.from(this.memories.values());
    if (filter.status) items = items.filter(m => m.status === filter.status);
    if (filter.minImportance !== undefined) items = items.filter(m => m.importance >= filter.minImportance);
    return items;
  }

  archive(id) { const m = this.memories.get(id); if (m) m.archive(); }
  evict(id) { const m = this.memories.get(id); if (m) { m.evict(); this.memories.delete(id); } }

  search(query) {
    const q = query.toLowerCase();
    return Array.from(this.memories.values()).filter(m =>
      m.title.toLowerCase().includes(q) ||
      m.snippet.toLowerCase().includes(q) ||
      m.source.toLowerCase().includes(q)
    );
  }
}

// ── MemoryRetriever ────────────────────────────────────────────────────────────

class MemoryRetriever {
  constructor(workingMemory, longTermMemory) {
    this.working = workingMemory;
    this.longterm = longTermMemory;
    this.scorer = new MemoryImportanceScorer();
  }

  retrieve(query, { maxItems = 10, minImportance = 0.2, scopes } = {}) {
    const results = [];
    const includeWorking = !scopes || scopes.includes(MemoryScope.WORKING);
    const includeLongterm = !scopes || scopes.includes(MemoryScope.LONGTERM);

    if (includeWorking) {
      for (const m of this.working.list()) {
        const score = this.scorer.score(m);
        if (score >= minImportance) results.push({ memory: m, scope: MemoryScope.WORKING, score });
      }
    }

    if (includeLongterm) {
      const matches = query ? this.longterm.search(query) : this.longterm.list();
      for (const m of matches) {
        const score = this.scorer.score(m);
        if (score >= minImportance) results.push({ memory: m, scope: MemoryScope.LONGTERM, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxItems);
  }
}

// ── MemoryWriter ───────────────────────────────────────────────────────────────

class MemoryWriter {
  constructor(workingMemory, longTermMemory) {
    this.working = workingMemory;
    this.longterm = longTermMemory;
    this._writeLog = [];
  }

  write(data, scope = MemoryScope.WORKING) {
    const memory = data instanceof MemoryItem ? data : new MemoryItem({ ...data, scope });
    const target = scope === MemoryScope.WORKING ? this.working : this.longterm;
    const result = target.add(memory);
    this._writeLog.push({ id: result.id, scope, ts: new Date().toISOString() });
    return result;
  }

  promote(id) {
    const m = this.working.get(id);
    if (!m) return null;
    m.scope = MemoryScope.LONGTERM;
    this.working.remove(id);
    return this.longterm.add(m);
  }

  getWriteLog() { return this._writeLog.slice(-100); }
}

// ── MemoryManager ──────────────────────────────────────────────────────────────

class MemoryManager {
  constructor() {
    this.workingMemory = new WorkingMemoryManager();
    this.longTermMemory = new LongTermMemoryManager();
    this.retriever = new MemoryRetriever(this.workingMemory, this.longTermMemory);
    this.writer = new MemoryWriter(this.workingMemory, this.longTermMemory);
    this.scorer = new MemoryImportanceScorer();
  }

  addToWorking(data) { return this.writer.write(data, MemoryScope.WORKING); }
  addToLongTerm(data) { return this.writer.write(data, MemoryScope.LONGTERM); }

  retrieve(query, opts) { return this.retriever.retrieve(query, opts); }

  getWorkingMemories() { return this.workingMemory.list(); }
  getLongTermMemories() { return this.longTermMemory.list(); }
  searchLongTerm(q) { return this.longTermMemory.search(q); }

  archiveLongTerm(id) { this.longTermMemory.archive(id); }
  evict(scope, id) {
    if (scope === MemoryScope.WORKING) this.workingMemory.remove(id);
    else this.longTermMemory.evict(id);
  }

  scoreImportance(m) { return this.scorer.score(m); }

  getEvictions() { return this.workingMemory.getEvictions(); }
  getWriteLog()  { return this.writer.getWriteLog(); }
}

module.exports = {
  MemoryItem, MemoryScope, MemoryStatus,
  MemoryImportanceScorer,
  WorkingMemoryManager, LongTermMemoryManager,
  MemoryRetriever, MemoryWriter, MemoryManager,
};
