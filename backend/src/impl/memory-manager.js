'use strict';

const { MemoryManager } = require('../interfaces');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');
// Session 2 memory intelligence (additive): hybrid retrieval, dedup,
// conflict representation. Run isolation + event shapes unchanged.
const memoryIntel = require('../intelligence/memory-intelligence');
const { classifyTask } = require('../intelligence/task-classifier');
const { redactSecrets, classifyMemoryCandidate } = memoryIntel;

class InMemoryMemoryManager extends MemoryManager {
  constructor(eventBus = null, options = {}) {
    super();
    this.eventBus = eventBus;
    this.workingMemory = new Map();
    this.longTermMemory = new Map();
    this.config = {
      maxWorkingItems: options.maxWorkingItems || 50,
      maxLongTermItems: options.maxLongTermItems || 500,
      importanceThreshold: options.importanceThreshold || 0.3,
      retrievalWeights: options.retrievalWeights || null, // null = engine defaults
      duplicateThreshold: options.duplicateThreshold || 0.55,
      ...options
    };
    // Optional Session 2 learning store (IntelligenceStore). Attached by
    // server wiring; retrieval works without it.
    this.intelligence = options.intelligence || null;
  }

  attachIntelligence(store) {
    this.intelligence = store || null;
    return this;
  }

  // Run isolation: items are tagged with the writing run's ID. Reads return the
  // run's own items first, then shared seed knowledge (runId 'shared'/missing).
  // Runs never see each other's working memory. Owner/user isolation is
  // fail-open: it applies only when both the record and the runtime carry an
  // identity (unit/demo runtimes without identities keep historical behavior).
  _visibleItems(store, runtimeOrRunId) {
    const runtime = runtimeOrRunId && typeof runtimeOrRunId === 'object' ? runtimeOrRunId : { runId: runtimeOrRunId };
    const runId = runtime.runId;
    const orgId = runtime.orgId || null;
    const projectId = runtime.projectId || null;
    const userId = runtime.userId || runtime.ownerId || null;
    const items = Array.from(store.values()).filter((item) => item.status === 'active');
    return items.filter((i) => {
      const owner = i.userId || i.ownerId || null;
      if (owner && userId && owner !== userId) return false;
      if (i.runId === runId) return true;
      if (i.runId && i.runId !== 'shared') return i.orgId === orgId && (!projectId || !i.projectId || i.projectId === projectId);
      return !i.orgId || !orgId || i.orgId === orgId;
    })
      .sort((a, b) => {
        const aOwn = a.runId === runId ? 0 : 1;
        const bOwn = b.runId === runId ? 0 : 1;
        if (aOwn !== bOwn) return aOwn - bOwn;
        return (b.importance * b.confidence) - (a.importance * a.confidence);
      });
  }

  _rankByQuery(items, query, opts = {}) {
    if (!query) return items;
    // Hybrid retrieval (§18): lexical + task relevance + confidence +
    // importance + recency. Own-run-first isolation is applied by callers
    // before ranking (interleaved deterministically below).
    let taskCategory = opts.taskCategory || null;
    try {
      if (!taskCategory && opts.taskText) taskCategory = classifyTask(opts.taskText).category;
    } catch { /* advisory */ }
    const ranked = memoryIntel.rankMemories(items, query, {
      taskCategory,
      weights: this.config.retrievalWeights || undefined,
      limit: items.length || 10,
    });
    const byId = new Map(ranked.map((r) => [r.memory.id, r]));
    // Stable, explainable order: hybrid score desc, own-run first on ties.
    // Conflicted records are demoted (×0.7): contradictory memories stay
    // visible but never outrank their uncontested peers.
    return items
      .map((item) => ({ item, r: byId.get(item.id) }))
      .filter((x) => x.r && x.r.s.score > 0)
      .map((x) => {
        const conflicted = !!(x.item.conflictWith || x.item.conflict);
        const score = conflicted ? Math.round(x.r.s.score * 0.7 * 1000) / 1000 : x.r.s.score;
        return { ...x, score, conflicted };
      })
      .sort((a, b) => b.score - a.score
        || ((b.item.runId === opts.runId ? 1 : 0) - (a.item.runId === opts.runId ? 1 : 0))
        || String(a.item.id).localeCompare(String(b.item.id)))
      .map((x) => {
        x.item._retrievalScore = x.score;
        x.item._retrievalExplanation = x.r.s.explanation + (x.conflicted ? ' + demoted: contradicted by another record' : '');
        x.item._conflicted = x.conflicted;
        return x.item;
      });
  }

  _queryOpts(runtimeState, query) {
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    return { runId: runtimeState.runId, taskText: `${taskText} ${query || ''}`.trim() };
  }

  async readWorkingMemory(runtimeState, query, limit = 10) {
    runtimeState.memory.recordRead();
    
    const items = this._rankByQuery(this._visibleItems(this.workingMemory, runtimeState), query, this._queryOpts(runtimeState, query));
    
    const result = items.slice(0, limit);
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_READ, {
        scope: 'working',
        query,
        count: result.length
      });
    }
    
    return result;
  }

  async readLongTermMemory(runtimeState, query, limit = 10) {
    runtimeState.memory.recordRead();
    
    const items = this._rankByQuery(this._visibleItems(this.longTermMemory, runtimeState), query, this._queryOpts(runtimeState, query));
    
    const result = items.slice(0, limit);
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_READ, {
        scope: 'longterm',
        query,
        count: result.length
      });
    }
    
    return result;
  }

  // Store a full MemoryRecord (§17) while staying wire-compatible with the
  // CONTRACTS MemoryItem shape (superset, never a breaking change).
  _toRecord(item, scope, runId, runtimeState = null) {
    const base = memoryIntel.createMemoryRecord({
      ...item, scope, sourceRunId: runId, runId,
      orgId: runtimeState?.orgId || item.orgId || null,
      projectId: runtimeState?.projectId || item.projectId || null,
    });
    // Preserve the run-isolation tag the readers filter on.
    base.runId = item.runId || runId;
    // Keep legacy field names for existing consumers.
    return base;
  }

  async writeWorkingMemory(runtimeState, item) {
    runtimeState.memory.recordWrite();

    // Snippets are safe for display by construction: secrets redacted first.
    const clean = this._sanitizeInput(item);
    const classification = classifyMemoryCandidate({ ...clean, source: item.source });
    const memoryItem = this._toRecord({ ...clean, confidence: clean.confidence ?? classification.confidence }, 'working', runtimeState.runId, runtimeState);
    // Legacy-compatible aliases:
    memoryItem.title = clean.title;
    memoryItem.snippet = clean.snippet;
    memoryItem.candidateKind = classification.kind;
    memoryItem.candidateConfidence = classification.confidence;
    
    this.workingMemory.set(memoryItem.id, memoryItem);
    
    if (this.workingMemory.size > this.config.maxWorkingItems) {
      await this._evictOldestWorking();
    }
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
        scope: 'working',
        itemId: memoryItem.id,
        title: memoryItem.title
      });
    }
    
    return memoryItem;
  }

  // Candidate-memory flow (explicit and trustworthy):
  //   propose -> classify -> confidence -> policy/visibility -> persist.
  // Returns { action, record, classification, reasons } without persisting.
  // Actions: persist_working | persist_longterm | quarantine | reject.
  proposeMemory(runtimeState, item, opts = {}) {
    const target = opts.target === 'working' ? 'working' : 'longterm';
    const clean = this._sanitizeInput(item || {});
    if (!clean.title && !clean.snippet) {
      return { action: 'reject', record: null, classification: null, reasons: ['empty candidate: no title or snippet'] };
    }
    const explicit = opts.explicit === true || item.durable === true || item.candidateApproved === true;
    const classification = classifyMemoryCandidate({ ...clean, source: item.source, explicit });
    const reasons = [...classification.reasons];
    const policy = (runtimeState && runtimeState.policy) || {};
    // A direct call to the long-term API is an explicit persist intent and is
    // honored — EXCEPT for unvetted model/system output, secret-bearing
    // content, or an explicit policy ban. Those quarantine to working memory
    // until approved, so keyword-like model output can never silently become
    // durable project memory.
    if (target === 'longterm' && !explicit) {
      if (policy.allowDurableMemory === false) {
        reasons.push('policy forbids durable writes (allowDurableMemory=false); quarantined to working memory');
        return { action: 'quarantine', record: null, classification, reasons, sanitized: clean };
      }
      if (classification.kind === 'secret_or_unsafe') {
        reasons.push('secret-bearing candidate quarantined (redacted) until explicitly approved');
        return { action: 'quarantine', record: null, classification, reasons, sanitized: clean };
      }
      if (classification.kind === 'unvetted_model_output') {
        reasons.push('unvetted model output quarantined to working memory until approved');
        return { action: 'quarantine', record: null, classification, reasons, sanitized: clean };
      }
    }
    return { action: target === 'working' ? 'persist_working' : 'persist_longterm', record: null, classification, reasons, sanitized: clean };
  }

  // Promote a quarantined/working candidate to long-term memory after human
  // or policy approval. The approval itself is recorded as provenance.
  async approveMemoryCandidate(runtimeState, item, opts = {}) {
    const approved = { ...(item || {}), candidateApproved: true, approvedBy: opts.approvedBy || 'operator', approvedAt: new Date().toISOString() };
    return this.writeLongTermMemory(runtimeState, approved, { explicit: true });
  }

  _sanitizeInput(item) {
    const clean = { ...(item || {}) };
    if (typeof clean.title === 'string') clean.title = redactSecrets(clean.title).slice(0, 300);
    if (typeof clean.snippet === 'string') clean.snippet = redactSecrets(clean.snippet).slice(0, 2000);
    if (typeof clean.content === 'string') clean.content = redactSecrets(clean.content).slice(0, 4000);
    return clean;
  }

  async writeLongTermMemory(runtimeState, item, opts = {}) {
    runtimeState.memory.recordWrite();

    // Keyword-like model output never becomes durable automatically: without
    // an explicit durability signal it quarantines to working memory.
    const proposal = this.proposeMemory(runtimeState, item, {
      target: 'longterm',
      explicit: (opts && opts.explicit === true) || item.durable === true || item.candidateApproved === true,
    });
    if (proposal.action === 'reject') {
      throw Object.assign(new Error('memory candidate rejected: empty title and snippet'), { code: 'empty_memory' });
    }
    if (proposal.action === 'quarantine') {
      const quarantined = this._toRecord(
        { ...proposal.sanitized, confidence: Math.min(Number(item.confidence ?? 0.5), proposal.classification.confidence) },
        'working', runtimeState.runId, runtimeState,
      );
      quarantined.title = proposal.sanitized.title;
      quarantined.snippet = proposal.sanitized.snippet;
      quarantined.quarantined = true;
      quarantined.quarantinedFrom = 'longterm';
      quarantined.quarantineReasons = proposal.reasons;
      quarantined.candidateKind = proposal.classification.kind;
      quarantined.candidateConfidence = proposal.classification.confidence;
      this.workingMemory.set(quarantined.id, quarantined);
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
          scope: 'working',
          itemId: quarantined.id,
          title: quarantined.title,
          quarantined: true,
          candidateKind: proposal.classification.kind,
        });
      }
      return quarantined;
    }

    const clean = proposal.sanitized;
    const memoryItem = this._toRecord({ ...clean, confidence: clean.confidence ?? proposal.classification.confidence }, 'longterm', runtimeState.runId, runtimeState);
    memoryItem.title = clean.title;
    memoryItem.snippet = clean.snippet;
    memoryItem.candidateKind = proposal.classification.kind;
    memoryItem.candidateConfidence = proposal.classification.confidence;
    
    this.longTermMemory.set(memoryItem.id, memoryItem);
    
    if (this.longTermMemory.size > this.config.maxLongTermItems) {
      await this._evictOldestLongTerm();
    }
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
        scope: 'longterm',
        itemId: memoryItem.id,
        title: memoryItem.title
      });
    }
    
    return memoryItem;
  }

  async evictMemory(runtimeState, itemId, scope) {
    const store = scope === 'working' ? this.workingMemory : this.longTermMemory;
    const item = store.get(itemId);
    
    if (item) {
      item.status = 'evicted';
      item.lastUsedAt = now();
      
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.MEMORY_EVICTED, {
          scope,
          itemId,
          title: item.title
        });
      }
      
      return true;
    }
    
    return false;
  }

  async searchMemory(runtimeState, query, scopes = ['working', 'longterm'], limit = 20) {
    const results = [];
    
    if (scopes.includes('working')) {
      const working = await this.readWorkingMemory(runtimeState, query, limit);
      results.push(...working.map(i => ({ ...i, scope: 'working' })));
    }
    
    if (scopes.includes('longterm')) {
      const longterm = await this.readLongTermMemory(runtimeState, query, limit);
      results.push(...longterm.map(i => ({ ...i, scope: 'longterm' })));
    }
    
    results.sort((a, b) => {
      // Query relevance actually affects ranking (§18 acceptance): hybrid
      // score first, static importance*confidence only as tie-break.
      const sa = Number.isFinite(Number(a._retrievalScore)) ? Number(a._retrievalScore) : (a.importance * a.confidence);
      const sb = Number.isFinite(Number(b._retrievalScore)) ? Number(b._retrievalScore) : (b.importance * b.confidence);
      return sb - sa || (b.importance * b.confidence) - (a.importance * a.confidence);
    });

    return results.slice(0, limit);
  }

  // Consolidation path (§19): candidate -> similar detection -> merge /
  // supersede / reject -> canonical memory. Returns a describe object; the
  // caller decides persistence. Never silently overwrites contradictions.
  consolidate(memory, candidates) {
    const candidate = memoryIntel.createMemoryRecord(memory);
    return memoryIntel.consolidateCandidate(candidate, candidates || [], {
      duplicateThreshold: this.config.duplicateThreshold,
    });
  }

  // Write-through consolidation for long-term memory: duplicates merge into
  // the canonical record (provenance kept), contradictions are BOTH retained
  // with a conflict descriptor attached to the new record.
  async writeLongTermConsolidated(runtimeState, item) {
    const existing = this._visibleItems(this.longTermMemory, runtimeState);
    const decision = this.consolidate({ ...item, scope: 'longterm' }, existing);
    if (decision.action === 'merge' && decision.target) {
      Object.assign(decision.target, decision.merged);
      decision.target.lastUsedAt = now();
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
          scope: 'longterm', itemId: decision.target.id, title: decision.target.title,
          consolidated: true, similarity: decision.similarity,
        });
      }
      return { record: decision.target, action: 'merge', similarity: decision.similarity };
    }
    const written = await this.writeLongTermMemory(runtimeState, item);
    if (decision.action === 'conflict' && decision.target) {
      written.conflictWith = decision.target.id;
      written.conflict = memoryIntel.describeConflict(written, decision.target);
    }
    return { record: written, action: decision.action === 'conflict' ? 'conflict' : 'create', similarity: decision.similarity || 0 };
  }

  // Conflicts visible to a run (§20): pairs of active, contradictory records.
  listConflicts(runtimeState) {
    const all = [
      ...this._visibleItems(this.workingMemory, runtimeState),
      ...this._visibleItems(this.longTermMemory, runtimeState),
    ];
    const conflicts = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (memoryIntel.similarity(all[i], all[j]) >= 0.35 && memoryIntel.isContradiction(all[i], all[j])) {
          conflicts.push(memoryIntel.describeConflict(all[i], all[j]));
        }
      }
    }
    return conflicts;
  }

  // Explainable retrieval for the frontend memory panel.
  explainRetrieval(runtimeState, query, scopes = ['working', 'longterm'], limit = 10) {
    const all = [];
    if (scopes.includes('working')) all.push(...this._visibleItems(this.workingMemory, runtimeState));
    if (scopes.includes('longterm')) all.push(...this._visibleItems(this.longTermMemory, runtimeState));
    let taskCategory = null;
    try {
      taskCategory = classifyTask((runtimeState.task && runtimeState.task.objective) || '').category;
    } catch { /* advisory */ }
    return memoryIntel.rankMemories(all, query, {
      taskCategory, weights: this.config.retrievalWeights || undefined, limit,
    }).map((r) => ({
      id: r.memory.id, scope: r.memory.scope, title: r.memory.title,
      score: r.s.score, components: r.s.components, explanation: r.s.explanation,
      conflicted: !!(r.memory.conflictWith || r.memory.conflict),
      projectId: r.memory.projectId || null,
    }));
  }

  getMemoryState(runtimeState) {
    return {
      working: this._visibleItems(this.workingMemory, runtimeState),
      longterm: this._visibleItems(this.longTermMemory, runtimeState)
    };
  }

  async _evictOldestWorking() {
    let oldest = null;
    for (const item of this.workingMemory.values()) {
      if (item.status === 'active' && (!oldest || item.lastUsedAt < oldest.lastUsedAt)) {
        oldest = item;
      }
    }
    if (oldest) {
      oldest.status = 'evicted';
    }
  }

  async _evictOldestLongTerm() {
    let oldest = null;
    for (const item of this.longTermMemory.values()) {
      if (item.status === 'active' && (!oldest || item.lastUsedAt < oldest.lastUsedAt)) {
        oldest = item;
      }
    }
    if (oldest) {
      oldest.status = 'archived';
    }
  }

  // Full dump for the /api/memory listing (redacted snippets only upstream).
  dumpAll() {
    return {
      working: Array.from(this.workingMemory.values()),
      longterm: Array.from(this.longTermMemory.values()),
    };
  }

  purgeRun(runId) {
    if (!runId) return 0;
    let removed = 0;
    for (const collection of [this.workingMemory, this.longTermMemory]) {
      for (const [id, item] of collection.entries()) {
        if (item && (item.runId === runId || item.sourceRunId === runId)) {
          collection.delete(id);
          removed++;
        }
      }
    }
    return removed;
  }

  on(event, handler) {}

  seedMemory(working = [], longterm = []) {
    for (const item of working) {
      this.workingMemory.set(item.id, { ...item, scope: 'working', status: 'active', runId: item.runId || 'shared' });
    }
    for (const item of longterm) {
      this.longTermMemory.set(item.id, { ...item, scope: 'longterm', status: 'active', runId: item.runId || 'shared' });
    }
  }
}

module.exports = {
  InMemoryMemoryManager
};
