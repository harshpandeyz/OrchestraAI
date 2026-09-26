'use strict';

// Production startup/readiness checks for database, Redis, encryption and
// auth configuration. Pure + unit-testable: takes plain status inputs and
// returns { ready, checks }. The HTTP layer (server.js) supplies live probe
// results; tests supply fixtures.
//
// Readiness (distinct from liveness):
//   ready === true  → the instance may accept work
//   ready === false → orchestrator/load-balancer must not route to it
//
// A non-critical provider outage never affects readiness. Missing Redis in
// a single-process deployment is degraded coordination (ready stays true
// when REDIS_URL is unset, with an explicit note); when REDIS_URL is set
// but unreachable, readiness fails closed. File datastore in production is
// a loud warning (backwards compatible), not a readiness failure, unless
// the operator requires postgres explicitly.

async function checkReadiness({
  config,
  datastoreKind = 'file',
  datastoreProbe = { ok: true },
  redis = { backend: 'memory', degraded: false },
  authConfig = { enabled: false },
} = {}) {
  // NOTE: all environment input arrives via `config` (src/config.js is the
  // only place that reads process.env). This module takes plain status
  // inputs and never touches process.env.
  const isProd = !!(config && config.isProduction);
  const checks = {};

  // Datastore: writable + reachable. Postgres failures fail closed.
  checks.datastore = {
    kind: datastoreKind,
    ok: !!(datastoreProbe && datastoreProbe.ok),
    ...(datastoreProbe && datastoreProbe.error ? { error: String(datastoreProbe.error).slice(0, 200) } : {}),
  };
  if (isProd && datastoreKind === 'file' && !(config && config.allowFileDatastoreInProduction)) {
    checks.datastore.note = 'file datastore in production is single-process only; set DATABASE_URL for multi-instance durability';
  }

  // Redis / coordination.
  const redisConfigured = !!(config && config.redisUrl);
  const redisDegraded = !!(redis && redis.degraded);
  const redisBackend = (redis && redis.backend) || (redisConfigured ? 'unknown' : 'memory');
  const redisOk = redisConfigured ? !redisDegraded : true;
  checks.redis = {
    ok: redisOk,
    backend: redisBackend,
    configured: redisConfigured,
    ...(redis && redis.host ? { host: redis.host } : {}),
    ...(redis && redis.lastError ? { error: String(redis.lastError).slice(0, 200) } : {}),
  };
  if (!redisConfigured) {
    checks.redis.note = 'ephemeral coordination is process-local (single-instance); set REDIS_URL for multi-instance locks/rate-limits';
  }

  // Encryption: production requires DATA_ENCRYPTION_KEY before any provider
  // credential is stored (matches validateConfig fail-fast).
  const encOk = !isProd || !!(config && config.dataEncryptionKey);
  checks.encryption = {
    ok: encOk,
    ...(encOk ? {} : { error: 'DATA_ENCRYPTION_KEY is required in production' }),
  };

  // Auth: production fails closed (auth enabled). Dev-open is explicit.
  const authOk = !isProd || !!(authConfig && authConfig.enabled);
  checks.auth = {
    ok: authOk,
    enabled: !!(authConfig && authConfig.enabled),
    ...(authOk ? {} : { error: 'auth must be enabled in production (AUTH_ENABLED=true or NODE_ENV=production with tokens)' }),
  };

  const ready = !!(checks.datastore.ok && checks.redis.ok && checks.encryption.ok && checks.auth.ok);
  return { ready, checks };
}

module.exports = { checkReadiness };
