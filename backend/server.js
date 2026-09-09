'use strict';

// OrchestraAI — adaptive agent runtime server.
//
// Wiring (canonical modules only; nothing from backend/demo/ is imported):
//
//   config/env -> ProviderRegistry -> Orchestrator -> snapshot adapter -> REST+SSE
//   ModelRegistry <- DiscoveryService (background refresh, lightweight timer)
//   ToolRegistry -> per-run tool sync (orchestrator.createRun)
//   FileStore -> run index / event logs / snapshots / evaluations (restart-safe)
//   EvaluationStore -> GET /api/evaluations (real stored run outcomes)
//
// RUNTIME_MODE=live requires provider credentials; otherwise the server runs
// in explicit DEMO mode (mock provider) and says so on /api/health and in
// every snapshot's meta block. Production never silently executes a fake path.
//
// Fictional seed data (backend/data.js: nemotron-x / helium-b / ferrite-c and
// canned memory) loads ONLY when mode != live. In live mode the registry
// starts empty and fills via DiscoveryService + provider default.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Orchestrator } = require('./src/core/orchestrator');
const { InMemoryModelRegistry } = require('./src/impl/model-registry');
const { InMemoryModelRouter } = require('./src/impl/model-router');
const { InMemoryContextManager } = require('./src/impl/context-manager');
const { InMemoryMemoryManager } = require('./src/impl/memory-manager');
const { InMemoryCacheManager } = require('./src/impl/cache-manager');
const { InMemoryToolRegistry } = require('./src/impl/tool-registry');
const { InMemoryToolExecutor } = require('./src/impl/tool-executor');
const { eventBus } = require('./src/events/event-bus');
const { SwitchingCostCalculator, ModelStickinessManager } = require('./src/decisions/switching-cost');
const { CostEstimator } = require('./src/cost/cost-estimator');
const { ProviderRegistry } = require('./src/providers/provider-adapter');
const { DiscoveryService } = require('./src/providers/model-discovery');
const { buildSnapshot, runSummary } = require('./src/api/snapshot');
const { SavingsEngine } = require('./src/savings');
const { FileStore } = require('./src/persistence');
const { EvaluationStore } = require('./src/evals');
const { loadConfig, validateConfig, redact } = require('./src/config');
const { createLogger } = require('./src/logger');
const { MODELS, TOOLS, MEMORY } = require('./data');
const { CredentialStore, SUPPORTED_PROVIDERS } = require('./src/providers/credential-store');
const { RuntimeSettings } = require('./src/runtime-settings');
const { ModelChangeLog } = require('./src/model-changes');
const { compareRuns } = require('./src/api/compare');
const { serveRunEvents } = require('./src/services/sse-service');
const { PRESETS, validPreset, getPreset, listPresets } = require('./src/policies/presets');
const { TaskStatus, EventType } = require('./src/core/types');
// Session 2 intelligence engine (model routing intelligence, context/memory
// intelligence, outcome evaluation, online learning). Additive wiring only:
// managers keep their contracts; the store adds durable learning.
const { IntelligenceStore, buildCapabilityProfile } = require('./src/intelligence');
const { VERSIONS } = require('./src/intelligence/versions');
const { attachExecution } = require('./src/execution/controller');
const { loadAuthConfig, authenticate, requireRole, canAccessRun, isGlobalAdmin, readSessionCookie, buildSessionCookie, clearSessionCookie } = require('./src/auth');
const { resolveProviderRuntime, disabledSet } = require('./src/provider-runtime');
const { loadLimits } = require('./src/limits');
const { appVersion } = require('./src/version');
const { IdempotencyStore } = require('./src/idempotency');
const { resolveRunConfig } = require('./src/run-config');
const { TenantStore } = require('./src/tenant-store');
const { aggregate: aggregateBilling, fromSavings: billingLine } = require('./src/billing');
const { buildAnalytics } = require('./src/analytics');
const { buildIntelligence } = require('./src/intelligence-analytics');
const { verifyStripeSignature, eventMetadata } = require('./src/billing-webhooks');
const { persistedEvents, persistedSnapshot, persistedRunSummary, normalizePrivacyMode } = require('./src/privacy');
// Agent 1 production infrastructure (datastore/Redis/locks/queue/readiness).
// All new environment variables are centralized in src/config.js; this file
// reads them via `config`, never via new process.env accesses.
const { assertNoSilentFallback } = require('./src/persistence');
const { createDatastore } = require('./src/infrastructure/datastore');
const { createCoordinator, createMemoryCoordinatorForTests } = require('./src/infrastructure/redis');
const { LockManager } = require('./src/infrastructure/locks');
const { RateLimiter } = require('./src/infrastructure/rate-limit');
const { createJobQueue } = require('./src/infrastructure/queue');
const { checkReadiness } = require('./src/infrastructure/readiness');
const { parseCursor, parseLastEventIdHeader, readDurableSince } = require('./src/infrastructure/event-log');
const { RedisIdempotencyBackend, PostgresIdempotencyBackend } = require('./src/idempotency');

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
// Fail fast on incoherent or insecure configuration instead of starting
// half-secured. Production refuses to boot without required secrets.
try {
  const { warnings } = validateConfig(config, process.env);
  for (const w of warnings || []) log.warn('configuration warning', { warning: w });
} catch (e) {
  const msg = `refusing to start: ${String((e && e.message) || e).slice(0, 300)}`;
  try { log.error(msg, {}); } catch {}
  // Throw during module load so `node backend/server.js` exits non-zero
  // with a clear reason instead of serving with dangerous defaults.
  throw new Error(msg);
}
const APP_VERSION = appVersion();
const limits = loadLimits(process.env);
// Auth: local development may be dev-open; production always fails closed.
// See src/auth.js.
let authConfig = loadAuthConfig(process.env);
const disabledProviders = disabledSet(process.env);

// Secure provider credentials: env/bootstrap keys are snapshotted, then any
// UI-configured (encrypted at rest) key takes precedence at runtime.
const credentials = new CredentialStore(config.dataDir, {
  logger: log,
  encryptionKey: config.dataEncryptionKey,
  requireEncryptionKey: config.isProduction,
});
const runtimeSettings = new RuntimeSettings(config.dataDir, { logger: log });
const modelChanges = new ModelChangeLog(config.dataDir);
const envKeys = {
  openrouter: config.providers.openrouter.apiKey || '',
  openai: config.providers.openai.apiKey || '',
  anthropic: config.providers.anthropic.apiKey || '',
};
function applyStoredKeys() {
  for (const id of SUPPORTED_PROVIDERS) {
    const stored = credentials.getKey(id);
    if (stored) config.providers[id].apiKey = stored;
    else if (envKeys[id]) config.providers[id].apiKey = envKeys[id];
    else config.providers[id].apiKey = '';
  }
}
applyStoredKeys();
if (credentials.wasCorrupted()) {
  log.warn('provider credential store was corrupt and quarantined; starting with env keys only');
}

function effectiveKey(providerId) {
  const id = String(providerId || '').toLowerCase();
  return (config.providers[id] && config.providers[id].apiKey) || '';
}

function credentialScope(principal) {
  return !authConfig.enabled || isGlobalAdmin(principal)
    ? 'default' : (principal?.orgId || principal?.id || 'default');
}

function modeForProvider(providerId, principal) {
  const explicit = String(process.env.RUNTIME_MODE || '').toLowerCase();
  const id = String(providerId || config.provider).toLowerCase();
  try {
    const adapter = providerRegistry && typeof providerRegistry.getAdapterForScope === 'function'
      ? providerRegistry.getAdapterForScope(id, credentialScope(principal)) : null;
    // A tenant's own encrypted key is authoritative. A deployment-wide
    // RUNTIME_MODE=demo must not silently disable a tenant that has chosen
    // LIVE and supplied its own provider credential.
    const tenantHasKey = authConfig.enabled && principal && !isGlobalAdmin(principal)
      ? !!credentials.getKey(id, credentialScope(principal)) : false;
    if (tenantHasKey || (adapter && adapter.hasCredentials && (!authConfig.enabled || !principal || isGlobalAdmin(principal)))) return 'live';
    if (explicit === 'live') return 'live';
    if (explicit === 'demo') return 'demo';
    return adapter && adapter.hasCredentials ? 'live' : 'demo';
  } catch {
    return explicit === 'live' ? 'live' : 'demo';
  }
}

function modeForPrincipal(principal) {
  return modeForProvider(config.provider, principal);
}

// Dynamic mode: explicit RUNTIME_MODE=demo pins demo (tests/offline).
// Otherwise live iff the configured provider has credentials (env or stored).
function currentMode() {
  const explicit = String(process.env.RUNTIME_MODE || '').toLowerCase();
  if (explicit === 'demo') return 'demo';
  if (explicit === 'live') return 'live';
  return effectiveKey(config.provider) || credentials.hasAnyStored(config.provider) ? 'live' : 'demo';
}
function refreshRuntimeMode() {
  const mode = currentMode();
  config.mode = mode;
  try { orchestrator.config.mode = mode; } catch { /* not constructed yet */ }
  return mode;
}
const isLiveBoot = config.mode === 'live';

// Per-provider health from real verification/refresh probes only.
const providerHealth = new Map(); // id -> { lastCheckedAt, healthy, lastError, lastLatencyMs, modelCount }
function recordProbe(id, result) {
  providerHealth.set(String(id).toLowerCase(), {
    lastCheckedAt: new Date().toISOString(),
    healthy: !!result.ok,
    lastError: result.ok ? null : redact(String(result.error || result.code || 'probe failed')).slice(0, 300),
    lastLatencyMs: Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs) : null,
    modelCount: Number.isFinite(result.modelCount) ? result.modelCount : null,
  });
}

function providerStatus(id, principal = null) {
  const key = String(id || '').toLowerCase();
  const scoped = credentialScope(principal);
  const stored = credentials.metaFor(key, scoped);
  const hasStored = principal && authConfig.enabled ? stored.configured : credentials.hasAnyStored(key);
  const canSeeDeploymentCredential = !authConfig.enabled || !principal || isGlobalAdmin(principal);
  const hasEnv = canSeeDeploymentCredential && !!envKeys[key];
  const configured = hasStored || hasEnv;
  const probe = providerHealth.get(key) || null;
  return {
    id: key,
    label: key === 'openrouter' ? 'OpenRouter' : key === 'openai' ? 'OpenAI' : key === 'anthropic' ? 'Anthropic' : key,
    supported: SUPPORTED_PROVIDERS.includes(key),
    configured,
    source: hasStored ? 'stored' : (hasEnv ? 'env' : null),
    keyMasked: principal && authConfig.enabled ? stored.keyMasked : null,
    updatedAt: principal && authConfig.enabled ? stored.updatedAt : null,
    lastVerifiedAt: principal && authConfig.enabled ? stored.lastVerifiedAt : null,
    // Connected means a real verification succeeded — never assumed. Public
    // health only exposes aggregate configured state, never another tenant's
    // masked key or verification metadata.
    connected: principal && authConfig.enabled
      ? stored.lastStatus === 'connected' || (!!probe && probe.healthy && hasEnv)
      : (!!probe && probe.healthy && configured),
    healthy: probe ? probe.healthy : null, // null = never checked
    lastCheckedAt: probe ? probe.lastCheckedAt : null,
    lastError: principal && authConfig.enabled
      ? (stored.lastError ? redact(stored.lastError) : (hasEnv && probe ? redact(probe.lastError) : null)) : null,
    lastLatencyMs: principal && authConfig.enabled ? (stored.lastLatencyMs ?? (hasEnv && probe ? probe.lastLatencyMs : null) ?? null) : null,
    modelCount: principal && authConfig.enabled ? (stored.modelCount ?? (hasEnv && probe ? probe.modelCount : null) ?? null) : null,
    modeState: modeStateForProvider(key, principal, { configured }),
  };
}

function modeStateForProvider(providerId, principal = null, options = {}) {
  const id = String(providerId || '').toLowerCase();
  if (disabledProviders.has(id)) return 'BLOCKED';
  const mode = modeForProvider(id, principal);
  if (mode === 'demo') return 'DEMO';
  let configured = options.configured;
  if (configured === undefined) {
    const stored = credentials.metaFor(id, credentialScope(principal));
    const canSeeDeploymentCredential = !authConfig.enabled || !principal || isGlobalAdmin(principal);
    configured = (authConfig.enabled && principal ? stored.configured : credentials.hasAnyStored(id))
      || (canSeeDeploymentCredential && !!envKeys[id]);
  }
  // The adapter is the final authority for injected/test providers and for
  // the credential resolver's tenant-scoped view. It never exposes the key;
  // only its boolean readiness is used here.
  try {
    const adapter = providerRegistry && typeof providerRegistry.getAdapterForScope === 'function'
      ? providerRegistry.getAdapterForScope(id, credentialScope(principal)) : null;
    if (adapter && adapter.hasCredentials) configured = true;
  } catch { /* an unavailable adapter remains unconfigured */ }
  return configured ? 'LIVE_READY' : 'LIVE_UNCONFIGURED';
}

// Model provenance enrichment: provider-reported vs observed vs unknown.
// Values without evidence are nulled so the UI renders "Not measured".
function enrichModel(m, runtimeMode = currentMode()) {
  const obs = (typeof modelRegistry.getObserved === 'function' && modelRegistry.getObserved(m.id)) || null;
  const samples = obs ? (obs.successes + obs.failures) : 0;
  const measured = samples >= 3;
  const out = { ...m };
  const qSrc = m.qualitySource || (m.source === 'discovered' || m.source === 'seed-default' ? 'unknown' : 'demo');
  out.qualitySource = qSrc;
  if (qSrc !== 'observed' && qSrc !== 'demo') out.quality = null;
  if (obs && Number.isFinite(obs.avgLatencyMs)) {
    out.avgLatencyMs = obs.avgLatencyMs;
    out.latencySource = 'observed';
  } else if (m.latencySource) {
    out.latencySource = m.latencySource;
    if (m.latencySource === 'unknown') out.avgLatencyMs = null;
  } else {
    out.latencySource = (m.source === 'discovered' || m.source === 'seed-default') ? 'unknown' : 'demo';
    if (out.latencySource === 'unknown') out.avgLatencyMs = null;
  }
  if (measured) {
    out.reliabilitySource = 'observed';
  } else if (m.reliabilitySource) {
    out.reliabilitySource = m.reliabilitySource;
    if (m.reliabilitySource === 'unknown') out.reliability = null;
  } else {
    out.reliabilitySource = (m.source === 'discovered' || m.source === 'seed-default') ? 'unknown' : 'demo';
    if (out.reliabilitySource === 'unknown') out.reliability = null;
  }
  const pSrc = m.pricingSource || (m.source === 'discovered' ? 'provider' : m.source === 'seed-default' ? 'unknown' : 'demo');
  out.pricingSource = pSrc;
  if (pSrc === 'unknown') {
    out.inputPer1k = null;
    out.outputPer1k = null;
    out.cachedPer1k = null;
  }
  out.contextSource = m.contextSource || (m.contextWindow ? (m.source === 'discovered' ? 'provider' : 'demo') : 'unknown');
  if (!m.contextWindow) out.contextWindow = null;
  // Health: never infer healthy from registry presence alone.
  if (m.status === 'unavailable' || m.status === 'down') {
    out.healthSource = 'observed';
  } else if (measured || (obs && samples > 0 && m.status !== 'healthy')) {
    out.healthSource = 'observed';
  } else if (m.source === 'discovered' || m.source === 'seed-default') {
    out.healthSource = m.status === 'healthy' ? 'unlisted' : 'observed';
    if (out.healthSource === 'unlisted') out.status = 'unknown';
  } else {
    out.healthSource = 'demo';
  }
  out.observed = obs ? { samples, lastObservedAt: obs.lastObservedAt, lastErrorCode: obs.lastErrorCode } : null;
  // Demo mode: every model is sample data, even after mock executions.
  // Mock observations must never be presented as real-world measurements.
  if (runtimeMode !== 'live') {
    out.qualitySource = 'demo';
    out.latencySource = 'demo';
    out.reliabilitySource = 'demo';
    out.healthSource = 'demo';
    if (out.pricingSource === 'unknown') out.pricingSource = 'demo';
    if (out.contextSource === 'unknown') out.contextSource = 'demo';
  }
  return out;
}

// Demo seed catalog is explicitly labelled sample data (qualitySource demo);
// live mode starts empty and fills via DiscoveryService + provider default.
const seedModels = isLiveBoot ? [] : MODELS.map((m) => ({
  ...m, source: 'demo-seed', qualitySource: 'demo', latencySource: 'demo',
  reliabilitySource: 'demo', pricingSource: 'demo', contextSource: 'demo',
}));
const modelRegistry = new InMemoryModelRegistry(seedModels, eventBus);
const switchingCostCalculator = new SwitchingCostCalculator();
const stickinessManager = new ModelStickinessManager();
const modelRouter = new InMemoryModelRouter(modelRegistry, switchingCostCalculator, stickinessManager, eventBus);
const contextManager = new InMemoryContextManager(eventBus);
const memoryManager = new InMemoryMemoryManager(eventBus);
// Canned memory is demo/test knowledge only; live runs start empty and
// accumulate their own run-scoped memory through real execution.
if (!isLiveBoot) memoryManager.seedMemory(MEMORY.working, MEMORY.longterm);
const cacheManager = new InMemoryCacheManager(eventBus);
const toolRegistry = new InMemoryToolRegistry(eventBus);
// Tool catalog is real (sandboxed handlers) in every mode.
toolRegistry.seedTools(TOOLS);
const store = new FileStore(config.dataDir, { logger: log });
// Production datastore boundary: FileStore is the explicit dev/test adapter.
// Postgres is selected via DATASTORE_PROVIDER/DATABASE_URL (see config.js +
// infrastructure/datastore.js). Postgres requested-but-unavailable throws at
// factory time — never a silent fallback to JSON.
let datastore = { kind: 'file', store, pg: null };
try {
  datastore = createDatastore(config, { fileStore: store, logger: log });
  assertNoSilentFallback(config, datastore.kind);
  if (datastore.kind !== 'file') log.info('durable datastore active', { kind: datastore.kind });
} catch (e) {
  // Fail fast: a miswired production datastore must not boot on JSON.
  throw new Error(`refusing to start: datastore misconfigured: ${String((e && e.message) || e).slice(0, 300)}`);
}
const tenants = new TenantStore(config.dataDir);
// Authoritative durable run persistence: Postgres when configured
// (DATASTORE_PROVIDER=postgres + DATABASE_URL), FileStore only as the
// explicit dev/test adapter. Reads/writes below go through runStore —
// never past it to `store` — so Postgres is genuinely the source of truth.
const { RunStore } = require('./src/infrastructure/run-store');
const runStore = new RunStore({ datastore, fileStore: store, logger: log });
if (datastore.kind === 'postgres' && datastore.pg) {
  tenants.remote = datastore.pg;
  log.info('tenant store durable backend active', { kind: 'postgres' });
}
// Append-only audit for security-relevant operations. Postgres mode writes
// to audit_log; file mode keeps audit in structured logs. Never throws into
// request paths (failures are logged, never fatal).
async function auditEvent({ actor = null, action, runId = null, projectId = null, orgId = null, detail = null } = {}) {
  if (!action) return;
  try {
    const r = await runStore.audit({ actor, action, runId, projectId, orgId, detail });
    if (!r.ok && r.error) log.warn('audit write failed', { action, error: r.error });
  } catch (e) {
    log.warn('audit write failed', { action, error: String((e && e.message) || e).slice(0, 160) });
  }
  if (runStore.kind !== 'postgres') {
    try { log.info('audit', { actor, action, runId, projectId, orgId }); } catch {}
  }
}
// Durable idempotency (Session 1 primitive for Session 3 tools).
// Production paid/durable side effects must use the async distributed path
// (beginAsync/completeAsync); the local Map is only the dev/test authority.
const idempotencyStore = new IdempotencyStore(config.dataDir, { logger: log });
// Distributed coordination (Redis) + durable job scheduling. Synchronous
// memory adapters boot immediately so tests/demo never need infrastructure;
// when REDIS_URL is configured the coordinator upgrades asynchronously and
// readiness reflects the real state (degraded => not ready, never silent).
let coordinator = createMemoryCoordinatorForTests();
let locks = new LockManager(coordinator);
let distributedLimiter = new RateLimiter(coordinator);
const coordinationRequired = !!(config.redisUrl || config.queueProvider === 'redis');
let coordinationReady = !coordinationRequired;
let coordinationPromise = Promise.resolve();
let jobQueue = createJobQueue({
  provider: config.queueProvider === 'redis' ? 'redis' : 'memory',
  coordinator, concurrency: config.queueConcurrency, logger: log,
});
// Durable execution scheduling boundary: run-lifecycle jobs go through the
// queue so API -> enqueue -> worker claims -> executes -> persists -> emits
// holds in every deployment. Run execution is NON-retryable by construction
// (unknown side effects are never blindly re-run; recovery-service decides
// resume/skip/refuse). Maintenance uses retryable jobs. Handlers resolve
// their dependencies lazily because the queue boots before the orchestrator.
function wireQueueHandlers(q) {
  q.on('run.execute', async (job) => {
    // When Redis is configured, the initial in-memory queue is only a startup
    // buffer. Do not execute a job against process-local coordination before
    // the shared coordinator has been probed and installed.
    if (coordinationRequired && !coordinationReady) {
      await coordinationPromise;
      if (!coordinationReady) {
        throw Object.assign(new Error('shared coordination is not ready'), { code: 'coordination_unavailable' });
      }
    }
    const { runId, content, attempt } = (job && job.payload) || {};
    if (!runId || typeof runId !== 'string') {
      throw Object.assign(new Error('run.execute job missing runId'), { code: 'bad_params' });
    }
    const text = String(content || '');
    const waitMs = Math.min((config.runTimeoutMs || 300000) + 60000, 600000);
    // Distributed execution claim: exactly one worker runs a run at a time,
    // even across API instances sharing the redis queue. withLock renews the
    // lease while the provider/tool loop runs, so a long run cannot be
    // mistaken for a crashed worker and started concurrently elsewhere.
    try {
      return await locks.withLock(`run-exec:${runId}`, waitMs, () => executeRunJob(runId, text, attempt, waitMs));
    } catch (e) {
      if (e && (e.code === 'lock_busy' || e.code === 'lock_lost')) throw e;
      if (e && e.code !== 'lock_unavailable') throw e;
      throw Object.assign(new Error('Run is already executing; wait for it to finish.'), { code: 'busy' });
    }
  });
  q.on('maintenance.sweep', async () => runRetentionSweep('queued'));
}

// The actual run lifecycle (start or same-run continuation episode), run
// under the distributed claim above. Terminal/refused outcomes throw with
// honest codes; post-claim progress travels over SSE/run state.
async function executeRunJob(runId, text, attempt, waitMs) {
  if (attempt === 'continue') {
    let cont = null;
    try {
      cont = await execution.continueRun(runId, text);
    } catch (ce) {
      throw Object.assign(new Error(String((ce && ce.message) || ce).slice(0, 220)), { code: 'terminal' });
    }
    if (!cont || !cont.ok) throw Object.assign(new Error('continuation refused'), { code: 'terminal' });
    await orchestrator.waitForCompletion(runId, waitMs);
    return { accepted: true, continued: true, episodeId: (cont.episode && cont.episode.episodeId) || null };
  }
  try {
    await orchestrator.startRun(runId, text);
  } catch (e) {
    // Session 3: a message to a COMPLETED run continues the SAME run as a
    // new execution episode (never an unrelated run).
    if (e && e.code === 'terminal') {
      let cont = null;
      try {
        cont = await execution.continueRun(runId, text);
      } catch (ce) {
        throw Object.assign(new Error(String((ce && ce.message) || ce).slice(0, 220)), { code: 'terminal' });
      }
      if (!cont || !cont.ok) throw e;
      await orchestrator.waitForCompletion(runId, waitMs);
      return { accepted: true, continued: true, episodeId: (cont.episode && cont.episode.episodeId) || null };
    }
    throw e;
  }
  await orchestrator.waitForCompletion(runId, waitMs);
  return { accepted: true };
}
function wireIdempotencyRemote() {
  try {
    if (datastore.kind === 'postgres' && datastore.pg) {
      idempotencyStore.remote = new PostgresIdempotencyBackend(datastore.pg);
      return;
    }
    if (coordinator && coordinator.backend === 'redis') {
      idempotencyStore.remote = new RedisIdempotencyBackend(coordinator);
    }
  } catch (e) {
    log.warn('idempotency remote wiring failed; local-only mode', { error: String((e && e.message) || e).slice(0, 160) });
  }
}
wireIdempotencyRemote();
if (config.redisUrl || config.queueProvider === 'redis') {
  coordinationPromise = createCoordinator(config, log).then(async (upgraded) => {
    coordinator = upgraded;
    locks = new LockManager(coordinator);
    distributedLimiter = new RateLimiter(coordinator);
    if (config.queueProvider === 'redis') {
      const previousQueue = jobQueue;
      const pending = Array.isArray(previousQueue.local) ? previousQueue.local.splice(0) : [];
      const pendingIds = new Set(pending.map((job) => job && job.id).filter(Boolean));
      const pendingWaiters = new Map();
      const pendingClaimWaiters = new Map();
      for (const id of pendingIds) {
        if (previousQueue.waiters && previousQueue.waiters.has(id)) {
          pendingWaiters.set(id, previousQueue.waiters.get(id));
          previousQueue.waiters.delete(id);
        }
        if (previousQueue.claimWaiters && previousQueue.claimWaiters.has(id)) {
          pendingClaimWaiters.set(id, previousQueue.claimWaiters.get(id));
          previousQueue.claimWaiters.delete(id);
        }
      }
      // Preserve accepted startup-buffer jobs and their HTTP claim waiters
      // while stopping the old in-memory dispatcher. Already-running jobs
      // remain owned by the old queue until their handler settles.
      try { await previousQueue.close({ drain: false, rejectWaiters: false }); } catch {}
      const nextQueue = createJobQueue({ provider: 'redis', coordinator, concurrency: config.queueConcurrency, logger: log });
      jobQueue = nextQueue;
      wireQueueHandlers(jobQueue);
      for (const job of pending) {
        if (!job || !job.id) continue;
        if (job.idempotencyKey) nextQueue.inflightKeys.set(job.idempotencyKey, job.id);
        if (pendingWaiters.has(job.id)) nextQueue.waiters.set(job.id, pendingWaiters.get(job.id));
        if (pendingClaimWaiters.has(job.id)) nextQueue.claimWaiters.set(job.id, pendingClaimWaiters.get(job.id));
        try {
          await nextQueue._push(job);
          setImmediate(() => nextQueue._drain().catch(() => {}));
        } catch (e) {
          nextQueue._releaseKey(job);
          nextQueue._settleWaiter(job, e, null);
        }
      }
    }
    coordinationReady = !coordinationRequired || coordinator.backend === 'redis';
wireIdempotencyRemote();
// Production startup checks (database, Redis, encryption, auth). Results
// are logged once at boot; /api/ready gates traffic on the same checks.
// A postgres datastore that is unreachable fails readiness (never a silent
// file fallback). Missing encryption/auth in production refuses to boot via
// validateConfig above.
(async function productionStartupChecks() {
  try {
    if (datastore.kind === 'postgres' && datastore.pg) {
      await datastore.pg.ping();
      log.info('startup check: postgres reachable', {});
    } else if (config.isProduction && datastore.kind === 'file' && !config.allowFileDatastoreInProduction) {
      log.warn('startup check: file datastore in production (single-process only); set DATABASE_URL for durable multi-instance state');
    }
    if (config.redisUrl && coordinator && coordinator.backend !== 'redis') {
      log.warn('startup check: REDIS_URL set but coordination is degraded', { backend: coordinator.backend });
    }
    if (config.isProduction && !config.dataEncryptionKey) {
      log.warn('startup check: DATA_ENCRYPTION_KEY missing in production');
    }
    if (config.isProduction && !authConfig.enabled) {
      log.warn('startup check: auth disabled in production (dev-open); enable AUTH_ENABLED/API_TOKEN or session auth');
    }
  } catch (e) {
    log.warn('startup check failed', { error: String((e && e.message) || e).slice(0, 200) });
  }
})();
    log.info('coordination backend ready', { backend: coordinator.backend, ready: coordinationReady });
  }).catch((e) => {
    coordinationReady = false;
    log.warn('coordination backend unavailable', { error: String((e && e.message) || e).slice(0, 200) });
  });
}
const toolExecutor = new InMemoryToolExecutor(toolRegistry, eventBus, { idempotencyStore });
const costEstimator = new CostEstimator();
const providerRegistry = new ProviderRegistry(config, {
  credentialResolver: (providerId, scope = 'default') => {
    const id = String(providerId || '').toLowerCase();
    const scopedKey = credentials.getKey(id, scope);
    // Deployment-level stored credentials remain compatible with the
    // unauthenticated/default scope. Authenticated tenants only resolve
    // their own namespaced credentials.
    const deploymentKey = scope === 'default' ? config.providers?.[id]?.apiKey : '';
    const deploymentScope = scope === 'default';
    return { apiKey: scopedKey || (deploymentScope ? (envKeys[id] || deploymentKey || '') : '') };
  },
});
const evaluations = new EvaluationStore();
// Intelligence learning store: durable via the authoritative runStore
// (Postgres intelligence_docs when configured, intelligence.json otherwise).
// Process memory is a cache; the durable store is the system of record.
const intelligence = new IntelligenceStore();
// Durable boot. File mode (dev/test) loads SYNCHRONOUSLY at require time —
// exactly the historical behavior — so in-memory learning state is settled
// before any request or test runs, and a late load can never clobber fresh
// state (e.g. repopulate a semantic index a test just cleared). Postgres
// mode (production) loads asynchronously; /api/ready gates traffic until
// bootDone is true, so no writes can race the restore.
let bootDone = false;
let bootError = null;
let bootPromise = Promise.resolve();
if (runStore.kind === 'postgres') {
  bootPromise = (async () => {
    const evals = await runStore.loadEvals();
    evaluations.loadAll(evals);
    const doc = await runStore.loadIntelligence();
    if (doc) intelligence.load(doc);
  })().catch((e) => {
    bootError = e;
    log.warn('durable boot failed', { error: String((e && e.message) || e).slice(0, 200) });
  }).then(() => { bootDone = true; });
} else {
  try {
    evaluations.loadAll(store.loadEvals());
  } catch (e) {
    log.warn('evaluations restore failed', { error: String((e && e.message) || e).slice(0, 200) });
  }
  try {
    const doc = store.loadIntelligence();
    if (doc) intelligence.load(doc);
  } catch (e) {
    log.warn('intelligence restore failed', { error: String((e && e.message) || e).slice(0, 200) });
  }
  try {
    const restored = store.loadIdempotency();
    if (Array.isArray(restored) && restored.length) {
      for (const r of restored.slice(-1000)) {
        if (r && typeof r.key === 'string' && !idempotencyStore.records.has(r.key)) {
          idempotencyStore.records.set(r.key, r);
        }
      }
    }
  } catch {}
  bootDone = true;
}
// Attach (additive): managers gain intelligence-aware scoring with legacy
// fallbacks; the cache shares the durable semantic index.
modelRouter.attachIntelligence(intelligence);
contextManager.attachIntelligence(intelligence);
memoryManager.attachIntelligence(intelligence);
cacheManager.attachIntelligence(intelligence);

async function persistActive() {
  try {
    const runs = orchestrator.getActiveRuns();
    const safeRuns = [];
    for (const run of runs) {
      safeRuns.push(persistedRunSummary(run, await privacyModeForRun(run)));
    }
    let r;
    if (runStore.kind === 'postgres') {
      // Postgres already persists each terminal summary incrementally (run-end
      // hook). Re-writing the whole run_index every tick would be O(all runs)
      // and re-scan the per-tenant retention prune; only the active window
      // needs a refresh here.
      if (safeRuns.length) r = await runStore.saveRunIndex(safeRuns);
    } else {
      // File mode stores the index as one JSON document, so reconcile the
      // active summaries over the persisted index and rewrite it.
      r = await runStore.saveRunIndex(mergeIndex(await runStore.loadRunIndex(), safeRuns));
    }
    if (r && !r.ok) log.warn('run index persist failed', { error: r.error });
    for (const run of runs) {
      await persistRunArtifacts(run.id, run);
    }
    const e3 = typeof runStore.appendEvals === 'function'
      ? await runStore.appendEvals(evaluations.dump())
      : await runStore.saveEvals(evaluations.dump());
    if (!e3.ok) log.warn('evaluations persist failed', { error: e3.error });
    // Idempotency durability: the file flush is the dev/test path only. In
    // postgres/redis mode the distributed backend is authoritative.
    if (runStore.kind === 'file') {
      try {
        const recs = Array.from(idempotencyStore.records.values()).slice(-1000);
        const e4 = store.saveIdempotency(recs);
        if (!e4.ok) log.warn('idempotency persist failed', { error: e4.error });
      } catch (e) {
        log.warn('idempotency persist failed', { error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    // Intelligence durability: learning survives restarts via runStore.
    try {
      const e5 = await runStore.saveIntelligence(intelligence.dump());
      if (!e5.ok) log.warn('intelligence persist failed', { error: e5.error });
    } catch (e) {
      log.warn('intelligence persist failed', { error: String((e && e.message) || e).slice(0, 200) });
    }
  } catch (e) {
    log.warn('persist failed', { error: String((e && e.message) || e).slice(0, 200) });
  }
}

const orchestrator = new Orchestrator({
  modelRegistry,
  modelRouter,
  contextManager,
  memoryManager,
  cacheManager,
  toolRegistry,
  toolExecutor,
  costEstimator,
  providerRegistry,
  intelligence,
  runEndSink: {
    recordEvaluation(evidence) {
      try {
        evaluations.record(evidence);
      } catch (e) {
        log.warn('evaluation record failed', { error: String((e && e.message) || e).slice(0, 200) });
      }
    },
    // Terminal runs persist immediately (not just on the 15s timer) so a
    // crash right after completion cannot lose history.
    onRunEnd(summary) {
      (async () => {
        try {
          if (summary && summary.id) {
            await persistRunArtifacts(summary.id, summary);
            const economics = await economicsForRun(summary.id);
            await runStore.saveBilling(summary.id, billingLine(economics, { date: summary.updatedAt }));
            if (typeof runStore.appendEvals === 'function') await runStore.appendEvals(evaluations.dump());
            else await runStore.saveEvals(evaluations.dump());
            await runStore.saveIntelligence(intelligence.dump());
          }
        } catch (e) {
          log.warn('run-end persist failed', { error: String((e && e.message) || e).slice(0, 200) });
        }
      })().catch(() => {});
    },
  },
  config: {
    mode: config.mode,
    provider: config.provider,
    runTimeoutMs: config.runTimeoutMs,
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    maxRetries: config.maxRetries,
    defaultBudgetUsd: config.defaultBudgetUsd,
    defaultMaxContextTokens: config.defaultMaxContextTokens,
    providerTimeoutMs: config.providerTimeoutMs,
    maxConcurrentRuns: limits.maxConcurrentRuns,
    optimizationInterval: 5,
    maxToolCallsTotal: 100,
    contextCompressionThreshold: 0.8,
    budgetWarningThreshold: 0.8,
  },
  logger: log,
});
// Runtime defaults (persisted, safe-to-change) seed per-run resolution.
// Precedence: process defaults -> runtime settings -> run overrides.
try { orchestrator.setRuntimeDefaults(runtimeSettings.load()); } catch {}
// Durable checkpoints: after every completed step the orchestrator asks for
// a snapshot persist, so a crash loses at most the in-flight step. Failures
// are advisory (logged inside persistRunArtifacts), never fatal to the run.
orchestrator.persistHook = (runId) => {
  persistRunArtifacts(runId).catch((e) => {
    log.warn('checkpoint persist hook failed', { runId, error: String((e && e.message) || e).slice(0, 160) });
  });
};

const discovery = new DiscoveryService({ registry: modelRegistry, providerRegistry, config, logger: log, changeLog: modelChanges });

// Session 3 — agent execution capabilities (tools/policy/approvals/episodes/
// recovery). Consumes Session-1 contracts; default run behavior unchanged.
const applicationRoot = path.resolve(__dirname, '..');
const configuredWorkspace = config.workspaceRoot ? path.resolve(config.workspaceRoot) : null;
const configuredWorkspaceSafe = configuredWorkspace && configuredWorkspace !== applicationRoot && !configuredWorkspace.startsWith(`${applicationRoot}${path.sep}`);
const productionProcess = config.isProduction;
const executionWorkspace = productionProcess
  ? (configuredWorkspaceSafe ? configuredWorkspace : path.join(path.resolve(config.dataDir), 'workspaces'))
  : (configuredWorkspace || process.cwd());
try { fs.mkdirSync(executionWorkspace, { recursive: true, mode: 0o700 }); } catch (e) { if (config.isProduction) throw e; }
const execution = attachExecution(orchestrator, {
  workspace: executionWorkspace,
  productionSafeToolsOnly: config.isProduction,
  autoVerify: config.session3AutoVerify,
});
// The queue is the genuine execution scheduler: run lifecycle and background
// maintenance are consumed by these workers (in-process for `memory`,
// durable redis-backed for `redis`). Re-wired on every queue instance
// (including the redis upgrade above).
wireQueueHandlers(jobQueue);

// Merge live summaries over the persisted index (live wins on conflict).
// No global count cap: retention is enforced per-tenant by the adapters, and
// the listing surface filters by ownership, so no tenant's history is ever
// silently dropped because another tenant is more active.
function mergeIndex(persisted, live) {
  const byId = new Map();
  for (const entry of persisted || []) {
    if (entry && entry.id) byId.set(entry.id, entry);
  }
  for (const run of live || []) {
    if (run && run.id) byId.set(run.id, run);
  }
  return Array.from(byId.values());
}

function economicsForRuntime(runtimeState, explicitReferenceModelId = null) {
  if (runtimeState && runtimeState.economics && typeof runtimeState.economics === 'object') {
    return runtimeState.economics;
  }
  const result = SavingsEngine.calculateSavingsForRun(
    runtimeState, eventBus, modelRegistry, explicitReferenceModelId, orchestrator,
    { platformFeePct: config.platformFeePct },
  );
  const terminal = ['completed', 'failed', 'cancelled'].includes(String(runtimeState?.status));
  if (terminal && runtimeState) {
    runtimeState.economics = JSON.parse(JSON.stringify(result));
    return runtimeState.economics;
  }
  return result;
}

async function economicsForRun(id, explicitReferenceModelId = null) {
  const runtimeState = (orchestrator.getRun && orchestrator.getRun(id)) || null;
  if (runtimeState) return economicsForRuntime(runtimeState, explicitReferenceModelId);
  const persisted = await runStore.loadSnapshot(id);
  if (persisted && persisted.economics) return persisted.economics;
  // A legacy snapshot can still be inspected, but it cannot prove a modeled
  // baseline without the original execution step usage. Stay explicit.
  return {
    status: 'insufficient_pricing_data', economicsStatus: 'not_eligible',
    calculationStatus: 'insufficient_data', economicOutcome: null,
    baselineCost: null, actualCost: null, savings: null, savingsRate: null,
    platformFeePct: config.platformFeePct, eligibleSavings: 0, platformFee: 0,
    customerFinalCost: null, customerNetSavings: null, currency: 'USD', steps: [],
    pricingSnapshot: [], error: 'Historical usage snapshot is not available for this run',
  };
}

async function privacyModeForRun(runOrId) {
  const runtime = typeof runOrId === 'string' ? orchestrator.getRun(runOrId) : runOrId;
  if (runtime?.privacyMode) return normalizePrivacyMode(runtime.privacyMode);
  const id = typeof runOrId === 'string' ? runOrId : runOrId?.id;
  const persisted = id ? await persistedSummary(id) : null;
  return normalizePrivacyMode(runOrId?.privacyMode || persisted?.privacyMode);
}

async function persistedSummary(id) {
  const index = await runStore.loadRunIndex();
  return index.find((r) => r && r.id === id) || null;
}

async function purgeProjectContent(projectId, mode) {
  const normalized = normalizePrivacyMode(mode);
  const runs = (await runStore.loadRunIndex()).filter((r) => r && r.projectId === projectId);
  for (const run of runs) {
    const runtime = orchestrator.getRun(run.id);
    if (runtime) runtime.privacyMode = normalized;
    if (typeof eventBus.setPrivacyMode === 'function') eventBus.setPrivacyMode(run.id, normalized);
    const economics = runtime ? economicsForRuntime(runtime) : await economicsForRun(run.id);
    await runStore.upsertRunSummary(persistedRunSummary({ ...run, privacyMode: normalized, economics }, normalized));
    const events = await runStore.loadEvents(run.id);
    await runStore.saveEvents(run.id, persistedEvents(events, normalized));
    const snapshot = await runStore.loadSnapshot(run.id);
    if (snapshot) await runStore.saveSnapshot(run.id, persistedSnapshot(snapshot, normalized));
    if (normalized === 'zero_retention') {
      try { if (cacheManager && typeof cacheManager.clearRun === 'function') cacheManager.clearRun(run.id); } catch {}
    }
    try { if (memoryManager && typeof memoryManager.purgeRun === 'function') memoryManager.purgeRun(run.id); } catch {}
  }
  try {
    if (intelligence?.semanticCache && typeof intelligence.semanticCache.clearScope === 'function') {
      intelligence.semanticCache.clearScope({ tenantId: runs[0]?.orgId || null, projectId });
      await runStore.saveIntelligence(intelligence.dump());
    }
  } catch {}
}

async function persistRunArtifacts(runId, summary = null) {
  const mode = await privacyModeForRun(orchestrator.getRun(runId) || summary || runId);
  const runtime = orchestrator.getRun(runId);
  const terminal = ['completed', 'failed', 'cancelled'].includes(String(runtime?.status || summary?.internalStatus || summary?.status));
  const frozenEconomics = terminal && runtime ? economicsForRuntime(runtime) : null;
  if (summary) {
    const durableSummary = frozenEconomics ? { ...summary, economics: frozenEconomics } : summary;
    const result = await runStore.upsertRunSummary(persistedRunSummary(durableSummary, mode));
    if (!result.ok) log.warn('run summary persist failed', { runId, error: result.error });
  }
  const e1 = typeof runStore.appendEvents === 'function'
    ? await runStore.appendEvents(runId, persistedEvents(eventBus.eventLogs.get(runId) || [], mode))
    : await runStore.saveEvents(runId, persistedEvents(eventBus.eventLogs.get(runId) || [], mode));
  if (!e1.ok) log.warn('events persist failed', { runId, error: e1.error });
  const snap = buildSnapshot(orchestrator, runId);
  if (snap) {
    if (['completed', 'failed', 'cancelled'].includes(String(snap.status))) {
      snap.economics = frozenEconomics || economicsForRuntime(orchestrator.getRun(runId));
    }
    const e2 = await runStore.saveSnapshot(runId, persistedSnapshot(snap, mode));
    if (!e2.ok) log.warn('snapshot persist failed', { runId, error: e2.error });
  }
}

async function visibleRunIndex(principal) {
  const scoped = authConfig.enabled && principal && !isGlobalAdmin(principal)
    ? { orgId: principal.orgId } : {};
  const all = mergeIndex(await runStore.loadRunIndex(scoped), orchestrator.getActiveRuns());
  if (!authConfig.enabled || !principal || isGlobalAdmin(principal)) return all;
  return all.filter((r) => {
    const owner = r && (r.ownerId || r.owner);
    return !!owner && (owner === principal.id || (r.orgId && principal.orgId && r.orgId === principal.orgId));
  });
}

function withinDateRange(run, from, to) {
  const ts = new Date(run.updatedAt || run.createdAt || 0).getTime();
  if (!Number.isFinite(ts)) return false;
  if (from) {
    const start = new Date(from).getTime();
    if (Number.isFinite(start) && ts < start) return false;
  }
  if (to) {
    const end = new Date(to).getTime();
    if (Number.isFinite(end) && ts > end) return false;
  }
  return true;
}

const TERMINAL_SUMMARY = new Set(['completed', 'failed', 'cancelled']);

// Restore persisted event logs so SSE replay + history survive restarts.
// In-flight execution does NOT resume; runs that were active at shutdown are
// marked interrupted (failed, honest about no resumption) instead of
// pretending to still execute.
(async function restorePersisted() {
  try {
    await bootPromise;
    const index = await runStore.loadRunIndex();
    let replayed = 0;
    let interrupted = 0;
    const rewritten = index.map((entry) => {
      if (!entry || !entry.id) return entry;
      const status = entry.internalStatus || entry.status;
      const terminal = TERMINAL_SUMMARY.has(entry.status) ||
        ['completed', 'failed', 'cancelled'].includes(status);
      if (!terminal) {
        interrupted++;
        return {
          ...entry,
          status: 'failed',
          internalStatus: 'failed',
          interrupted: true,
          interruptReason: 'server_restart: in-flight execution does not resume across restarts',
          updatedAt: new Date().toISOString(),
        };
      }
      return entry;
    });
    if (interrupted) await runStore.saveRunIndex(rewritten);
    for (const entry of rewritten.slice(-50)) {
      if (!entry || !entry.id) continue;
      const events = await runStore.loadEvents(entry.id);
      if (events && events.length && !eventBus.eventLogs.has(entry.id)) {
        eventBus.eventLogs.set(entry.id, events);
        for (const e of events) {
          if (e && e.seq > eventBus.globalSeq) eventBus.globalSeq = e.seq;
        }
        replayed++;
      }
    }
    if (replayed || interrupted) log.info('restored persisted state', { runs: replayed, interrupted });
  } catch (e) {
    bootError = bootError || e;
    log.warn('persistence restore failed', { error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    // Readiness gates on this flag: no traffic until durable history is
    // loaded (or its failure is recorded above — failures stay visible).
    bootDone = true;
  }
})();

discovery.ensureDefaultModel().catch(() => {});
discovery.start();

const persistTimer = setInterval(persistActive, 15000);
if (persistTimer.unref) persistTimer.unref();

// Retention sweep: per-run files that are neither active nor indexed are
// garbage-collected on a slow cadence (default hourly). Explicit,
// configurable via config.js (RETENTION_*), observable (report logged), and
// safe during concurrent writes (only orphaned files are eligible).
const RETENTION_SWEEP_INTERVAL_MS = config.retentionSweepIntervalMs;
const RETENTION_GRACE_MS = config.retentionGraceMs;
function runRetentionSweep(reason = 'scheduled') {
  try {
    const activeIds = Array.from(orchestrator.activeRuns.keys());
    const report = runStore.sweepRetention({ activeIds, graceMs: RETENTION_GRACE_MS });
    if ((report.deleted && report.deleted.length) || (report.errors && report.errors.length)) {
      log.info('retention sweep', {
        reason,
        deleted: report.deleted.length,
        freedBytes: report.freedBytes,
        keptActive: report.keptActive,
        keptIndexed: report.keptIndexed,
        keptFresh: report.keptFresh,
        errors: report.errors.slice(0, 5),
      });
    }
    return report;
  } catch (e) {
    log.warn('retention sweep failed', { error: String((e && e.message) || e).slice(0, 200) });
    return null;
  }
}
// One sweep at startup (after restore) so restarted processes do not
// accumulate orphans, then on the slow cadence via the durable queue so the
// sweep itself exercises the same worker path as run execution.
try { runRetentionSweep('startup'); } catch {}
const retentionTimer = setInterval(() => {
  jobQueue.enqueue({ type: 'maintenance.sweep', retryable: true, maxAttempts: 3, idempotencyKey: `sweep:${Math.floor(Date.now() / RETENTION_SWEEP_INTERVAL_MS)}` }).catch(() => {});
}, RETENTION_SWEEP_INTERVAL_MS);
if (retentionTimer.unref) retentionTimer.unref();

let shuttingDown = false;
function isDraining() { return shuttingDown; }
async function shutdown(signal = 'shutdown') {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(persistTimer);
  clearInterval(retentionTimer);
  try { discovery.stop(); } catch {}
  // Stop accepting new work first (server.close), then reconcile active
  // runs: mark them interrupted-persisted (FAILED + interrupted flag) so a
  // restart reports honestly instead of pretending execution continues.
  // In-flight provider/tool work observes abort via per-run controllers.
  try {
    for (const [runId, rs] of orchestrator.activeRuns.entries()) {
      try {
        const ctrl = orchestrator.liveControl(runId);
        if (ctrl) {
          ctrl.abort = true;
          try { ctrl.abortController.abort(); } catch {}
        }
        if (rs && typeof rs.updateStatus === 'function' && !['completed', 'failed', 'cancelled'].includes(String(rs.status))) {
          rs.updateStatus('failed');
          try {
            rs.metadata = { ...(rs.metadata || {}), interrupted: true, interruptReason: `server_shutdown (${signal}): in-flight execution does not resume across restarts; retry the run to recover from its last checkpoint` };
          } catch {}
        }
        try { persistRunArtifacts(runId).catch(() => {}); } catch {}
      } catch {}
    }
  } catch {}
  try { await persistActive(); } catch {}
  // Production infrastructure teardown (after state is durable): stop
  // coordination/queue backends. The queue drains running jobs up to a grace
  // period; redis-pending jobs stay durable for the next worker.
  try { await jobQueue.close({ drain: true, graceMs: 8000 }); } catch {}
  try { await coordinator.close(); } catch {}
  try { if (datastore.pg) await datastore.pg.close(); } catch {}
  await new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // Do not hang shutdown forever on keep-alive connections.
    setTimeout(resolve, 5000).unref?.();
  });
  log.info('runtime stopped', { signal });
}

if (require.main === module) {
  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
}

// ---------- HTTP plumbing ----------

// Central limits (no magic numbers scattered in handlers).
const MAX_BODY_BYTES = limits.maxBodyBytes;
const rateBuckets = new Map();

function requestAddress(req) {
  // Forwarded headers are not trusted without an explicitly configured proxy.
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 80);
}

function allowRequest(req, pathname) {
  const now = Date.now();
  const windowMs = 60_000;
  const kind = pathname.startsWith('/api/auth/') ? 'auth' : 'api';
  const key = `${requestAddress(req)}:${kind}`;
  const limit = kind === 'auth' ? limits.authRequestsPerMinute : limits.requestsPerMinute;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.startedAt + windowMs <= now) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  // Bound memory for a long-lived single-process deployment.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.startedAt + windowMs <= now) rateBuckets.delete(k);
  }
  return bucket.count <= limit;
}

// Distributed rate-limit check (Redis-backed when REDIS_URL is configured).
// Local allowRequest() above remains the fast synchronous shed; this async
// check enforces the same window across instances. Single-process
// deployments (memory coordinator) skip the second check.
async function allowRequestDistributed(req, pathname) {
  try {
    if (!distributedLimiter || !distributedLimiter.distributed) return { allowed: true, count: 0 };
    const kind = pathname.startsWith('/api/auth/') ? 'auth' : 'api';
    const limit = kind === 'auth' ? limits.authRequestsPerMinute : limits.requestsPerMinute;
    return await distributedLimiter.allow({ key: `${requestAddress(req)}:${kind}`, limit, windowMs: 60000 });
  } catch {
    return { allowed: true, count: 0 };
  }
}

function newRequestId() {
  return `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// CORS + security headers live in src/security/http-headers.js (pure/unit-
// testable). These bindings preserve the existing export surface exactly.
const { resolveCorsOrigin, securityHeaders: buildSecurityHeaders } = require('./src/security/http-headers');

function corsHeaders(req) {
  return resolveCorsOrigin(req.headers && req.headers.origin, {
    frontendOrigin: config.frontendOrigin,
    isLive: currentMode() === 'live',
  });
}

function securityHeaders() {
  return buildSecurityHeaders({ secure: config.isProduction || currentMode() === 'live' });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  const allowCredentials = res._cors && res._cors['Access-Control-Allow-Origin']
    ? { 'Access-Control-Allow-Credentials': 'true' } : {};
  res.writeHead(code, {
    ...securityHeaders(),
    'Content-Type': 'application/json',
    ...(res._setCookie ? { 'Set-Cookie': res._setCookie } : {}),
    ...(res._cors || {}),
    ...allowCredentials,
    ...(res._retryAfter ? { 'Retry-After': String(res._retryAfter) } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(body);
}

// Safe errors: consistent shape { error, code, requestId, message }.
// `error` stays a plain string for existing frontend clients; `message`
// aliases it and `errorInfo` carries the normalized { code, message,
// requestId } object from the Session 1 contract. Never keys/secrets/stacks.
function sendError(res, httpCode, code, message, details) {
  const safe = redact(String(message || 'internal error')).slice(0, 500);
  const c = code || 'internal';
  const rid = res._requestId || undefined;
  send(res, httpCode, {
    error: safe,
    message: safe,
    code: c,
    requestId: rid,
    errorInfo: { code: c, message: safe, requestId: rid },
    // Optional machine-readable context (already-safe values only; callers
    // must never pass secrets, stacks, or filesystem internals).
    ...(details && typeof details === 'object' ? { details } : {}),
  });
}

// Auth helpers (401 unauthenticated, 403 forbidden — consistent).
function currentPrincipal(req) {
  return authenticate(req, authConfig, tenants);
}
function needAuth(res, principal) {
  if (principal) return false;
  sendError(res, 401, 'unauthenticated', 'authentication required (missing or invalid bearer token)');
  return true;
}
function needRole(res, principal, minRole) {
  if (requireRole(principal, minRole)) return false;
  sendError(res, 403, 'forbidden', `requires ${minRole} role or higher`);
  return true;
}
// Run-scoped read guard (private run/project data must not leak through
// predictable IDs when auth is enabled). Public catalog endpoints (models,
// tools, presets, liveness) stay open. Ownerless legacy records are
// quarantined under authentication. Returns true when the request must stop.
function ownedByOtherWithIndex(runId, principal, index) {
  if (!runId || !principal || isGlobalAdmin(principal)) return false;
  const rs = (orchestrator.getRun && orchestrator.getRun(runId)) || orchestrator.activeRuns.get(runId) || null;
  if (rs?.orgId && principal.orgId && rs.orgId === principal.orgId) return false;
  const owner = (rs && rs.ownerId) || null;
  if (owner) return owner !== principal.id;
  const idx = (index || []).find((r) => r && r.id === runId) || null;
  if (idx?.orgId && principal.orgId && idx.orgId === principal.orgId) return false;
  const pOwner = (idx && (idx.ownerId || idx.owner)) || null;
  if (pOwner) return pOwner !== principal.id;
  return true;
}
async function ownedByOther(runId, principal) {
  if (!runId || !principal || isGlobalAdmin(principal)) return false;
  try {
    const rs = (orchestrator.getRun && orchestrator.getRun(runId)) || orchestrator.activeRuns.get(runId) || null;
    if (rs?.orgId && principal.orgId && rs.orgId === principal.orgId) return false;
    const owner = (rs && rs.ownerId) || null;
    if (owner) return owner !== principal.id;
    const index = await runStore.loadRunIndex();
    return ownedByOtherWithIndex(runId, principal, index);
  } catch {
    // An ownership lookup failure is an authorization failure, never a reason
    // to serve a private run optimistically.
    return true;
  }
}
async function guardRunRead(res, principal, runId) {
  if (!authConfig.enabled) return false;
  if (needAuth(res, principal)) return true;
  if (await ownedByOther(runId, principal)) {
    sendError(res, 403, 'forbidden', 'not owner of this run');
    return true;
  }
  return false;
}
// Sync visibility check for preloaded request indexes (bulk filters). Falls
// back to the async single-item check when no index is provided.
function memoryVisibleToPrincipal(item, principal, index = null) {
  if (!item || !principal) return false;
  if (isGlobalAdmin(principal)) return true;
  if (item.orgId) return !!principal.orgId && item.orgId === principal.orgId;
  if (index) return !ownedByOtherWithIndex(item.runId || item.sourceRunId, principal, index);
  return null; // unknown without an index lookup — caller must resolve async
}
async function memoryVisibleToPrincipalAsync(item, principal) {
  if (!item || !principal) return false;
  if (isGlobalAdmin(principal)) return true;
  if (item.orgId) return !!principal.orgId && item.orgId === principal.orgId;
  return !(await ownedByOther(item.runId || item.sourceRunId, principal));
}
function providerRuntimeSnapshot(principal = null) {
  return resolveProviderRuntime({
    configuredProvider: config.provider,
    providerStatusFn: (id) => providerStatus(id, principal),
    disabled: disabledProviders,
  });
}

function sseLine(envelope) {
  if (envelope && typeof envelope.toSSE === 'function') return envelope.toSSE();
  return `event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

// ---------- production console (frontend/dist) ----------
//
// Zero-dependency static server (GET only, traversal-proof, no directory
// listing, SPA fallback). Implemented in src/services/static-console.js and
// bound here so one process serves UI + API on :8787.

const { resolveConsoleRoot, createConsoleHandler } = require('./src/services/static-console');
const consoleRoot = resolveConsoleRoot(path.resolve(__dirname, '..'));
const serveConsole = createConsoleHandler({
  dist: consoleRoot.dist,
  enabled: consoleRoot.ok,
  securityHeaders,
  cors: (req) => req._cors || {},
});

// ---------- validation ----------

const TASK_MODES = new Set(['auto', 'code', 'debug', 'research', 'general']);
const MEMORY_SCOPES = new Set(['working', 'longterm']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function finiteNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v, fallback, min, max) {
  // Missing/empty params must yield the default: Number(null) === 0 would
  // otherwise collapse every unfiltered listing to a single item.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function validRunId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function validateCreateRun(json) {
  const errors = [];
  const body = (json && typeof json === 'object') ? json : {};
  if (body.title !== undefined && typeof body.title !== 'string') errors.push('title must be a string');
  if (body.projectId !== undefined && !(typeof body.projectId === 'string' && ID_RE.test(body.projectId))) errors.push('projectId is invalid');
  if (body.taskMode !== undefined && !TASK_MODES.has(body.taskMode)) errors.push('taskMode must be one of auto|code|debug|research|general');
  if (body.mode !== undefined && body.mode !== 'demo' && body.mode !== 'live') errors.push('mode must be demo or live');
  if (body.budget !== undefined && !(Number.isFinite(body.budget) && body.budget >= 0 && body.budget <= 1000)) {
    errors.push('budget must be a number between 0 and 1000');
  }
  if (body.maxLatencyMs !== undefined && !(Number.isFinite(body.maxLatencyMs) && body.maxLatencyMs >= 1000 && body.maxLatencyMs <= 3600000)) {
    errors.push('maxLatencyMs must be between 1000 and 3600000');
  }
  if (body.maxContextTokens !== undefined && !(Number.isFinite(body.maxContextTokens) && body.maxContextTokens >= 500 && body.maxContextTokens <= 1000000)) {
    errors.push('maxContextTokens must be between 500 and 1000000');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 20)) errors.push('tools must be an array of at most 20 entries');
  if (body.policy !== undefined && (typeof body.policy !== 'object' || body.policy === null)) errors.push('policy must be an object');
  // Per-run runtime overrides (hidden behind Advanced in the UI).
  if (body.preset !== undefined && !validPreset(body.preset)) errors.push('preset must be one of balanced|fast|economical|reasoning|longcontext');
  if (body.preferredModel !== undefined && !(typeof body.preferredModel === 'string' && body.preferredModel.length <= 200)) {
    errors.push('preferredModel must be a string of at most 200 characters');
  }
  if (body.allowSwitching !== undefined && typeof body.allowSwitching !== 'boolean') errors.push('allowSwitching must be a boolean');
  if (body.allowCompaction !== undefined && typeof body.allowCompaction !== 'boolean') errors.push('allowCompaction must be a boolean');
  if (body.policy && body.policy.qualityFloor !== undefined && !(Number.isFinite(body.policy.qualityFloor) && body.policy.qualityFloor >= 0 && body.policy.qualityFloor <= 1)) errors.push('policy.qualityFloor must be between 0 and 1');
  if (body.policy && body.policy.latencyTargetMs !== undefined && !(Number.isFinite(body.policy.latencyTargetMs) && body.policy.latencyTargetMs >= 1000 && body.policy.latencyTargetMs <= 3600000)) errors.push('policy.latencyTargetMs must be between 1000 and 3600000');
  if (body.policy && body.policy.hardBudget !== undefined && typeof body.policy.hardBudget !== 'boolean') errors.push('policy.hardBudget must be a boolean');
  if (body.toolPolicy !== undefined && body.toolPolicy !== 'auto' && body.toolPolicy !== 'readonly') {
    errors.push('toolPolicy must be auto or readonly');
  }
  // Session 3 execution policy (conservative defaults apply when omitted).
  const AUTONOMY_MODES = ['read_only', 'assisted', 'autonomous', 'restricted_autonomous'];
  if (body.autonomyMode !== undefined && !AUTONOMY_MODES.includes(body.autonomyMode)) {
    errors.push('autonomyMode must be one of read_only|assisted|autonomous|restricted_autonomous');
  }
  const APPROVAL_MODES = ['AUTO_APPROVE_LOW', 'APPROVE_WRITES', 'APPROVE_DANGEROUS', 'APPROVE_ALL'];
  if (body.approvalMode !== undefined && !APPROVAL_MODES.includes(body.approvalMode)) {
    errors.push('approvalMode must be one of AUTO_APPROVE_LOW|APPROVE_WRITES|APPROVE_DANGEROUS|APPROVE_ALL');
  }
  if (body.networkAccess !== undefined && !['disabled', 'allowlist', 'enabled'].includes(body.networkAccess)) {
    errors.push('networkAccess must be one of disabled|allowlist|enabled');
  }
  if (body.maxSteps !== undefined && !(Number.isFinite(body.maxSteps) && body.maxSteps >= 1 && body.maxSteps <= 50)) {
    errors.push('maxSteps must be between 1 and 50');
  }
  const mem = body.memory;
  if (mem !== undefined) {
    if (typeof mem !== 'object' || mem === null) errors.push('memory must be an object');
    else {
      for (const k of ['working', 'longterm']) {
        if (mem[k] !== undefined && (!Array.isArray(mem[k]) || mem[k].length > 50)) errors.push(`memory.${k} must be an array of at most 50 items`);
      }
    }
  }
  return errors;
}

const server = http.createServer(async (req, res) => {
  const requestId = newRequestId();
  res._requestId = requestId;
  res._cors = corsHeaders(req);
  let u;
  try {
    u = new URL(req.url, `http://localhost:${config.port}`);
  } catch {
    return sendError(res, 400, 'bad_request', 'malformed URL');
  }
  const path = u.pathname;

  if (!allowRequest(req, path)) {
    res._retryAfter = 60;
    return sendError(res, 429, 'rate_limited', 'too many requests; retry shortly');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...securityHeaders(),
      ...(res._cors || {}),
      ...(res._cors?.['Access-Control-Allow-Origin'] ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    return res.end();
  }

  let body = '';
  let bodyTooLarge = false;
  req.on('data', (c) => {
    if (bodyTooLarge) return;
    body += c;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) bodyTooLarge = true;
  });
  req.on('end', async () => {
    if (bodyTooLarge) {
      log.warn('request body too large', { requestId, path });
      return sendError(res, 413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    let json = {};
    let malformedJson = false;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        json = (parsed && typeof parsed === 'object') ? parsed : {};
      } catch {
        malformedJson = true;
      }
    }
    if (malformedJson && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      return sendError(res, 400, 'invalid_json', 'request body is not valid JSON');
    }

    // Authenticate every request; only non-production defaults to dev-open.
    // Distributed rate limit (multi-instance) runs after the fast local shed
    // at the top of the handler; single-process deployments skip it.
    const distLimit = await allowRequestDistributed(req, path);
    if (!distLimit.allowed) {
      res._retryAfter = 60;
      return sendError(res, 429, 'rate_limited', 'too many requests; retry shortly');
    }
    const principal = await currentPrincipal(req);
    // Session cookies are HttpOnly and SameSite=Lax; also reject cross-origin
    // state changes when a browser supplies an Origin header. Bearer-token and
    // non-browser requests remain compatible with signed/token auth.
    if (principal?.source === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && req.headers.origin && !res._cors['Access-Control-Allow-Origin']) {
      return sendError(res, 403, 'csrf_origin_denied', 'request origin is not allowed');
    }
    try {
      // ---------- Stripe-compatible billing webhook boundary ----------
      // This endpoint is intentionally outside user auth: Stripe authenticates
      // it with the signed raw body. Only sanitized metadata is persisted in
      // the durable idempotency store; SavingsEngine remains the sole source
      // of economics and is never recomputed here.
      if (req.method === 'POST' && path === '/api/webhooks/stripe') {
        if (!config.stripeWebhookSecret) return sendError(res, 503, 'not_configured', 'billing webhook is not configured');
        const verified = verifyStripeSignature(body, req.headers['stripe-signature'], config.stripeWebhookSecret);
        if (!verified.ok) return sendError(res, 400, verified.code, 'invalid billing webhook signature');
        if (!json || typeof json.id !== 'string' || typeof json.type !== 'string') {
          return sendError(res, 400, 'bad_request', 'billing webhook event requires id and type');
        }
        const metadata = eventMetadata(json);
        const key = `stripe:webhook:${metadata.eventId}`;
        // Distributed reservation: cross-instance safe when a remote
        // idempotency backend is configured (Postgres/Redis); otherwise the
        // local reservation applies and `degraded` is observable.
        const reservation = await idempotencyStore.beginAsync(key, { op: 'stripe_webhook', state: 'running' });
        if (!reservation.fresh) return send(res, 200, { received: true, deduplicated: true, event: metadata });
        await idempotencyStore.completeAsync(key, metadata);
        log.info('billing webhook accepted', { eventId: metadata.eventId, type: metadata.type, livemode: metadata.livemode });
        return send(res, 200, { received: true, deduplicated: false, event: metadata });
      }

      // ---------- account/session bootstrap ----------
      if (req.method === 'POST' && path === '/api/auth/signup') {
        try {
          const created = await tenants.signup({ email: json.email, password: json.password, name: json.name });
          const session = await tenants.login({ email: json.email, password: json.password });
          res._setCookie = buildSessionCookie(session.token, { secure: currentMode() === 'live' || config.isProduction });
          await auditEvent({ actor: created.user.id, action: 'auth.signup', orgId: created.user.orgId, detail: { projectId: created.project && created.project.id } });
          return send(res, 201, { user: created.user, project: created.project });
        } catch (e) {
          const code = e && e.code === 'conflict' ? 'conflict' : 'bad_request';
          return sendError(res, code === 'conflict' ? 409 : 400, code, e && e.message);
        }
      }
      if (req.method === 'POST' && path === '/api/auth/login') {
        try {
          const session = await tenants.login({ email: json.email, password: json.password });
          res._setCookie = buildSessionCookie(session.token, { secure: currentMode() === 'live' || config.isProduction });
          await auditEvent({ actor: session.user.id, action: 'auth.login', orgId: session.user.orgId });
          return send(res, 200, { user: session.user });
        } catch (e) {
          return sendError(res, 401, 'unauthenticated', 'invalid email or password');
        }
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        const rawCookie = readSessionCookie(req.headers);
        if (rawCookie) {
          try { await tenants.revoke(rawCookie); } catch {}
        }
        res._setCookie = clearSessionCookie();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/auth/me') {
        return send(res, 200, { authenticated: !!principal && principal.id !== 'dev', principal: principal || null });
      }
      if (req.method === 'GET' && path === '/api/projects') {
        if (needAuth(res, principal)) return;
        return send(res, 200, { projects: await tenants.listProjects(principal) });
      }
      if (req.method === 'POST' && path === '/api/projects') {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        const project = await tenants.createProject(principal, {
          name: json.name, referenceModelId: json.referenceModelId,
          policy: json.policy, privacyMode: json.privacyMode,
        });
        return send(res, 201, { project });
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && req.method === 'GET') {
        if (needAuth(res, principal)) return;
        const project = await tenants.getProject(decodeURIComponent(projectMatch[1]), principal);
        return project ? send(res, 200, { project }) : sendError(res, 404, 'not_found', 'project not found');
      }
      if (projectMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        const before = await tenants.getProject(decodeURIComponent(projectMatch[1]), principal);
        if (!before) return sendError(res, 404, 'not_found', 'project not found');
        const project = await tenants.updateProject(decodeURIComponent(projectMatch[1]), principal, json);
        if (!project) return sendError(res, 403, 'forbidden', 'project is not accessible');
        if (json.privacyMode && json.privacyMode !== before.privacyMode) await purgeProjectContent(project.id, project.privacyMode);
        return send(res, 200, { project });
      }
      if (req.method === 'GET' && path === '/api/health') {
        // Liveness: is the process alive? Never fails on dependency outage.
        const mode = refreshRuntimeMode();
        return send(res, 200, {
          ok: true, service: 'orchestraai', version: APP_VERSION, mode,
        });
      }
      if (req.method === 'GET' && (path === '/api/health/details' || path === '/api/health/detailed')) {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        // Detailed health: dependencies, event bus, memory. A dependency is
        // healthy only on real evidence (probe/registry), never on config.
        const mode = refreshRuntimeMode();
        const pr = providerRuntimeSnapshot(principal);
        let storageOk = true;
        let storageError = null;
        try {
          if (runStore.kind === 'postgres') {
            await runStore.pg.ping();
          } else {
            const probe = await runStore.saveRunIndex(await runStore.loadRunIndex());
            storageOk = !!probe.ok;
            storageError = probe.error || null;
          }
        } catch (e) {
          storageOk = false;
          storageError = String((e && e.message) || e).slice(0, 200);
        }
        const mem = process.memoryUsage();
        return send(res, 200, {
          ok: true, service: 'orchestraai', version: APP_VERSION, mode,
          activeProvider: pr.activeProvider,
          providerRuntime: pr,
          activeRuns: orchestrator.activeRuns.size,
          terminalRetained: orchestrator.terminalRuns ? orchestrator.terminalRuns.size : 0,
          persistence: { ok: storageOk, ...(storageError ? { error: storageError } : {}) },
          eventBus: {
            runs: eventBus.eventLogs.size,
            subscribers: Array.from(eventBus.subscribers.values()).reduce((a, s) => a + s.size, 0),
            globalSeq: eventBus.globalSeq,
          },
          memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
          discovery: discovery.lastResult || { enabled: discovery.enabled },
        });
      }
      // Readiness (distinct from liveness): initialized + storage writable.
      // A non-critical provider outage never makes the service unready.
      // Production startup requirements (Agent 1): database, Redis
      // coordination state, encryption config, and auth config are reported
      // as explicit checks alongside the legacy storage/registry fields
      // (response shape is additive — existing fields unchanged).
      if (req.method === 'GET' && (path === '/api/ready' || path === '/api/readiness')) {
        const mode = refreshRuntimeMode();
        const models = await modelRegistry.getModels().catch(() => null);
        let storageProbe;
        if (datastore.kind === 'postgres' && datastore.pg) {
          try {
            await datastore.pg.ping();
            storageProbe = { ok: true };
          } catch (e) {
            storageProbe = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
          }
        } else {
          storageProbe = await runStore.saveRunIndex(await runStore.loadRunIndex());
        }
        const registryOk = Array.isArray(models);
        // Live mode with zero models and no discovery path is not ready to
        // accept work; demo mode always has its labelled catalog.
        const discoveryPending = mode === 'live' && models && models.length === 0 && !discovery.enabled;
        const infra = await checkReadiness({
          config,
          datastoreKind: datastore.kind,
          datastoreProbe: storageProbe,
          redis: coordinationReady ? coordinator : {
            backend: 'initializing',
            degraded: true,
            lastError: 'shared coordination is still initializing',
          },
          authConfig,
        });
        const ready = registryOk && storageProbe.ok && !discoveryPending && infra.ready && bootDone && !bootError && (!coordinationRequired || coordinationReady);
        return send(res, ready ? 200 : 503, {
          ready,
          service: 'orchestraai',
          mode,
          provider: config.provider,
          checks: {
            boot: { ok: bootDone && !bootError, ...(bootError ? { error: String((bootError && bootError.message) || bootError).slice(0, 200) } : {}) },
            registry: { ok: registryOk, models: Array.isArray(models) ? models.length : 0 },
            storage: { ok: storageProbe.ok, kind: datastore.kind, ...(storageProbe.ok ? {} : { error: storageProbe.error }) },
            provider: {
              configured: !!effectiveKey(config.provider),
              note: 'provider outage does not affect readiness',
            },
            discovery: discovery.lastResult || { enabled: discovery.enabled },
            // Production infrastructure (additive).
            datastore: infra.checks.datastore,
            redis: infra.checks.redis,
            encryption: infra.checks.encryption,
            auth: infra.checks.auth,
            coordination: {
              locks: locks.backend,
              rateLimits: distributedLimiter.distributed ? 'distributed' : 'process-local',
              queue: jobQueue.provider,
              ready: coordinationReady,
              queueStats: (typeof jobQueue.stats === 'function' ? jobQueue.stats() : null),
              idempotency: idempotencyStore.distributed ? 'distributed' : 'process-local',
            },
          },
        });
      }
      if (req.method === 'GET' && path === '/api/config') {
        // Non-secret runtime configuration for the UI badge. No credentials.
        // Precedence: process defaults -> runtime settings -> run overrides
        // (see src/run-config.js). Only safe-to-change settings are runtime.
        if (authConfig.enabled && needAuth(res, principal)) return;
        refreshRuntimeMode();
        const mode = modeForPrincipal(principal);
        const pr = providerRuntimeSnapshot(principal);
        return send(res, 200, {
          mode, modeState: modeStateForProvider(config.provider, principal), provider: config.provider,
          activeProvider: pr.activeProvider,
          providerRuntime: pr,
          version: APP_VERSION,
          maxSteps: config.maxSteps, runTimeoutMs: config.runTimeoutMs,
          defaultBudgetUsd: config.defaultBudgetUsd,
          platformFeePct: config.platformFeePct,
          discoveryEnabled: discovery.enabled,
          runtime: runtimeSettings.load(),
          precedence: 'process defaults -> runtime settings -> run-specific overrides',
        });
      }
      // ---------- provider configuration (backend-mediated, secrets never leave) ----------
      if (req.method === 'GET' && path === '/api/providers') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        refreshRuntimeMode();
        const mode = modeForPrincipal(principal);
        const pr = providerRuntimeSnapshot(principal);
        return send(res, 200, {
          mode, modeState: modeStateForProvider(config.provider, principal),
          activeProvider: pr.activeProvider,
          providers: SUPPORTED_PROVIDERS.map((id) => providerStatus(id, principal)),
          // Explicit authoritative config (new) + legacy `providers` (compat).
          providerRuntime: pr,
        });
      }
      const provMatch = path.match(/^\/api\/providers\/([^/]+)(\/(status|connect|test))?$/);
      if (provMatch) {
        const pid = provMatch[1].toLowerCase();
        const sub = provMatch[3];
        if (!SUPPORTED_PROVIDERS.includes(pid)) {
          return sendError(res, 404, 'not_found', `unsupported provider "${provMatch[1]}" (supported: ${SUPPORTED_PROVIDERS.join(', ')})`);
        }
        if (req.method === 'GET' && (!sub || sub === 'status')) {
          if (authConfig.enabled && needAuth(res, principal)) return;
          refreshRuntimeMode();
          return send(res, 200, { provider: providerStatus(pid, principal), mode: modeForProvider(pid, principal), modeState: modeStateForProvider(pid, principal) });
        }
        if (req.method === 'POST' && (sub === 'test' || sub === 'connect')) {
          // Sensitive mutation: operator+ (connect requires admin since it
          // persists credentials). 401 when unauthenticated, 403 otherwise.
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, sub === 'connect' ? 'admin' : 'operator')) return;
          const canUseDeploymentCredential = !authConfig.enabled || !principal || isGlobalAdmin(principal);
          const candidate = typeof json.apiKey === 'string' && json.apiKey
            ? json.apiKey : (credentials.getKey(pid, credentialScope(principal)) || (canUseDeploymentCredential ? effectiveKey(pid) : ''));
          if (!candidate) {
            return sendError(res, 400, 'bad_request', 'apiKey required (no stored or env key found)');
          }
          if (sub === 'connect' && (typeof json.apiKey !== 'string' || json.apiKey.length < 8 || json.apiKey.length > 500)) {
            return sendError(res, 400, 'bad_request', 'API key must be 8–500 characters');
          }
          const started = Date.now();
          try {
            const probe = providerRegistry.buildFresh(pid, candidate);
            await probe.verifyCredentials();
            const latencyMs = Date.now() - started;
            let modelCount = null;
            try {
              const listed = await probe.listModels();
              if (Array.isArray(listed)) modelCount = listed.length;
            } catch { /* listing is informational; verification already passed */ }
            const result = { ok: true, latencyMs, modelCount };
            recordProbe(pid, result);
            if (sub === 'connect') {
              const scope = credentialScope(principal);
              credentials.setKey(pid, candidate, scope);
              credentials.recordVerification(pid, result, scope);
              const mode = refreshRuntimeMode();
              log.info('provider connected', { provider: pid, latencyMs, mode });
              // Populate the tenant's live catalog before reporting success so
              // the onboarding flow can issue its first real request safely.
              try { await discovery.refreshOnce(pid, scope, 'live'); } catch { /* verification already passed */ }
            }
            refreshRuntimeMode();
            log.info('provider verified', { requestId, provider: pid, latencyMs, userId: principal && principal.id });
            return send(res, 200, { ok: true, latencyMs, modelCount, provider: providerStatus(pid, principal), mode: modeForProvider(pid, principal), modeState: modeStateForProvider(pid, principal), activeProvider: providerRuntimeSnapshot(principal).activeProvider });
          } catch (e) {
            const latencyMs = Date.now() - started;
            const code = (e && e.code) || 'unavailable';
            const safe = redact((e && e.message) || 'verification failed');
            const result = { ok: false, error: safe, code, latencyMs };
            recordProbe(pid, result);
            if (sub === 'connect') credentials.recordVerification(pid, result, credentialScope(principal));
            log.warn('provider verification failed', { provider: pid, code });
            const status = code === 'auth' ? 401 : code === 'bad_request' ? 400 : 502;
            return send(res, status, { ok: false, error: safe.slice(0, 300), code, provider: providerStatus(pid, principal) });
          }
        }
        if (req.method === 'DELETE' && !sub) {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'admin')) return;
          const scope = credentialScope(principal);
          const hadStored = credentials.remove(pid, scope);
          providerRegistry.invalidate(pid);
          const mode = refreshRuntimeMode();
          log.info('provider disconnected', { requestId, provider: pid, hadStored, mode, userId: principal && principal.id });
          return send(res, 200, { ok: true, removedStored: hadStored, provider: providerStatus(pid, principal), mode, modeState: modeStateForProvider(pid, principal) });
        }
        return sendError(res, 405, 'method_not_allowed', 'unsupported method for provider endpoint');
      }
      // ---------- runtime presets + defaults ----------
      if (req.method === 'GET' && path === '/api/runtime/presets') {
        return send(res, 200, { presets: listPresets() });
      }
      if (req.method === 'GET' && path === '/api/runtime/settings') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        return send(res, 200, { settings: runtimeSettings.load(), presets: listPresets() });
      }
      if ((req.method === 'PUT' || req.method === 'POST') && path === '/api/runtime/settings') {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'admin')) return;
        const next = runtimeSettings.save({
          defaultPreset: json.defaultPreset,
          defaultBudgetUsd: json.defaultBudgetUsd,
          maxSteps: json.maxSteps,
          allowSwitching: json.allowSwitching,
          allowCompaction: json.allowCompaction,
          toolPolicy: json.toolPolicy,
          qualityFloor: json.qualityFloor,
          latencyTargetMs: json.latencyTargetMs,
          hardBudget: json.hardBudget,
        });
        try { orchestrator.setRuntimeDefaults(next); } catch {}
        log.info('runtime settings updated', { requestId, userId: principal && principal.id });
        return send(res, 200, { settings: next });
      }
      if (req.method === 'GET' && path === '/api/models') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const models = await modelRegistry.getModels();
        return send(res, 200, {
          models: models.map((model) => enrichModel(model, modeForProvider(model.provider, principal))),
          meta: {
            updatedAt: (discovery.lastResult && discovery.lastResult.at) || null,
            discoveryEnabled: discovery.enabled,
          mode: modeForProvider(config.provider, principal),
          },
        });
      }
      // Contextual catalog refresh (Models page / provider details only).
      if (req.method === 'POST' && path === '/api/models/refresh') {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        const pid = typeof json.provider === 'string' && SUPPORTED_PROVIDERS.includes(json.provider.toLowerCase())
          ? json.provider.toLowerCase() : undefined;
        const result = await discovery.refreshOnce(pid, credentialScope(principal), modeForProvider(pid, principal));
        if (result && result.error) {
          return send(res, 502, { ok: false, error: `refresh failed: ${result.error}`, ...result });
        }
        if (result && result.skipped) {
          return send(res, 200, { ok: false, skipped: result.skipped, ...result });
        }
        return send(res, 200, { ok: true, ...result, changes: modelChanges.load().slice(-10) });
      }
      if (req.method === 'GET' && path === '/api/models/changes') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const limit = clampInt(u.searchParams.get('limit'), 30, 1, 100);
        return send(res, 200, { changes: modelChanges.load().slice(-limit).reverse() });
      }
      if (req.method === 'GET' && path === '/api/tools') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const tools = await toolRegistry.getTools();
        return send(res, 200, { tools });
      }
      if (req.method === 'GET' && path === '/api/memory') {
        const scope = u.searchParams.get('scope');
        const q = (u.searchParams.get('q') || '').slice(0, 200).toLowerCase();
        const limit = clampInt(u.searchParams.get('limit'), 100, 1, 500);
        if (scope && !MEMORY_SCOPES.has(scope)) {
          return sendError(res, 400, 'bad_request', 'scope must be working or longterm');
        }
        if (authConfig.enabled && needAuth(res, principal)) return;
        const dump = memoryManager.dumpAll();
        let items = [...dump.working, ...dump.longterm].map((m) => ({
          id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
          createdAt: m.createdAt, lastUsedAt: m.lastUsedAt, runId: m.runId || m.sourceRunId || null,
          orgId: m.orgId || null, projectId: m.projectId || null,
          importance: m.importance, confidence: m.confidence, status: m.status,
        }));
        if (authConfig.enabled && principal && !isGlobalAdmin(principal)) {
          const visIndex = await runStore.loadRunIndex();
          items = items.filter((i) => memoryVisibleToPrincipal(i, principal, visIndex));
        }
        if (scope) items = items.filter((i) => i.scope === scope);
        if (q) items = items.filter((i) => (i.title + i.snippet + i.source).toLowerCase().includes(q));
        return send(res, 200, { items: items.slice(0, limit) });
      }
      if (req.method === 'GET' && path === '/api/evaluations') {
        const runId = u.searchParams.get('runId');
        const limit = clampInt(u.searchParams.get('limit'), 50, 1, 200);
        if (runId && !validRunId(runId)) return sendError(res, 400, 'bad_request', 'invalid runId');
        if (runId) { if (await guardRunRead(res, principal, runId)) return; }
        else if (authConfig.enabled) {
          if (needAuth(res, principal)) return;
          if (!isGlobalAdmin(principal)) {
            const all = evaluations.list({ runId: null, limit: 500 });
            const evalIndex = await runStore.loadRunIndex();
            return send(res, 200, { evaluations: all.filter((e) => !ownedByOtherWithIndex(e.runId, principal, evalIndex)).slice(0, limit) });
          }
        }
        return send(res, 200, { evaluations: evaluations.list({ runId, limit }) });
      }
      // ---------- Session 2 intelligence API (read-only unless noted) ----------
      // Model capability profiles + empirical performance (Session 4 consumes
      // data; never computes). Provider facts and observed intelligence stay
      // separate; unknown renders as null ("Not measured").
      if (req.method === 'GET' && path === '/api/models/intelligence') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const models = await modelRegistry.getModels();
        const profiles = models.map((m) => {
          const obs = typeof modelRegistry.getObserved === 'function' ? modelRegistry.getObserved(m.id) : null;
          const taskPerf = intelligence.performance ? intelligence.performance.forModel(m.id, principal && principal.orgId) : {};
          return buildCapabilityProfile(m, obs, taskPerf);
        });
        return send(res, 200, { profiles, versions: VERSIONS, mode: currentMode() });
      }
      const perfMatch = path.match(/^\/api\/models\/([^/]+)\/performance$/);
      if (perfMatch && req.method === 'GET') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const modelId = decodeURIComponent(perfMatch[1]);
        const model = await modelRegistry.getModel(modelId);
        if (!model) return sendError(res, 404, 'not_found', 'model not found');
        const obs = typeof modelRegistry.getObserved === 'function' ? modelRegistry.getObserved(modelId) : null;
        const taskPerf = intelligence.performance ? intelligence.performance.forModel(modelId, principal && principal.orgId) : {};
        return send(res, 200, {
          profile: buildCapabilityProfile(model, obs, taskPerf),
          versions: VERSIONS,
        });
      }
      // Routing decision detail for a run (live or persisted history).
      const routingMatch = path.match(/^\/api\/routing\/([^/]+)$/);
      if (routingMatch && req.method === 'GET') {
        const id = routingMatch[1];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (await guardRunRead(res, principal, id)) return;
        const ctrl = orchestrator.control ? orchestrator.control(id) : null;
        if (ctrl && ctrl.routing) {
          return send(res, 200, {
            runId: id,
            currentId: (orchestrator.activeRuns.get(id) || {}).model
              ? orchestrator.activeRuns.get(id).model.currentModel : null,
            candidates: ctrl.routing.candidates || [],
            decision: ctrl.routing.decision && typeof ctrl.routing.decision.toJSON === 'function'
              ? ctrl.routing.decision.toJSON() : ctrl.routing.decision || null,
            counterfactuals: ctrl.routing.counterfactuals || [],
            explanation: ctrl.routing.explanation || null,
            tradeoff: ctrl.routing.tradeoff || null,
            taskProfile: ctrl.routing.taskProfile || null,
            inputsHash: ctrl.routing.inputsHash || null,
            policyVersion: ctrl.routing.policyVersion || null,
            history: intelligence.routingHistory ? intelligence.routingHistory.forRun(id) : [],
          });
        }
        const persisted = await runStore.loadSnapshot(id);
        if (persisted && persisted.routing) {
          return send(res, 200, { runId: id, persisted: true, ...persisted.routing });
        }
        return sendError(res, 404, 'not_found', 'run not found');
      }
      // Authoritative prompt plan + explainable context selection for a run.
      const planMatch = path.match(/^\/api\/context\/([^/]+)\/plan$/);
      if (planMatch && req.method === 'GET') {
        const id = planMatch[1];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (await guardRunRead(res, principal, id)) return;
        const runtimeState = orchestrator.activeRuns.get(id);
        if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
        const ctrl = orchestrator.control ? orchestrator.control(id) : {};
        const plan = await contextManager.buildPromptPlan(runtimeState, {
          messages: (ctrl.messages || []).slice(-10).map((m) => ({ role: m.role, content: m.content })),
          history: (ctrl.history || []).slice(-10),
          contextWindow: runtimeState.model.modelContextLimit || runtimeState.context.maximumTokens,
        });
        const explanation = contextManager.explainSelection
          ? contextManager.explainSelection(runtimeState) : null;
        return send(res, 200, { runId: id, plan, explanation });
      }
      // Hybrid memory search with per-hit explanations (read-only).
      if (req.method === 'GET' && path === '/api/memory/search') {
        const q = (u.searchParams.get('q') || '').slice(0, 500);
        const limit = clampInt(u.searchParams.get('limit'), 10, 1, 50);
        const runId = u.searchParams.get('runId');
        const scopes = (u.searchParams.get('scope') || 'working,longterm').split(',').map((s) => s.trim()).filter(Boolean);
        if (!q) return sendError(res, 400, 'bad_request', 'q required');
        if (runId && !validRunId(runId)) return sendError(res, 400, 'bad_request', 'invalid runId');
        if (runId) { if (await guardRunRead(res, principal, runId)) return; }
        else if (authConfig.enabled && needAuth(res, principal)) return;
        const dump = memoryManager.dumpAll();
        let pool = [...dump.working, ...dump.longterm].filter((m) => !scopes.length || scopes.includes(m.scope));
        if (authConfig.enabled && principal && !isGlobalAdmin(principal)) {
          const searchIndex = await runStore.loadRunIndex();
          pool = pool.filter((m) => memoryVisibleToPrincipal(m, principal, searchIndex));
        }
        const { rankMemories } = require('./src/intelligence/memory-intelligence');
        const ranked = rankMemories(pool.filter((m) => m.status === 'active'), q, { limit });
        return send(res, 200, {
          query: q,
          results: ranked.map((r) => ({
            id: r.memory.id, scope: r.memory.scope, title: r.memory.title,
            snippet: r.memory.snippet, source: r.memory.source,
            importance: r.memory.importance, confidence: r.memory.confidence,
            score: r.s.score, components: r.s.components, explanation: r.s.explanation,
          })),
          retrievalVersion: VERSIONS.memoryRetrieval,
        });
      }
      // Memory conflicts visible to a run (both records retained, newer
      // project-scoped preference preferred).
      if (req.method === 'GET' && path === '/api/memory/conflicts') {
        const runId = u.searchParams.get('runId');
        if (!runId || !validRunId(runId)) return sendError(res, 400, 'bad_request', 'runId required');
        if (await guardRunRead(res, principal, runId)) return;
        const runtimeState = orchestrator.activeRuns.get(runId);
        if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
        const conflicts = typeof memoryManager.listConflicts === 'function'
          ? memoryManager.listConflicts(runtimeState) : [];
        return send(res, 200, { runId, conflicts });
      }
      // Outcome evaluations v2 (genuine success assessment, not just
      // completion). The v1 /api/evaluations rubric endpoint is unchanged.
      if (req.method === 'GET' && path === '/api/outcomes') {
        const runId = u.searchParams.get('runId');
        const limit = clampInt(u.searchParams.get('limit'), 50, 1, 200);
        if (runId && !validRunId(runId)) return sendError(res, 400, 'bad_request', 'invalid runId');
        if (runId) { if (await guardRunRead(res, principal, runId)) return; }
        else if (authConfig.enabled) {
          if (needAuth(res, principal)) return;
          if (!isGlobalAdmin(principal)) {
            const all = intelligence.listOutcomes({ runId: null, limit: 500 });
            const outIndex = await runStore.loadRunIndex();
            return send(res, 200, { outcomes: all.filter((o) => !ownedByOtherWithIndex(o.runId, principal, outIndex)).slice(0, limit), evaluatorVersion: VERSIONS.evaluator });
          }
        }
        return send(res, 200, { outcomes: intelligence.listOutcomes({ runId, limit }), evaluatorVersion: VERSIONS.evaluator });
      }
      const outcomeMatch = path.match(/^\/api\/outcomes\/([^/]+)$/);
      if (outcomeMatch && req.method === 'GET') {
        const id = outcomeMatch[1];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (await guardRunRead(res, principal, id)) return;
        const outcome = intelligence.outcomeForRun(id);
        if (!outcome) return sendError(res, 404, 'not_found', 'no outcome evaluation for run');
        return send(res, 200, { outcome });
      }
      // Structured decisions for a run (live or persisted).
      const decisionsMatch = path.match(/^\/api\/decisions\/([^/]+)$/);
      if (decisionsMatch && req.method === 'GET') {
        const id = decisionsMatch[1];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (await guardRunRead(res, principal, id)) return;
        const ctrl = orchestrator.control ? orchestrator.control(id) : null;
        if (ctrl && ctrl.decisions) {
          return send(res, 200, {
            runId: id,
            decisions: ctrl.decisions.map((d) => (d && typeof d.toJSON === 'function' ? d.toJSON() : d)),
          });
        }
        const persisted = await runStore.loadSnapshot(id);
        if (persisted && persisted.decisions) return send(res, 200, { runId: id, persisted: true, decisions: persisted.decisions });
        return sendError(res, 404, 'not_found', 'run not found');
      }
      // Benchmark dataset (evaluation platform architecture; no seed data).
      if (req.method === 'GET' && path === '/api/benchmarks') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        return send(res, 200, { cases: intelligence.benchmarks.listCases() });
      }
      if (req.method === 'POST' && path === '/api/benchmarks') {
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        try {
          const c = intelligence.benchmarks.createCase({
            id: json.id, category: json.category, prompt: json.prompt,
            context: json.context, successCriteria: json.successCriteria,
            expectedCapabilities: json.expectedCapabilities,
          });
          try { await runStore.saveIntelligence(intelligence.dump()); } catch { /* best-effort */ }
          return send(res, 201, { case: c });
        } catch (e) {
          return sendError(res, 400, (e && e.code) || 'bad_request', (e && e.message) || 'invalid benchmark case');
        }
      }
      const benchMatch = path.match(/^\/api\/benchmarks\/([^/]+)(\/attempts)?$/);
      if (benchMatch && (req.method === 'GET' || req.method === 'POST')) {
        const benchId = decodeURIComponent(benchMatch[1]);
        if (benchMatch[2] === '/attempts' && req.method === 'POST') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!intelligence.benchmarks.getCase(benchId)) return sendError(res, 404, 'not_found', 'benchmark case not found');
          const a = intelligence.benchmarks.recordAttempt({
            caseId: benchId, modelId: json.modelId, runId: json.runId,
            outcome: json.outcome, passed: json.passed, score: json.score,
            cost: json.cost, latencyMs: json.latencyMs,
          });
          try { await runStore.saveIntelligence(intelligence.dump()); } catch { /* best-effort */ }
          return send(res, 201, { attempt: a });
        }
        if (req.method === 'GET' && !benchMatch[2]) {
          if (authConfig.enabled && needAuth(res, principal)) return;
          const c = intelligence.benchmarks.getCase(benchId);
          if (!c) return sendError(res, 404, 'not_found', 'benchmark case not found');
          return send(res, 200, { case: c, summary: intelligence.benchmarks.summarize(benchId) });
        }
      }
      // Explicit user feedback signal (one signal among many, §32).
      const feedbackMatch = path.match(/^\/api\/runs\/([^/]+)\/feedback$/);
      if (feedbackMatch && req.method === 'POST') {
        const id = feedbackMatch[1];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (needAuth(res, principal)) return;
        if (await guardRunRead(res, principal, id)) return;
        const signal = typeof json.signal === 'string' ? json.signal.slice(0, 32)
          : typeof json.value === 'string' ? json.value.slice(0, 32) : null;
        if (!signal) return sendError(res, 400, 'bad_request', 'signal required');
        const fb = intelligence.recordFeedback(id, {
          signal, rating: json.rating, confidence: json.confidence,
        });
        try { await runStore.saveIntelligence(intelligence.dump()); } catch { /* best-effort */ }
        return send(res, 200, { ok: true, runId: id, feedback: fb });
      }
      // Named control-center collections. These are view-specific projections
      // over the canonical run, snapshot, provider, and SavingsEngine stores;
      // they do not introduce a second persistence or accounting model.
      if (req.method === 'GET' && path === '/api/sessions') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        return send(res, 200, { sessions: (await visibleRunIndex(principal)).slice(-200).reverse().map((r) => ({
          sessionId: r.id, title: r.title, status: r.status,
          projectId: r.projectId || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
        })) });
      }
      if (req.method === 'GET' && path === '/api/cache') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const runs = await visibleRunIndex(principal);
        let hits = 0; let misses = 0; let cachedTokens = 0;
        for (const run of runs) {
          const snapshot = await runStore.loadSnapshot(run.id);
          const cache = snapshot?.cache || {};
          hits += Number(cache.hits) || 0;
          misses += Number(cache.misses) || 0;
          cachedTokens += Number(snapshot?.usage?.cachedTokens) || 0;
        }
        return send(res, 200, {
          cache: { hits, misses, hitRate: hits + misses > 0 ? hits / (hits + misses) : 0, cachedTokens, providerCostOnLocalHit: 0 },
          note: 'Local response-cache hits make no provider call and have zero provider inference cost. Semantic reuse is separately gated.',
        });
      }
      if (req.method === 'GET' && path === '/api/alerts') {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const alerts = [];
        for (const provider of SUPPORTED_PROVIDERS.map((id) => providerStatus(id, principal))) {
          if (provider.configured && provider.healthy === false) alerts.push({
            id: `provider-${provider.id}`, severity: 'warning', source: 'provider_health',
            title: `${provider.label} health check failed`, at: provider.lastCheckedAt,
          });
        }
        for (const run of (await visibleRunIndex(principal)).slice(-50)) {
          if (run.status === 'failed') alerts.push({ id: `run-${run.id}`, severity: 'error', source: 'run', title: `Run failed: ${String(run.title || run.id).slice(0, 100)}`, at: run.updatedAt });
        }
        return send(res, 200, { alerts: alerts.slice(-100).reverse(), note: 'Alerts are factual runtime signals; no alert is emitted without an observed failure.' });
      }
      // ---------- Orchestra Intelligence analytics APIs ----------
      // Reusable analytics contracts over canonical economics + observed
      // telemetry. The backend is authoritative; the frontend never prices
      // independently and never fabricates thin slices (INSUFFICIENT_DATA).
      const INTELLIGENCE_SECTIONS = {
        '/api/analytics/intelligence': null,
        '/api/analytics/models': 'topModels',
        '/api/analytics/leaderboard': 'leaderboard',
        '/api/analytics/tasks': 'tasks',
        '/api/analytics/cost': 'cost',
        '/api/analytics/market-share': 'marketShare',
        '/api/analytics/benchmarks': 'benchmarks',
        '/api/analytics/latency': 'latency',
        '/api/analytics/context': 'context',
        '/api/analytics/tools': 'tools',
        '/api/analytics/workloads': 'workloads',
        '/api/analytics/languages': 'languages',
        '/api/analytics/images': 'images',
        '/api/analytics/execution-flow': 'executionFlow',
      };
      if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(INTELLIGENCE_SECTIONS, path)) {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const granularity = ['daily', 'weekly', 'monthly'].includes(u.searchParams.get('granularity')) ? u.searchParams.get('granularity') : 'daily';
        const range = u.searchParams.get('range') || '30d';
        const from = u.searchParams.get('from') || null;
        const to = u.searchParams.get('to') || null;
        const filters = {
          model: u.searchParams.get('model') || null,
          provider: u.searchParams.get('provider') || null,
          taskCategory: u.searchParams.get('taskCategory') || u.searchParams.get('task') || null,
          projectId: u.searchParams.get('projectId') || u.searchParams.get('project') || null,
        };
        const allRuns = await visibleRunIndex(principal);
        const economicsByRun = new Map();
        const snapshotsByRun = new Map();
        for (const run of allRuns) {
          try {
            const economics = await economicsForRun(run.id, u.searchParams.get('referenceModel') || null);
            economicsByRun.set(run.id, economics);
          } catch { /* per-run economics must not fail the whole surface */ }
          try {
            const live = orchestrator.getRun ? orchestrator.getRun(run.id) : null;
            if (live) {
              const snap = buildSnapshot(orchestrator, run.id);
              if (snap) snapshotsByRun.set(run.id, snap);
            } else {
              const persisted = await runStore.loadSnapshot(run.id);
              if (persisted) snapshotsByRun.set(run.id, persisted);
            }
          } catch { /* snapshot failure is non-fatal */ }
        }
        let registryModels = [];
        try { registryModels = await modelRegistry.getModels(); } catch { registryModels = []; }
        const observedByModel = new Map();
        try {
          if (typeof modelRegistry.getObserved === 'function') {
            for (const m of registryModels) {
              const obs = modelRegistry.getObserved(m.id);
              if (obs) observedByModel.set(m.id, obs);
            }
          }
        } catch { /* observed enrichment is best-effort */ }
        // currentMode() is deployment-level; per-tenant LIVE requires the
        // tenant's own credential (modeForPrincipal). Prefer the stricter
        // per-principal view so demo tenants never see LIVE provenance.
        let intelMode = currentMode();
        try { if (principal) intelMode = modeForPrincipal(principal); } catch { /* keep deployment mode */ }
        const full = buildIntelligence({
          runs: allRuns, economicsByRun, snapshotsByRun,
          models: registryModels, observedByModel, intelligence,
          mode: intelMode,
          tenantId: principal ? (principal.orgId || null) : null,
          options: { granularity, range, from, to, filters },
        });
        const sectionKey = INTELLIGENCE_SECTIONS[path];
        if (!sectionKey) return send(res, 200, { intelligence: full });
        return send(res, 200, { meta: full.meta, section: sectionKey, data: full[sectionKey] || null });
      }
      // ---------- canonical economics / analytics / billing APIs ----------
      // All three surfaces consume the same SavingsEngine result. There is no
      // second savings formula in analytics or billing.
      if (req.method === 'GET' && (path === '/api/savings' || path === '/api/analytics/overview' || path === '/api/billing')) {
        if (authConfig.enabled && needAuth(res, principal)) return;
        const from = u.searchParams.get('from') || null;
        const to = u.searchParams.get('to') || null;
        const runs = (await visibleRunIndex(principal)).filter((r) => ['completed', 'failed', 'cancelled'].includes(String(r.status)));
        const lines = [];
        const displayRuns = [];
        const economicsByRun = new Map();
        for (const run of runs) {
          const economics = await economicsForRun(run.id, u.searchParams.get('referenceModel') || null);
          economicsByRun.set(run.id, economics);
          if (withinDateRange(run, from, to)) {
            // Keep every terminal outcome visible in history, including
            // incomplete/insufficient runs. Aggregate billing below only
            // consumes eligible lines, so display rows cannot affect totals.
            displayRuns.push({
              runId: run.id,
              title: run.title || 'Untitled task',
              status: run.status,
              date: run.updatedAt || run.createdAt,
              economics,
            });
          }
          if (withinDateRange(run, from, to)) {
            lines.push({ runId: run.id, title: run.title || 'Untitled task', date: run.updatedAt || run.createdAt, savings: economics, snapshot: await runStore.loadSnapshot(run.id) });
          }
        }
        if (path === '/api/billing') {
          return send(res, 200, {
            billing: aggregateBilling(lines),
            lineItems: lines.map((line) => billingLine(line.savings, { date: line.date })),
            note: 'BYOK billing: provider inference is paid directly by the customer; Orchestra bills only the platform fee on eligible positive modeled savings.',
          });
        }
        if (path === '/api/analytics/overview') {
          const analyticsRuns = [];
          for (const r of runs) analyticsRuns.push({ ...r, snapshot: await runStore.loadSnapshot(r.id) });
          return send(res, 200, { analytics: buildAnalytics(analyticsRuns, economicsByRun, { from, to }) });
        }
        const summary = aggregateBilling(lines);
        return send(res, 200, {
          summary,
          runs: displayRuns.slice(-100).reverse().map((line) => ({
            runId: line.runId, title: line.title, status: line.status, date: line.date, economics: line.economics,
          })),
          waterfall: [
            { key: 'modeled_baseline', label: 'Modeled baseline', amount: summary.baselineCost, kind: 'baseline' },
            { key: 'modeled_execution_delta', label: 'Modeled execution delta', amount: summary.optimizedProviderCost === null || summary.baselineCost === null ? null : summary.optimizedProviderCost - summary.baselineCost, kind: 'reduction' },
            { key: 'optimized_provider_cost', label: 'Optimized provider cost', amount: summary.optimizedProviderCost, kind: 'provider_cost' },
            { key: 'platform_fee', label: 'Orchestra platform fee', amount: summary.platformFee, kind: 'platform_fee' },
            { key: 'customer_final_cost', label: 'Customer final cost', amount: summary.customerFinalCost, kind: 'customer_cost' },
            { key: 'customer_net_savings', label: 'Customer net savings', amount: summary.customerNetSavings, kind: 'net_savings' },
          ],
          note: 'The bridge uses one canonical run-economics result. Modeled execution reduction = optimized provider cost − modeled baseline; platform fee is applied once. It is not an invoice.',
        });
      }
      if (req.method === 'GET' && path === '/api/runs') {
        // Live summaries over persisted history so terminal runs stay
        // queryable across restarts. Under auth, non-admin principals see
        // only their own tenant's runs. Ownerless legacy records are
        // quarantined rather than treated as public.
        if (authConfig.enabled && needAuth(res, principal)) return;
        return send(res, 200, { runs: await visibleRunIndex(principal) });
      }
      if (req.method === 'POST' && path === '/api/runs') {
        if (isDraining()) return sendError(res, 503, 'draining', 'server is shutting down; no new runs accepted');
        if (needAuth(res, principal)) return;
        if (needRole(res, principal, 'operator')) return;
        const errors = validateCreateRun(json);
        if (errors.length) return sendError(res, 400, 'bad_request', errors[0]);
        const title = String(json.title || 'New Task').slice(0, limits.maxTitleChars);
        const taskMode = json.taskMode || 'general';
        const project = json.projectId ? await tenants.getProject(String(json.projectId), principal) : null;
        if (json.projectId && !project) return sendError(res, 403, 'forbidden', 'project is not accessible');
        const defaults = runtimeSettings.load();
        const preset = getPreset(typeof json.preset === 'string' && validPreset(json.preset) ? json.preset : defaults.defaultPreset);
        const allowSwitching = typeof json.allowSwitching === 'boolean' ? json.allowSwitching : defaults.allowSwitching;
        const allowCompaction = typeof json.allowCompaction === 'boolean' ? json.allowCompaction : defaults.allowCompaction;
        const toolPolicy = json.toolPolicy === 'auto' || json.toolPolicy === 'readonly' ? json.toolPolicy : defaults.toolPolicy;
        // ResolvedRunConfig precedence lives in src/run-config.js; overrides
        // are passed explicitly here (never hidden).
        const runConfig = {
          taskType: taskMode,
          priority: typeof json.priority === 'string' ? json.priority.slice(0, 32) : 'normal',
          complexity: typeof json.complexity === 'string' ? json.complexity.slice(0, 32) : 'medium',
          maxCost: typeof json.budget === 'number' ? json.budget : defaults.defaultBudgetUsd,
          maxLatencyMs: typeof json.maxLatencyMs === 'number' ? json.maxLatencyMs : 300000,
          maxContextTokens: typeof json.maxContextTokens === 'number' ? json.maxContextTokens : config.defaultMaxContextTokens,
          maxSteps: Number.isFinite(json.maxSteps) ? Math.max(1, Math.min(50, Math.floor(json.maxSteps))) : defaults.maxSteps,
          provider: typeof json.provider === 'string' ? json.provider.slice(0, 64) : config.provider,
          mode: json.mode === 'demo' || json.mode === 'live'
            ? json.mode
            : modeForProvider(typeof json.provider === 'string' ? json.provider : config.provider, principal),
          ownerId: principal ? principal.id : null,
          orgId: principal?.orgId || null,
          projectId: project ? project.id : null,
          referenceModelId: project?.referenceModelId || (typeof json.referenceModelId === 'string' ? json.referenceModelId.slice(0, 200) : null),
          privacyMode: project?.privacyMode || 'standard',
          policy: {
            ...(Number.isFinite(defaults.qualityFloor) ? { qualityFloor: defaults.qualityFloor } : {}),
            ...(Number.isFinite(defaults.latencyTargetMs) ? { latencyTargetMs: defaults.latencyTargetMs } : {}),
            ...(defaults.hardBudget ? { hardBudget: true } : {}),
            ...(json.policy && typeof json.policy === 'object' ? json.policy : {}),
            preset: preset.id,
            routerWeights: preset.weights,
            minReliability: preset.policy.minReliability || 0,
            preferredModel: typeof json.preferredModel === 'string' && json.preferredModel ? json.preferredModel.slice(0, 200) : undefined,
            allowSwitching,
            allowCompaction,
          },
          toolPolicy,
          tools: json.tools,
          memory: json.memory,
          // Session 3 execution policy passthrough (validated above).
          autonomyMode: typeof json.autonomyMode === 'string' ? json.autonomyMode : undefined,
          approvalMode: typeof json.approvalMode === 'string' ? json.approvalMode : undefined,
          networkAccess: typeof json.networkAccess === 'string' ? json.networkAccess : undefined,
          networkAllowlist: Array.isArray(json.networkAllowlist) ? json.networkAllowlist.slice(0, 20) : undefined,
        };
        if (runConfig.mode === 'live') {
          let liveState = modeStateForProvider(runConfig.provider, principal);
          // The execution registry is the authority for the call that will
          // actually run. This also keeps injected provider adapters in the
          // integration boundary honest without weakening production checks.
          if (liveState !== 'LIVE_READY' && orchestrator.providerRegistry && orchestrator.providerRegistry !== providerRegistry) {
            try {
              const adapter = orchestrator.providerRegistry.getAdapterForScope
                ? orchestrator.providerRegistry.getAdapterForScope(runConfig.provider, credentialScope(principal))
                : orchestrator.providerRegistry.getAdapter(runConfig.provider);
              if (adapter && adapter.hasCredentials) liveState = 'LIVE_READY';
            } catch { /* retain the unresolved state */ }
          }
          if (liveState !== 'LIVE_READY') {
            return sendError(res, 409, 'provider_unconfigured', `${runConfig.provider} is ${liveState}; connect and verify a provider credential before running LIVE`);
          }
        }
        let runtimeState;
        try {
          runtimeState = await orchestrator.createRun(title, runConfig);
        } catch (e) {
          if (e && e.code === 'busy') return sendError(res, 429, 'busy', String(e.message));
          throw e;
        }
        const ctrl = orchestrator.liveControl(runtimeState.runId) || orchestrator.control(runtimeState.runId);
        if (ctrl) {
          ctrl.preset = preset.id;
          ctrl.toolPolicy = toolPolicy;
        }
        persistActive();
        log.info('run created', { requestId, runId: runtimeState.runId, userId: principal && principal.id, taskMode, preset: preset.id });
        return send(res, 201, { run: runSummary(orchestrator, runtimeState.runId), preset: preset.id });
      }
      // Run comparison (two completed runs): duration, cost, tokens, model
      // path, tools, context, decisions, status. Read-only, history-backed.
      const cmp = path.match(/^\/api\/runs\/([^/]+)\/compare\/([^/]+)$/);
      if (cmp && req.method === 'GET') {
        const [idA, idB] = [cmp[1], cmp[2]];
        if (!validRunId(idA) || !validRunId(idB)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (authConfig.enabled && needAuth(res, principal)) return;
        if ((await guardRunRead(res, principal, idA)) || (await guardRunRead(res, principal, idB))) return;
        const result = await compareRuns(orchestrator, runStore, eventBus, idA, idB);
        if (!result) return sendError(res, 404, 'not_found', 'one or both runs not found');
        return send(res, 200, result);
      }

      const m = path.match(/^\/api\/runs\/([^/]+)(\/(state|events|messages|cancel|retry|telemetry|savings))?$/);
      if (m) {
        const id = m[1];
        const sub = m[3];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        if (authConfig.enabled && needAuth(res, principal)) return;
        // Unified lookup: live active + retired terminal history (Session 1).
        const runtimeState = (orchestrator.getRun && orchestrator.getRun(id)) || orchestrator.activeRuns.get(id) || null;
        const isLive = !!(runtimeState && orchestrator.isActiveRun && orchestrator.isActiveRun(id));
        const ownsRun = () => {
          if (!principal) return !authConfig.enabled;
          if (isGlobalAdmin(principal)) return true;
          if (!runtimeState) return false;
          if (runtimeState.orgId && principal.orgId && runtimeState.orgId === principal.orgId) return true;
          const owner = runtimeState.ownerId || null;
          if (!owner) return false;
          return owner === principal.id;
        };

        if (req.method === 'GET' && !sub) {
          if (runtimeState) {
            if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
            return send(res, 200, { run: runSummary(orchestrator, id) });
          }
          // Terminated history stays queryable after restart.
          const persisted = await persistedSummary(id);
          if (persisted) {
            if (authConfig.enabled && !canAccessRun(principal, persisted)) return sendError(res, 403, 'forbidden', 'not owner of this run');
            return send(res, 200, { run: persisted, persisted: true });
          }
          return sendError(res, 404, 'not_found', 'run not found');
        }
        if (req.method === 'GET' && sub === 'state') {
          if (runtimeState) {
            if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
            const state = buildSnapshot(orchestrator, id);
            if (state && ['completed', 'failed', 'cancelled'].includes(String(state.status))) state.economics = economicsForRuntime(runtimeState);
            return send(res, 200, { state });
          }
          // Terminated runs: serve the last persisted snapshot (read-only history).
          const persisted = await runStore.loadSnapshot(id);
          if (persisted) {
            if (authConfig.enabled && !canAccessRun(principal, persisted)) return sendError(res, 403, 'forbidden', 'not owner of this run');
            return send(res, 200, { state: persisted, persisted: true });
          }
          return sendError(res, 404, 'not_found', 'run not found');
        }
        if (req.method === 'GET' && sub === 'events') {
          if (await guardRunRead(res, principal, id)) return;
          // Multi-instance replay: ?since= and Last-Event-ID are equivalent
          // cursors (CONTRACTS.md shape unchanged). The durable event log
          // merges this instance's bus with durable storage so a client that
          // reconnects to a different instance still replays without loss.
          const rawSince = Number(u.searchParams.get('since'));
          const since = parseCursor({ since: rawSince, lastEventId: parseLastEventIdHeader(req) });
          if (datastore.kind === 'postgres') {
            const replay = await readDurableSince({ eventBus, store: runStore, runId: id, since });
            const hasLive = eventBus.eventLogs.has(id) || (replay.latestSeq || 0) > 0;
            if (!hasLive && !replay.events.length && !replay.latestSeq) return sendError(res, 404, 'not_found', 'run not found');
            res.writeHead(200, {
              ...securityHeaders(),
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              ...(res._cors || {}),
              ...((res._cors || {})['Access-Control-Allow-Origin'] ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
            });
            res.write(`: connected run=${id}\n\n`);
            if (replay.gap) {
              res.write(`event: gap\ndata: ${JSON.stringify({ runId: id, since, oldestSeq: replay.oldestSeq, message: 'event window truncated; resync via GET state' })}\n\n`);
            }
            for (const msg of replay.events || []) res.write(sseLine(msg));
            if (isLive) eventBus.subscribe(id, res);
            else res.end();
            return;
          }
          const served = await serveRunEvents({ eventBus, store: runStore, sseLine }, req, res, {
            runId: id, since, live: isLive,
            corsHeaders: res._cors || {},
            securityHeaders: securityHeaders(),
          });
          if (!served.served) return sendError(res, 404, 'not_found', 'run not found');
          return;
        }
        if (req.method === 'GET' && sub === 'telemetry') {
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          const ctrl = orchestrator.control(id);
          return send(res, 200, {
            telemetry: {
              ...orchestrator.getRunTelemetry(id),
              series: (ctrl && ctrl.series) || [],
              summary: orchestrator.getRunSummary(id),
            },
          });
        }
        if (req.method === 'GET' && sub === 'savings') {
          if (!runtimeState) {
            const persisted = await runStore.loadSnapshot(id);
            if (!persisted) return sendError(res, 404, 'not_found', 'run not found');
            runtimeState = persisted;
          }
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          const explicitRef = u.searchParams.get('referenceModel') || null;
          const terminal = ['completed', 'failed', 'cancelled'].includes(String(runtimeState.status));
          // Terminal runs are immutable economic records. An alternate
          // reference is useful while a run is active, but historical reads
          // must never re-price a completed call with today's catalog.
          const savingsResult = terminal
            ? economicsForRuntime(runtimeState)
            : SavingsEngine.calculateSavingsForRun(
              runtimeState,
              eventBus,
              modelRegistry,
              explicitRef,
              orchestrator,
              { platformFeePct: config.platformFeePct },
            );
          return send(res, 200, { savings: savingsResult });
        }
        if (req.method === 'POST' && sub === 'messages') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          if (typeof json.content !== 'string' || !json.content.trim()) {
            return sendError(res, 400, 'bad_request', 'content required');
          }
          const content = json.content.slice(0, limits.maxMessageChars);

          // Session 3: user intervention during execution becomes a runtime
          // constraint/command (stop/pause/resume/scopes), not just text.
          try {
            const cmd = await execution.userMessage(id, content);
            if (cmd && (cmd.command === 'stop' || cmd.command === 'pause' || cmd.command === 'resume')) {
              persistActive();
              return send(res, 202, { accepted: true, runtimeCommand: cmd.command });
            }
          } catch { /* fall through to normal flow */ }

          eventBus.emit(id, EventType.TASK_UPDATED, { userText: content });

          // Genuine execution path: API -> enqueue run.execute -> worker
          // claims -> executes (start or same-run continuation episode) ->
          // persists -> emits. 202 means a worker claimed the run (or settled
          // it instantly); late outcomes travel over SSE/run state. Duplicate
          // delivery while the run is executing is rejected as busy (never
          // double-executed). Run execution is non-retryable: unknown side
          // effects are never blindly re-run.
          try {
            const claimed = await jobQueue.enqueueAndClaim({
              type: 'run.execute',
              runId: id,
              payload: { runId: id, content },
              idempotencyKey: `run-execute:${id}`,
              retryable: false,
              maxAttempts: 1,
              timeoutMs: Math.min((config.runTimeoutMs || 300000) + 60000, 600000),
            }, { waitMs: 15000 });
            persistActive();
            log.info('run message accepted', { requestId, runId: id, userId: principal && principal.id });
            if (claimed && claimed.settled && claimed.result && claimed.result.continued) {
              return send(res, 202, { accepted: true, continued: true, episodeId: claimed.result.episodeId });
            }
            return send(res, 202, { accepted: true });
          } catch (e) {
            if (e && (e.code === 'duplicate' || e.code === 'busy')) {
              return sendError(res, 409, 'busy', 'Run is already executing; wait for it to finish.');
            }
            if (e && e.code === 'terminal') {
              return sendError(res, 409, 'terminal', String((e && e.message) || e).slice(0, 220));
            }
            if (e && (e.code === 'claim_timeout' || e.code === 'wait_timeout' || e.code === 'timed_out' || e.code === 'queue_closed' || e.code === 'worker_lost')) {
              return sendError(res, 503, 'execution_unavailable', 'Execution worker did not claim the run in time; the run state is durable — retry the message or check run state.');
            }
            throw e;
          }
        }
        if (req.method === 'POST' && sub === 'cancel') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          const ok = await orchestrator.cancelRun(id);
          persistActive();
          const summary = runSummary(orchestrator, id) || await persistedSummary(id) || { id, status: TaskStatus.CANCELLED };
          log.info('run cancel requested', { requestId, runId: id, userId: principal && principal.id, ok });
          return send(res, 200, { run: summary, cancelled: ok });
        }
if (req.method === 'POST' && sub === 'retry') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          const ok = await orchestrator.retryRun(id);
          if (!ok) {
            // Surface WHY recovery refused: the plan distinguishes "needs
            // operator input" from "nothing recoverable" for the UI.
            const plan = (orchestrator.lastRecoveryPlan && orchestrator.lastRecoveryPlan(id)) || null;
            return sendError(res, 409, 'retry_rejected', plan && plan.reason
              ? `Retry refused: ${String(plan.reason).slice(0, 220)}`
              : 'Retry is only available for failed runs with remaining budget.', plan ? { recoveryAction: plan.action, checkpointId: plan.checkpointId } : undefined);
          }
          persistActive();
          log.info('run retry accepted', { requestId, runId: id, userId: principal && principal.id });
          return send(res, 202, { accepted: true });
        }
        if (req.method === 'POST' && sub === 'fork') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          try {
            const newRunId = await orchestrator.forkRun(id);
            persistActive();
            log.info('run fork accepted', { requestId, runId: id, newRunId, userId: principal && principal.id });
            return send(res, 202, { accepted: true, newRunId });
          } catch (e) {
            log.warn('run fork failed', { requestId, runId: id, error: String((e && e.message) || e).slice(0, 200) });
            return sendError(res, 409, 'fork_refused', String((e && e.message) || e).slice(0, 220));
          }
        }
        if (req.method === 'POST' && sub === 'duplicate') {
          if (needAuth(res, principal)) return;
          if (needRole(res, principal, 'operator')) return;
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (authConfig.enabled && !ownsRun()) return sendError(res, 403, 'forbidden', 'not owner of this run');
          try {
            const newRunId = await orchestrator.duplicateRun(id);
            persistActive();
            log.info('run duplicate accepted', { requestId, runId: id, newRunId, userId: principal && principal.id });
            return send(res, 202, { accepted: true, newRunId });
          } catch (e) {
            log.warn('run duplicate failed', { requestId, runId: id, error: String((e && e.message) || e).slice(0, 220) });
            return sendError(res, 409, 'duplicate_refused', String((e && e.message) || e).slice(0, 220));
          }
        }
      }

      // ---------- Session 3: agent execution, approvals, recovery ----------
      // Session 1 compat: auth + ownership enforced here (no semantic change).
      const s3 = path.match(/^\/api\/runs\/([^/]+)\/(execution|continue|pause|resume|approvals|plan|changesets|verify|episodes|commands|environment|git|policy|result)(?:\/([^/]+)(?:\/(approve|deny|cancel|apply|rollback))?)?$/);
      if (s3) {
        const id = s3[1];
        const resource = s3[2];
        const extra = s3[3];
        const verb = s3[4];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        // Auth: reads need authentication, mutations need operator (dev-open
        // allows all in non-production when auth is unset, so existing clients remain unaffected).
        if (authConfig.enabled) {
          if (!principal) return sendError(res, 401, 'unauthenticated', 'authentication required');
          if (req.method !== 'GET' && !requireRole(principal, 'operator')) {
            return sendError(res, 403, 'forbidden', 'requires operator role or higher');
          }
          const s3run = (orchestrator.getRun && orchestrator.getRun(id)) || orchestrator.activeRuns.get(id) || null;
          // Same quarantine rule as guardRunRead/ownedByOther: ownerless
          // legacy runs are NOT implicitly shared with every authenticated
          // user. One rule everywhere, no IDOR drift between route groups.
          if (s3run && !isGlobalAdmin(principal) && (await ownedByOther(id, principal))) {
            return sendError(res, 403, 'forbidden', 'not owner of this run');
          }
        }
        // Liveness: most execution mutations need a live run, but the
        // continuation contract explicitly supports retired terminal runs
        // (same-run new episode resurrects COMPLETED/FAILED). Reads
        // (execution view, result, episodes list) also serve terminal history.
        const liveOnly = !(
          (req.method === 'POST' && resource === 'continue') ||
          (req.method === 'GET' && (resource === 'execution' || resource === 'result' || resource === 'episodes'))
        );
        if (liveOnly && !orchestrator.activeRuns.get(id)) {
          const persisted = await persistedSummary(id);
          if (!persisted) return sendError(res, 404, 'not_found', 'run not found');
          return sendError(res, 410, 'gone', 'run is persisted history; execution APIs need a live run');
        }
        if (!liveOnly && !orchestrator.activeRuns.get(id) && !(orchestrator.getRun && orchestrator.getRun(id))) {
          const persisted = await persistedSummary(id);
          if (!persisted) return sendError(res, 404, 'not_found', 'run not found');
          return sendError(res, 410, 'gone', 'run is persisted history; execution APIs need a live run');
        }
        const needBody = (fields) => {
          for (const f of fields) {
            if (json[f] === undefined) return sendError(res, 400, 'bad_request', `${f} required`);
          }
          return null;
        };
        if (req.method === 'GET' && resource === 'execution') {
          return send(res, 200, { execution: execution.executionView(id) });
        }
        if (req.method === 'GET' && resource === 'result') {
          const built = execution.results.get(id) || execution.buildResult(id);
          return send(res, 200, { result: built });
        }
        if (req.method === 'POST' && resource === 'continue') {
          const err = needBody(['content']);
          if (err) return err;
          if (typeof json.content !== 'string' || !json.content.trim()) return sendError(res, 400, 'bad_request', 'content required');
          try {
            const cont = await execution.continueRun(id, json.content.slice(0, 4000));
            if (!cont.ok) {
              const code = cont.code === 'busy' ? 409 : 400;
              return sendError(res, code, cont.code || 'bad_request', cont.error || 'cannot continue');
            }
            persistActive();
            return send(res, 202, { accepted: true, episodeId: cont.episode.episodeId });
          } catch (e) {
            return sendError(res, 409, 'busy', String((e && e.message) || e).slice(0, 300));
          }
        }
        if (req.method === 'POST' && resource === 'pause') {
          return send(res, 200, { pause: execution.pauseRun(id) });
        }
        if (req.method === 'POST' && resource === 'resume') {
          return send(res, 200, { pause: execution.resumeRun(id) });
        }
        if (req.method === 'POST' && resource === 'commands') {
          const err = needBody(['text']);
          if (err) return err;
          const out = await execution.userMessage(id, String(json.text).slice(0, 2000));
          persistActive();
          return send(res, 200, out);
        }
        if (resource === 'approvals') {
          if (req.method === 'GET' && !extra) {
            return send(res, 200, { approvals: execution.approvals.listForRun(id, true) });
          }
          if (req.method === 'POST' && !extra) {
            try {
              const req2 = execution.requestApproval(id, {
                actionType: String(json.actionType || 'apply_patch').slice(0, 64),
                title: json.title, description: json.description,
                riskLevel: json.riskLevel, params: json.params || {},
                proposedAction: json.proposedAction,
                affectedResources: json.affectedResources,
                estimatedChanges: json.estimatedChanges, estimatedCost: json.estimatedCost,
              });
              persistActive();
              return send(res, 201, { approval: req2 });
            } catch (e) {
              return sendError(res, 400, 'bad_request', String((e && e.message) || e).slice(0, 300));
            }
          }
          if (req.method === 'POST' && extra && ['approve', 'deny', 'cancel'].includes(verb)) {
            const r = execution.decideApproval(id, extra, verb, 'user');
            if (!r.ok) return sendError(res, 409, 'approval_rejected', r.error || 'cannot decide approval');
            persistActive();
            return send(res, 200, { approval: r.approval });
          }
          return sendError(res, 405, 'method_not_allowed', 'unsupported approvals method');
        }
        if (resource === 'plan') {
          if (req.method === 'GET') return send(res, 200, { plan: execution.plans.view(id) });
          if (req.method === 'POST' && Array.isArray(json.descriptions)) {
            return send(res, 201, { plan: execution.createPlan(id, json.descriptions.slice(0, 30)) });
          }
          if ((req.method === 'POST' || req.method === 'PATCH') && json.adapt) {
            return send(res, 200, { plan: execution.adaptPlan(id, json.adapt) });
          }
          if ((req.method === 'POST' || req.method === 'PATCH') && json.stepId && json.status) {
            const updated = execution.plans.setStatus(id, String(json.stepId), String(json.status));
            if (!updated) return sendError(res, 404, 'not_found', 'plan step not found');
            try { eventBus.emit(id, EventType.PLAN_UPDATED, { stepId: json.stepId, status: json.status }); } catch {}
            return send(res, 200, { step: updated });
          }
          return sendError(res, 400, 'bad_request', 'plan: POST {descriptions[]} to create, {adapt} to revise, or {stepId,status} to update');
        }
        if (resource === 'changesets') {
          if (req.method === 'GET' && !extra) {
            return send(res, 200, { changesets: execution.changesets.listForRun(id) });
          }
          if (req.method === 'POST' && extra === 'propose') {
            const err = needBody(['files']);
            if (err) return err;
            try {
              const cs = await execution.proposeChangeset(id, json.files, { riskLevel: json.riskLevel });
              persistActive();
              return send(res, 201, { changeset: cs });
            } catch (e) {
              return sendError(res, 400, 'bad_request', String((e && e.message) || e).slice(0, 500));
            }
          }
          if (req.method === 'POST' && extra && verb === 'apply') {
            const r = await execution.applyChangeset(id, extra, { approvalId: json.approvalId || null });
            if (!r.ok && r.needsApproval) return send(res, 202, { needsApproval: true, approvalId: r.approvalId });
            if (!r.ok) {
              const code = r.conflict ? 409 : 400;
              return sendError(res, code, r.conflict ? 'conflict' : 'bad_request', r.error || 'apply failed');
            }
            persistActive();
            return send(res, 200, { changeset: r.changeset });
          }
          if (req.method === 'POST' && extra && verb === 'rollback') {
            const r = await execution.rollbackChangeset(id, extra);
            if (!r.ok) {
              const code = r.conflict ? 409 : 400;
              return send(res, code, { ok: false, error: r.error, conflicts: r.conflicts, restored: r.restored });
            }
            persistActive();
            return send(res, 200, { ok: true, restored: r.restored, changeset: r.changeset });
          }
          return sendError(res, 405, 'method_not_allowed', 'unsupported changesets method');
        }
        if (req.method === 'POST' && resource === 'verify') {
          const r = await execution.verifyChangeset(id, json.changesetId || null, { origin: 'api' });
          persistActive();
          return send(res, 200, r);
        }
        if (req.method === 'GET' && resource === 'episodes') {
          return send(res, 200, { episodes: execution.episodes.list(id) });
        }
        if (req.method === 'GET' && resource === 'environment') {
          return send(res, 200, { environment: await execution.envProfile() });
        }
        if (req.method === 'POST' && resource === 'git') {
          const err = needBody(['op']);
          if (err) return err;
          const r = await execution.git(id, String(json.op), json);
          if (!r.ok && r.needsApproval) return send(res, 202, { needsApproval: true, approvalId: r.approvalId });
          if (!r.ok) return sendError(res, 400, 'bad_request', r.error || 'git op failed');
          persistActive();
          return send(res, 200, r);
        }
        if (resource === 'policy') {
          if (req.method === 'GET') return send(res, 200, { policy: execution.policyFor(id) });
          if (req.method === 'PUT' || req.method === 'POST') {
            const allowed = ['autonomyMode', 'approvalMode', 'allowedTools', 'deniedTools', 'allowedCommands', 'deniedCommands', 'networkAccess', 'networkAllowlist', 'writeAccess', 'maxSteps', 'maxToolCalls'];
            const patch = {};
            for (const k of allowed) if (json[k] !== undefined) patch[k] = json[k];
            if (patch.autonomyMode && !['read_only', 'assisted', 'autonomous', 'restricted_autonomous'].includes(patch.autonomyMode)) {
              return sendError(res, 400, 'bad_request', 'invalid autonomyMode');
            }
            if (patch.approvalMode && !['AUTO_APPROVE_LOW', 'APPROVE_WRITES', 'APPROVE_DANGEROUS', 'APPROVE_ALL'].includes(patch.approvalMode)) {
              return sendError(res, 400, 'bad_request', 'invalid approvalMode');
            }
            return send(res, 200, { policy: execution.setPolicy(id, patch) });
          }
          return sendError(res, 405, 'method_not_allowed', 'unsupported policy method');
        }
        return sendError(res, 404, 'not_found', 'unknown execution resource');
      }

      // Production console (only when frontend/dist was built into the image).
      if (serveConsole(req, res, path)) return;

      return sendError(res, 404, 'not_found', 'not found');
    } catch (e) {
      log.error('request failed', { requestId, path, error: String((e && e.message) || e).slice(0, 300) });
      return sendError(res, 500, 'internal', (e && e.message) || 'internal error');
    }
  });
});

if (require.main === module) {
  server.listen(config.port, () => log.info('runtime listening', { port: config.port, mode: config.mode, provider: config.provider }));
}

module.exports = { server, orchestrator, execution, config, providerRegistry, discovery, store, tenants, evaluations, intelligence, corsHeaders, resolveCorsOrigin, credentials, runtimeSettings, modelChanges, providerStatus, currentMode, refreshRuntimeMode, enrichModel, shutdown,
  // Agent 1 production infrastructure handles (additive exports for tests and
  // the final integrator; existing exports unchanged).
  datastore, coordinator: () => coordinator, locks: () => locks, jobQueue: () => jobQueue, idempotencyStore, allowRequestDistributed };
