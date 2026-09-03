'use strict';

// ModelDefinition — canonical representation of a model.
// Extends the basic Session-1 Model type with full metadata, pricing, health, performance.
// All fields are optional/extensible to support future providers without breaking changes.

const DEFAULT = {
  status: 'healthy',
  capabilities: {
    text: true,
    vision: false,
    audio: false,
    image: false,
    tool_calling: true,
    structured_output: false,
    reasoning: false,
    coding: false,
    embeddings: false,
    agent: false,
  },
  limits: { context_window: 0, max_output_tokens: 0 },
  pricing: {
    input_price: null,
    output_price: null,
    cached_input_price: null,
    cache_write_price: null,
    currency: 'USD',
    pricing_unit: '1k tokens',
    effective_from: null,
    effective_until: null,
    pricing_source: null,
    pricing_last_updated: null,
  },
  provider: { provider_id: null, endpoint: null, region: null, routing_options: {} },
  health: {
    availability: 1,
    latency: null,
    error_rate: 0,
    rate_limit: { requests_per_minute: null, requests_per_day: null },
    last_health_check: null,
  },
  performance: {
    benchmark_scores: {},
    observed_task_performance: {},
    success_rate: 0,
    quality_score: 0,
    sample_count: 0,
    confidence: 0,
  },
  lifecycle: {
    discovered_at: new Date(),
    updated_at: new Date(),
    deprecated_at: null,
    retirement_at: null,
  },
  metadata: { source: null, raw_metadata: null, normalized_metadata: {}, tags: [] },
};

// ---------------------------------------------------------------------------
// ModelRegistry — canonical in-memory registry. Persistence is delegated to the
// project's existing storage layer; this module keeps the authoritative state.
// ---------------------------------------------------------------------------

class ModelRegistry {
  constructor() {
    this.models = new Map(); // model_id -> ModelDefinition
    this.providers = new Map(); // provider_id -> { models: Set, info: object }
    this.history = {
      pricing: [], // [ { model_id, price_type, old_price, new_price, timestamp, source } ]
      health: [], // [ { model_id, previous_health, new_health, latency, error_rate, timestamp } ]
      performance: [], // [ { model_id, task_category, metric, sample_count, timestamp, confidence } ]
    };
  }

  // ---- Core CRUD ----

  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  listModels(filters = {}) {
    const { status, provider, capability, minContext, maxContext, minQuality, maxQuality } = filters;
    return Array.from(this.models.values()).filter(m => {
      if (status && m.status !== status) return false;
      if (provider && m.provider.provider_id !== provider) return false;
      if (capability && !m.capabilities[capability]) return false;
      if (minContext && m.limits.context_window < minContext) return false;
      if (maxContext && m.limits.context_window > maxContext) return false;
      if (minQuality !== undefined && m.performance.quality_score < minQuality) return false;
      if (maxQuality !== undefined && m.performance.quality_score > maxQuality) return false;
      return true;
    });
  }

  // Discover or update a model. Returns [model, wasCreated].
  // normalizer: function that takes raw provider metadata and returns a partial ModelDefinition
  discoverModel(modelId, providerId, normalizer) {
    let model = this.models.get(modelId);

    if (!model) {
      model = {
        id: modelId,
        canonical_name: modelId,
        provider_id: providerId,
        provider: { provider_id: providerId, endpoint: null, region: null, routing_options: {} },
        display_name: modelId,
        version: '0.0.1',
        status: 'healthy',
        discovered_at: new Date(),
        updated_at: new Date(),
        ...DEFAULT,
      };
      this.models.set(modelId, model);
    }

    // Apply normalizer to merge in provider metadata
    normalizer(model);

    model.updated_at = new Date();
    return [model, !wasCreated]; // simplified - always returns model
  }

  // ---- Pricing ----

  setPricing(modelId, pricingSpec) {
    const model = this.models.get(modelId);
    if (!model) return false;

    const oldPrice = model.pricing.input_price;
    const oldOutputPrice = model.pricing.output_price;

    // Preserve history before update
    if (pricingSpec.input_price !== oldPrice || pricingSpec.output_price !== oldOutputPrice) {
      this.history.pricing.push({
        model_id: modelId,
        price_type: 'input_output',
        old_price: { input: oldPrice, output: oldOutputPrice },
        new_price: { input: pricingSpec.input_price, output: pricingSpec.output_price },
        timestamp: new Date(),
        source: pricingSpec.pricing_source || 'configuration',
      });
    }

    // Apply new pricing
    model.pricing = { ...DEFAULT.pricing, ...pricingSpec, pricing_last_updated: new Date() };
    model.updated_at = new Date();
    return true;
  }

  getPricingHistory(modelId) {
    return this.history.pricing.filter(h => h.model_id === modelId);
  }

  getCurrentPricing(modelId) {
    const model = this.models.get(modelId);
    if (!model) return null;
    return { ...model.pricing, modelId };
  }

  // ---- Health ----

  setHealth(modelId, healthSpec) {
    const model = this.models.get(modelId);
    if (!model) return false;

    const prev = { ...model.health };
    model.health = { ...DEFAULT.health, ...healthSpec, last_health_check: new Date() };

    // Preserve history
    this.history.health.push({
      model_id: modelId,
      previous_health: prev,
      new_health: model.health,
      latency: model.health.latency,
      error_rate: model.health.error_rate,
      timestamp: new Date(),
    });

    model.updated_at = new Date();
    return true;
  }

  getHealthHistory(modelId) {
    return this.history.health.filter(h => h.model_id === modelId);
  }

  // ---- Performance ----

  recordPerformance(modelId, record) {
    const model = this.models.get(modelId);
    if (!model) return false;

    record.timestamp = record.timestamp || new Date();
    model.performance.observed_task_performance = {
      ...model.performance.observed_task_performance,
      [record.task_category]: {
        metric: record.metric,
        sample_count: record.sample_count,
        timestamp: record.timestamp,
        confidence: record.confidence,
      },
    };

    // Update aggregate stats
    const cat = model.performance.observed_task_performance[record.task_category];
    if (cat && cat.sample_count > 0) {
      const total = cat.sample_count;
      const prevScore = model.performance.quality_score;
      const n = model.performance.sample_count + (cat.sample_count || 0);
      model.performance.quality_score = (prevScore * (model.performance.sample_count || 0) + cat.metric * (cat.sample_count || 0)) / n;
      model.performance.sample_count = n;
      model.performance.confidence = Math.min(1, 0.5 + 0.5 * Math.log10(Math.max(1, n)) / Math.log10(1000));
    }

    model.updated_at = new Date();
    return true;
  }

  getPerformance(modelId) {
    const model = this.models.get(modelId);
    if (!model) return null;
    return { ...model.performance, modelId };
  }

  // ---- Capabilities ----

  hasCapability(modelId, capability) {
    const model = this.models.get(modelId);
    if (!model) return false;
    return !!model.capabilities[capability];
  }

  // ---- Lifecycle ----

  deprecateModel(modelId, reason) {
    const model = this.models.get(modelId);
    if (!model) return false;

    model.status = 'deprecated';
    model.lifecycle.deprecated_at = new Date();
    model.updated_at = new Date();

    // Emit event implicitly - caller can handle
    return true;
  }

  retireModel(modelId) {
    const model = this.models.get(modelId);
    if (!model) return false;

    model.status = 'retired';
    model.lifecycle.retirement_at = new Date();
    model.updated_at = new Date();
    return true;
  }

  // ---- Provider registration ----

  registerProvider(providerId, config = {}) {
    this.providers.set(providerId, {
      models: new Set(),
      info: config,
    });
    return this.providers.get(providerId);
  }

  getProviderModels(providerId) {
    return Array.from(this.models.values()).filter(m => m.provider.provider_id === providerId);
  }
}

module.exports = { ModelRegistry, DEFAULT };