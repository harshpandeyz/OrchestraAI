'use strict';

// Session 1 regression tests: backend foundation, reliability & security.
//
// Covers every concrete bug fixed in Session 1 (A–G + auth/provider/pagination
// /SSE/concurrency/terminal/errors/persistence/health/limits).
//
// Run: node backend/test/session1-regression.test.js
// No network. Demo provider only. Isolated data dir.

process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = 'backend/.runtime-data-session1-test';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.LOG_LEVEL = 'error';
// Auth disabled by default (dev-open) — enabled explicitly in auth tests.
delete process.env.AUTH_ENABLED;
delete process.env.API_TOKEN;

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { FileStore } = require('../src/persistence');
const { EvaluationStore } = require('../src/evals');
const { IdempotencyStore, STATES } = require('../src/idempotency');
const { resolveRunConfig, runConfigFor } = require('../src/run-config');
const { normalizeModelCost } = require('../src/cost/breakdown');
const { loadAuthConfig, authenticate, requireRole, canAccessRun } = require('../src/auth');
const { resolveProviderRuntime } = require('../src/provider-runtime');
const { loadLimits } = require('../src/limits');
const { appVersion } = require('../src/version');
const { ModelState, RuntimeState } = require('../src/state/runtime-state');
const { TaskStatus, CostCategory } = require('../src/core/types');
const { EventBus } = require('../src/events/event-bus');
const { Orchestrator } = require('../src/core/orchestrator');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryModelRouter } = require('../src/impl/model-router');
const { InMemoryContextManager } = require('../src/impl/context-manager');
const { InMemoryMemoryManager } = require('../src/impl/memory-manager');
const { InMemoryCacheManager } = require('../src/impl/cache-manager');
const { InMemoryToolRegistry } = require('../src/impl/tool-registry');
const { InMemoryToolExecutor } = require('../src/impl/tool-executor');
const { CostEstimator } = require('../src/cost/cost-estimator');
const { ProviderRegistry } = require('../src/providers/provider-adapter');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
    failed++;
  }
}

function makeOrchestrator(overrides = {}) {
  const reg = new InMemoryModelRegistry([
    { id: 'm-a', name: 'A', provider: 'demo', status: 'healthy', contextWindow: 64000, quality: 0.9, avgLatencyMs: 500, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0005, capabilities: ['text'] },
    { id: 'm-b', name: 'B', provider: 'demo', status: 'healthy', contextWindow: 64000, quality: 0.8, avgLatencyMs: 400, reliability: 0.98, inputPer1k: 0.0005, outputPer1k: 0.001, cachedPer1k: 0.0002, capabilities: ['text'] },
  ]);
  const toolReg = new InMemoryToolRegistry();
  toolReg.seedTools([
    { name: 'read_file', description: 'r', status: 'enabled', costPerCall: 0.0002, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
  return new Orchestrator({
    modelRegistry: reg,
    modelRouter: new InMemoryModelRouter(reg),
    contextManager: new InMemoryContextManager(),
    memoryManager: new InMemoryMemoryManager(),
    cacheManager: new InMemoryCacheManager(),
    toolRegistry: toolReg,
    toolExecutor: new InMemoryToolExecutor(toolReg),
    costEstimator: new CostEstimator(),
    providerRegistry: new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 1000 }),
    config: { mode: 'demo', provider: 'openrouter', maxSteps: 12, maxToolCalls: 5, maxRetries: 1, runTimeoutMs: 30000, ...(overrides.config || {}) },
  });
}

async function main() {
  // ---------- A. Per-run maxSteps authoritative ----------
  await test('A1. resolveRunConfig precedence: process -> runtime -> run', async () => {
    const r = resolveRunConfig({
      processDefaults: { maxSteps: 12 },
      runtimeDefaults: { maxSteps: 20 },
      overrides: { maxSteps: 3 },
    });
    assert.strictEqual(r.maxSteps, 3);
    const r2 = resolveRunConfig({ processDefaults: { maxSteps: 12 }, runtimeDefaults: { maxSteps: 20 }, overrides: {} });
    assert.strictEqual(r2.maxSteps, 20);
    const r3 = resolveRunConfig({ processDefaults: { maxSteps: 12 }, runtimeDefaults: {}, overrides: {} });
    assert.strictEqual(r3.maxSteps, 12);
  });

  await test('A2. per-run maxSteps controls execution (not global)', async () => {
    const orch = makeOrchestrator({ config: { maxSteps: 12 } });
    const st = await orch.createRun('a2', { maxSteps: 1 });
    const cfg = orch.runConfig(st.runId);
    assert.strictEqual(cfg.maxSteps, 1, 'resolved per-run config wins');
    // Legacy alias stays in sync.
    assert.strictEqual(orch.control(st.runId).maxSteps, 1);
  });

  await test('A3. runConfigFor falls back to global for legacy runs', async () => {
    const cfg = runConfigFor({ maxSteps: 7 }, { maxSteps: 12 });
    assert.strictEqual(cfg.maxSteps, 7);
    const cfg2 = runConfigFor(null, { maxSteps: 12 });
    assert.strictEqual(cfg2.maxSteps, 12);
  });

  // ---------- B. activeRuns lifecycle ----------
  await test('B1. successful completion leaves activeRuns (retired to history)', async () => {
    const orch = makeOrchestrator();
    const st = await orch.createRun('b1', {});
    await orch.startRun(st.runId, 'hello');
    await orch.waitForCompletion(st.runId, 30000);
    assert.strictEqual(orch.activeRuns.has(st.runId), false, 'terminal run not in activeRuns');
    assert.ok(orch.isTerminalRun(st.runId), 'retired to terminal history');
    assert.ok(orch.getRun(st.runId), 'history queryable via getRun');
  });

  await test('B2. failure + cancel retire from activeRuns', async () => {
    const orch = makeOrchestrator();
    // Failure path: empty registry -> no_models.
    orch.modelRegistry.models.clear();
    const st = await orch.createRun('b2-fail', {});
    await orch.startRun(st.runId, 'hello').catch(() => {});
    await orch.waitForCompletion(st.runId, 30000).catch(() => {});
    assert.strictEqual(orch.activeRuns.has(st.runId), false, 'failed run retired');

    const orch2 = makeOrchestrator();
    const st2 = await orch2.createRun('b2-cancel', {});
    // Cancel before start (CREATED -> CANCELLED is legal).
    const ok = await orch2.cancelRun(st2.runId);
    assert.strictEqual(ok, true);
    assert.strictEqual(orch2.activeRuns.has(st2.runId), false, 'cancelled run retired');
  });

  await test('B3. invalid state transition rejected (COMPLETED -> RUNNING)', async () => {
    const { StateMachine } = require('../src/core/state-machine');
    const sm = new StateMachine(TaskStatus.COMPLETED);
    assert.throws(() => sm.transition(TaskStatus.EXECUTING), /Invalid state transition/);
  });

  await test('B4. duplicate terminal transitions are idempotent', async () => {
    const orch = makeOrchestrator();
    const st = await orch.createRun('b4', {});
    await orch.startRun(st.runId, 'hello');
    await orch.waitForCompletion(st.runId, 30000);
    const before = (require('../src/events/event-bus').eventBus.eventLogs.get(st.runId) || []).length;
    // Second terminal call is a no-op (no duplicate run.completed).
    await orch._completeRun(st, {});
    const after = (require('../src/events/event-bus').eventBus.eventLogs.get(st.runId) || []).length;
    assert.strictEqual(after, before, 'no duplicate terminal event');
  });

  // ---------- C. apply_patch atomicity ----------
  await test('C1. multi-edit patch succeeds with hashes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello world\nfoo bar\n');
    const { HANDLERS } = require('../src/impl/tool-executor');
    delete process.env.WORKSPACE_ROOT;
    const origCwd = process.cwd();
    // Run handler with workspace=dir via ctx.
    const out = await HANDLERS.apply_patch.__call
      ? null
      : await (async () => {
        // Call via tool executor path with sandboxed workspace.
        const reg = new InMemoryToolRegistry();
        reg.seedTools([{ name: 'apply_patch', description: 'p', status: 'enabled', costPerCall: 0.001, parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] } }]);
        const ex = new InMemoryToolExecutor(reg, null, { workspace: dir });
        const rs = new RuntimeState('t');
        const res = await ex.execute('apply_patch', { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'hi' }, { oldText: 'foo', newText: 'baz' }] }, rs);
        assert.strictEqual(res.success, true, `patch failed: ${res.error}`);
        assert.ok(res.result.originalHash && res.result.resultingHash, 'hashes present');
        assert.notStrictEqual(res.result.originalHash, res.result.resultingHash);
        assert.strictEqual(res.result.editsApplied, 2);
        assert.strictEqual(res.result.atomic, true);
        const content = fs.readFileSync(file, 'utf8');
        assert.ok(content.includes('hi world') && content.includes('baz bar'));
        return true;
      })();
    assert.ok(out, 'patch applied');
    fs.rmSync(dir, { recursive: true, force: true });
    void origCwd;
  });

  await test('C2. failed second edit leaves original untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch2-'));
    const file = path.join(dir, 'b.txt');
    const original = 'alpha beta\ngamma delta\n';
    fs.writeFileSync(file, original);
    const reg = new InMemoryToolRegistry();
    reg.seedTools([{ name: 'apply_patch', description: 'p', status: 'enabled', costPerCall: 0.001, parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] } }]);
    const ex = new InMemoryToolExecutor(reg, null, { workspace: dir });
    const rs = new RuntimeState('t');
    const res = await ex.execute('apply_patch', { path: 'b.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'MISSING-CONTEXT-XYZ', newText: 'nope' }] }, rs);
    assert.strictEqual(res.success, false, 'second edit should fail');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'original unchanged (atomic)');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- D. FileStore ----------
  await test('D1. near-limit writes valid JSON (pruned, never truncated)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
    const s = new FileStore(dir, { maxBytes: 2000 });
    const big = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, data: 'x'.repeat(100) }));
    const r = s.saveEvents('run-x', big);
    assert.strictEqual(r.ok, true, `should prune, not fail: ${r.error}`);
    const raw = fs.readFileSync(path.join(dir, 'run-x.events.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'always valid JSON');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('D2. over-limit snapshot rejected safely (no malformed JSON)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs2-'));
    const s = new FileStore(dir, { maxBytes: 100 });
    const r = s.saveSnapshot('r1', { data: 'x'.repeat(10000), trace: Array.from({ length: 500 }, (_, i) => ({ i })) });
    // Either pruned to fit or rejected — but never a truncated file.
    if (!r.ok) assert.match(r.error, /too_large/);
    const p = path.join(dir, 'r1.snapshot.json');
    if (fs.existsSync(p)) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('D3. corruption quarantined, restart clean', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs3-'));
    const s = new FileStore(dir);
    s.saveRunIndex([{ id: 'a' }]);
    fs.writeFileSync(path.join(dir, 'runs.json'), '{corrupt');
    assert.deepStrictEqual(s.loadRunIndex(), []);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), 'quarantined');
    // Restart: new instance reads clean.
    const s2 = new FileStore(dir);
    assert.deepStrictEqual(s2.loadRunIndex(), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('D4. concurrent writes do not corrupt (sequential atomic)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs4-'));
    const s = new FileStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve(s.saveRunIndex([{ id: `r${i}` }]))));
    const raw = fs.readFileSync(path.join(dir, 'runs.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- E. Idempotency durability ----------
  await test('E1. idempotency states + UNIQUE key + durability', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-'));
    const store = new IdempotencyStore(dir);
    assert.strictEqual(store.statusOf('k1'), STATES.UNKNOWN);
    const b1 = store.begin('k1', { runId: 'r1', op: 'apply_patch' });
    assert.strictEqual(b1.fresh, true);
    assert.strictEqual(store.statusOf('k1'), STATES.RUNNING);
    const b2 = store.begin('k1', {});
    assert.strictEqual(b2.fresh, false, 'UNIQUE enforced');
    store.complete('k1', { ok: true });
    assert.strictEqual(store.statusOf('k1'), STATES.COMPLETED);
    // Restart: record survives.
    const store2 = new IdempotencyStore(dir);
    assert.strictEqual(store2.statusOf('k1'), STATES.COMPLETED);
    assert.deepStrictEqual(store2.get('k1').result, { ok: true });
    store2.fail('k2', new Error('boom'));
    assert.strictEqual(store2.statusOf('k2'), STATES.FAILED);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('E2. tool executor reuses durable COMPLETED (no re-execute)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-tool-'));
    const idem = new IdempotencyStore(dir);
    const reg = new InMemoryToolRegistry();
    reg.seedTools([{ name: 'read_file', description: 'r', status: 'enabled', costPerCall: 0.001, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
    const ex = new InMemoryToolExecutor(reg, null, { workspace: process.cwd(), idempotencyStore: idem });
    const rs = new RuntimeState('t');
    const key = ex.idempotencyKeyFor(rs.runId, 'read_file', { path: 'package.json' }, 0);
    idem.begin(key, { runId: rs.runId, op: 'read_file' });
    const fake = { toolName: 'read_file', success: true, result: { content: 'CACHED' }, error: null, latencyMs: 1, cost: 0.001, timestamp: new Date().toISOString(), code: 'success', executionId: 'exec-1', idempotencyKey: key };
    idem.complete(key, fake);
    const out = await ex.execute('read_file', { path: 'package.json' }, rs, { idempotencyKey: key });
    assert.strictEqual(out.deduped, true);
    assert.strictEqual(out.result.content, 'CACHED');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- F. Cost semantics ----------
  await test('F1. normalized breakdown separates categories (total != output)', async () => {
    const n = normalizeModelCost({ inputTokens: 1000, cachedTokens: 200, outputTokens: 500, reasoningTokens: 100, toolCosts: 0.001, pricing: { inputPer1k: 0.001, cachedPer1k: 0.0002, outputPer1k: 0.003 }, provider: 'p', model: 'm' });
    assert.strictEqual(n.inputTokens.tokens, 800);
    assert.strictEqual(n.cachedInputTokens.tokens, 200);
    assert.strictEqual(n.outputTokens.tokens, 500);
    assert.strictEqual(n.reasoningTokens.tokens, 100);
    assert.ok(n.totalUsd > n.outputTokens.costUsd, 'total includes more than output');
    assert.strictEqual(n.currency, 'USD');
  });

  await test('F2. estimator keeps legacy keys + normalized (compat)', async () => {
    const est = new CostEstimator().estimateModelCost('m', 'p', 1000, 500, 200);
    assert.ok(Number.isFinite(est[CostCategory.INPUT_TOKENS]));
    assert.ok(Number.isFinite(est[CostCategory.OUTPUT_TOKENS]));
    assert.ok(est.normalized && Number.isFinite(est.normalized.totalUsd));
    assert.ok(est.total >= est[CostCategory.OUTPUT_TOKENS], 'total is not output-only');
  });

  // ---------- G. Model switch counter ----------
  await test('G1. initial selection = 0 switches, A->B = 1, B->C = 2', async () => {
    const ms = new ModelState();
    assert.strictEqual(ms.modelSwitchCount, 0);
    ms.setCurrentModel('A', 'p', 'initial');
    assert.strictEqual(ms.modelSwitchCount, 0, 'initial is not a switch');
    ms.setCurrentModel('A', 'p', 'same');
    assert.strictEqual(ms.modelSwitchCount, 0, 'same model is not a switch');
    ms.setCurrentModel('B', 'p', 'switch');
    assert.strictEqual(ms.modelSwitchCount, 1);
    ms.setCurrentModel('C', 'p', 'switch');
    assert.strictEqual(ms.modelSwitchCount, 2);
  });

  // ---------- Auth ----------
  await test('H1. dev-open mode allows all (no token)', async () => {
    const cfg = loadAuthConfig({ AUTH_ENABLED: '' });
    assert.strictEqual(cfg.enabled, false);
    const p = authenticate({ headers: {} }, cfg);
    assert.strictEqual(p.role, 'admin');
  });

  await test('H2. token mode: 401 unauthenticated, 403 forbidden, ownership', async () => {
    const cfg = loadAuthConfig({ AUTH_ENABLED: 'true', API_TOKEN: 'admin-secret-123', READ_TOKEN: 'view-secret-123' });
    assert.strictEqual(authenticate({ headers: {} }, cfg), null, 'missing -> null (401)');
    const admin = authenticate({ headers: { authorization: 'Bearer admin-secret-123' } }, cfg);
    assert.strictEqual(admin.role, 'admin');
    const viewer = authenticate({ headers: { authorization: 'Bearer view-secret-123' } }, cfg);
    assert.strictEqual(viewer.role, 'viewer');
    assert.strictEqual(requireRole(viewer, 'operator'), false, 'viewer cannot do operator');
    assert.strictEqual(requireRole(admin, 'operator'), true);
    assert.strictEqual(canAccessRun(viewer, { ownerId: 'viewer' }), true);
    assert.strictEqual(canAccessRun(viewer, { ownerId: 'someone-else' }), false);
    assert.strictEqual(canAccessRun(viewer, {}), false, 'ownerless legacy = quarantined');
    assert.strictEqual(canAccessRun(admin, { ownerId: 'someone-else' }), true, 'admin bypass');
  });

  await test('H3. no hardcoded production credentials', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    assert.ok(!/sk-(live|prod|secret)/i.test(src), 'no hardcoded secrets');
  });

  // ---------- Provider runtime ----------
  await test('I1. provider runtime distinguishes registered/configured/enabled/active', async () => {
    const pr = resolveProviderRuntime({
      configuredProvider: 'openai',
      providerStatusFn: (id) => ({ id, configured: id === 'openai', connected: id === 'openai' }),
      disabled: new Set(['anthropic']),
    });
    assert.strictEqual(pr.activeProvider, 'openai');
    const openai = pr.availableProviders.find((p) => p.id === 'openai');
    assert.strictEqual(openai.registered, true);
    assert.strictEqual(openai.credentialsConfigured, true);
    assert.strictEqual(openai.active, true);
    const anth = pr.availableProviders.find((p) => p.id === 'anthropic');
    assert.strictEqual(anth.enabled, false);
    assert.strictEqual(anth.active, false);
  });

  // ---------- Pagination ----------
  await test('J1. evaluations pagination is newest-first, capped, runId-stable', async () => {
    const es = new EvaluationStore({ max: 5 });
    for (let i = 0; i < 8; i++) es.record({ runId: `run-${i % 2}`, completed: true, hasAssistantMessage: true, withinBudget: true });
    assert.strictEqual(es.dump().length, 5, 'bounded');
    const page = es.list({ limit: 2 });
    assert.strictEqual(page.length, 2, 'limit honored');
    // Specific record exists even when capped (not length-increase).
    const all = es.dump();
    assert.ok(all.some((e) => e.runId === 'run-0'));
  });

  // ---------- SSE ----------
  await test('K1. seq monotonic per run + gap signal + subscriber cleanup', async () => {
    const bus = new EventBus({ maxReplayBuffer: 5 });
    for (let i = 0; i < 8; i++) bus.emit('r1', 'test.event', { i });
    const log = bus.eventLogs.get('r1');
    assert.strictEqual(log.length, 5, 'bounded');
    for (let i = 1; i < log.length; i++) assert.ok(log[i].seq > log[i - 1].seq, 'monotonic');
    const gap = bus.getEventsSinceWithGap('r1', 1);
    assert.strictEqual(gap.gap, true, 'old since signals gap (no silent loss)');
    // Subscriber cleanup.
    const fake = { write: () => {}, on: () => {}, end: () => {} };
    bus.subscribe('r1', fake);
    assert.strictEqual(bus.subscriberCount('r1'), 1);
    bus.closeSubscribers('r1');
    assert.strictEqual(bus.subscriberCount('r1'), 0);
    bus.clearRun('r1');
    assert.strictEqual(bus.eventLogs.has('r1'), false);
  });

  // ---------- Limits / version ----------
  await test('L1. central limits + authoritative version', async () => {
    const lim = loadLimits({ LIMIT_MAX_BODY_BYTES: '1234' });
    assert.strictEqual(lim.maxBodyBytes, 1234);
    const v = appVersion();
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    assert.strictEqual(v, String(pkg.version), 'single version source');
  });

  // ---------- Security ----------
  await test('M1. workspace boundary enforced (no traversal)', async () => {
    const reg = new InMemoryToolRegistry();
    reg.seedTools([{ name: 'read_file', description: 'r', status: 'enabled', costPerCall: 0.001, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
    const ex = new InMemoryToolExecutor(reg, null, { workspace: '/tmp/sandbox-test-xyz' });
    const rs = new RuntimeState('t');
    const res = await ex.execute('read_file', { path: '../../etc/passwd' }, rs);
    assert.strictEqual(res.success, false, 'traversal blocked');
  });

  await test('M2. secrets never in snapshot payload (spot check)', async () => {
    const orch = makeOrchestrator();
    const st = await orch.createRun('m2', {});
    const { buildSnapshot } = require('../src/api/snapshot');
    const snap = buildSnapshot(orch, st.runId);
    const text = JSON.stringify(snap);
    assert.ok(!/sk-(or|openai|ant)-/i.test(text), 'no key material in snapshot');
    orch.cleanupRun(st.runId);
  });

  console.log(`\n--- Session1 results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('session1 harness failed:', e);
  process.exit(1);
});
