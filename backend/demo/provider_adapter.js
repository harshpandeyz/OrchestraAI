'use strict';

// ProviderAdapter — abstraction layer for model provider APIs.
// Shields the rest of the system from provider-specific formats.
// Supports: OpenAI, Anthropic, OpenRouter, local/Ollama, enterprise/private gateways.

class ProviderAdapter {
  constructor(providerId, options = {}) {
    this.providerId = providerId;
    this.endpoint = options.endpoint || null;
    this.apiKey = options.apiKey; // never logged; use env config
    this.region = options.region || null;
    this.timeout = options.timeout || 30000;
    selfRefresh = options.selfRefresh || false;
    this.defaultHeaders = options.defaultHeaders || {};
    this.modelsCache = new Map(); // model_id -> raw provider metadata
    this.lastRefresh = 0;
    this.refreshInterval = options.refreshInterval || 300000; // 5 min default
  }

  // ---- Core API operations (provider-agnostic) ----

  async listModels() {
    // Implemented by subclasses or dynamic dispatch
    throw new Error('listModels not implemented — use concrete adapter or dynamic dispatch');
  }

  async getModelInfo(modelId) {
    // Implemented by subclasses
    throw new Error('getModelInfo not implemented');
  }

  async healthCheck(modelId) {
    // Implemented by subclasses
    throw new Error('healthCheck not implemented');
  }

  async estimateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
    // Implemented by subclasses
    throw new Error('estimateCost not implemented');
  }

  // ---- Concrete provider integrations ----

  // OpenAI-compatible gateway (OpenAI, Anthropic via gateway, etc.)
  async _openaiLike(path, method = 'GET', body = null) {
    if (!this.endpoint) throw new Error('No endpoint configured');
    const url = new URL(path, this.endpoint).toString();
    const fetch = (await import('node-fetch')).default;
    const headers = { ...this.defaultHeaders, 'Content-Type': 'application/json' };
    const options = {
      method,
      headers,
      timeout: this.timeout,
    };
    if (body !== null && body !== undefined) {
      options.body = JSON.stringify(body);
    }
    if (this.apiKey) {
      options.headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Provider API ${resp.status}: ${txt}`);
    }
    return resp.json();
  }

  // Normalize a raw provider model into a partial ModelDefinition
  normalizeModel(raw) {
    // Base normalization — subclasses may override
    return {
      model_id: raw.id || raw.model || raw.name,
      canonical_name: raw.name || raw.model || raw.id || 'unknown',
      provider_id: this.providerId,
      display_name: raw.name || raw.model || raw.id || 'unknown',
      version: raw.version || raw.model_name || '0.0.1',
      status: raw.status || 'healthy',
      capabilities: this._normalizeCapabilities(raw.capabilities || raw.tool_calling || {}),
      limits: {
        context_window: raw.context_window || raw.max_ctx || raw.context_length || 0,
        max_output_tokens: raw.max_output_tokens || raw.max_tokens || 0,
      },
      metadata: { source: 'provider', raw_metadata: raw },
    };
  }

  _normalizeCapabilities(raw) {
    if (!raw) return { ...DEFAULT.capabilities };
    if (typeof raw === 'string') {
      const caps = { ...DEFAULT.capabilities };
      ;(raw || '').split(',').forEach(c => c.trim().toLowerCase()).forEach(c => { if (c in caps) caps[c] = true; });
      return caps;
    }
    if (Array.isArray(raw)) {
      const caps = { ...DEFAULT.capabilities };
      raw.forEach(c => { if (c in caps) caps[c] = true; });
      return caps;
    }
    if (typeof raw === 'object') {
      const caps = { ...DEFAULT.capabilities };
      // Check for known capability keys
      const known = ['text', 'vision', 'audio', 'image', 'tool_calling', 'structured_output', 'reasoning', 'coding', 'embeddings', 'agent'];
      known.forEach(k => { if (k in raw) caps[k] = !!raw[k]; });
      return caps;
    }
    return { ...DEFAULT.capabilities };
  }

  // Cache-wrapped refresh
  async refreshModels(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRefresh < this.refreshInterval) {
      return this.modelsCache; // return cached
    }
    try {
      const raw = await this.listModels();
      this.modelsCache.clear();
      for (const rawModel of Array.isArray(raw) ? raw : [raw]) {
        const normalized = this.normalizeModel(rawModel);
        const mid = normalized.model_id;
        if (mid) {
          this.modelsCache.set(mid, { raw: rawModel, normalized });
          this.providers.get(this.providerId)?.models.add(mid);
        }
      }
      this.lastRefresh = now;
    } catch (e) {
      // Log silently — do not crash the runtime
      console.warn(`[ProviderAdapter ${this.providerId}] refresh failed: ${e.message}`);
    }
    return this.modelsCache;
  }
}

// ---- Concrete: OpenAI ----

class OpenAIAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('openai', options);
  }

  async listModels() {
    return this._openaiLike('/v1/models');
  }

  async getModelInfo(modelId) {
    return this._openaiLike(`/v1/models/${modelId}`);
  }

  async healthCheck(modelId) {
    const info = await this.getModelInfo(modelId);
    return {
      availability: 1,
      latency: info.response_ms || null,
      error_rate: 0,
    };
  }

  async estimateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
    // OpenAI pricing model — base rates, overridden by registry
    const modelInfo = await this.getModelInfo(modelId);
    const per1k = modelInfo.pricing_per_1k || {};
    const inputPrice = (per1k.input || 0) / 1000;
    const outputPrice = (per1k.output || 0) / 1000;
    const cachedPrice = per1k.cached !== undefined ? (per1k.cached / 1000) : null;

    const inputCost = inputTokens * inputPrice / 1000;
    const outputCost = outputTokens * outputPrice / 1000;
    const cachedCost = cachedTokens * (cachedPrice || 0) / 1000;

    return { inputCost, outputCost, cachedCost, total: inputCost + outputCost + cachedCost };
  }
}

// ---- Concrete: Anthropic ----

class AnthropicAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('anthropic', options);
  }

  async listModels() {
    return this._openaiLike('/v1/models', 'GET');
  }

  async getModelInfo(modelId) {
    return this._openaiLike(`/v1/models/${modelId}`);
  }

  async healthCheck(modelId) {
    const info = await this.getModelInfo(modelId);
    return {
      availability: 1,
      latency: info.response_ms || null,
      error_rate: 0,
    };
  }

  async estimateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
    const modelInfo = await this.getModelInfo(modelId);
    // Anthropic pricing
    const inputPrice = (modelInfo.pricing && modelInfo.pricing.input_per_1k) || 0.003; // placeholder
    const outputPrice = (modelInfo.pricing && modelInfo.pricing.output_per_1k) || 0.015; // placeholder
    // ... simplified
    return { inputCost: inputTokens * inputPrice / 1000, outputCost: outputTokens * outputPrice / 1000, cachedCost: 0, total: 0 };
  }
}

// ---- Concrete: OpenRouter ----

class OpenRouterAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('openrouter', options);
  }

  async listModels() {
    if (!this.endpoint) throw new Error('OpenRouter endpoint required');
    const fetch = (await import('node-fetch')).default;
    const url = new URL('/v1/models', this.endpoint).toString();
    const headers = { ...this.defaultHeaders, 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const resp = await fetch(url, { method: 'GET', headers, timeout: this.timeout });
    if (!resp.ok) throw new Error(`OpenRouter API ${resp.status}`);
    return resp.json();
  }

  normalizeModel(raw) {
    // OpenRouter-specific normalization
    return {
      model_id: raw.id,
      canonical_name: raw.name || raw.id,
      provider_id: this.providerId,
      display_name: raw.name || raw.id,
      version: raw.version || '0.0.1',
      status: raw.status || 'healthy',
      capabilities: this._normalizeCapabilities(raw.capabilities || {}),
      limits: {
        context_window: raw.max_ctx || raw.context_length || 0,
        max_output_tokens: raw.max_output_tokens || 0,
      },
      metadata: { source: 'openrouter', raw_metadata: raw },
    };
  }
}

// ---- Singleton factory ----

const adapters = new Map();

function getAdapter(providerId, options = {}) {
  if (adapters.has(providerId)) return adapters.get(providerId);
  let adapter;
  switch (providerId.toLowerCase()) {
    case 'openai': adapter = new OpenAIAdapter(options); break;
    case 'anthropic': adapter = new AnthropicAdapter(options); break;
    case 'openrouter': adapter = new OpenRouterAdapter(options); break;
    default:
      // Generic adapter — uses base class methods; provider must supply listModels/getModelInfo
      adapter = new ProviderAdapter(providerId, options);
  }
  adapters.set(providerId, adapter);
  return adapter;
}

module.exports = { ProviderAdapter, OpenAIAdapter, AnthropicAdapter, OpenRouterAdapter, getAdapter };