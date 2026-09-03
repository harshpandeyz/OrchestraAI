'use strict';

// ModelDiscovery — dynamic discovery pipeline.
// Flow: provider → fetch models → normalize metadata → validate → compare with registry → create/update → emit event.

const { ModelRegistry } = require('./model_registry');
const { getAdapter } = require('./provider_adapter');

class ModelDiscovery {
  constructor(registry = null) {
    this.registry = registry || new ModelRegistry();
    this.discoveryEvents = []; // emitted events for telemetry
  }

  // ---- Main discovery entry point ----

  async discoverFromProvider(providerId, options = {}) {
    const adapter = getAdapter(providerId, options);
    if (!adapter) {
      throw new Error(`No adapter for provider: ${providerId}`);
    }

    // 1. Fetch models from provider
    let rawModels;
    try {
      rawModels = await adapter.listModels();
    } catch (e) {
      this._emit({
        type: 'MODEL_DISCOVERY_FAILED',
        provider: providerId,
        error: e.message,
        timestamp: new Date(),
      });
      return;
    }

    // 2. Normalize each model
    const normalized = this._normalizeModels(rawModels, adapter);

    // 3. Validate and compare with registry
    const results = this._compareAndUpdate(normalized, adapter);

    // 4. Emit events
    for (const r of results) {
      this._emit({
        type: r.eventType,
        ...r.payload,
        timestamp: new Date(),
      });
    }

    return { discovered: results.length, provider: providerId, results };
  }

  // ---- Internal pipeline steps ----

  _normalizeModels(rawModels, adapter) {
    const results = [];
    const items = Array.isArray(rawModels) ? rawModels : [rawModels];
    for (const raw of items) {
      const normalized = adapter.normalizeModel(raw);
      // Validate required fields
      if (!normalized.model_id) {
        continue; // skip malformed
      }
      // Ensure capabilities exist
      if (!normalized.capabilities) {
        normalized.capabilities = { ...DEFAULT.capabilities };
      }
      // Ensure limits exist
      if (!normalized.limits) {
        normalized.limits = { context_window: 0, max_output_tokens: 0 };
      }
      results.push(normalized);
    }
    return results;
  }

  _compareAndUpdate(normalizedModels, adapter) {
    const results = [];

    for (const model of normalizedModels) {
      const existing = this.registry.getModel(model.model_id);

      if (!existing) {
        // New model — create
        this.registry.models.set(model.model_id, {
          ...model,
          id: model.model_id,
          canonical_name: model.canonical_name || model.model_id,
          provider_id: model.provider_id || adapter.providerId,
          provider: { ...{ provider_id: adapter.providerId, endpoint: adapter.endpoint }, ...model.provider },
          display_name: model.display_name || model.model_id,
          version: model.version || '0.0.1',
          status: 'healthy',
          discovered_at: new Date(),
          updated_at: new Date(),
          ...DEFAULT,
        });

        results.push({
          eventType: 'MODEL_DISCOVERED',
          modelId: model.model_id,
          provider: model.provider_id || adapter.providerId,
          capabilities: model.capabilities,
          context_window: model.limits?.context_window,
          pricing: model.pricing,
          payload: { modelId: model.model_id, provider: model.provider_id || adapter.providerId },
        });
      } else {
        // Existing model — check for updates
        const updates = this._checkUpdates(existing, model);
        if (updates.length > 0) {
          // Apply updates
          updates.forEach(u => {
            if (u.key === 'pricing') {
              this.registry.setPricing(model.model_id, u.newValue);
            } else if (u.key === 'health') {
              this.registry.setHealth(model.model_id, u.newValue);
            } else if (u.key === 'capability') {
              // merge capabilities
              const cap = this.registry.getModel(model.model_id).capabilities;
              Object.keys(u.newValue).forEach(k => { cap[k] = u.newValue[k]; });
            } else if (u.key === 'context_window') {
              model.limits.context_window = u.newValue;
            }
            u.model.updated_at = new Date();
          });

          results.push({
            eventType: 'MODEL_UPDATED',
            modelId: model.model_id,
            changes: updates.map(u => ({ key: u.key, old: u.old, new: u.new })),
            payload: { modelId: model.model_id, changes: updates.map(u => ({ key: u.key, new: u.new })) },
          });
        }
      }
    }

    return results;
  }

  _checkUpdates(existing, newModel) {
    const updates = [];

    // Check pricing
    if (newModel.pricing && newModel.pricing.input_price !== existing.pricing.input_price) {
      updates.push({
        key: 'pricing',
        old: { input: existing.pricing.input_price, output: existing.pricing.output_price },
        new: { input: newModel.pricing.input_price, output: newModel.pricing.output_price },
        model: existing.id,
      });
    }

    // Check capabilities
    const newCaps = newModel.capabilities || {};
    const oldCaps = existing.capabilities || {};
    let capChanged = false;
    Object.keys(newCaps).forEach(k => {
      if (oldCaps[k] !== newCaps[k]) { capChanged = true; }
    });
    if (capChanged) {
      updates.push({
        key: 'capability',
        old: { ...oldCaps },
        new: { ...newCaps },
        model: existing.id,
      });
    }

    // Check context window
    if (newModel.limits && newModel.limits.context_window !== existing.limits.context_window) {
      updates.push({
        key: 'context_window',
        old: existing.limits.context_window,
        new: newModel.limits.context_window,
        model: existing.id,
      });
    }

    // Check health if provided
    if (newModel.health) {
      updates.push({
        key: 'health',
        old: { ...existing.health },
        new: { ...newModel.health },
        model: existing.id,
      });
    }

    return updates;
  }

  // ---- Emit events ----

  _emit(event) {
    this.discoveryEvents.push(event);
    // In a full system, this would publish to the event bus / SSE
    // For now we just track it
  }

  // ---- Admission pipeline (from spec) ----

  async admitModel(modelId, options = {}) {
    const model = this.registry.getModel(modelId);
    if (!model) return { eligible: false, reason: 'model_not_found' };

    // Step 1: metadata normalized ✓ (already done during discovery)

    // Step 2: pricing validated
    const pricing = this.registry.getCurrentPricing(modelId);
    if (!pricing || pricing.input_price === null) {
      return { eligible: false, reason: 'pricing_missing' };
    }

    // Step 3: capability validated
    // (capabilities already present from discovery)

    // Step 4: basic benchmark (if benchmark framework available)
    // deferred — caller can invoke benchmark separately

    // Step 5: health observation
    const health = this.registry.getHealthHistory(modelId).slice(-1)[0];
    if (!health || health.new_health.available !== undefined && health.new_health.available === false) {
      return { eligible: false, reason: 'model_unavailable' };
    }

    // Step 6: eligible candidate
    return {
      eligible: true,
      model,
      reason: 'admitted_for_limited_use',
    };
  }
}

module.exports = { ModelDiscovery };