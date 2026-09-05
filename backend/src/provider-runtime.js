'use strict';

// Session 1 — authoritative runtime provider configuration (one source of truth).
//
// Distinctions (never conflated):
//   registered            — known adapter id (SUPPORTED_PROVIDERS)
//   credentialsConfigured — env key OR stored (encrypted) key exists
//   enabled               — not in the disabled set (env DISABLED_PROVIDERS)
//   connected             — a real verification probe succeeded (never assumed)
//   active                — the provider the runtime actually uses (config.provider)
//
// ProviderRuntimeConfig {
//   activeProvider: string,
//   availableProviders: [{ id, label, registered, credentialsConfigured,
//     enabled, active, connected, healthy, ...probe/meta }]
// }
//
// The runtime consumes `activeProvider`. API responses include it explicitly
// so the frontend never infers the active provider from incidental state.

const { SUPPORTED_PROVIDERS } = require('./providers/credential-store');

function disabledSet(env = process.env) {
  const raw = String(env.DISABLED_PROVIDERS || env.DISABLED_PROVIDER || '');
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function resolveProviderRuntime({ configuredProvider, providerStatusFn, disabled = null } = {}) {
  const active = String(configuredProvider || 'openrouter').toLowerCase();
  const dis = disabled instanceof Set ? disabled : new Set();
  const availableProviders = SUPPORTED_PROVIDERS.map((id) => {
    const st = typeof providerStatusFn === 'function' ? providerStatusFn(id) : null;
    const base = st || { id, configured: false, connected: false, healthy: null };
    return {
      ...base,
      id,
      registered: true,
      credentialsConfigured: !!base.configured,
      enabled: !dis.has(id),
      active: id === active,
    };
  });
  // Active id may be unsupported (custom gateway): still report explicitly.
  const known = availableProviders.some((p) => p.id === active);
  return {
    activeProvider: active,
    activeKnown: known,
    availableProviders,
  };
}

module.exports = { resolveProviderRuntime, disabledSet };
