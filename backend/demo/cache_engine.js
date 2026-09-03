'use strict';

/**
 * Cache Engine — manages prompt cache and semantic/result cache.
 *
 * Components:
 *   CacheEntry              – single cached item
 *   CacheKeyManager         – deterministic key generation
 *   PromptCacheManager      – provider-level prompt reuse
 *   SemanticCacheManager    – similarity-based result reuse
 *   CacheInvalidationManager – targeted / bulk invalidation
 *   CacheCostEstimator      – USD savings estimation
 *   CacheManager            – top-level façade
 */

// ── enums ──────────────────────────────────────────────────────────────────────

const CacheState = Object.freeze({ WARM: 'WARM', COLD: 'COLD', COOLING: 'COOLING' });
const CacheType  = Object.freeze({ PROMPT: 'prompt', SEMANTIC: 'semantic', RESULT: 'result' });

// ── CacheEntry ─────────────────────────────────────────────────────────────────

let _cacheSeq = 0;

class CacheEntry {
  constructor({
    id, type = CacheType.PROMPT, key = '', content = null,
    tokenCount = 0, costSaved = 0,
    createdAt = new Date(), lastUsedAt = new Date(), expiresAt = null,
    hitCount = 0, metadata = {},
  }) {
    this.id = id || `cache-${Date.now().toString(36)}-${++_cacheSeq}`;
    this.type = type;
    this.key = key;
    this.content = content;
    this.tokenCount = tokenCount;
    this.costSaved = costSaved;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
    this.expiresAt = expiresAt;
    this.hitCount = hitCount;
    this.metadata = metadata;
  }

  isExpired() { return this.expiresAt !== null && new Date() > this.expiresAt; }
  hit() { this.hitCount++; this.lastUsedAt = new Date(); }
}

// ── CacheKeyManager ────────────────────────────────────────────────────────────

class CacheKeyManager {
  constructor(sep = '::') { this.sep = sep; }

  generate(...parts) { return parts.join(this.sep); }

  promptKey(systemPrompt, userMessage, modelId) {
    return this.generate('prompt', modelId, this._hash(systemPrompt), this._hash(userMessage));
  }

  semanticKey(query, context = '') {
    return this.generate('semantic', this._normalize(query), this._hash(context));
  }

  resultKey(operation, inputs) {
    return this.generate('result', operation, this._hash(JSON.stringify(inputs)));
  }

  _hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return h.toString(36);
  }

  _normalize(s) { return s.toLowerCase().trim().replace(/\s+/g, ' '); }
}

// ── PromptCacheManager ─────────────────────────────────────────────────────────

class PromptCacheManager {
  constructor() {
    this.entries = new Map();
    this.keyManager = new CacheKeyManager();
    this._hitLog = [];
  }

  store(systemPrompt, userMessage, modelId, response, tokenCount) {
    const key = this.keyManager.promptKey(systemPrompt, userMessage, modelId);
    const entry = new CacheEntry({
      type: CacheType.PROMPT, key,
      content: { systemPrompt, userMessage, response },
      tokenCount,
      metadata: { modelId },
    });
    this.entries.set(key, entry);
    return entry;
  }

  retrieve(systemPrompt, userMessage, modelId) {
    const key = this.keyManager.promptKey(systemPrompt, userMessage, modelId);
    const entry = this.entries.get(key);
    if (entry && !entry.isExpired()) {
      entry.hit();
      this._hitLog.push({ key, ts: new Date().toISOString(), hit: true });
      return entry;
    }
    this._hitLog.push({ key, ts: new Date().toISOString(), hit: false });
    return null;
  }

  getHitRate() {
    const n = this._hitLog.length;
    if (n === 0) return 0;
    return this._hitLog.filter(h => h.hit).length / n;
  }

  getCachedTokens() {
    return Array.from(this.entries.values()).reduce((s, e) => s + e.tokenCount, 0);
  }

  getRecentHits(limit = 10) { return this._hitLog.slice(-limit); }
}

// ── SemanticCacheManager ───────────────────────────────────────────────────────

class SemanticCacheManager {
  constructor() {
    this.entries = new Map();
    this.keyManager = new CacheKeyManager();
    this._hitLog = [];
  }

  store(query, context, result, tokenCount, costSaved = 0) {
    const key = this.keyManager.semanticKey(query, context);
    const entry = new CacheEntry({
      type: CacheType.SEMANTIC, key,
      content: { query, context, result },
      tokenCount, costSaved,
    });
    this.entries.set(key, entry);
    return entry;
  }

  retrieve(query, context = '') {
    const norm = query.toLowerCase().trim();
    for (const entry of this.entries.values()) {
      if (entry.isExpired()) continue;
      const stored = entry.content.query.toLowerCase().trim();
      if (stored.includes(norm) || norm.includes(stored)) {
        entry.hit();
        this._hitLog.push({ key: entry.key, ts: new Date().toISOString(), hit: true });
        return entry;
      }
    }
    this._hitLog.push({ key: this.keyManager.semanticKey(query, context), ts: new Date().toISOString(), hit: false });
    return null;
  }

  getHitRate() {
    const n = this._hitLog.length;
    if (n === 0) return 0;
    return this._hitLog.filter(h => h.hit).length / n;
  }

  getRecentHits(limit = 10) { return this._hitLog.slice(-limit); }

  getCachedTokens() {
    return Array.from(this.entries.values()).reduce((s, e) => s + e.tokenCount, 0);
  }
}

// ── CacheInvalidationManager ───────────────────────────────────────────────────

class CacheInvalidationManager {
  constructor(promptCache, semanticCache) {
    this.prompt = promptCache;
    this.semantic = semanticCache;
    this._invalidationLog = [];
  }

  invalidateByKey(key) {
    const had1 = this.prompt.entries.delete(key);
    const had2 = this.semantic.entries.delete(key);
    if (had1 || had2) this._log('key', key);
  }

  invalidateByModel(modelId) {
    let count = 0;
    for (const [key, entry] of this.prompt.entries) {
      if (entry.metadata.modelId === modelId) { this.prompt.entries.delete(key); count++; }
    }
    if (count) this._log('model', modelId, count);
  }

  invalidateByPrefix(prefix) {
    let count = 0;
    for (const key of this.prompt.entries.keys()) {
      if (key.startsWith(prefix)) { this.prompt.entries.delete(key); count++; }
    }
    for (const key of this.semantic.entries.keys()) {
      if (key.startsWith(prefix)) { this.semantic.entries.delete(key); count++; }
    }
    if (count) this._log('prefix', prefix, count);
  }

  invalidateExpired() {
    let count = 0;
    for (const [k, e] of this.prompt.entries)  { if (e.isExpired()) { this.prompt.entries.delete(k); count++; } }
    for (const [k, e] of this.semantic.entries) { if (e.isExpired()) { this.semantic.entries.delete(k); count++; } }
    if (count) this._log('expired', '', count);
  }

  clearAll() {
    this.prompt.entries.clear();
    this.semantic.entries.clear();
    this._log('clear', '', 0);
  }

  _log(scope, target, count) {
    this._invalidationLog.push({ scope, target, count, ts: new Date().toISOString() });
    if (this._invalidationLog.length > 200) this._invalidationLog.shift();
  }

  getLog(limit = 20) { return this._invalidationLog.slice(-limit); }
}

// ── CacheCostEstimator ─────────────────────────────────────────────────────────

class CacheCostEstimator {
  constructor() {
    this.defaultCachedCostPer1k   = 0.0002;
    this.defaultUncachedCostPer1k = 0.0009;
  }

  estimateSavings(cachedTokens, pricing = null) {
    const cached   = pricing?.cachedPer1k   || this.defaultCachedCostPer1k;
    const uncached = pricing?.inputPer1k    || this.defaultUncachedCostPer1k;
    return (cachedTokens / 1000) * (uncached - cached);
  }

  estimateEntryCost(entry, pricing = null) {
    return this.estimateSavings(entry.tokenCount, pricing);
  }
}

// ── CacheManager ───────────────────────────────────────────────────────────────

class CacheManager {
  constructor() {
    this.promptCache = new PromptCacheManager();
    this.semanticCache = new SemanticCacheManager();
    this.invalidation = new CacheInvalidationManager(this.promptCache, this.semanticCache);
    this.costEstimator = new CacheCostEstimator();
    this.state = CacheState.COLD;
    this._recentEvents = [];
  }

  _emit(type, detail, savedUsd = 0) {
    this._recentEvents.push({ type, ts: new Date().toISOString(), detail, savedUsd });
    if (this._recentEvents.length > 50) this._recentEvents.shift();
  }

  storePrompt(sup, um, modelId, resp, tokens) {
    this.state = CacheState.WARM;
    const entry = this.promptCache.store(sup, um, modelId, resp, tokens);
    this._emit('cache.store', `Prompt cached for ${modelId}`, 0);
    return entry;
  }

  retrievePrompt(sup, um, modelId) {
    const entry = this.promptCache.retrieve(sup, um, modelId);
    if (entry) {
      this._emit('cache.hit', `Prompt reused for ${modelId}`, this.costEstimator.estimateEntryCost(entry));
      return entry;
    }
    this._emit('cache.miss', `Prompt miss for ${modelId}`);
    return null;
  }

  storeSemantic(q, ctx, result, tokens, saved = 0) {
    this.state = CacheState.WARM;
    const entry = this.semanticCache.store(q, ctx, result, tokens, saved);
    this._emit('cache.store', 'Semantic result cached', saved);
    return entry;
  }

  retrieveSemantic(q, ctx) {
    const entry = this.semanticCache.retrieve(q, ctx);
    if (entry) {
      this._emit('cache.hit', 'Semantic hit', entry.costSaved || 0);
      return entry;
    }
    this._emit('cache.miss', `Semantic miss: ${q.slice(0, 40)}`);
    return null;
  }

  invalidateByKey(k)    { this.invalidation.invalidateByKey(k); }
  invalidateByModel(m)  { this.invalidation.invalidateByModel(m); }
  invalidateExpired()   { this.invalidation.invalidateExpired(); this._maybeCool(); }
  clear()               { this.invalidation.clearAll(); this.state = CacheState.COLD; }

  _maybeCool() {
    if (this.promptCache.entries.size + this.semanticCache.entries.size === 0) {
      this.state = CacheState.COLD;
    }
  }

  getHitRate() {
    const ph = this.promptCache.getHitRate();
    const sh = this.semanticCache.getHitRate();
    const pn = this.promptCache._hitLog.length;
    const sn = this.semanticCache._hitLog.length;
    const total = pn + sn;
    if (total === 0) return 0;
    return (ph * pn + sh * sn) / total;
  }

  getCachedTokens() {
    return this.promptCache.getCachedTokens() + this.semanticCache.getCachedTokens();
  }

  getSavedCost() {
    const pSaved = Array.from(this.promptCache.entries.values()).reduce((s, e) => s + this.costEstimator.estimateEntryCost(e), 0);
    const sSaved = Array.from(this.semanticCache.entries.values()).reduce((s, e) => s + (e.costSaved || 0), 0);
    return pSaved + sSaved;
  }

  getRecentEvents(limit = 10) { return this._recentEvents.slice(-limit); }
  getInvalidationLog(limit = 20) { return this.invalidation.getLog(limit); }
}

module.exports = {
  CacheEntry, CacheType, CacheState,
  CacheKeyManager,
  PromptCacheManager, SemanticCacheManager,
  CacheInvalidationManager, CacheCostEstimator,
  CacheManager,
};
