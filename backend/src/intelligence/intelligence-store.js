'use strict';

// Durable intelligence facade (§8).
//
// Owns NOTHING filesystem-specific: dump()/load() plain JSON, persisted by
// Session 1's FileStore (files: intelligence.json, benchmarks.json,
// semantic-cache.json, outcome-evals.json). Process memory is a cache, never
// the system of record — servers reload on boot and persist on run-end.

const { ModelPerformanceStore, RoutingHistoryStore } = require('./performance-store');
const { BenchmarkStore } = require('./benchmarks');
const { SemanticCacheIndex } = require('./semantic-cache');
const { evaluateOutcome, outcomeToLearningUpdate } = require('./outcome-evaluator');
const { classifyTask } = require('./task-classifier');

class IntelligenceStore {
  constructor(options = {}) {
    this.performance = options.performance || new ModelPerformanceStore(options.performanceOptions);
    this.routingHistory = options.routingHistory || new RoutingHistoryStore(options.routingOptions);
    this.benchmarks = options.benchmarks || new BenchmarkStore(options.benchmarkOptions);
    this.semanticCache = options.semanticCache || new SemanticCacheIndex(options.semanticOptions);
    this.outcomeEvals = []; // bounded outcome evaluations (v2)
    this.maxOutcomeEvals = options.maxOutcomeEvals || 200;
    this.userFeedback = new Map(); // runId -> feedback signal
  }

  // ---- outcome -> learning loop (§8, §31) ----
  // Returns { outcome, learning } where learning is the performance update
  // applied (or null when evidence was insufficient — unknown stays unknown).
  ingestRunOutcome(input = {}) {
    const taskProfile = input.taskProfile || classifyTask(input.taskText || '');
    const outcome = evaluateOutcome({
      runId: input.runId || null,
      modelId: input.modelId || null,
      taskCategory: input.taskCategory || taskProfile.category,
      signals: {
        completed: input.completed,
        hasAssistantMessage: input.hasAssistantMessage,
        toolFailures: input.toolFailures || 0,
        withinBudget: input.withinBudget,
        criteria: input.criteria || [],
        evidence: input.evidence || [],
        testSummary: input.testSummary || null,
        toolObservations: input.toolObservations || [],
        userFeedback: input.userFeedback || this.userFeedback.get(input.runId) || null,
        modelSelfReport: input.modelSelfReport || null,
        cost: input.cost,
        latencyMs: input.latencyMs,
        steps: input.steps,
      },
    });
    this.outcomeEvals.push(outcome);
    if (this.outcomeEvals.length > this.maxOutcomeEvals) {
      this.outcomeEvals.splice(0, this.outcomeEvals.length - this.maxOutcomeEvals);
    }
    let learning = null;
    const update = outcomeToLearningUpdate(outcome);
    if (update && input.modelId) {
      if (update.latencyOnly) {
        learning = this.performance.recordOutcome(input.modelId, outcome.taskCategory, {
          success: null, qualityScore: null, latencyMs: input.latencyMs, errorCode: null,
        });
      } else {
        learning = this.performance.recordOutcome(input.modelId, outcome.taskCategory, {
          success: update.success,
          qualityScore: Number.isFinite(Number(update.qualityScore)) ? update.qualityScore : null,
          latencyMs: input.latencyMs,
          errorCode: update.success === false ? (input.errorCode || 'task_failed') : null,
        });
      }
    } else if (input.modelId && Number.isFinite(Number(input.latencyMs))) {
      // Latency observations are always safe to record (no success claim).
      learning = this.performance.recordOutcome(input.modelId, outcome.taskCategory, {
        success: null, qualityScore: null, latencyMs: input.latencyMs, errorCode: null,
      });
    }
    if (input.runId) this.routingHistory.attachOutcome(input.runId, { taskSuccess: outcome.taskSuccess, overallScore: outcome.overallScore });
    return { outcome, learning, taskProfile };
  }

  recordFeedback(runId, feedback) {
    if (!runId) return null;
    const fb = { signal: feedback.signal || feedback.value || null, rating: feedback.rating ?? null, confidence: feedback.confidence ?? 0.4, ts: new Date().toISOString() };
    this.userFeedback.set(runId, fb);
    return fb;
  }

  outcomeForRun(runId) {
    const list = this.outcomeEvals.filter((o) => o.runId === runId);
    return list.length ? list[list.length - 1] : null;
  }

  listOutcomes({ runId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(this.maxOutcomeEvals, Number(limit) || 50));
    const filtered = runId ? this.outcomeEvals.filter((o) => o.runId === runId) : this.outcomeEvals;
    return filtered.slice(-n).reverse();
  }

  dump() {
    return {
      performance: this.performance.dump(),
      routingHistory: this.routingHistory.dump(),
      benchmarks: this.benchmarks.dump(),
      semanticCache: this.semanticCache.dump(),
      outcomeEvals: this.outcomeEvals.slice(-this.maxOutcomeEvals),
      userFeedback: Array.from(this.userFeedback.entries()).slice(-200).map(([runId, fb]) => ({ runId, ...fb })),
    };
  }

  load(data) {
    if (!data || typeof data !== 'object') return;
    try { this.performance.load(data.performance); } catch { /* keep empty */ }
    try { this.routingHistory.load(data.routingHistory); } catch { /* keep empty */ }
    try { this.benchmarks.load(data.benchmarks); } catch { /* keep empty */ }
    try { this.semanticCache.load(data.semanticCache); } catch { /* keep empty */ }
    if (Array.isArray(data.outcomeEvals)) this.outcomeEvals = data.outcomeEvals.filter(Boolean).slice(-this.maxOutcomeEvals);
    this.userFeedback.clear();
    for (const f of data.userFeedback || []) {
      if (f && f.runId) this.userFeedback.set(f.runId, f);
    }
  }
}

module.exports = { IntelligenceStore };
