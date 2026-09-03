'use strict';

// Adaptive Agent Runtime — production server.
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
const { FileStore } = require('./src/persistence');
const { EvaluationStore } = require('./src/evals');
const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { MODELS, TOOLS, MEMORY } = require('./data');
const { TaskStatus, EventType } = require('./src/core/types');

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
const isLive = config.mode === 'live';

const modelRegistry = new InMemoryModelRegistry(isLive ? [] : MODELS, eventBus);
const switchingCostCalculator = new SwitchingCostCalculator();
const stickinessManager = new ModelStickinessManager();
const modelRouter = new InMemoryModelRouter(modelRegistry, switchingCostCalculator, stickinessManager, eventBus);
const contextManager = new InMemoryContextManager(eventBus);
const memoryManager = new InMemoryMemoryManager(eventBus);
// Canned memory is demo/test knowledge only; live runs start empty and
// accumulate their own run-scoped memory through real execution.
if (!isLive) memoryManager.seedMemory(MEMORY.working, MEMORY.longterm);
const cacheManager = new InMemoryCacheManager(eventBus);
const toolRegistry = new InMemoryToolRegistry(eventBus);
// Tool catalog is real (sandboxed handlers) in every mode.
toolRegistry.seedTools(TOOLS);
const toolExecutor = new InMemoryToolExecutor(toolRegistry, eventBus);
const costEstimator = new CostEstimator();
const providerRegistry = new ProviderRegistry(config);

const store = new FileStore(config.dataDir, { logger: log });
const evaluations = new EvaluationStore();
try {
  evaluations.loadAll(store.loadEvals());
} catch (e) {
  log.warn('evaluations restore failed', { error: String((e && e.message) || e).slice(0, 200) });
}

function persistActive() {
  try {
    const runs = orchestrator.getActiveRuns();
    const r = store.saveRunIndex(mergeIndex(store.loadRunIndex(), runs));
    if (!r.ok) log.warn('run index persist failed', { error: r.error });
    for (const run of runs) {
      const logEvents = eventBus.eventLogs.get(run.id) || [];
      const e1 = store.saveEvents(run.id, logEvents);
      if (!e1.ok) log.warn('events persist failed', { runId: run.id, error: e1.error });
      const snap = buildSnapshot(orchestrator, run.id);
      if (snap) {
        const e2 = store.saveSnapshot(run.id, snap);
        if (!e2.ok) log.warn('snapshot persist failed', { runId: run.id, error: e2.error });
      }
    }
    const e3 = store.saveEvals(evaluations.dump());
    if (!e3.ok) log.warn('evaluations persist failed', { error: e3.error });
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
      try {
        if (summary && summary.id) {
          store.upsertRunSummary(summary);
          const logEvents = eventBus.eventLogs.get(summary.id) || [];
          store.saveEvents(summary.id, logEvents);
          const snap = buildSnapshot(orchestrator, summary.id);
          if (snap) store.saveSnapshot(summary.id, snap);
          store.saveEvals(evaluations.dump());
        }
      } catch (e) {
        log.warn('run-end persist failed', { error: String((e && e.message) || e).slice(0, 200) });
      }
    },
  },
  config: {
    mode: config.mode,
    provider: config.provider,
    runTimeoutMs: config.runTimeoutMs,
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    maxRetries: config.maxRetries,
    providerTimeoutMs: config.providerTimeoutMs,
    optimizationInterval: 5,
    maxToolCallsTotal: 100,
    contextCompressionThreshold: 0.8,
    budgetWarningThreshold: 0.8,
  },
  logger: log,
});

const discovery = new DiscoveryService({ registry: modelRegistry, providerRegistry, config, logger: log });

// Merge live summaries over the persisted index (live wins on conflict).
function mergeIndex(persisted, live) {
  const byId = new Map();
  for (const entry of persisted || []) {
    if (entry && entry.id) byId.set(entry.id, entry);
  }
  for (const run of live || []) {
    if (run && run.id) byId.set(run.id, run);
  }
  return Array.from(byId.values()).slice(-200);
}

function persistedSummary(id) {
  const index = store.loadRunIndex();
  return index.find((r) => r && r.id === id) || null;
}

const TERMINAL_SUMMARY = new Set(['completed', 'failed', 'cancelled']);

// Restore persisted event logs so SSE replay + history survive restarts.
// In-flight execution does NOT resume; runs that were active at shutdown are
// marked interrupted (failed, honest about no resumption) instead of
// pretending to still execute.
(function restorePersisted() {
  try {
    const index = store.loadRunIndex();
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
    if (interrupted) store.saveRunIndex(rewritten);
    for (const entry of rewritten.slice(-50)) {
      if (!entry || !entry.id) continue;
      const events = store.loadEvents(entry.id);
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
    log.warn('persistence restore failed', { error: String((e && e.message) || e).slice(0, 200) });
  }
})();

discovery.ensureDefaultModel().catch(() => {});
discovery.start();

const persistTimer = setInterval(persistActive, 15000);
if (persistTimer.unref) persistTimer.unref();

// ---------- HTTP plumbing ----------

const MAX_BODY_BYTES = 256 * 1024;

function newRequestId() {
  return `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// CORS: configured frontend origin(s) only in production. Loopback origins
// stay usable for local development outside live mode. Unknown origins get no
// ACAO header (browser blocks); non-browser clients (no Origin) are unaffected.
// Pure + unit-testable CORS rule. corsHeaders() below binds it to this
// process's config.
function resolveCorsOrigin(origin, opts = {}) {
  if (!origin) return {};
  const configured = String(opts.frontendOrigin || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  if (!opts.isLive && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

function corsHeaders(req) {
  return resolveCorsOrigin(req.headers && req.headers.origin, {
    frontendOrigin: config.frontendOrigin,
    isLive,
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    ...(res._cors || {}),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

// Safe errors: { error, code, requestId }. Never keys, secrets, or stacks.
function sendError(res, httpCode, code, message) {
  send(res, httpCode, {
    error: String(message || 'internal error').slice(0, 500),
    code: code || 'internal',
    requestId: res._requestId || undefined,
  });
}

function sseLine(envelope) {
  if (envelope && typeof envelope.toSSE === 'function') return envelope.toSSE();
  return `event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

// ---------- validation ----------

const TASK_MODES = new Set(['code', 'debug', 'research', 'general']);
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
  if (body.taskMode !== undefined && !TASK_MODES.has(body.taskMode)) errors.push('taskMode must be one of code|debug|research|general');
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...(res._cors || {}),
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

    try {
      if (req.method === 'GET' && path === '/api/health') {
        return send(res, 200, {
          ok: true, service: 'adaptive-agent-runtime', version: '1.0.0',
          mode: config.mode, provider: config.provider,
          providerConfigured: providerRegistry.getAdapter(config.provider).hasCredentials,
          discovery: discovery.lastResult || { enabled: discovery.enabled },
          runs: orchestrator.activeRuns.size,
        });
      }
      // Readiness (distinct from liveness): initialized + storage writable.
      // A non-critical provider outage never makes the service unready.
      if (req.method === 'GET' && (path === '/api/ready' || path === '/api/readiness')) {
        const models = await modelRegistry.getModels().catch(() => null);
        const storageProbe = store.saveRunIndex(store.loadRunIndex());
        const registryOk = Array.isArray(models);
        // Live mode with zero models and no discovery path is not ready to
        // accept work; demo mode always has its labelled catalog.
        const discoveryPending = isLive && models && models.length === 0 && !discovery.enabled;
        const ready = registryOk && storageProbe.ok && !discoveryPending;
        return send(res, ready ? 200 : 503, {
          ready,
          service: 'adaptive-agent-runtime',
          mode: config.mode,
          provider: config.provider,
          checks: {
            registry: { ok: registryOk, models: Array.isArray(models) ? models.length : 0 },
            storage: { ok: storageProbe.ok, dir: config.dataDir, ...(storageProbe.ok ? {} : { error: storageProbe.error }) },
            provider: {
              configured: providerRegistry.getAdapter(config.provider).hasCredentials,
              note: 'provider outage does not affect readiness',
            },
            discovery: discovery.lastResult || { enabled: discovery.enabled },
          },
        });
      }
      if (req.method === 'GET' && path === '/api/config') {
        // Non-secret runtime configuration for the UI badge. No credentials.
        return send(res, 200, {
          mode: config.mode, provider: config.provider,
          maxSteps: config.maxSteps, runTimeoutMs: config.runTimeoutMs,
          defaultBudgetUsd: config.defaultBudgetUsd,
          discoveryEnabled: discovery.enabled,
        });
      }
      if (req.method === 'GET' && path === '/api/models') {
        const models = await modelRegistry.getModels();
        return send(res, 200, { models });
      }
      if (req.method === 'GET' && path === '/api/tools') {
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
        const dump = memoryManager.dumpAll();
        let items = [...dump.working, ...dump.longterm].map((m) => ({
          id: m.id, scope: m.scope, title: m.title, snippet: m.snippet, source: m.source,
          createdAt: m.createdAt, lastUsedAt: m.lastUsedAt,
          importance: m.importance, confidence: m.confidence, status: m.status,
        }));
        if (scope) items = items.filter((i) => i.scope === scope);
        if (q) items = items.filter((i) => (i.title + i.snippet + i.source).toLowerCase().includes(q));
        return send(res, 200, { items: items.slice(0, limit) });
      }
      if (req.method === 'GET' && path === '/api/evaluations') {
        const runId = u.searchParams.get('runId');
        const limit = clampInt(u.searchParams.get('limit'), 50, 1, 200);
        if (runId && !validRunId(runId)) return sendError(res, 400, 'bad_request', 'invalid runId');
        return send(res, 200, { evaluations: evaluations.list({ runId, limit }) });
      }
      if (req.method === 'GET' && path === '/api/runs') {
        // Live summaries over persisted history so terminal runs stay
        // queryable across restarts.
        return send(res, 200, { runs: mergeIndex(store.loadRunIndex(), orchestrator.getActiveRuns()) });
      }
      if (req.method === 'POST' && path === '/api/runs') {
        const errors = validateCreateRun(json);
        if (errors.length) return sendError(res, 400, 'bad_request', errors[0]);
        const title = String(json.title || 'New Task').slice(0, 200);
        const taskMode = json.taskMode || 'general';
        const runConfig = {
          taskType: taskMode,
          priority: typeof json.priority === 'string' ? json.priority.slice(0, 32) : 'normal',
          complexity: typeof json.complexity === 'string' ? json.complexity.slice(0, 32) : 'medium',
          maxCost: typeof json.budget === 'number' ? json.budget : config.defaultBudgetUsd,
          maxLatencyMs: typeof json.maxLatencyMs === 'number' ? json.maxLatencyMs : 300000,
          maxContextTokens: typeof json.maxContextTokens === 'number' ? json.maxContextTokens : config.defaultMaxContextTokens,
          provider: typeof json.provider === 'string' ? json.provider.slice(0, 64) : config.provider,
          policy: json.policy,
          tools: json.tools,
          memory: json.memory,
        };
        const runtimeState = await orchestrator.createRun(title, runConfig);
        persistActive();
        return send(res, 201, { run: runSummary(orchestrator, runtimeState.runId) });
      }

      const m = path.match(/^\/api\/runs\/([^/]+)(\/(state|events|messages|cancel|retry|telemetry))?$/);
      if (m) {
        const id = m[1];
        const sub = m[3];
        if (!validRunId(id)) return sendError(res, 400, 'bad_request', 'invalid run id');
        const runtimeState = orchestrator.activeRuns.get(id);

        if (req.method === 'GET' && !sub) {
          if (runtimeState) return send(res, 200, { run: runSummary(orchestrator, id) });
          // Terminated history stays queryable after restart.
          const persisted = persistedSummary(id);
          if (persisted) return send(res, 200, { run: persisted, persisted: true });
          return sendError(res, 404, 'not_found', 'run not found');
        }
        if (req.method === 'GET' && sub === 'state') {
          if (runtimeState) {
            const state = buildSnapshot(orchestrator, id);
            return send(res, 200, { state });
          }
          // Terminated runs: serve the last persisted snapshot (read-only history).
          const persisted = store.loadSnapshot(id);
          if (persisted) return send(res, 200, { state: persisted, persisted: true });
          return sendError(res, 404, 'not_found', 'run not found');
        }
        if (req.method === 'GET' && sub === 'events') {
          if (!runtimeState && !eventBus.eventLogs.has(id)) {
            // Persisted-only runs may not have reloaded logs in this process.
            const onDisk = store.loadEvents(id);
            if (!onDisk.length) return sendError(res, 404, 'not_found', 'run not found');
            eventBus.eventLogs.set(id, onDisk);
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(res._cors || {}),
          });
          res.write(`: connected run=${id}\n\n`);
          const rawSince = Number(u.searchParams.get('since'));
          const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;
          for (const msg of eventBus.getEventsSince(id, since)) {
            res.write(sseLine(msg));
          }
          if (runtimeState) eventBus.subscribe(id, res);
          else res.end();
          return;
        }
        if (req.method === 'GET' && sub === 'telemetry') {
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          const ctrl = orchestrator.control(id);
          return send(res, 200, {
            telemetry: {
              ...orchestrator.getRunTelemetry(id),
              series: (ctrl && ctrl.series) || [],
              summary: orchestrator.getRunSummary(id),
            },
          });
        }
        if (req.method === 'POST' && sub === 'messages') {
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          if (typeof json.content !== 'string' || !json.content.trim()) {
            return sendError(res, 400, 'bad_request', 'content required');
          }
          const content = json.content.slice(0, 4000);

          eventBus.emit(id, EventType.TASK_UPDATED, { userText: content });

          try {
            await orchestrator.startRun(id, content);
          } catch (e) {
            if (e && e.code === 'busy') return sendError(res, 409, 'busy', 'Run is already executing; wait for it to finish.');
            if (e && e.code === 'terminal') return sendError(res, 409, 'terminal', String(e.message));
            throw e;
          }
          persistActive();
          return send(res, 202, { accepted: true });
        }
        if (req.method === 'POST' && sub === 'cancel') {
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          const ok = await orchestrator.cancelRun(id);
          persistActive();
          const summary = runSummary(orchestrator, id) || { id, status: TaskStatus.CANCELLED };
          return send(res, 200, { run: summary, cancelled: ok });
        }
        if (req.method === 'POST' && sub === 'retry') {
          if (!runtimeState) return sendError(res, 404, 'not_found', 'run not found');
          const ok = await orchestrator.retryRun(id);
          if (!ok) return sendError(res, 409, 'retry_rejected', 'Retry is only available for failed runs with remaining budget.');
          persistActive();
          return send(res, 202, { accepted: true });
        }
      }

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

module.exports = { server, orchestrator, config, providerRegistry, discovery, store, evaluations, corsHeaders, resolveCorsOrigin };
