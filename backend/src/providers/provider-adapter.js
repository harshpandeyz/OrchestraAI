'use strict';

// Canonical provider layer (Session 5).
//
//   ProviderAdapter (base)
//     -> OpenRouterAdapter   (first real gateway: many models, one API)
//     -> OpenAIAdapter       (OpenAI + any OpenAI-compatible gateway)
//     -> AnthropicAdapter    (Anthropic Messages API)
//     -> DemoProviderAdapter (explicit labelled mock; DEMO mode + tests only)
//
//   ProviderRegistry — owns adapters, resolves credentials from config (never
//   committed keys), exposes one `complete()` and one `listModels()`.
//
// All completions return a NORMALIZED response — the orchestrator never parses
// provider-specific shapes:
//
//   {
//     text: string,
//     toolCalls: [{ id, name, arguments }],
//     usage: { inputTokens, outputTokens, cachedTokens },
//     latencyMs, providerLatencyMs,
//     model, provider, stopReason,
//     raw: <provider payload, never logged>
//   }
//
// Errors are normalized to ProviderError { code, retryable, status, message }.
// Safe messages only — no keys, no secrets, no stack traces.

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = options.code || 'unknown';
    this.retryable = !!options.retryable;
    this.status = options.status ?? null;
    this.provider = options.provider || null;
  }

  toSafeJSON() {
    return { error: this.message, code: this.code, retryable: this.retryable };
  }
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (status === 429) return { code: 'rate_limit', retryable: true };
  if (status === 400 || status === 422) return { code: 'bad_request', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status >= 500) return { code: 'unavailable', retryable: true };
  return { code: 'unknown', retryable: false };
}

class ProviderAdapter {
  constructor(providerId, options = {}) {
    this.providerId = providerId;
    this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || 60000;
    this.defaultModel = options.defaultModel || null;
    this.appName = options.appName || 'orchestraai';
  }

  get hasCredentials() {
    return !!this.apiKey;
  }

  async complete() {
    throw new ProviderError(`complete() not implemented for ${this.providerId}`, { code: 'unknown', provider: this.providerId });
  }

  async listModels() {
    throw new ProviderError(`listModels() not implemented for ${this.providerId}`, { code: 'unknown', provider: this.providerId });
  }

  async healthCheck() {
    try {
      await this.listModels();
      return { provider: this.providerId, healthy: true };
    } catch (e) {
      return { provider: this.providerId, healthy: false, code: e.code || 'unknown' };
    }
  }

  async _fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    // Honor caller cancellation: if their signal aborts, abort ours too.
    const onCallerAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
      if (!res.ok) {
        const safeDetail = data && data.error
          ? String(data.error.message || data.error.code || JSON.stringify(data.error)).slice(0, 300)
          : `HTTP ${res.status}`;
        const cls = classifyHttpStatus(res.status);
        throw new ProviderError(`${this.providerId} request failed: ${safeDetail}`, { ...cls, status: res.status, provider: this.providerId });
      }
      return data;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e && e.name === 'AbortError') {
        const callerAborted = options.signal && options.signal.aborted;
        throw new ProviderError(
          callerAborted ? `${this.providerId} request cancelled` : `${this.providerId} request timed out`,
          { code: callerAborted ? 'cancelled' : 'timeout', retryable: !callerAborted, provider: this.providerId }
        );
      }
      throw new ProviderError(`${this.providerId} network error`, { code: 'unavailable', retryable: true, provider: this.providerId });
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  _authHeaders(extra = {}) {
    return { ...extra };
  }
}

// OpenAI-style chat completions. Used by OpenAI and OpenRouter.
class OpenAICompatibleAdapter extends ProviderAdapter {
  constructor(providerId, options = {}) {
    super(providerId, options);
    this.chatPath = options.chatPath || '/chat/completions';
    this.modelsPath = options.modelsPath || '/models';
  }

  _authHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  // messages: [{role, content}] (content may be string). tools: OpenAI-style array.
  async complete(request = {}) {
    const model = request.model || this.defaultModel;
    if (!model) throw new ProviderError(`No model configured for ${this.providerId}`, { code: 'bad_request', provider: this.providerId });
    const started = Date.now();
    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens || 1024,
    };
    if (request.tools && request.tools.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }
    if (request.jsonMode) body.response_format = { type: 'json_object' };
    const data = await this._fetchJson(this.baseUrl + this.chatPath, {
      method: 'POST',
      headers: this._authHeaders(this.extraHeaders()),
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    const latencyMs = Date.now() - started;
    return this._normalizeCompletion(data, { model, latencyMs });
  }

  extraHeaders() {
    return {};
  }

  _normalizeCompletion(data, meta) {
    const choice = (data && data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => {
      let args = {};
      try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
      catch { args = { _raw: String(tc.function?.arguments || '').slice(0, 2000) }; }
      return { id: tc.id || `call-${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name || 'unknown', arguments: args };
    });
    const usage = data?.usage || {};
    return {
      text: typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : ''),
      toolCalls,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
      },
      latencyMs: meta.latencyMs,
      providerLatencyMs: null,
      model: data?.model || meta.model,
      provider: this.providerId,
      stopReason: choice.finish_reason || (toolCalls.length ? 'tool_calls' : 'stop'),
      raw: data,
    };
  }

  async listModels() {
    const data = await this._fetchJson(this.baseUrl + this.modelsPath, { method: 'GET', headers: this._authHeaders(this.extraHeaders()) });
    const items = Array.isArray(data?.data) ? data.data : [];
    return items.map((m) => this.normalizeModel(m));
  }

  normalizeModel(raw) {
    return {
      id: raw.id,
      name: raw.name || raw.id,
      provider: this.providerId,
      contextWindow: raw.context_length || raw.context_window || 0,
      pricing: {
        inputPer1k: raw.pricing?.prompt ? Number(raw.pricing.prompt) * 1000 : null,
        outputPer1k: raw.pricing?.completion ? Number(raw.pricing.completion) * 1000 : null,
        cachedPer1k: null,
      },
      capabilities: { text: true },
      raw,
    };
  }
}

class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor(options = {}) {
    super('openrouter', { baseUrl: 'https://openrouter.ai/api', ...options });
    this.chatPath = '/v1/chat/completions';
    this.modelsPath = '/v1/models';
  }

  extraHeaders() {
    return {
      'HTTP-Referer': this.appName,
      'X-Title': this.appName,
    };
  }

  normalizeModel(raw) {
    const perToken = (v) => (v === undefined || v === null || v === '' ? null : Number(v) * 1000);
    const params = raw.supported_parameters || [];
    return {
      id: raw.id,
      name: raw.name || raw.id,
      provider: 'openrouter',
      contextWindow: raw.context_length || raw.top_provider?.context_length || 0,
      pricing: {
        inputPer1k: perToken(raw.pricing?.prompt),
        outputPer1k: perToken(raw.pricing?.completion),
        cachedPer1k: perToken(raw.pricing?.input_cache_read),
      },
      capabilities: {
        text: true,
        tools: params.includes('tools') || params.includes('tool_choice'),
        structured_output: params.includes('structured_outputs') || params.includes('response_format'),
        vision: params.includes('image') || (raw.architecture?.modality || '').includes('image'),
      },
      raw,
    };
  }
}

class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(options = {}) {
    super('openai', { baseUrl: 'https://api.openai.com', ...options });
    this.chatPath = '/v1/chat/completions';
    this.modelsPath = '/v1/models';
  }
}

class AnthropicAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('anthropic', { baseUrl: 'https://api.anthropic.com', ...options });
  }

  _authHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...extra,
    };
  }

  async complete(request = {}) {
    const model = request.model || this.defaultModel;
    if (!model) throw new ProviderError('No model configured for anthropic', { code: 'bad_request', provider: this.providerId });
    const started = Date.now();
    const system = (request.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const messages = (request.messages || [])
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
    const body = { model, system: system || undefined, messages, max_tokens: request.maxTokens || 1024, temperature: request.temperature ?? 0.2 };
    if (request.tools && request.tools.length) {
      body.tools = request.tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
    }
    const data = await this._fetchJson(this.baseUrl + '/v1/messages', {
      method: 'POST', headers: this._authHeaders(), body: JSON.stringify(body),
      timeoutMs: request.timeoutMs, signal: request.signal,
    });
    const latencyMs = Date.now() - started;
    const toolCalls = [];
    let text = '';
    for (const block of data?.content || []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
    }
    return {
      text, toolCalls,
      usage: {
        inputTokens: data?.usage?.input_tokens ?? estimateTokens(JSON.stringify(messages)),
        outputTokens: data?.usage?.output_tokens ?? estimateTokens(text),
        cachedTokens: (data?.usage?.cache_read_input_tokens ?? 0),
      },
      latencyMs, providerLatencyMs: null, model: data?.model || model,
      provider: this.providerId, stopReason: data?.stop_reason || (toolCalls.length ? 'tool_use' : 'end_turn'),
      raw: data,
    };
  }

  async listModels() {
    const data = await this._fetchJson(this.baseUrl + '/v1/models', { method: 'GET', headers: this._authHeaders() });
    return (data?.data || []).map((m) => ({
      id: m.id, name: m.display_name || m.id, provider: 'anthropic',
      contextWindow: 200000, pricing: { inputPer1k: null, outputPer1k: null, cachedPer1k: null },
      capabilities: { text: true, tools: true }, raw: m,
    }));
  }
}

// Deterministic mock implementing the SAME interface. DEMO mode + tests only.
// Never used when mode=live. Behaviour is content-driven (not random) so the
// real agent loop — tool selection, tool execution, retries — is exercised.
class DemoProviderAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('demo', options);
    this.defaultModel = options.defaultModel || 'demo-model';
  }

  get hasCredentials() {
    return true;
  }

  async complete(request = {}) {
    const started = Date.now();
    if (request.signal && request.signal.aborted) {
      throw new ProviderError('demo request cancelled', { code: 'cancelled', provider: 'demo' });
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 60);
      if (request.signal) request.signal.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError('demo request cancelled', { code: 'cancelled', provider: 'demo' })); }, { once: true });
    });
    const lastUser = [...(request.messages || [])].reverse().find((m) => m.role === 'user');
    const text = String(lastUser?.content || '').toLowerCase();
    const toolNames = new Set((request.tools || []).map((t) => t.function?.name));
    const toolCalls = [];
    const alreadyHave = (name) => (request.messages || []).some((m) => m.role === 'tool' && m.name === name);
    // Content-driven tool requests so the real tool loop is exercised.
    if ((/test|fail|bug|spec/.test(text)) && toolNames.has('run_tests') && !alreadyHave('run_tests')) {
      toolCalls.push({ id: 'demo-call-1', name: 'run_tests', arguments: { suite: 'session' } });
    } else if ((/read|file|auth|code|inspect/.test(text)) && toolNames.has('read_file') && !alreadyHave('read_file')) {
      toolCalls.push({ id: 'demo-call-1', name: 'read_file', arguments: { path: 'auth/service.ts' } });
    } else if ((/search|find|where/.test(text)) && toolNames.has('search_code') && !alreadyHave('search_code')) {
      toolCalls.push({ id: 'demo-call-1', name: 'search_code', arguments: { query: lastUser?.content ? String(lastUser.content).slice(0, 120) : 'auth' } });
    }
    const hasToolResults = (request.messages || []).some((m) => m.role === 'tool');
    let out;
    if (toolCalls.length) {
      out = `I'll ${toolCalls[0].name === 'run_tests' ? 'run the test suite' : toolCalls[0].name === 'read_file' ? 'read the relevant file' : 'search the codebase'} first, then continue.`;
    } else if (hasToolResults) {
      const summary = (request.messages || []).filter((m) => m.role === 'tool').map((m) => `${m.name}: ${String(m.content).slice(0, 160)}`).join(' | ');
      out = `Done. Based on tool results (${summary || 'no output'}), the task is complete. No further actions required.`;
    } else {
      out = `Understood: "${String(lastUser?.content || '').slice(0, 200)}". Completed analysis with the available context. No further actions required.`;
    }
    const inputTokens = estimateTokens(JSON.stringify(request.messages || []));
    const outputTokens = estimateTokens(out);
    return {
      text: out, toolCalls,
      usage: { inputTokens, outputTokens, cachedTokens: 0 },
      latencyMs: Date.now() - started, providerLatencyMs: null,
      model: request.model || this.defaultModel, provider: 'demo',
      stopReason: toolCalls.length ? 'tool_calls' : 'stop', raw: { demo: true },
    };
  }

  async listModels() {
    return [];
  }
}

class ProviderRegistry {
  constructor(config, options = {}) {
    this.config = config;
    this.adapters = new Map();
    this.demoAdapter = new DemoProviderAdapter({ defaultModel: 'demo-model' });
    this.createAdapter = options.createAdapter || null;
  }

  getAdapter(providerId) {
    const id = (providerId || this.config.provider || 'openrouter').toLowerCase();
    if (this.adapters.has(id)) return this.adapters.get(id);
    const c = this.config.providers?.[id] || {};
    let adapter;
    if (this.createAdapter) {
      adapter = this.createAdapter(id, c);
    } else if (id === 'openrouter') {
      adapter = new OpenRouterAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, appName: c.appName, timeoutMs: this.config.providerTimeoutMs });
    } else if (id === 'openai') {
      adapter = new OpenAIAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
    } else if (id === 'anthropic') {
      adapter = new AnthropicAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
    } else {
      adapter = new OpenAIAdapter({ apiKey: c.apiKey || '', baseUrl: c.baseUrl || '', defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
      adapter.providerId = id;
    }
    this.adapters.set(id, adapter);
    return adapter;
  }

  // The adapter the runtime must use. In demo mode this is ALWAYS the mock.
  resolveForRun(mode, providerId) {
    if (mode === 'demo') return this.demoAdapter;
    const adapter = this.getAdapter(providerId);
    if (!adapter.hasCredentials) {
      throw new ProviderError(`No API key configured for provider "${adapter.providerId}". Set ${adapter.providerId.toUpperCase()}_API_KEY or run with RUNTIME_MODE=demo.`, { code: 'auth', provider: adapter.providerId });
    }
    return adapter;
  }
}

module.exports = {
  estimateTokens,
  ProviderError,
  ProviderAdapter,
  OpenAICompatibleAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  DemoProviderAdapter,
  ProviderRegistry,
};
