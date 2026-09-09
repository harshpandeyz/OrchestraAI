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

const { redact } = require('../config');

function safeProviderDetail(value, apiKey = '') {
  let detail = String(value || '');
  if (apiKey) detail = detail.split(apiKey).join('[REDACTED]');
  return redact(detail).slice(0, 300);
}

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
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status === 409) return { code: 'conflict', retryable: false };
  if (status === 400 || status === 422) return { code: 'bad_request', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status >= 500) return { code: 'unavailable', retryable: true };
  return { code: 'unknown', retryable: false };
}

function normalizedUsage(usage = {}) {
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const outputDetails = usage.completion_tokens_details || usage.output_tokens_details || {};
  const cost = Number(usage.cost ?? usage.cost_usd ?? usage.costUsd);
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    inputTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    cachedTokens: numberOrNull(promptDetails.cached_tokens ?? usage.cached_tokens),
    reasoningTokens: numberOrNull(outputDetails.reasoning_tokens ?? usage.reasoning_tokens),
    ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
    cacheWriteTokens: numberOrNull(promptDetails.cache_write_tokens),
  };
}

function parseSseData(buffer, options = {}) {
  const normalized = String(buffer || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hasDelimiter = normalized.includes('\n\n');
  const frames = normalized.split('\n\n');
  let remainder = frames.pop() || '';
  // A provider/proxy may close immediately after a single complete SSE line
  // without sending the usual blank-line delimiter. Only callers explicitly
  // flushing at stream end may treat that final line as a frame; otherwise a
  // partial JSON payload remains buffered for the next network chunk.
  if (options.flush === true && !hasDelimiter && remainder.trim()) {
    frames.push(remainder);
    remainder = '';
  }
  const events = [];
  for (const frame of frames) {
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // comments/heartbeats
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n').trim();
    if (!raw) continue;
    if (raw === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push(JSON.parse(raw)); } catch { /* malformed frames are ignored safely */ }
  }
  return { events, remainder };
}

// Translate the normalized OpenAI-style conversation used by the
// orchestrator into Anthropic's role/content-block contract. In particular,
// an assistant tool call is followed by a user message containing one or more
// tool_result blocks; flattening these to strings loses the tool-use turn and
// causes Anthropic to reject or misinterpret the continuation.
function anthropicContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  return content == null ? '' : JSON.stringify(content);
}

function normalizeAnthropicMessages(messages = []) {
  const normalized = [];
  const appendToolResult = (message) => {
    const last = normalized[normalized.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(message);
    else normalized.push({ role: 'user', content: [message] });
  };

  for (const message of messages) {
    if (!message || message.role === 'system') continue;
    if (message.role === 'tool') {
      appendToolResult({
        type: 'tool_result',
        tool_use_id: message.tool_call_id || message.toolCallId || message.id || null,
        content: anthropicContentText(message.content),
      });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = [];
    if (Array.isArray(message.content)) blocks.push(...message.content);
    else if (message.content !== undefined && message.content !== null && String(message.content)) {
      blocks.push({ type: 'text', text: String(message.content) });
    }
    for (const call of message.tool_calls || []) {
      blocks.push({
        type: 'tool_use',
        id: call.id || `call-${blocks.length}`,
        name: call.name || call.function?.name || 'unknown',
        input: call.arguments || call.function?.arguments || {},
      });
    }
    normalized.push({ role, content: blocks.length ? blocks : anthropicContentText(message.content) });
  }
  return normalized;
}

// Model-access failure: the provider states the *model* is unknown or not
// accessible with the current credentials/tier (e.g. OpenRouter 404 "No
// endpoints found for <model>", "model is unavailable for free"). Distinct
// from key auth (401/invalid key), billing, and rate limits: retrying the
// SAME model cannot succeed, but failing over to another model can.
// Pure + deterministic (unit-tested); message matching is deliberately narrow
// so generic 4xx errors keep their existing codes.
function isModelAccessFailure(status, detail) {
  const text = String(detail || '');
  if (!text) return false;
  if (status === 404) {
    // Any provider 404 on a completions call names a model the API will not
    // serve (unknown id, withdrawn model, or no serving endpoints for tier).
    return true;
  }
  if ((status === 400 || status === 422) && /no endpoints found|unknown model|invalid model|model .*not (found|supported|available)|model .*unavailable/i.test(text)) {
    return true;
  }
  if (status === 403 && /model/i.test(text)) {
    return true;
  }
  return false;
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

  async complete(request = {}) {
    throw new ProviderError(`complete() not implemented for ${this.providerId}`, { code: 'unknown', provider: this.providerId });
  }

  // Native adapters override this with provider SSE. The base contract stays
  // explicit so injected/demo adapters can use complete() without pretending
  // a completed response was streamed.
  async stream(request = {}) {
    void request;
    throw new ProviderError(`stream() not implemented for ${this.providerId}`, { code: 'unknown', provider: this.providerId });
  }

  // Request validation shared by all adapters (fail fast, no network).
  validateCompleteRequest(request = {}) {
    if (!request || typeof request !== 'object') {
      throw new ProviderError('complete() requires a request object', { code: 'bad_request', provider: this.providerId });
    }
    // messages must be an array; empty is allowed (provider/stub decides).
    // Shape-check entries only when present so existing callers/tests that
    // exercise error paths with minimal messages keep working.
    if (!Array.isArray(request.messages)) {
      throw new ProviderError('complete() requires messages[]', { code: 'bad_request', provider: this.providerId });
    }
    for (const m of request.messages) {
      if (!m || typeof m.role !== 'string' || typeof m.content === 'undefined') {
        throw new ProviderError('each message requires { role, content }', { code: 'bad_request', provider: this.providerId });
      }
    }
    if (request.maxTokens !== undefined && !(Number.isFinite(request.maxTokens) && request.maxTokens > 0 && request.maxTokens <= 128000)) {
      throw new ProviderError('maxTokens must be 1..128000', { code: 'bad_request', provider: this.providerId });
    }
    if (request.timeoutMs !== undefined && !(Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 600000)) {
      throw new ProviderError('timeoutMs must be 1..600000', { code: 'bad_request', provider: this.providerId });
    }
  }

  async listModels() {
    throw new ProviderError(`listModels() not implemented for ${this.providerId}`, { code: 'unknown', provider: this.providerId });
  }

  async healthCheck() {
    try {
      await this.verifyCredentials();
      return { provider: this.providerId, healthy: true };
    } catch (e) {
      return { provider: this.providerId, healthy: false, code: e.code || 'unknown' };
    }
  }

  // Lightweight auth verification: proves the KEY works without spending
  // tokens on a completion. Providers override with their auth-gated probe.
  async verifyCredentials() {
    await this.listModels();
    return { ok: true };
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
          ? safeProviderDetail(data.error.message || data.error.code || JSON.stringify(data.error), this.apiKey)
          : `HTTP ${res.status}`;
        // Model-access failures are non-terminal for the RUN (failover to the
        // next viable candidate) but terminal for the MODEL (never retry same).
        const cls = isModelAccessFailure(res.status, safeDetail)
          ? { code: 'model_unavailable', retryable: false }
          : classifyHttpStatus(res.status);
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

  // Streaming transport keeps the provider response open and returns the
  // abort/cleanup hooks to the adapter. Errors are normalized before any
  // consumer sees the stream.
  async _openStream(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
    };
    try {
      const response = await fetch(url, {
        method: options.method || 'POST',
        headers: options.headers || {}, body: options.body, signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        const detail = data?.error ? safeProviderDetail(data.error.message || data.error.code || JSON.stringify(data.error), this.apiKey) : `HTTP ${response.status}`;
        const cls = isModelAccessFailure(response.status, detail) ? { code: 'model_unavailable', retryable: false } : classifyHttpStatus(response.status);
        cleanup();
        throw new ProviderError(`${this.providerId} request failed: ${detail}`, { ...cls, status: response.status, provider: this.providerId });
      }
      return { response, cleanup };
    } catch (e) {
      cleanup();
      if (e instanceof ProviderError) throw e;
      if (e && e.name === 'AbortError') {
        const callerAborted = options.signal && options.signal.aborted;
        throw new ProviderError(callerAborted ? `${this.providerId} request cancelled` : `${this.providerId} request timed out`, {
          code: callerAborted ? 'cancelled' : 'timeout', retryable: !callerAborted, provider: this.providerId,
        });
      }
      throw new ProviderError(`${this.providerId} network error`, { code: 'unavailable', retryable: true, provider: this.providerId });
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
    this.validateCompleteRequest(request);
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

  // Native provider SSE. The orchestrator receives deltas as they arrive and
  // only records usage once the provider sends its terminal usage frame.
  async *stream(request = {}) {
    this.validateCompleteRequest(request);
    const model = request.model || this.defaultModel;
    if (!model) throw new ProviderError(`No model configured for ${this.providerId}`, { code: 'bad_request', provider: this.providerId });
    const body = {
      model, messages: request.messages, temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens || 1024, stream: true,
    };
    if (request.tools && request.tools.length) { body.tools = request.tools; body.tool_choice = 'auto'; }
    if (request.jsonMode) body.response_format = { type: 'json_object' };
    // OpenAI supports this; OpenRouter ignores the deprecated hint but sends
    // usage on its final SSE frame, so this is safe for both adapters.
    body.stream_options = { include_usage: true };
    const opened = await this._openStream(this.baseUrl + this.chatPath, {
      method: 'POST', headers: this._authHeaders(this.extraHeaders()), body: JSON.stringify(body),
      timeoutMs: request.timeoutMs, signal: request.signal,
    });
    const started = Date.now();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = {};
    let finishReason = null;
    let requestId = null;
    let providerMetadata = null;
    const toolState = new Map();
    try {
      for await (const chunk of opened.response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const parsed = parseSseData(buffer);
        buffer = parsed.remainder;
        for (const data of parsed.events) {
          if (data.done) continue;
          if (data.id) requestId = data.id;
          if (data.provider || data.metadata?.provider) providerMetadata = data.provider || data.metadata.provider;
          const choice = data?.choices?.[0] || {};
          const delta = choice.delta || {};
          const content = typeof delta.content === 'string' ? delta.content : '';
          if (content) { text += content; yield { delta: content, raw: data }; }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          for (const tool of delta.tool_calls || []) {
            const index = Number(tool.index) || 0;
            const existing = toolState.get(index) || { id: tool.id || `call-${index}`, name: '', args: '' };
            existing.id = tool.id || existing.id;
            existing.name = tool.function?.name || existing.name;
            existing.args += String(tool.function?.arguments || '');
            toolState.set(index, existing);
          }
          if (data.usage) usage = normalizedUsage(data.usage);
        }
      }
      if (buffer.trim().startsWith('data:')) {
        const parsed = parseSseData(`${buffer}\n`, { flush: true });
        for (const data of parsed.events) if (data.usage) usage = normalizedUsage(data.usage);
      }
    } finally {
      opened.cleanup();
    }
    const toolCalls = Array.from(toolState.values()).map((tool) => {
      let args = {};
      try { args = tool.args ? JSON.parse(tool.args) : {}; } catch { args = { _raw: tool.args.slice(0, 2000) }; }
      return { id: tool.id, name: tool.name || 'unknown', arguments: args };
    });
    yield {
      done: true, text, toolCalls, usage,
      latencyMs: Date.now() - started, providerLatencyMs: null,
      model, provider: this.providerId,
      stopReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
      ...(requestId ? { requestId } : {}),
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }

  extraHeaders() {
    return {};
  }

  // OpenAI's /v1/models requires auth — a 200 proves the key.
  async verifyCredentials() {
    await this._fetchJson(this.baseUrl + this.modelsPath, {
      method: 'GET', headers: this._authHeaders(this.extraHeaders()), timeoutMs: 20000,
    });
    return { ok: true };
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
    const usage = normalizedUsage(data?.usage || {});
    return {
      text: typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : ''),
      toolCalls,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      },
      latencyMs: meta.latencyMs,
      providerLatencyMs: null,
      model: data?.model || meta.model,
      provider: this.providerId,
      stopReason: choice.finish_reason || (toolCalls.length ? 'tool_calls' : 'stop'),
      requestId: data?.id || null,
      ...(data?.provider || data?.metadata?.provider ? { providerMetadata: data.provider || data.metadata.provider } : {}),
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

  // OpenRouter's /v1/models is PUBLIC (keyless 200 proves nothing), so auth
  // is verified against the auth-gated /v1/auth/key endpoint instead.
  async verifyCredentials() {
    await this._fetchJson(this.baseUrl + '/v1/auth/key', {
      method: 'GET', headers: this._authHeaders(this.extraHeaders()), timeoutMs: 20000,
    });
    return { ok: true };
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
    this.validateCompleteRequest(request);
    const model = request.model || this.defaultModel;
    if (!model) throw new ProviderError('No model configured for anthropic', { code: 'bad_request', provider: this.providerId });
    const started = Date.now();
    const system = (request.messages || []).filter((m) => m.role === 'system')
      .map((m) => anthropicContentText(m.content)).filter(Boolean).join('\n');
    const messages = normalizeAnthropicMessages(request.messages || []);
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
        inputTokens: data?.usage?.input_tokens ?? null,
        outputTokens: data?.usage?.output_tokens ?? null,
        cachedTokens: data?.usage?.cache_read_input_tokens ?? null,
        reasoningTokens: data?.usage?.output_tokens_details?.reasoning_tokens ?? data?.usage?.reasoning_tokens ?? null,
        ...(Number.isFinite(Number(data?.usage?.cost)) ? { costUsd: Number(data.usage.cost) } : {}),
      },
      latencyMs, providerLatencyMs: null, model: data?.model || model,
      provider: this.providerId, stopReason: data?.stop_reason || (toolCalls.length ? 'tool_use' : 'end_turn'),
      requestId: data?.id || null,
      raw: data,
    };
  }

  async *stream(request = {}) {
    this.validateCompleteRequest(request);
    const model = request.model || this.defaultModel;
    if (!model) throw new ProviderError('No model configured for anthropic', { code: 'bad_request', provider: this.providerId });
    const system = (request.messages || []).filter((m) => m.role === 'system')
      .map((m) => anthropicContentText(m.content)).filter(Boolean).join('\n');
    const messages = normalizeAnthropicMessages(request.messages || []);
    const body = { model, system: system || undefined, messages, max_tokens: request.maxTokens || 1024, temperature: request.temperature ?? 0.2, stream: true };
    if (request.tools && request.tools.length) body.tools = request.tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
    const opened = await this._openStream(this.baseUrl + '/v1/messages', {
      method: 'POST', headers: this._authHeaders(), body: JSON.stringify(body), timeoutMs: request.timeoutMs, signal: request.signal,
    });
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = null;
    let outputTokens = null;
    let reasoningTokens = null;
    let requestId = null;
    const tools = new Map();
    const started = Date.now();
    try {
      for await (const chunk of opened.response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const parsed = parseSseData(buffer);
        buffer = parsed.remainder;
        for (const data of parsed.events) {
          if (data.type === 'message_start') {
            requestId = data.message?.id || requestId;
            const candidate = Number(data.message?.usage?.input_tokens);
            if (Number.isFinite(candidate) && candidate >= 0) inputTokens = candidate;
          }
          if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
            tools.set(data.index || 0, { id: data.content_block.id, name: data.content_block.name, args: '' });
          }
          if (data.type === 'content_block_delta') {
            if (data.delta?.type === 'text_delta' && data.delta.text) { text += data.delta.text; yield { delta: data.delta.text, raw: data }; }
            if (data.delta?.type === 'input_json_delta') {
              const tool = tools.get(data.index || 0) || { id: `call-${data.index || 0}`, name: 'unknown', args: '' };
              tool.args += String(data.delta.partial_json || ''); tools.set(data.index || 0, tool);
            }
          }
          if (data.type === 'message_delta') {
            const outputCandidate = Number(data.usage?.output_tokens);
            if (Number.isFinite(outputCandidate) && outputCandidate >= 0) outputTokens = outputCandidate;
            const reasoningCandidate = Number(data.usage?.output_tokens_details?.reasoning_tokens || data.usage?.reasoning_tokens);
            if (Number.isFinite(reasoningCandidate) && reasoningCandidate >= 0) reasoningTokens = reasoningCandidate;
          }
        }
      }
    } finally { opened.cleanup(); }
    const toolCalls = Array.from(tools.values()).map((tool) => {
      let args = {};
      try { args = tool.args ? JSON.parse(tool.args) : {}; } catch { args = { _raw: tool.args.slice(0, 2000) }; }
      return { id: tool.id, name: tool.name, arguments: args };
    });
    yield {
      done: true, text, toolCalls,
      usage: { inputTokens, outputTokens, cachedTokens: null, reasoningTokens },
      latencyMs: Date.now() - started, providerLatencyMs: null, model, provider: this.providerId,
      stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
      ...(requestId ? { requestId } : {}),
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

  // Anthropic's /v1/models requires the x-api-key header — 200 proves it.
  async verifyCredentials() {
    await this._fetchJson(this.baseUrl + '/v1/models', {
      method: 'GET', headers: this._authHeaders(), timeoutMs: 20000,
    });
    return { ok: true };
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
    const rawUserText = String(lastUser?.content || '');
    // Demo behavior is deterministic, but it still models the trust
    // boundary: routing/tool intent comes from the task section only, never
    // from retrieved memory or tool-result text.
    const taskSection = rawUserText.match(/Task content \(untrusted\):\n([\s\S]*?)(?:\n\n(?:Selected context|Retrieved memory)|$)/i);
    const text = String(taskSection ? taskSection[1] : rawUserText).toLowerCase();
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
    this.credentialResolver = options.credentialResolver || null;
    this.demoAdapter = new DemoProviderAdapter({ defaultModel: 'demo-model' });
    this.createAdapter = options.createAdapter || null;
  }

  // Fresh (uncached) adapter for verification probes — never pollutes the
  // cached runtime adapter and never persists the candidate key.
  buildFresh(providerId, keyOverride) {
    const id = (providerId || '').toLowerCase();
    const c = { ...(this.config.providers?.[id] || {}) };
    if (keyOverride !== undefined) c.apiKey = keyOverride;
    return this._build(id, c);
  }

  _build(id, c) {
    if (this.createAdapter) {
      return this.createAdapter(id, c);
    } else if (id === 'openrouter') {
      return new OpenRouterAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, appName: c.appName, timeoutMs: this.config.providerTimeoutMs });
    } else if (id === 'openai') {
      return new OpenAIAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
    } else if (id === 'anthropic') {
      return new AnthropicAdapter({ apiKey: c.apiKey, baseUrl: c.baseUrl, defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
    } else {
      const adapter = new OpenAIAdapter({ apiKey: c.apiKey || '', baseUrl: c.baseUrl || '', defaultModel: c.defaultModel, timeoutMs: this.config.providerTimeoutMs });
      adapter.providerId = id;
      return adapter;
    }
  }

  // Drop the cached adapter so the next getAdapter() picks up new credentials.
  invalidate(providerId) {
    this.adapters.delete((providerId || '').toLowerCase());
  }

  getAdapter(providerId) {
    const id = (providerId || this.config.provider || 'openrouter').toLowerCase();
    if (this.adapters.has(id)) return this.adapters.get(id);
    const c = this.config.providers?.[id] || {};
    const adapter = this._build(id, c);
    this.adapters.set(id, adapter);
    return adapter;
  }

  // Tenant-scoped credentials are resolved per run and are intentionally not
  // put in the shared adapter cache. This prevents one organization's key
  // from being reused by a concurrent run belonging to another organization.
  getAdapterForScope(providerId, scope = 'default') {
    const id = (providerId || this.config.provider || 'openrouter').toLowerCase();
    const base = { ...(this.config.providers?.[id] || {}) };
    const scoped = this.credentialResolver ? (this.credentialResolver(id, scope) || {}) : {};
    return this._build(id, { ...base, ...scoped });
  }

  // The adapter the runtime must use. In demo mode this is ALWAYS the mock.
  resolveForRun(mode, providerId, scope = 'default') {
    if (mode === 'demo') return this.demoAdapter;
    const adapter = this.credentialResolver ? this.getAdapterForScope(providerId, scope) : this.getAdapter(providerId);
    if (!adapter.hasCredentials) {
      throw new ProviderError(`No API key configured for provider "${adapter.providerId}". Set ${adapter.providerId.toUpperCase()}_API_KEY or run with RUNTIME_MODE=demo.`, { code: 'auth', provider: adapter.providerId });
    }
    return adapter;
  }
}

module.exports = {
  estimateTokens,
  normalizedUsage,
  parseSseData,
  isModelAccessFailure,
  classifyHttpStatus,
  ProviderError,
  ProviderAdapter,
  OpenAICompatibleAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  DemoProviderAdapter,
  ProviderRegistry,
};
