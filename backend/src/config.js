'use strict';

// Centralized runtime configuration. Every value comes from the environment with
// a safe default. NEVER read provider secrets from anywhere else.
//
// RUNTIME_MODE:
//   live — real provider calls (requires provider credentials)
//   demo — deterministic local mock provider, explicitly labelled in API/SSE/UI
//          (used for tests, offline development, and honest offline fallback)
// Mode resolves to `live` only when credentials for the configured provider exist;
// otherwise it resolves to `demo` and the server says so on /api/health.

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function loadConfig(env = process.env) {
  const provider = (env.PROVIDER || env.MODEL_PROVIDER || 'openrouter').toLowerCase();
  const openrouterKey = env.OPENROUTER_API_KEY || '';
  const openaiKey = env.OPENAI_API_KEY || '';
  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const hasKey =
    (provider === 'openrouter' && !!openrouterKey) ||
    (provider === 'openai' && !!openaiKey) ||
    (provider === 'anthropic' && !!anthropicKey) ||
    !!env.CUSTOM_PROVIDER_API_KEY;

  const explicitMode = (env.RUNTIME_MODE || '').toLowerCase();
  const mode = explicitMode === 'demo' ? 'demo' : explicitMode === 'live' ? 'live' : hasKey ? 'live' : 'demo';

  return {
    port: num('PORT', 8787),
    frontendOrigin: str('FRONTEND_ORIGIN', 'http://localhost:5173'),
    mode, // 'live' | 'demo'
    provider,
    providers: {
      openrouter: {
        apiKey: openrouterKey,
        baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api'),
        defaultModel: str('OPENROUTER_DEFAULT_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'),
        appName: str('OPENROUTER_APP_NAME', 'adaptive-agent-runtime'),
      },
      openai: {
        apiKey: openaiKey,
        baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com'),
        defaultModel: str('OPENAI_DEFAULT_MODEL', 'gpt-4o-mini'),
      },
      anthropic: {
        apiKey: anthropicKey,
        baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        defaultModel: str('ANTHROPIC_DEFAULT_MODEL', 'claude-3-5-haiku-latest'),
      },
    },
    providerTimeoutMs: num('PROVIDER_TIMEOUT_MS', 60000),
    runTimeoutMs: num('RUN_TIMEOUT_MS', 300000),
    maxSteps: num('RUN_MAX_STEPS', 12),
    maxToolCalls: num('RUN_MAX_TOOL_CALLS', 20),
    maxRetries: num('RUN_MAX_RETRIES', 2),
    defaultBudgetUsd: num('DEFAULT_BUDGET_USD', 0.5),
    defaultMaxContextTokens: num('DEFAULT_MAX_CONTEXT_TOKENS', 64000),
    discoveryEnabled: bool('DISCOVERY_ENABLED', true),
    discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 300000),
    workspaceRoot: str('WORKSPACE_ROOT', ''),
    dataDir: str('RUNTIME_DATA_DIR', 'backend/.runtime-data'),
    logLevel: str('LOG_LEVEL', 'info'),
  };
}

// Names that must never appear in logs, errors, or API responses.
const SECRET_KEYS = ['api_key', 'apikey', 'authorization', 'secret', 'token', 'bearer'];

function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const k of SECRET_KEYS) {
      out = out.replace(new RegExp(`(${k}[\"'\\s:=]+)([^\"'\\s,}]+)`, 'gi'), '$1[REDACTED]');
    }
    return out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  }
  return value;
}

module.exports = { loadConfig, redact, SECRET_KEYS };
