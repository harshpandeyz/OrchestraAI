'use strict';

// Session 1 — one authoritative resolved runtime configuration per run.
//
// Precedence (no hidden rules):
//   process defaults (env / loadConfig)
//     -> runtime configuration (RuntimeSettings persisted defaults for NEW runs)
//     -> run-specific overrides (POST /api/runs body)
//
// Only settings safe to change at runtime live in RuntimeSettings / overrides.
// Sensitive settings (API keys, workspace root, data dir) are NEVER per-run.
//
// ResolvedRunConfig {
//   maxSteps, budgetUsd, timeoutMs, maxToolCalls, maxRetries,
//   maxLatencyMs, maxContextTokens, provider
// }
//
// Every execution check MUST read ctrl.runConfig (via runConfigFor()).
// Legacy `ctrl.maxSteps` is kept as a synced alias for backward compat.

function clampInt(v, fallback, min, max) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function resolveRunConfig({ processDefaults = {}, runtimeDefaults = {}, overrides = {} } = {}) {
  const maxSteps = clampInt(
    overrides.maxSteps ?? runtimeDefaults.maxSteps ?? processDefaults.maxSteps ?? 12,
    12, 1, 50
  );
  const budgetUsd = clampFloat(
    overrides.budget ?? overrides.maxCost ?? runtimeDefaults.defaultBudgetUsd ?? processDefaults.defaultBudgetUsd ?? 0.5,
    0.5, 0, 1000
  );
  const timeoutMs = clampInt(
    overrides.runTimeoutMs ?? processDefaults.runTimeoutMs ?? 300000,
    300000, 1000, 3600000
  );
  const maxToolCalls = clampInt(
    overrides.maxToolCalls ?? processDefaults.maxToolCalls ?? 20,
    20, 1, 100
  );
  const maxRetries = clampInt(
    overrides.maxRetries ?? processDefaults.maxRetries ?? 2,
    2, 0, 10
  );
  const maxLatencyMs = clampInt(
    overrides.maxLatencyMs ?? processDefaults.runTimeoutMs ?? 300000,
    300000, 1000, 3600000
  );
  const maxContextTokens = clampInt(
    overrides.maxContextTokens ?? processDefaults.defaultMaxContextTokens ?? 64000,
    64000, 500, 1000000
  );
  const provider = typeof overrides.provider === 'string' && overrides.provider
    ? overrides.provider.slice(0, 64)
    : (processDefaults.provider || 'openrouter');

  return {
    maxSteps,
    budgetUsd,
    timeoutMs,
    maxToolCalls,
    maxRetries,
    maxLatencyMs,
    maxContextTokens,
    provider,
  };
}

// Attach resolved config to a run control record. Keeps legacy ctrl.maxSteps
// in sync (both directions) so older callers keep working.
function attachRunConfig(ctrl, resolved) {
  ctrl.runConfig = { ...resolved };
  ctrl.maxSteps = resolved.maxSteps;
  return ctrl.runConfig;
}

function runConfigFor(ctrl, globalConfig) {
  if (ctrl && ctrl.runConfig && Number.isFinite(ctrl.runConfig.maxSteps)) return ctrl.runConfig;
  // Fallback for runs created before this module existed.
  const fallbackMax = (ctrl && Number.isFinite(ctrl.maxSteps) ? ctrl.maxSteps : null)
    ?? (globalConfig && globalConfig.maxSteps) ?? 12;
  return {
    maxSteps: Math.max(1, Math.min(50, Math.floor(fallbackMax))),
    budgetUsd: (globalConfig && globalConfig.defaultBudgetUsd) ?? 0.5,
    timeoutMs: (globalConfig && globalConfig.runTimeoutMs) ?? 300000,
    maxToolCalls: (globalConfig && globalConfig.maxToolCalls) ?? 20,
    maxRetries: (globalConfig && globalConfig.maxRetries) ?? 2,
    maxLatencyMs: (globalConfig && globalConfig.runTimeoutMs) ?? 300000,
    maxContextTokens: (globalConfig && globalConfig.defaultMaxContextTokens) ?? 64000,
    provider: (ctrl && ctrl.providerId) || (globalConfig && globalConfig.provider) || 'openrouter',
  };
}

// Keep legacy direct writes (ctrl.maxSteps = N) routed into runConfig.
function syncLegacyMaxSteps(ctrl) {
  if (ctrl && ctrl.runConfig && Number.isFinite(ctrl.maxSteps)) {
    ctrl.runConfig.maxSteps = Math.max(1, Math.min(50, Math.floor(ctrl.maxSteps)));
  } else if (ctrl && !ctrl.runConfig && Number.isFinite(ctrl.maxSteps)) {
    ctrl.runConfig = { maxSteps: Math.max(1, Math.min(50, Math.floor(ctrl.maxSteps))) };
  }
}

module.exports = {
  resolveRunConfig,
  attachRunConfig,
  runConfigFor,
  syncLegacyMaxSteps,
};
