'use strict';

const { CacheManager } = require('../interfaces');
const { EventType } = require('../core/types');
// Session 2 semantic cache (additive): L3 near-duplicate reuse with
// similarity + freshness + fingerprint + tool-dependency gates.
const { SemanticCacheIndex } = require('../intelligence/semantic-cache');
// Monetary value is derived from an explicit pricing snapshot via canonical
// economics — this manager never hardcodes dollars per token.
const { cacheValueUsd } = require('../economics/economic-states');

class InMemoryCacheManager extends CacheManager {
  constructor(eventBus = null, options = {}) {
    super();
    this.eventBus = eventBus;
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };
    // Per-run isolation: stats + recent events are namespaced by runId.
    // Global `stats` above is retained for backwards compatibility only.
    this.runStats = new Map();
    this.config = {
      defaultTtl: options.defaultTtl || 3600000,
      maxSize: options.maxSize || 1000,
      ...options
    };
    // L3 semantic index (workspace-scoped reuse). Exact L1 behavior above is
    // untouched; semantic lookup is opt-in via lookupSemantic().
    this.semantic = options.semantic || new SemanticCacheIndex(options.semanticOptions);
    this.intelligence = options.intelligence || null;
  }

  attachIntelligence(store) {
    this.intelligence = store || null;
    // Share the durable semantic index when the learning store is attached so
    // semantic entries survive restarts via intelligence.json.
    if (store && store.semanticCache) this.semantic = store.semanticCache;
    return this;
  }

  // L3 semantic reuse (§21): gated, explainable, never blind. Returns the
  // cached result on hit, plus hit metadata (similarity, freshness, source
  // task, model used, tool dependencies, context fingerprint).
  async storeSemantic(taskText, result, opts = {}) {
    return this.semantic.store({
      taskText,
      result,
      fingerprint: opts.fingerprint || null,
      modelId: opts.modelId || null,
      tools: opts.tools || [],
      workspaceRev: opts.workspaceRev || null,
      tenantId: opts.tenantId || null,
      projectId: opts.projectId || null,
      runId: opts.runId || null,
      // Provenance facts for the reuse hierarchy (additive):
      cachedAt: opts.cachedAt || new Date().toISOString(),
      maxAgeMs: opts.maxAgeMs,
      pureAnswer: opts.pureAnswer === true,
      compatibleModels: Array.isArray(opts.compatibleModels) ? opts.compatibleModels.slice(0, 20) : null,
    });
  }

  async lookupSemantic(query = {}) {
    const res = this.semantic.lookup(query);
    if (this.eventBus && query.runId) {
      this._recordRecent(query.runId, res.hit ? 'cache.hit' : 'cache.miss',
        res.hit
          ? `Semantic reuse (similarity ${res.similarity}, freshness ${res.freshness})`
          : `Semantic miss: ${res.reason}`);
    }
    return res;
  }

  // Namespaced key so concurrent runs never share prompt/response entries.
  scopedKey(runId, key) {
    return runId ? `${runId}:${key}` : key;
  }

  _runStats(runId) {
    if (!runId) return null;
    if (!this.runStats.has(runId)) {
      this.runStats.set(runId, { hits: 0, misses: 0, sets: 0, invalidations: 0, recent: [] });
    }
    return this.runStats.get(runId);
  }

  _recordRecent(runId, type, detail) {
    const rs = this._runStats(runId);
    if (!rs) return;
    rs.recent.unshift({ type, ts: new Date().toISOString(), detail });
    if (rs.recent.length > 20) rs.recent.length = 20;
  }

  // get(key, runId?) — pass the runId to attribute hit/miss to that run.
  async get(key, runId = null) {
    const entry = this.cache.get(key);
    const rs = this._runStats(runId);
    
    if (!entry) {
      this.stats.misses++;
      if (rs) rs.misses++;
      return { hit: false, value: null };
    }
    
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      if (rs) rs.misses++;
      return { hit: false, value: null };
    }
    
    this.stats.hits++;
    if (rs) rs.hits++;
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    
    return { hit: true, value: entry.value, metadata: { cachedAt: entry.cachedAt, accessCount: entry.accessCount } };
  }

  async set(key, value, ttl = this.config.defaultTtl, runId = null) {
    if (this.cache.size >= this.config.maxSize) {
      this._evictOldest();
    }
    
    const now = Date.now();
    this.cache.set(key, {
      value,
      cachedAt: now,
      expiresAt: ttl > 0 ? now + ttl : null,
      lastAccessed: now,
      accessCount: 0,
      runId: runId || null,
    });
    
    this.stats.sets++;
    const rs = this._runStats(runId);
    if (rs) rs.sets++;
    
    return { success: true, key };
  }

  async invalidate(key, runId = null) {
    const deleted = this.cache.delete(key);
    
    if (deleted) {
      this.stats.invalidations++;
      const rs = this._runStats(runId);
      if (rs) {
        rs.invalidations++;
        this._recordRecent(runId, 'cache.invalidated', `Invalidated ${key}`);
      }
      
      if (this.eventBus) {
        this.eventBus.emit(runId || 'system', EventType.CACHE_INVALIDATED, { key, pattern: 'exact' });
      }
    }
    
    return { success: deleted, key };
  }

  async invalidatePrefix(prefix, runId = null) {
    let count = 0;
    
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    
    this.stats.invalidations += count;
    const rs = this._runStats(runId);
    if (rs) {
      rs.invalidations += count;
      if (count > 0) this._recordRecent(runId, 'cache.invalidated', `Invalidated ${count} keys under ${prefix}`);
    }
    
    if (this.eventBus && count > 0) {
      this.eventBus.emit(runId || 'system', EventType.CACHE_INVALIDATED, { prefix, count, pattern: 'prefix' });
    }
    
    return { success: true, count, prefix };
  }

  async getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;
    
    let cachedTokens = 0;
    for (const entry of this.cache.values()) {
      if (typeof entry.value === 'string') {
        cachedTokens += Math.ceil(entry.value.length / 4);
      } else if (entry.value && typeof entry.value === 'object') {
        cachedTokens += Math.ceil(JSON.stringify(entry.value).length / 4);
      }
    }
    
    return {
      hitRate,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      invalidations: this.stats.invalidations,
      size: this.cache.size,
      maxSize: this.config.maxSize,
      cachedTokens,
      state: hitRate > 0.7 ? 'WARM' : hitRate > 0.3 ? 'COOLING' : 'COLD'
    };
  }

  async warmCache(runtimeState, items) {
    let warmed = 0;
    
    for (const item of items) {
      const key = item.key || `ctx:${item.id}`;
      await this.set(this.scopedKey(runtimeState.runId, key), item.value, item.ttl, runtimeState.runId);
      warmed++;
    }
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.CACHE_HIT, {
        detail: `Warmed ${warmed} cache entries`,
        count: warmed
      });
    }
    
    return { warmed };
  }

  // Per-run stats for the snapshot. Falls back to global stats when no runId.
  statsFor(runId) {
    const rs = runId && this.runStats.get(runId);
    const base = rs || this.stats;
    const total = (base.hits || 0) + (base.misses || 0);
    return {
      hits: base.hits || 0,
      misses: base.misses || 0,
      sets: base.sets || 0,
      invalidations: base.invalidations || 0,
      hitRate: total > 0 ? base.hits / total : 0,
      recent: rs ? rs.recent.slice() : [],
    };
  }

  cachedTokensFor(runId) {
    let cachedTokens = 0;
    const prefix = runId ? `${runId}:` : null;
    for (const [key, entry] of this.cache.entries()) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (typeof entry.value === 'string') {
        cachedTokens += Math.ceil(entry.value.length / 4);
      } else if (entry.value && typeof entry.value === 'object') {
        cachedTokens += Math.ceil(JSON.stringify(entry.value).length / 4);
      }
    }
    return cachedTokens;
  }

  // Drop all per-run state for a finished run (bounded memory).
  clearRun(runId) {
    this.runStats.delete(runId);
    const prefix = `${runId}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  // Facts for one exact-cache entry (no dollar math here; monetary value is
  // derived by canonical economics from a pricing snapshot).
  describeEntry(key) {
    const entry = this.cache.get(key);
    if (!entry) return { key, hit: false, providerCallAvoided: false, tokensReused: 0 };
    const nowMs = Date.now();
    const expired = !!(entry.expiresAt && nowMs > entry.expiresAt);
    return {
      key,
      hit: !expired,
      providerCallAvoided: !expired,
      tokensReused: !expired ? estimateTokensOf(entry.value) : 0,
      freshness: entry.expiresAt ? Math.max(0, entry.expiresAt - nowMs) : null,
      cachedAt: entry.cachedAt || null,
      accessCount: entry.accessCount || 0,
      runId: entry.runId || null,
      expired,
    };
  }

  // Reuse hierarchy (safe order, gates enforced at every layer):
  //   L1 local/request exact  -> L2 run/project exact reuse
  //   -> L3 semantic project reuse.
  // query: { key?, runId?, tenantId?, projectId?, taskText?, fingerprint?,
  //          tools?, modelId?, requireSameModel?, requiresPureAnswer?,
  //          workspaceRev? }
  // Never upgrades a gated miss into a hit: tenant/project isolation,
  // fingerprint drift, freshness, model/tool compatibility and the
  // pure-answer constraint are all enforced before reporting hit:true.
  async resolveReuse(query = {}) {
    // L1: exact key in this process (request cache).
    if (query.key) {
      const entry = this.cache.get(query.key);
      if (entry && !(entry.expiresAt && Date.now() > entry.expiresAt)) {
        entry.lastAccessed = Date.now();
        entry.accessCount++;
        this.stats.hits++;
        const rs = this._runStats(query.runId);
        if (rs) rs.hits++;
        return {
          hit: true, layer: 'local_exact', value: entry.value,
          facts: { tokensReused: estimateTokensOf(entry.value), providerCallAvoided: true, freshness: entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : null, similarity: 1, contextFingerprint: null, modelCompatible: true, toolCompatible: true },
        };
      }
    }
    // L2: run/project exact reuse — same key under the run or project scope.
    if (query.key && (query.runId || query.projectId)) {
      const scoped = [query.runId ? `${query.runId}:${query.key}` : null, query.projectId ? `${query.projectId}:${query.key}` : null].filter(Boolean);
      for (const sk of scoped) {
        const entry = this.cache.get(sk);
        if (entry && !(entry.expiresAt && Date.now() > entry.expiresAt)) {
          entry.lastAccessed = Date.now();
          entry.accessCount++;
          this.stats.hits++;
          const rs = this._runStats(query.runId);
          if (rs) rs.hits++;
          return {
            hit: true, layer: 'scoped_exact', value: entry.value,
            facts: { tokensReused: estimateTokensOf(entry.value), providerCallAvoided: true, freshness: entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : null, similarity: 1, contextFingerprint: null, modelCompatible: true, toolCompatible: true },
          };
        }
      }
    }
    // L3: semantic project reuse (all safety gates live in the index plus
    // the model/purity gates applied here).
    if (query.taskText) {
      const res = this.semantic.lookup(query);
      if (!res.hit) {
        this.stats.misses++;
        const rs = this._runStats(query.runId);
        if (rs) rs.misses++;
        return { hit: false, layer: 'semantic', reason: res.reason, facts: { similarity: res.similarity ?? null, freshness: res.freshness ?? null } };
      }
      if (query.requireSameModel && query.modelId && res.modelUsed && res.modelUsed !== query.modelId) {
        this.stats.misses++;
        const rs = this._runStats(query.runId);
        if (rs) rs.misses++;
        return { hit: false, layer: 'semantic', reason: `model incompatibility (cached ${res.modelUsed}, need ${query.modelId})`, facts: { similarity: res.similarity, freshness: res.freshness, modelCompatible: false } };
      }
      const entryPure = res.pureAnswer === true;
      if (query.requiresPureAnswer === true && res.pureAnswer !== true && res.pureAnswer !== undefined) {
        this.stats.misses++;
        const rs = this._runStats(query.runId);
        if (rs) rs.misses++;
        return { hit: false, layer: 'semantic', reason: 'pure-answer constraint: cached entry may depend on tools/context', facts: { similarity: res.similarity, freshness: res.freshness } };
      }
      this.stats.hits++;
      const rs = this._runStats(query.runId);
      if (rs) rs.hits++;
      return {
        hit: true, layer: 'semantic_project', value: res.result,
        facts: {
          tokensReused: estimateTokensOf(res.result), providerCallAvoided: true,
          similarity: res.similarity, freshness: res.freshness,
          contextFingerprint: res.contextFingerprint || null,
          modelCompatible: !query.modelId || !res.modelUsed || res.modelUsed === query.modelId,
          toolCompatible: true, sourceTask: res.sourceTask || null, modelUsed: res.modelUsed || null,
          pureAnswer: entryPure || null,
        },
      };
    }
    this.stats.misses++;
    const rs = this._runStats(query.runId);
    if (rs) rs.misses++;
    return { hit: false, layer: 'none', reason: 'no key or task text' };
  }

  // Monetary value of reused tokens, derived from the caller's pricing
  // snapshot (canonical economics). No pricing -> value 0 labelled unpriced.
  describeValue(reusedTokens, pricing = null) {
    return cacheValueUsd({ reusedTokens, pricing });
  }

  getCacheState(runtimeState, pricing = null) {
    const stats = this.getStatsSync();
    const runId = runtimeState && runtimeState.runId;
    const perRun = runId && this.runStats.get(runId);
    const recent = perRun ? perRun.recent.slice() : [];
    const { valueUsd, basis } = cacheValueUsd({ reusedTokens: stats.cachedTokens, pricing });
    return {
      hitRate: stats.hitRate,
      cachedTokens: stats.cachedTokens,
      uncachedTokens: Math.max(0, (runtimeState.context.currentTokens || 0) - stats.cachedTokens),
      // Wire-compatible dollar field, now derived from the pricing snapshot
      // (or 0 when unpriced) instead of a hardcoded rate.
      savedUsd: valueUsd,
      valueBasis: basis,
      state: stats.state,
      recent,
      facts: {
        hits: this.stats.hits, misses: this.stats.misses,
        providerCallsAvoided: this.stats.hits,
        tokensReused: stats.cachedTokens,
      },
    };
  }

  getStatsSync() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;
    
    let cachedTokens = 0;
    for (const entry of this.cache.values()) {
      if (typeof entry.value === 'string') {
        cachedTokens += Math.ceil(entry.value.length / 4);
      } else if (entry.value && typeof entry.value === 'object') {
        cachedTokens += Math.ceil(JSON.stringify(entry.value).length / 4);
      }
    }
    
    return {
      hitRate,
      cachedTokens,
      state: hitRate > 0.7 ? 'WARM' : hitRate > 0.3 ? 'COOLING' : 'COLD'
    };
  }

  _evictOldest() {
    let oldest = null;
    let oldestKey = null;
    
    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.lastAccessed < oldest.lastAccessed) {
        oldest = entry;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  on(event, handler) {}

  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };
  }
}

function estimateTokensOf(value) {
  try {
    if (typeof value === 'string') return Math.ceil(value.length / 4);
    if (value && typeof value === 'object') return Math.ceil(JSON.stringify(value).length / 4);
  } catch { /* fall through */ }
  return 0;
}

module.exports = {
  InMemoryCacheManager
};
