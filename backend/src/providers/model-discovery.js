'use strict';

// Lightweight model discovery (Session 5, §7).
//
//   provider -> discover models -> normalize -> validate -> update registry
//             -> emit changes
//
// A NEW MODEL APPEARS without source changes: refreshOnce() registers unknown
// IDs into the ModelRegistry, after which routing can select them. No
// distributed scheduler — one interval timer (DISCOVERY_INTERVAL_MS).

const { createLogger } = require('../logger');

function toRegistryShape(normalized, providerId) {
  const caps = normalized.capabilities || {};
  const capabilities = ['text'];
  if (caps.tools) capabilities.push('tools');
  if (caps.structured_output) capabilities.push('structured');
  if (caps.vision) capabilities.push('vision');
  return {
    id: normalized.id,
    name: normalized.name || normalized.id,
    provider: providerId,
    status: 'healthy',
    contextWindow: normalized.contextWindow || 32000,
    quality: 0.7, // provisional until observed; documented, not invented precision
    avgLatencyMs: 2000,
    reliability: 0.9,
    inputPer1k: normalized.pricing?.inputPer1k ?? 0.001,
    outputPer1k: normalized.pricing?.outputPer1k ?? 0.003,
    cachedPer1k: normalized.pricing?.cachedPer1k ?? normalized.pricing?.inputPer1k ?? 0.001,
    capabilities,
    source: 'discovered',
    nativeId: normalized.id,
  };
}

function validPricing(p) {
  if (!p) return false;
  for (const k of ['inputPer1k', 'outputPer1k']) {
    const v = p[k];
    if (v !== null && v !== undefined && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return false;
  }
  return true;
}

class DiscoveryService {
  constructor(options = {}) {
    this.registry = options.registry;
    this.providerRegistry = options.providerRegistry;
    this.config = options.config || {};
    this.log = options.logger || createLogger({ level: process.env.LOG_LEVEL || 'info' });
    this.timer = null;
    this.lastResult = null;
  }

  get enabled() {
    return this.config.discoveryEnabled !== false && this.config.mode === 'live';
  }

  async refreshOnce(providerId) {
    const id = (providerId || this.config.provider || 'openrouter').toLowerCase();
    if (this.config.mode !== 'live') {
      return { skipped: 'demo mode: discovery disabled', provider: id };
    }
    const adapter = this.providerRegistry.getAdapter(id);
    if (!adapter.hasCredentials) {
      return { skipped: `no credentials for ${id}`, provider: id };
    }
    let listed;
    try {
      listed = await adapter.listModels();
    } catch (e) {
      this.log.warn('discovery refresh failed', { provider: id, code: e.code || 'unknown' });
      return { provider: id, error: e.code || 'unavailable', discovered: 0, updated: 0 };
    }
    let discovered = 0;
    let updated = 0;
    let prices = 0;
    for (const n of listed || []) {
      if (!n || !n.id) continue;
      try {
        const existing = await this.registry.getModel(n.id);
        if (!existing) {
          await this.registry.registerModel(toRegistryShape(n, id));
          discovered++;
        } else {
          const patch = {};
          if (n.contextWindow && n.contextWindow !== existing.contextWindow) patch.contextWindow = n.contextWindow;
          if (n.name && n.name !== existing.name) patch.name = n.name;
          if (Object.keys(patch).length) {
            await this.registry.updateModel(n.id, patch);
            updated++;
          }
          if (n.pricing && validPricing(n.pricing)) {
            const prev = this.registry.getPricing ? this.registry.getPricing(n.id) : null;
            const same = prev && prev.inputPer1k === n.pricing.inputPer1k && prev.outputPer1k === n.pricing.outputPer1k;
            if (!same && this.registry.updatePrice) {
              await this.registry.updatePrice(n.id, {
                inputPer1k: n.pricing.inputPer1k ?? prev?.inputPer1k,
                outputPer1k: n.pricing.outputPer1k ?? prev?.outputPer1k,
                cachedPer1k: n.pricing.cachedPer1k ?? prev?.cachedPer1k,
              }, 'discovery');
              prices++;
            }
          }
        }
      } catch (e) {
        this.log.warn('discovery item failed', { model: String(n.id).slice(0, 80) });
      }
    }
    this.lastResult = { provider: id, discovered, updated, prices, at: new Date().toISOString() };
    this.log.info('discovery refresh', this.lastResult);
    return this.lastResult;
  }

  // Ensure the configured provider default exists in the registry so LIVE mode
  // can execute before the first successful discovery round-trip.
  async ensureDefaultModel() {
    if (this.config.mode !== 'live') return null;
    const id = (this.config.provider || 'openrouter').toLowerCase();
    const adapter = this.providerRegistry.getAdapter(id);
    const nativeId = adapter.defaultModel;
    if (!nativeId) return null;
    const existing = await this.registry.getModel(nativeId);
    if (existing) return existing;
    const seeded = {
      id: nativeId, name: nativeId, provider: id, status: 'healthy',
      contextWindow: 64000, quality: 0.75, avgLatencyMs: 2000, reliability: 0.9,
      inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.001,
      capabilities: ['text', 'tools'], source: 'seed-default', nativeId,
    };
    await this.registry.registerModel(seeded);
    this.log.info('registered provider default model', { model: nativeId });
    return seeded;
  }

  start() {
    if (!this.enabled || this.timer) return;
    const ms = Math.max(60000, this.config.discoveryIntervalMs || 300000);
    this.refreshOnce().catch(() => {});
    this.timer = setInterval(() => { this.refreshOnce().catch(() => {}); }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DiscoveryService };
