'use strict';

const { ModelRegistry } = require('../interfaces');
const { ModelStatus, EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class InMemoryModelRegistry extends ModelRegistry {
  constructor(models = [], eventBus = null) {
    super();
    this.models = new Map();
    this.eventBus = eventBus;
    this.subscribers = new Map();
    this.pricingHistory = new Map();
    
    for (const model of models) {
      this.models.set(model.id, { ...model, status: model.status || ModelStatus.HEALTHY });
    }
  }

  async getModels() {
    return Array.from(this.models.values());
  }

  async getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  async registerModel(model) {
    const newModel = { ...model, id: model.id || generateId('model'), status: model.status || ModelStatus.HEALTHY, registeredAt: now() };
    this.models.set(newModel.id, newModel);
    this._emit('model.registered', newModel);
    return newModel;
  }

  async updateModel(modelId, updates) {
    const model = this.models.get(modelId);
    if (!model) return null;
    const updated = { ...model, ...updates, updatedAt: now() };
    this.models.set(modelId, updated);
    this._emit('model.updated', { modelId, updates });
    return updated;
  }

  async unregisterModel(modelId) {
    const model = this.models.get(modelId);
    if (!model) return false;
    this.models.delete(modelId);
    this._emit('model.unregistered', { modelId });
    return true;
  }

  async getModelsByCapability(capability) {
    return Array.from(this.models.values()).filter(m => m.capabilities?.includes(capability));
  }

  async getModelsByProvider(provider) {
    return Array.from(this.models.values()).filter(m => m.provider === provider);
  }

  async healthCheck(modelId) {
    const model = this.models.get(modelId);
    if (!model) return { modelId, status: ModelStatus.UNAVAILABLE, healthy: false };
    return { modelId, status: model.status, healthy: model.status === ModelStatus.HEALTHY };
  }

  // ---- Observed runtime health (real successes/failures/latency) ----
  //
  // Called by the orchestrator after every provider call. Drives routing
  // quality signals with real data. Transient failures NEVER permanently mark
  // a model unhealthy: `unavailable` is only set explicitly (admin/discovery);
  // repeated failures degrade, and any later success recovers to healthy.

  recordObservation(modelId, obs = {}) {
    const model = this.models.get(modelId);
    if (!model) return null;
    if (!this.observed) this.observed = new Map();
    let o = this.observed.get(modelId);
    if (!o) {
      o = { successes: 0, failures: 0, consecutiveFailures: 0, latencySamples: [], lastObservedAt: null, lastErrorCode: null };
      this.observed.set(modelId, o);
    }
    o.lastObservedAt = now();
    if (obs.success) {
      o.successes++;
      o.consecutiveFailures = 0;
      if (!obs.cached && Number.isFinite(obs.latencyMs) && obs.latencyMs > 0) {
        o.latencySamples.push(obs.latencyMs);
        if (o.latencySamples.length > 20) o.latencySamples.shift();
        model.avgLatencyMs = Math.round(o.latencySamples.reduce((a, b) => a + b, 0) / o.latencySamples.length);
      }
      const total = o.successes + o.failures;
      if (total > 0) model.reliability = Math.min(0.999, Math.max(0.05, o.successes / total));
      // Recovery: a real success clears a failure-driven degraded state.
      if (model.status === ModelStatus.DEGRADED && model.degradedByObserver) {
        model.status = ModelStatus.HEALTHY;
        model.degradedByObserver = false;
        model.updatedAt = now();
        this._emit('health.changed', { modelId, oldStatus: ModelStatus.DEGRADED, newStatus: ModelStatus.HEALTHY });
      }
    } else {
      o.failures++;
      o.consecutiveFailures++;
      o.lastErrorCode = obs.code || 'unknown';
      const total = o.successes + o.failures;
      if (total > 0) model.reliability = Math.min(0.999, Math.max(0.05, o.successes / total));
      // Degrade (never auto-unavailable) after sustained failure.
      if (o.consecutiveFailures >= 5 && model.status === ModelStatus.HEALTHY) {
        model.status = ModelStatus.DEGRADED;
        model.degradedByObserver = true;
        model.updatedAt = now();
        this._emit('health.changed', { modelId, oldStatus: ModelStatus.HEALTHY, newStatus: ModelStatus.DEGRADED });
      }
    }
    model.lastObservedAt = o.lastObservedAt;
    return this.getObserved(modelId);
  }

  getObserved(modelId) {
    const o = this.observed ? this.observed.get(modelId) : null;
    if (!o) return null;
    return {
      modelId,
      successes: o.successes,
      failures: o.failures,
      consecutiveFailures: o.consecutiveFailures,
      avgLatencyMs: o.latencySamples.length
        ? Math.round(o.latencySamples.reduce((a, b) => a + b, 0) / o.latencySamples.length)
        : null,
      lastObservedAt: o.lastObservedAt,
      lastErrorCode: o.lastErrorCode,
    };
  }

  // ---- Authoritative pricing (single source of truth for CostEstimator + router) ----

  // Returns the current per-1k pricing for a model, or null when unknown.
  getPricing(modelId) {
    const model = this.models.get(modelId);
    if (!model) return null;
    return {
      modelId,
      inputPer1k: model.inputPer1k ?? null,
      outputPer1k: model.outputPer1k ?? null,
      cachedPer1k: model.cachedPer1k ?? null,
      updatedAt: model.pricingUpdatedAt || model.updatedAt || null,
      source: model.pricingSource || 'seed',
    };
  }

  getPricingHistory(modelId) {
    return (this.pricingHistory.get(modelId) || []).slice();
  }

  // Real price update path (discovery, provider webhooks, admin). Records
  // immutable history, updates the model, and notifies subscribers so the
  // orchestrator can reevaluate WITHOUT auto-switching.
  async updatePrice(modelId, pricing, source = 'provider') {
    const model = this.models.get(modelId);
    if (!model) return null;
    const prev = this.getPricing(modelId);
    if (pricing.inputPer1k !== undefined) model.inputPer1k = pricing.inputPer1k;
    if (pricing.outputPer1k !== undefined) model.outputPer1k = pricing.outputPer1k;
    if (pricing.cachedPer1k !== undefined) model.cachedPer1k = pricing.cachedPer1k;
    model.pricingSource = source;
    model.pricingUpdatedAt = now();
    model.updatedAt = now();
    const record = { modelId, prev, next: this.getPricing(modelId), source, at: now() };
    if (!this.pricingHistory) this.pricingHistory = new Map();
    if (!this.pricingHistory.has(modelId)) this.pricingHistory.set(modelId, []);
    this.pricingHistory.get(modelId).push(record);
    this._emit('price.changed', { modelId, pricing: this.getPricing(modelId), prev, source });
    if (this.eventBus) {
      this.eventBus.emit('system', EventType.PRICE_UPDATED, { modelId, pricing: this.getPricing(modelId), prev, source });
    }
    return record;
  }

  on(event, handler) {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }
    this.subscribers.get(event).add(handler);
  }

  off(event, handler) {
    const subs = this.subscribers.get(event);
    if (subs) subs.delete(handler);
  }

  _emit(event, data) {
    const subs = this.subscribers.get(event);
    if (subs) {
      for (const handler of subs) {
        try {
          handler(data);
        } catch (e) {}
      }
    }
    if (this.eventBus) {
      this.eventBus.emit('system', EventType.MODEL_UPDATED, { event, data });
    }
  }

  // Demo/test helper. Prefer updatePrice() for real updates.
  simulatePriceChange(modelId, newPricing) {
    return this.updatePrice(modelId, newPricing, 'simulation');
  }

  simulateHealthChange(modelId, status) {
    const model = this.models.get(modelId);
    if (model) {
      const oldStatus = model.status;
      model.status = status;
      model.degradedByObserver = false;
      model.updatedAt = now();
      this._emit('health.changed', { modelId, oldStatus, newStatus: status });
    }
  }
}

module.exports = {
  InMemoryModelRegistry
};