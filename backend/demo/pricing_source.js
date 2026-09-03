'use strict';

// PricingSource — manages model pricing with full history preservation.
// Never overwrites history blindly. All pricing records are immutable entries.
// The registry uses this internally; the router/cost-estimator query it.

class PricingSource {
  constructor(registry = null) {
    this.registry = registry || new (require('./model_registry')).ModelRegistry();
    // If registry passed in, wire up internal hooks
    if (registry) {
      this._registry = registry;
    } else {
      this._registry = new (require('./model_registry')).ModelRegistry();
    }
  }

  // Record a new pricing entry for a model
  // Does NOT overwrite existing entries — appends a new historical record.
  recordPrice(modelId, priceSpec, source = 'configuration') {
    const model = this._registry.models.get(modelId);
    if (!model) return false;

    const oldInput = model.pricing.input_price;
    const oldOutput = model.pricing.output_price;

    // Append history entry before applying
    this._registry.history.pricing.push({
      model_id: modelId,
      price_type: 'input_output',
      old_price: { input: oldInput, output: oldOutput },
      new_price: {
        input: priceSpec.input_price !== undefined ? priceSpec.input_price : oldInput,
        output: priceSpec.output_price !== undefined ? priceSpec.output_price : oldOutput,
      },
      timestamp: new Date(),
      source,
    });

    // Apply the new pricing to the model
    model.pricing = {
      ...model.pricing,
      input_price: priceSpec.input_price !== undefined ? priceSpec.input_price : oldInput,
      output_price: priceSpec.output_price !== undefined ? priceSpec.output_price : oldOutput,
      cached_input_price:
        priceSpec.cached_input_price !== undefined ? priceSpec.cached_input_price : model.pricing.cached_input_price,
      cache_write_price:
        priceSpec.cache_write_price !== undefined ? priceSpec.cache_write_price : model.pricing.cache_write_price,
      currency: priceSpec.currency || model.pricing.currency || 'USD',
      pricing_unit: priceSpec.pricing_unit || model.pricing.pricing_unit || '1k tokens',
      effective_from: priceSpec.effective_from || new Date(),
      pricing_last_updated: new Date(),
      pricing_source: source,
    };

    model.updated_at = new Date();
    return true;
  }

  // Get current pricing for a model
  getCurrentPrice(modelId) {
    const model = this._registry.models.get(modelId);
    if (!model) return null;
    return {
      modelId,
      input_price: model.pricing.input_price,
      output_price: model.pricing.output_price,
      cached_input_price: model.pricing.cached_input_price,
      cache_write_price: model.pricing.cache_write_price,
      currency: model.pricing.currency,
      pricing_unit: model.pricing.pricing_unit,
      effective_from: model.pricing.effective_from,
      effective_until: model.pricing.effective_until,
      pricing_source: model.pricing.pricing_source,
      pricing_last_updated: model.pricing.pricing_last_updated,
    };
  }

  // Get pricing history for a model
  getPriceHistory(modelId) {
    return this._registry.history.pricing
      .filter(h => h.model_id === modelId)
      .sort((a, b) => b.timestamp - a.timestamp); // newest first
  }

  // Get all pricing records across all models
  getAllPrices() {
    const results = [];
    for (const [modelId, model] of this._registry.models) {
      results.push({
        modelId,
        current: this.getCurrentPrice(modelId),
        history: this.getPriceHistory(modelId),
      });
    }
    return results;
  }

  // Set pricing from a provider discovery
  setPricingFromDiscovery(modelId, pricingRaw, source = 'provider_api') {
    // Normalize various provider pricing formats into our schema
    const priceSpec = {
      input_price: pricingRaw.input_price
        || pricingRaw.input || pricingRaw.per_1k_input
        || pricingRaw.price_per_input
        || null,
      output_price: pricingRaw.output_price
        || pricingRaw.output
        || pricingRaw.per_1k_output
        || pricingRaw.price_per_output
        || null,
      cached_input_price:
        pricingRaw.cached_input_price || pricingRaw.cached_per_1k_input || pricingRaw.price_per_cached_input || null,
      cache_write_price: pricingRaw.cache_write_price || pricingRaw.price_per_cache_write || null,
      currency: pricingRaw.currency || pricingRaw.curr || 'USD',
      pricing_unit: pricingRaw.pricing_unit || pricingRaw.unit || '1k tokens',
      effective_from: pricingRaw.effective_from || new Date(),
      effective_until: pricingRaw.effective_until || model.pricing.effective_until || null,
    };

    this.recordPrice(modelId, priceSpec, source);
    return priceSpec;
  }
}

module.exports = { PricingSource };