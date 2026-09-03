'use strict';

// BenchmarkFramework — modular benchmark execution for newly discovered models.
// Supports categories: coding, reasoning, tool use, structured output, summarization, data analysis.
// Progression: DISCOVERED → METADATA VALIDATED → BENCHMARKING → CANDIDATE → LIMITED → ACTIVE

const { ModelPerformanceTracker } = require('./model_performance');

const CATEGORIES = [
  'coding',
  'reasoning',
  'tool_use',
  'structured_output',
  'summarization',
  'data_analysis',
];

const DEFAULT_BENCHMARK = {
  prompt: '',
  inputData: {},
  timeoutMs: 60000,
  expectedOutput: null,
  evaluationCriteria: [],
};

// Benchmark runner — executes a single benchmark against a model
class BenchmarkFramework {
  constructor(registry = null, performanceTracker = null) {
    this.registry = registry || new (require('./model_registry')).ModelRegistry();
    this.performanceTracker = performanceTracker || new ModelPerformanceTracker(this.registry);
    this.benchmarkResults = new Map(); // modelId -> { [category]: result }
    this.running = new Map(); // modelId -> boolean (in-progress)
  }

  // Execute a benchmark category for a model
  async runBenchmark(modelId, category, benchmarkSpec = {}) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown benchmark category: ${category}`);
    }

    const model = this.registry.models.get(modelId);
    if (!model) return { error: 'model_not_found' };

    if (this.running.has(modelId) && this.running.get(modelId)) {
      return { error: 'benchmark_already_running', modelId };
    }

    this.running.set(modelId, true);

    try {
      const spec = { ...DEFAULT_BENCHMARK, ...benchmarkSpec };

      // Execute model-specific benchmark logic
      // In a real implementation, this would call the model's endpoint
      // For now, we simulate with a modular executor
      const result = await this._executeBenchmark(model, category, spec);

      // Record the result
      this.performanceTracker.recordBenchmark(modelId, category, result.metric, result.sampleCount, result.confidence);

      // Store result
      if (!this.benchmarkResults.has(modelId)) {
        this.benchmarkResults.set(modelId, {});
      }
      this.benchmarkResults.get(modelId)[category] = result;

      // Transition model state: BENCHMARKED → candidate eligibility
      model.lifecycle.updated_at = new Date();

      return {
        success: true,
        category,
        metric: result.metric,
        sampleCount: result.sampleCount,
        confidence: result.confidence,
      };
    } finally {
      this.running.set(modelId, false);
    }
  }

  // _executeBenchmark — modular execution; subclasses/plugins can override per category
  async _executeBenchmark(model, category, spec) {
    // Default: simulated benchmark based on model's claimed quality and capabilities
    const baseQuality = model.performance.quality_score || 0;
    const caps = model.capabilities || {};

    // Category-specific weighting
    let difficultyAdjustment = 1;
    if (category === 'coding' && !caps.coding) difficultyAdjustment = 0.5;
    if (category === 'tool_use' && !caps.tool_calling) difficultyAdjustment = 0.5;
    if (category === 'reasoning' && !caps.reasoning) difficultyAdjustment = 0.7;

    // Simulated metric: base quality adjusted by capability fit and randomness
    const simulatedMetric = Math.max(0, Math.min(1, baseQuality * difficultyAdjustment + (Math.random() - 0.5) * 0.2));
    const sampleCount = 5; // simulated sample count
    const confidence = Math.min(1, 0.3 + 0.7 * (sampleCount / 10));

    return {
      metric: simulatedMetric,
      sampleCount,
      confidence,
    };
  }

  // Run all categories for a model
  async runAllBenchmarks(modelId, customSpecs = {}) {
    const results = {};
    for (const category of CATEGORIES) {
      const spec = customSpecs[category] || {};
      const result = await this.runBenchmark(modelId, category, spec);
      results[category] = result;
    }
    return results;
  }

  // Get benchmark results for a model
  getBenchmarkResults(modelId) {
    return this.benchmarkResults.get(modelId) || {};
  }

  // Get benchmark results by category
  getBenchmarkResult(modelId, category) {
    const results = this.getBenchmarkResults(modelId);
    return results[category] || null;
  }

  // Model state progression helper
  // Moves a model through the discovery/admission pipeline
  async admitModel(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return { error: 'model_not_found' };

    // Check prerequisites
    const hasBenchmark = Object.keys(this.getBenchmarkResults(modelId)).length > 0;
    const hasPricing = model.pricing.input_price !== null;
    const hasHealth = model.health.availability > 0;

    if (!hasBenchmark) {
      return { status: 'BENCHMARKING', eligible: false, reason: 'no_benchmarks' };
    }

    if (!hasPricing) {
      return { status: 'CANDIDATE', eligible: false, reason: 'no_pricing' };
    }

    if (!hasHealth) {
      return { status: 'LIMITED', eligible: false, reason: 'poor_health' };
    }

    // Eligible!
    model.status = 'active';
    model.updated_at = new Date();

    return {
      status: 'ACTIVE',
      eligible: true,
      reason: 'passed_admission_pipeline',
    };
  }
}

module.exports = { BenchmarkFramework, CATEGORIES };