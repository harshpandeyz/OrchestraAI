'use strict';

// ModelPerformanceTracker — separates three performance sources:
// A. Vendor/static metadata (quality, benchmark scores from provider)
// B. Benchmark performance (results from running our benchmark suite)
// C. Real observed performance (from actual application workloads)
// All tracked by task category.

const { ModelRegistry } = require('./model_registry');

class ModelPerformanceTracker {
  constructor(registry = null) {
    this.registry = registry || new ModelRegistry();
    // Per-model, per-category tracking
    this.categoryStats = new Map(); // modelId -> { [category]: { metric, sample_count, confidence, timestamp } }
  }

  // Record benchmark results (category A/B boundary — vendor claims vs our bench)
  recordBenchmark(modelId, category, metric, sampleCount = 1, confidence = 0.5) {
    const model = this.registry.models.get(modelId);
    if (!model) return false;

    // Store in model's performance.observed_task_performance
    if (!model.performance.observed_task_performance) {
      model.performance.observed_task_performance = {};
    }

    model.performance.observed_task_performance[category] = {
      metric,
      sample_count: sampleCount,
      timestamp: new Date(),
      confidence,
    };

    // Update aggregate quality score
    this._updateAggregateQuality(modelId);

    return true;
  }

  // Record observed runtime performance (from actual task execution)
  recordObservedPerformance(modelId, category, metric, sampleCount = 1, confidence = 0.5, timestamp = new Date()) {
    const model = this.registry.models.get(modelId);
    if (!model) return false;

    // Merge into observed_task_performance
    if (!model.performance.observed_task_performance) {
      model.performance.observed_task_performance = {};
    }

    const existing = model.performance.observed_task_performance[category];
    const n = (existing ? existing.sample_count : 0) + (sampleCount || 0);

    // Running average for metric
    const newMetric = n > 0
      ? (existing ? existing.metric : 0) * (existing ? existing.sample_count : 0) / n
        + metric * (sampleCount || 0) / n
      : metric;

    model.performance.observed_task_performance[category] = {
      metric: newMetric,
      sample_count: n,
      timestamp,
      confidence: Math.min(1, (existing ? existing.confidence : 0) * 0.5 + confidence * 0.5),
    };

    this._updateAggregateQuality(modelId);
    return true;
  }

  // _updateAggregateQuality — recompute quality_score from observed performances
  _updateAggregateQuality(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return;

    const cats = model.performance.observed_task_performance || {};
    const scores = Object.values(cats)
      .filter(c => c.metric !== undefined && c.sample_count > 0)
      .map(c => ({ metric: c.metric, sample_count: c.sample_count }));

    if (scores.length === 0) {
      model.performance.quality_score = model.performance.benchmark_scores && Object.keys(model.performance.benchmark_scores).length > 0
        ? Object.values(model.performance.benchmark_scores).reduce((a, b) => a + b, 0) / Object.keys(model.performance.benchmark_scores).length
        : 0;
      model.performance.sample_count = 0;
      model.performance.confidence = 0;
      return;
    }

    // Weighted average: observed performances weighted by sample count
    const total = scores.reduce((sum, s) => sum + s.sample_count, 0);
    model.performance.quality_score = total > 0
      ? scores.reduce((sum, s) => sum + s.metric * s.sample_count, 0) / total
      : 0;

    model.performance.sample_count = total;
    // Confidence grows with more samples — logarithmic scale
    model.performance.confidence = Math.min(1, 0.5 + 0.5 * Math.log10(Math.max(1, total)) / Math.log10(10000));
  }

  // Get performance for a model
  getPerformance(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return null;
    return { ...model.performance, modelId };
  }

  // Get observed performance by task category
  getCategoryPerformance(modelId, category) {
    const model = this.registry.models.get(modelId);
    if (!model) return null;
    return model.performance.observed_task_performance ? model.performance.observed_task_performance[category] || null : null;
  }

  // Set vendor/static benchmark scores (separate from observed)
  setBenchmarkScores(modelId, scores) {
    const model = this.registry.models.get(modelId);
    if (!model) return false;

    model.performance.benchmark_scores = { ...model.performance.benchmark_scores, ...scores };
    model.updated_at = new Date();

    // Recalculate aggregate quality
    this._updateAggregateQuality(modelId);
    return true;
  }

  // Get all categories for a model
  getAllCategories(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return {};
    return model.performance.observed_task_performance || {};
  }
}

module.exports = { ModelPerformanceTracker };