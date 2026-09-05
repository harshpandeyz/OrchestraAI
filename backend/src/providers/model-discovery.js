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
    contextWindow: normalized.contextWindow || 0,
    // Provisional defaults are labelled as such (qualitySource etc.) — the
    // API surfaces them as "Not measured" until real telemetry accumulates.
    quality: null,
    qualitySource: 'unknown',
    avgLatencyMs: null,
    latencySource: 'unknown',
    reliability: null,
    reliabilitySource: 'unknown',
    contextSource: normalized.contextWindow ? 'provider' : 'unknown',
    inputPer1k: normalized.pricing?.inputPer1k ?? null,
    outputPer1k: normalized.pricing?.outputPer1k ?? null,
    cachedPer1k: normalized.pricing?.cachedPer1k ?? normalized.pricing?.inputPer1k ?? null,
    pricingSource: normalized.pricing && (normalized.pricing.inputPer1k !== null || normalized.pricing.outputPer1k !== null) ? 'provider' : 'unknown',
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
    this.changeLog = options.changeLog || null;
    this.timer = null;
    this.lastResult = null;
  }

  get enabled() {
    return this.config.discoveryEnabled !== false && this.config.mode === 'live';
  }

  async refreshOnce(providerId, scope = 'default', executionMode = this.config.mode) {
    const id = (providerId || this.config.provider || 'openrouter').toLowerCase();
    if (executionMode !== 'live') {
      return { skipped: 'demo mode: discovery disabled', provider: id };
    }
    const adapter = typeof this.providerRegistry.getAdapterForScope === 'function'
      ? this.providerRegistry.getAdapterForScope(id, scope)
      : this.providerRegistry.getAdapter(id);
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
    const newIds = [];
    const updatedIds = [];
    const priceIds = [];
    for (const n of listed || []) {
      if (!n || !n.id) continue;
      try {
        const existing = await this.registry.getModel(n.id);
        if (!existing) {
          await this.registry.registerModel(toRegistryShape(n, id));
          discovered++;
          newIds.push(n.id);
        } else {
          const patch = {};
          if (n.contextWindow && n.contextWindow !== existing.contextWindow) {
            patch.contextWindow = n.contextWindow;
            patch.contextSource = 'provider';
          }
          if (n.name && n.name !== existing.name) patch.name = n.name;
          if (Object.keys(patch).length) {
            await this.registry.updateModel(n.id, patch);
            updated++;
            updatedIds.push(n.id);
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
              priceIds.push(n.id);
            }
          }
        }
      } catch (e) {
        this.log.warn('discovery item failed', { model: String(n.id).slice(0, 80) });
      }
    }
    this.lastResult = { provider: id, discovered, updated, prices, at: new Date().toISOString() };
    this.log.info('discovery refresh', this.lastResult);
    if (this.changeLog && (discovered || updated || prices)) {
      try {
        if (newIds.length) this.changeLog.append({ kind: 'added', label: `${newIds.length} new model${newIds.length === 1 ? '' : 's'} from ${id}`, ids: newIds.slice(0, 20) });
        if (updatedIds.length) this.changeLog.append({ kind: 'updated', label: `${updatedIds.length} model${updatedIds.length === 1 ? '' : 's'} updated (context/name) from ${id}`, ids: updatedIds.slice(0, 20) });
        if (priceIds.length) this.changeLog.append({ kind: 'updated', label: `Pricing updated for ${priceIds.length} model${priceIds.length === 1 ? '' : 's'} from ${id}`, ids: priceIds.slice(0, 20) });
      } catch { /* best-effort */ }
    }
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
      contextWindow: 64000, contextSource: 'default',
      quality: null, qualitySource: 'unknown',
      avgLatencyMs: null, latencySource: 'unknown',
      reliability: null, reliabilitySource: 'unknown',
      inputPer1k: null, outputPer1k: null, cachedPer1k: null,
      pricingSource: 'unknown',
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
