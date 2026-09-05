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

function str(env, name, fallback) {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(env, name, fallback) {
  const v = env[name];
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
    port: num(env, 'PORT', 8787),
    frontendOrigin: str(env, 'FRONTEND_ORIGIN', 'http://localhost:5173'),
    mode, // 'live' | 'demo'
    provider,
    providers: {
      openrouter: {
        apiKey: openrouterKey,
        baseUrl: str(env, 'OPENROUTER_BASE_URL', 'https://openrouter.ai/api'),
        defaultModel: str(env, 'OPENROUTER_DEFAULT_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'),
        appName: str(env, 'OPENROUTER_APP_NAME', 'orchestraai'),
      },
      openai: {
        apiKey: openaiKey,
        baseUrl: str(env, 'OPENAI_BASE_URL', 'https://api.openai.com'),
        defaultModel: str(env, 'OPENAI_DEFAULT_MODEL', 'gpt-4o-mini'),
      },
      anthropic: {
        apiKey: anthropicKey,
        baseUrl: str(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        defaultModel: str(env, 'ANTHROPIC_DEFAULT_MODEL', 'claude-3-5-haiku-latest'),
      },
    },
    providerTimeoutMs: num(env, 'PROVIDER_TIMEOUT_MS', 60000),
    runTimeoutMs: num(env, 'RUN_TIMEOUT_MS', 300000),
    maxSteps: num(env, 'RUN_MAX_STEPS', 12),
    maxToolCalls: num(env, 'RUN_MAX_TOOL_CALLS', 20),
    maxRetries: num(env, 'RUN_MAX_RETRIES', 2),
    defaultBudgetUsd: num(env, 'DEFAULT_BUDGET_USD', 0.5),
    // Business hypothesis, deliberately centralized and surfaced in every
    // economics response. This is a platform fee on eligible positive savings
    // only; it is not provider spend and is never mixed into model pricing.
    platformFeePct: Math.max(0, Math.min(1, num(env, 'PLATFORM_FEE_PCT', 0.25))),
    stripeWebhookSecret: str(env, 'STRIPE_WEBHOOK_SECRET', ''),
    defaultMaxContextTokens: num(env, 'DEFAULT_MAX_CONTEXT_TOKENS', 64000),
    discoveryEnabled: bool(env, 'DISCOVERY_ENABLED', true),
    discoveryIntervalMs: num(env, 'DISCOVERY_INTERVAL_MS', 300000),
    workspaceRoot: str(env, 'WORKSPACE_ROOT', ''),
    dataDir: str(env, 'RUNTIME_DATA_DIR', 'backend/.runtime-data'),
    dataEncryptionKey: str(env, 'DATA_ENCRYPTION_KEY', ''),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  };
}

// Names that must never appear in logs, errors, or API responses.
const SECRET_KEYS = ['api_key', 'apikey', 'authorization', 'secret', 'token', 'bearer'];

function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const k of SECRET_KEYS) {
      if (k === 'bearer') continue;
      out = out.replace(new RegExp(`(${k}[\"'\\s:=]+)([^\"'\\s,}]+)`, 'gi'), '$1[REDACTED]');
    }
    // Providers sometimes echo a masked or prefixed form of a rejected key
    // in their error body (for example, "API key provided: LLM_…"). Treat
    // those fragments as secrets too, even when the full key is not present.
    out = out.replace(/((?:api[\s_-]*key|access[\s_-]*token|secret|password)[^:=]{0,32}[:=]\s*)([^\s,}]+)/gi, '$1[REDACTED]');
    out = out.replace(/\b(?:sk-(?:ant|or-v1|proj)-|sk-|LLM_|key[_-])[A-Za-z0-9*._~+\/=~-]{8,}/gi, '[REDACTED]');
    return out.replace(/(Bearer\s+)(?!token\b)[^\s"']+/gi, '$1[REDACTED]');
  }
  return value;
}

// Fail-fast configuration validation. Production refuses to start with
// dangerous or incoherent settings instead of running half-secured.
// Returns { warnings } in non-production; throws in production for
// release-blocking misconfiguration. Never throws for missing optional keys.
function validateConfig(config, env = process.env) {
  const warnings = [];
  const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const problems = [];

  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT out of range: ${config.port}`);
  }
  const explicitMode = String(env.RUNTIME_MODE || '').toLowerCase();
  if (explicitMode && !['demo', 'live', 'auto'].includes(explicitMode)) {
    problems.push(`RUNTIME_MODE must be demo|live|auto (got ${JSON.stringify(explicitMode)})`);
  }
  if (!(config.defaultBudgetUsd >= 0)) problems.push('DEFAULT_BUDGET_USD must be >= 0');
  if (!(config.runTimeoutMs >= 1000)) problems.push('RUN_TIMEOUT_MS must be >= 1000');
  if (!(config.providerTimeoutMs >= 1000)) problems.push('PROVIDER_TIMEOUT_MS must be >= 1000');
  if (!(config.maxSteps >= 1 && config.maxSteps <= 50)) problems.push('RUN_MAX_STEPS must be 1..50');
  if (!(config.maxToolCalls >= 1 && config.maxToolCalls <= 100)) problems.push('RUN_MAX_TOOL_CALLS must be 1..100');
  if (!config.dataDir || typeof config.dataDir !== 'string') problems.push('RUNTIME_DATA_DIR is required');

  if (isProd) {
    // Secrets must never have accidental hardcoded production values, and
    // the encryption key must be present before any credential is stored.
    if (!config.dataEncryptionKey) {
      problems.push('DATA_ENCRYPTION_KEY is required in production (32 random bytes as 64 hex chars or base64)');
    }
    if (config.frontendOrigin === 'http://localhost:5173' && !env.FRONTEND_ORIGIN) {
      warnings.push('FRONTEND_ORIGIN is unset: production CORS falls back to localhost; set it to the real console origin');
    }
    if (String(env.AUTH_ENABLED || '').toLowerCase() === 'false' && !env.API_TOKEN && !env.OPERATOR_TOKEN && !env.AUTH_TOKENS) {
      warnings.push('AUTH_ENABLED=false in production with no API tokens: bearer auth is open; prefer session auth + tokens');
    }
  }

  if (problems.length) {
    const err = new Error(`invalid configuration: ${problems.join('; ')}`);
    err.code = 'config';
    err.problems = problems;
    throw err;
  }
  return { warnings };
}

module.exports = { loadConfig, validateConfig, redact, SECRET_KEYS };
