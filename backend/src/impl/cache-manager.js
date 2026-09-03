'use strict';

const { CacheManager } = require('../interfaces');
const { EventType } = require('../core/types');

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

  getCacheState(runtimeState) {
    const stats = this.getStatsSync();
    return {
      hitRate: stats.hitRate,
      cachedTokens: stats.cachedTokens,
      uncachedTokens: runtimeState.context.currentTokens - stats.cachedTokens,
      savedUsd: stats.cachedTokens * 0.0000002,
      state: stats.state,
      recent: []
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

module.exports = {
  InMemoryCacheManager
};