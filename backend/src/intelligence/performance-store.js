'use strict';

// Empirical model/task performance + routing history (§7, §8, §25, §26, §27).
//
// Design:
// - One record per (modelId, taskCategory): successes, attempts, EWMA quality,
//   latency samples (bounded, for p50/p75/p95), reliability by error code,
//   last-updated timestamps. No global "model.quality" is ever learned here;
//   the registry's static quality stays a provider/demo fact.
// - Updates are evidence-based and conservative: a single run moves the EWMA
//   by alpha (default 0.2), never overwrites. Minimum-sample thresholds gate
//   every consumer (n<3 -> unknown).
// - Uncertainty: Bayesian smoothing (prior successes/prior attempts) gives a
//   smoothed rate; confidence derives from sample count. Consumers that need
//   "don't overreact to n=1" use predictedSuccess() which blends toward the
//   prior when samples are few.
// - Durable: dump()/load() are plain JSON so Session 1's FileStore can persist
//   them without this module touching the filesystem.

const { VERSIONS } = require('./versions');

const MIN_SAMPLES_FOR_OBSERVED = 3;
const DEFAULT_PRIOR_SUCCESS = 0.7;
const DEFAULT_PRIOR_SAMPLES = 4;
const DEFAULT_ALPHA = 0.2;
const MAX_LATENCY_SAMPLES = 40;
const MAX_HISTORY = 300;

function clamp01(v) {
  if (!Number.isFinite(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function latencyStats(samples) {
  const nums = (samples || []).filter((v) => Number.isFinite(Number(v)) && Number(v) >= 0).map(Number).sort((a, b) => a - b);
  if (!nums.length) return { count: 0, p50: null, p75: null, p95: null, mean: null };
  const mean = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return {
    count: nums.length,
    p50: percentile(nums, 50),
    p75: percentile(nums, 75),
    p95: percentile(nums, 95),
    mean,
  };
}

function confidenceFor(n) {
  if (n >= 100) return 'high';
  if (n >= 20) return 'medium';
  if (n >= MIN_SAMPLES_FOR_OBSERVED) return 'low';
  return 'none';
}

class ModelPerformanceStore {
  constructor(options = {}) {
    this.priorSuccess = Number.isFinite(options.priorSuccess) ? options.priorSuccess : DEFAULT_PRIOR_SUCCESS;
    this.priorSamples = Number.isFinite(options.priorSamples) ? options.priorSamples : DEFAULT_PRIOR_SAMPLES;
    this.alpha = Number.isFinite(options.alpha) ? options.alpha : DEFAULT_ALPHA;
    // key `${modelId}::${category}` -> record
    this.records = new Map();
    // modelId -> { errors: {code: count}, samples }
    this.reliability = new Map();
    this.version = VERSIONS.performanceEstimator;
  }

  _key(modelId, category) {
    return `${modelId}::${category || 'general'}`;
  }

  _record(modelId, category) {
    const k = this._key(modelId, category);
    let r = this.records.get(k);
    if (!r) {
      r = {
        modelId, category: category || 'general',
        attempts: 0, successes: 0,
        qualityEwma: null,
        latencySamples: [],
        lastUpdated: null,
        version: this.version,
      };
      this.records.set(k, r);
    }
    return r;
  }

  // outcome: { success: bool|null, qualityScore: 0..1|null, latencyMs, errorCode }
  // success=null means "no outcome evidence" -> record latency only, never
  // moves success counters (learning safety: unknown stays unknown).
  recordOutcome(modelId, category, outcome = {}) {
    if (!modelId) return null;
    const r = this._record(modelId, category);
    const hasSuccess = outcome.success === true || outcome.success === false;
    if (hasSuccess) {
      r.attempts += 1;
      if (outcome.success) r.successes += 1;
    }
    if (Number.isFinite(Number(outcome.qualityScore))) {
      const q = clamp01(outcome.qualityScore);
      r.qualityEwma = r.qualityEwma === null ? q : (this.alpha * q + (1 - this.alpha) * r.qualityEwma);
      r.qualityEwma = Math.round(r.qualityEwma * 1000) / 1000;
    }
    if (Number.isFinite(Number(outcome.latencyMs)) && Number(outcome.latencyMs) >= 0) {
      r.latencySamples.push(Math.round(Number(outcome.latencyMs)));
      if (r.latencySamples.length > MAX_LATENCY_SAMPLES) {
        r.latencySamples.splice(0, r.latencySamples.length - MAX_LATENCY_SAMPLES);
      }
    }
    r.lastUpdated = new Date().toISOString();
    if (outcome.errorCode) this._recordReliability(modelId, outcome);
    return this.describe(modelId, category);
  }

  _recordReliability(modelId, outcome) {
    let rel = this.reliability.get(modelId);
    if (!rel) { rel = { samples: 0, failures: 0, byError: {} }; this.reliability.set(modelId, rel); }
    rel.samples += 1;
    if (outcome.success === false) {
      rel.failures += 1;
      const code = String(outcome.errorCode || 'unknown').slice(0, 64);
      rel.byError[code] = (rel.byError[code] || 0) + 1;
    }
  }

  rawRate(modelId, category) {
    const r = this.records.get(this._key(modelId, category));
    if (!r || r.attempts < MIN_SAMPLES_FOR_OBSERVED) return null;
    return r.successes / r.attempts;
  }

  // Bayesian-smoothed predicted success. Always returns a number PLUS an
  // explicit confidence + sample count so callers can reason about
  // uncertainty (§27). With zero samples this returns the prior with
  // confidence 'none' and observed=false.
  predictedSuccess(modelId, category) {
    const r = this.records.get(this._key(modelId, category));
    const attempts = r ? r.attempts : 0;
    const successes = r ? r.successes : 0;
    const smoothed = (successes + this.priorSuccess * this.priorSamples) / (attempts + this.priorSamples);
    return {
      modelId,
      category: category || 'general',
      predicted: Math.round(smoothed * 1000) / 1000,
      observed: attempts >= MIN_SAMPLES_FOR_OBSERVED ? Math.round((successes / attempts) * 1000) / 1000 : null,
      attempts,
      successes,
      confidence: confidenceFor(attempts),
      prior: { success: this.priorSuccess, samples: this.priorSamples },
      estimatorVersion: this.version,
    };
  }

  latency(modelId, category) {
    const r = this.records.get(this._key(modelId, category));
    const stats = latencyStats(r ? r.latencySamples : []);
    return { modelId, category: category || 'general', ...stats };
  }

  reliabilityFor(modelId) {
    const rel = this.reliability.get(modelId);
    if (!rel || rel.samples < MIN_SAMPLES_FOR_OBSERVED) return null;
    return {
      modelId,
      samples: rel.samples,
      failureRate: Math.round((rel.failures / rel.samples) * 1000) / 1000,
      byError: { ...rel.byError },
    };
  }

  describe(modelId, category) {
    const pred = this.predictedSuccess(modelId, category);
    const lat = this.latency(modelId, category);
    const r = this.records.get(this._key(modelId, category));
    return {
      ...pred,
      qualityEwma: r && r.qualityEwma !== null ? r.qualityEwma : null,
      latency: { p50: lat.p50, p75: lat.p75, p95: lat.p95, mean: lat.mean, count: lat.count },
      reliability: this.reliabilityFor(modelId),
      lastUpdated: r ? r.lastUpdated : null,
    };
  }

  // All categories observed for a model (for capability profiles / model
  // comparison data §35).
  forModel(modelId) {
    const out = {};
    for (const [k, r] of this.records.entries()) {
      if (r.modelId !== modelId) continue;
      out[r.category] = this.describe(modelId, r.category);
    }
    return out;
  }

  topCategories(limit = 50) {
    const cats = new Map();
    for (const r of this.records.values()) {
      cats.set(r.category, (cats.get(r.category) || 0) + r.attempts);
    }
    return Array.from(cats.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([category, attempts]) => ({ category, attempts }));
  }

  dump() {
    return {
      version: this.version,
      priorSuccess: this.priorSuccess,
      priorSamples: this.priorSamples,
      alpha: this.alpha,
      records: Array.from(this.records.values()).map((r) => ({ ...r, latencySamples: (r.latencySamples || []).slice(-MAX_LATENCY_SAMPLES) })),
      reliability: Array.from(this.reliability.entries()).map(([modelId, rel]) => ({ modelId, ...rel, byError: { ...rel.byError } })),
    };
  }

  load(data) {
    if (!data || typeof data !== 'object') return 0;
    let n = 0;
    this.records.clear();
    this.reliability.clear();
    if (Number.isFinite(data.priorSuccess)) this.priorSuccess = data.priorSuccess;
    if (Number.isFinite(data.priorSamples)) this.priorSamples = data.priorSamples;
    if (Number.isFinite(data.alpha)) this.alpha = data.alpha;
    for (const r of data.records || []) {
      if (!r || !r.modelId) continue;
      this.records.set(this._key(r.modelId, r.category), {
        modelId: r.modelId,
        category: r.category || 'general',
        attempts: Math.max(0, Math.floor(Number(r.attempts) || 0)),
        successes: Math.max(0, Math.floor(Number(r.successes) || 0)),
        qualityEwma: Number.isFinite(Number(r.qualityEwma)) ? clamp01(r.qualityEwma) : null,
        latencySamples: Array.isArray(r.latencySamples) ? r.latencySamples.filter(Number.isFinite).slice(-MAX_LATENCY_SAMPLES) : [],
        lastUpdated: r.lastUpdated || null,
        version: r.version || this.version,
      });
      n++;
    }
    for (const rel of data.reliability || []) {
      if (!rel || !rel.modelId) continue;
      this.reliability.set(rel.modelId, {
        samples: Math.max(0, Math.floor(Number(rel.samples) || 0)),
        failures: Math.max(0, Math.floor(Number(rel.failures) || 0)),
        byError: { ...(rel.byError || {}) },
      });
    }
    return n;
  }
}

class RoutingHistoryStore {
  constructor(options = {}) {
    this.max = options.max || MAX_HISTORY;
    this.entries = [];
  }

  record(entry) {
    const e = {
      id: entry.id || `route-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      ts: entry.ts || new Date().toISOString(),
      runId: entry.runId || null,
      taskCategory: entry.taskCategory || 'general',
      taskComplexity: entry.taskComplexity || null,
      selectedModel: entry.selectedModel || null,
      candidates: Array.isArray(entry.candidates) ? entry.candidates.slice(0, 12) : [],
      reasons: Array.isArray(entry.reasons) ? entry.reasons.slice(0, 12) : [],
      policyVersion: entry.policyVersion || VERSIONS.routingPolicy,
      inputsHash: entry.inputsHash || null,
      predictedSuccess: Number.isFinite(Number(entry.predictedSuccess)) ? Number(entry.predictedSuccess) : null,
      expectedCostUsd: Number.isFinite(Number(entry.expectedCostUsd)) ? Number(entry.expectedCostUsd) : null,
      outcome: entry.outcome !== undefined ? entry.outcome : null, // filled later by attachOutcome
    };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return e;
  }

  attachOutcome(runId, outcome) {
    let n = 0;
    for (const e of this.entries) {
      if (e.runId === runId && e.outcome === null) {
        e.outcome = outcome && typeof outcome === 'object' ? { ...outcome } : outcome;
        n++;
      }
    }
    return n;
  }

  forRun(runId) {
    return this.entries.filter((e) => e.runId === runId);
  }

  recent(limit = 50) {
    return this.entries.slice(-Math.max(1, Math.min(this.max, limit))).reverse();
  }

  dump() { return this.entries.slice(-this.max); }

  load(items) {
    if (!Array.isArray(items)) return 0;
    this.entries = items.filter((e) => e && typeof e === 'object').slice(-this.max);
    return this.entries.length;
  }
}

module.exports = {
  ModelPerformanceStore,
  RoutingHistoryStore,
  MIN_SAMPLES_FOR_OBSERVED,
  confidenceFor,
  latencyStats,
  clamp01,
};
