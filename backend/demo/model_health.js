'use strict';

// ModelHealthMonitor — tracks model health from multiple sources.
// Provider-reported health + runtime observations → composite health state.
// Uses rolling windows for latency/error rate tracking.

const rollingWindow = require('./rolling_window');

// Default rolling window sizes
const DEFAULT_WINDOW = {
  latency: 20, // last 20 samples
  error: 50, // last 50 requests
  availability: 100, // last 100 checks
};

class ModelHealthMonitor {
  constructor(registry = null) {
    this.registry = registry || new (require('./model_registry')).ModelRegistry();
    this.runtimeObservations = new Map(); // modelId -> { latencies, errors, successes, lastChecked }
    this.windows = new Map(); // modelId -> rolling windows
  }

  // Record a runtime health observation from executing a model
  recordObservation(modelId, observation) {
    observation = observation || {};
    let window = this.windows.get(modelId);
    if (!window) {
      window = {
        latencies: [],
        errors: 0,
        successes: 0,
        timeouts: 0,
        lastChecked: null,
      };
      this.windows.set(modelId, window);
    }

    window.latencies.push(observation.latencyMs || 0);
    if (observation.error) window.errors += 1;
    if (observation.timeout) window.timeouts += 1;
    if (!observation.error && !observation.timeout) window.successes += 1;
    window.lastChecked = new Date();

    // Trim to window size
    const max = DEFAULT_WINDOW.latency;
    if (window.latencies.length > max) {
      window.latencies = window.latencies.slice(-max);
    }

    // Update registry health
    this._updateRegistryHealth(modelId, window);
  }

  // Record a provider-reported health check
  recordProviderHealth(modelId, healthSpec) {
    const model = this.registry.models.get(modelId);
    if (!model) return false;

    const prev = { ...model.health };

    model.health = {
      ...model.health,
      availability: healthSpec.availability !== undefined ? healthSpec.availability : model.health.availability,
      latency: healthSpec.latency !== undefined ? healthSpec.latency : model.health.latency,
      error_rate: healthSpec.error_rate !== undefined ? healthSpec.error_rate : model.health.error_rate,
      rate_limit: healthSpec.rate_limit || model.health.rate_limit,
      last_health_check: new Date(),
    };

    // Preserve history
    this.registry.history.health.push({
      model_id: modelId,
      previous_health: prev,
      new_health: { ...model.health },
      latency: healthSpec.latency,
      error_rate: healthSpec.error_rate,
      timestamp: new Date(),
    });

    model.updated_at = new Date();
    return true;
  }

  // Record a runtime observation that contradicts provider health
  // e.g., provider says healthy but observations show 25% timeout rate
  reconcileHealth(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return false;

    const window = this.windows.get(modelId);
    if (!window || window.latencies.length < 5) return false;

    const avgLatency =
      window.latencies.reduce((a, b) => a + b, 0) / window.latencies.length;
    const timeoutRate = window.timeouts / window.latencies.length;
    const errorRate = window.errors / window.latencies.length;

    // If runtime observations are worse than provider-reported, reflect reality
    let updated = false;

    if (timeoutRate > 0.1 && model.health.availability > 0.8) {
      model.health.availability = 0.8;
      updated = true;
    }

    if (errorRate > 0.2 && model.health.error_rate < errorRate) {
      model.health.error_rate = errorRate;
      updated = true;
    }

    if (avgLatency > (model.health.latency || Infinity) && model.health.latency) {
      // Keep the higher latency
      model.health.latency = Math.max(model.health.latency, avgLatency);
      updated = true;
    }

    if (updated) {
      model.health.last_health_check = new Date();
      model.updated_at = new Date();

      // Emit history entry
      const prev = { ...this.registry.models.get(modelId).health };
      this.registry.history.health.push({
        model_id: modelId,
        previous_health: prev,
        new_health: { ...model.health },
        latency: model.health.latency,
        error_rate: model.health.error_rate,
        timestamp: new Date(),
      });
    }

    return updated;
  }

  // Get current health for a model
  getHealth(modelId) {
    const model = this.registry.models.get(modelId);
    if (!model) return null;
    return { ...model.health, modelId };
  }

  // Get health history for a model
  getHealthHistory(modelId) {
    return this.registry.history.health.filter(h => h.model_id === modelId);
  }

  // _updateRegistryHealth — internal, sync with registry
  _updateRegistryHealth(modelId, window) {
    const model = this.registry.models.get(modelId);
    if (!model) return;

    const n = window.latencies.length || 1;
    const avgLatency =
      window.latencies.reduce((a, b) => a + b, 0) / n;
    const errorRate = window.errors / n;
    const avail = window.successes / n;

    model.health = {
      ...model.health,
      availability: avail,
      latency: avgLatency,
      error_rate: errorRate,
      last_health_check: window.lastChecked,
    };

    model.updated_at = new Date();
  }
}

module.exports = { ModelHealthMonitor };