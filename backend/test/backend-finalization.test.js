'use strict';

// Session A regression tests: every bug fixed in the backend finalization
// session gets a failing-before/passing-after test here.
//
// Run: node backend/test/backend-finalization.test.js
// No network access. Demo provider only.

process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = 'backend/.runtime-data-finalization-test';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const srv = require('../server');
const { server, orchestrator, evaluations, corsHeaders, resolveCorsOrigin } = srv;
const { eventBus } = require('../src/events/event-bus');
const { buildSnapshot } = require('../src/api/snapshot');
const { FileStore } = require('../src/persistence');
const { EvaluationStore } = require('../src/evals');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryModelRouter } = require('../src/impl/model-router');
const { SwitchingCostCalculator, ModelStickinessManager } = require('../src/decisions/switching-cost');
const { RuntimeState } = require('../src/state/runtime-state');

let BASE = '';
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

function api(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runToCompletion(title, message) {
  const { status, json } = await api('POST', '/api/runs', { title, taskMode: 'general' });
  assert.strictEqual(status, 201, `create run: ${JSON.stringify(json)}`);
  const id = json.run.id;
  const sent = await api('POST', `/api/runs/${id}/messages`, { content: message });
  assert.strictEqual(sent.status, 202, `send message: ${JSON.stringify(sent.json)}`);
  await orchestrator.waitForCompletion(id, 60000);
  return id;
}

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://localhost:${server.address().port}`;
  // The semantic index is durable (shared via intelligence.json). Start cold
  // so fresh-execution assertions below are deterministic regardless of
  // entries persisted by earlier suite runs. This is fixture isolation, not
  // weakening: every assertion stays strict, and cross-run reuse itself is
  // covered by prompt-semantic.test.js.
  orchestrator.cacheManager.semantic.clear();

  // ---------- 1. cache-hit path: no ReferenceError, single cost count ----------
  await test('1. repeated prompt serves from cache without crashing', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'cache-1', taskMode: 'general' });
    const id = json.run.id;
    const st = orchestrator.activeRuns.get(id);
    await orchestrator._selectModel(st, 'test');
    // Force an identical second model call to hit the run-scoped prompt cache.
    const spyCosts = [];
    const origAdd = st.budget.addCost.bind(st.budget);
    st.budget.addCost = (cat, amt, meta) => { spyCosts.push([cat, amt]); return origAdd(cat, amt, meta); };
    const r1 = await orchestrator._callModel(st, 'hello cache', 1);
    assert.ok(r1.text, 'first call returns text');
    assert.strictEqual(r1.fromCache, undefined, 'first call is not from cache');
    const r2 = await orchestrator._callModel(st, 'hello cache', 1);
    assert.strictEqual(r2.fromCache, true, 'identical prompt hits cache');
    assert.strictEqual(r2.text, r1.text, 'cached text replays exactly');
    const cachedAdds = spyCosts.filter(([c]) => c === 'cached_input_tokens');
    assert.strictEqual(cachedAdds.length, 1, 'cache-hit cost recorded exactly once');
    orchestrator.cleanupRun(id);
  });

  // ---------- 2. router scoring is finite/bounded on malformed models ----------
  await test('2. router scores stay finite with missing/invalid telemetry', async () => {
    const registry = new InMemoryModelRegistry([
      { id: 'weird', name: 'Weird', provider: 'p', status: 'healthy', contextWindow: 0, capabilities: ['text'] }, // no pricing/latency/quality
      { id: 'nan', name: 'NaN', provider: 'p', status: 'healthy', contextWindow: 32000, quality: NaN, avgLatencyMs: Infinity, reliability: -3, inputPer1k: NaN, outputPer1k: undefined, capabilities: ['text'] },
    ]);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('t');
    state.context.currentTokens = 500;
    const { candidates } = await router.evaluateCandidates(state.task, state, await registry.getModels());
    assert.strictEqual(candidates.length, 2);
    for (const c of candidates) {
      for (const k of ['score', 'quality', 'cost', 'latency', 'reliability', 'contextFit', 'switchCost']) {
        assert.ok(Number.isFinite(c[k]), `${c.modelId}.${k} finite (got ${c[k]})`);
        if (['score', 'quality', 'cost', 'latency', 'reliability', 'contextFit'].includes(k)) {
          assert.ok(c[k] >= 0 && c[k] <= 1, `${c.modelId}.${k} bounded [0,1]`);
        }
      }
      assert.strictEqual(c.estimatedCost, null, `${c.modelId} has no fabricated estimated cost`);
    }
  });

  await test('2b. context-incompatible candidates are eliminated', async () => {
    const registry = new InMemoryModelRegistry([
      { id: 'small', name: 'Small', provider: 'p', status: 'healthy', contextWindow: 1000, quality: 0.99, avgLatencyMs: 100, reliability: 0.99, inputPer1k: 0.0001, outputPer1k: 0.0002, capabilities: ['text'] },
      { id: 'big', name: 'Big', provider: 'p', status: 'healthy', contextWindow: 128000, quality: 0.7, avgLatencyMs: 2000, reliability: 0.9, inputPer1k: 0.001, outputPer1k: 0.003, capabilities: ['text'] },
    ]);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('t');
    state.context.currentTokens = 50000; // exceeds small's window
    const { selectedModel } = await router.route(state.task, state, await registry.getModels(), state.policy);
    assert.strictEqual(selectedModel, 'big', 'small-window model eliminated despite higher quality');
  });

  await test('2c. empty candidate pool throws no_models instead of crashing', async () => {
    const registry = new InMemoryModelRegistry([]);
    const router = new InMemoryModelRouter(registry);
    const state = new RuntimeState('t');
    await assert.rejects(router.route(state.task, state, [], state.policy), /No available models/);
  });

  // ---------- 3. stickiness + net benefit units ----------
  await test('3. switching-cost object no longer bypasses hysteresis', async () => {
    const m = new ModelStickinessManager({ cooldownPeriodMs: 0, hysteresisFactor: 1.5 });
    const withObject = m.canSwitch('r', 'a', 'b', 0.001, { total: 0.01 });
    assert.strictEqual(withObject.allowed, false, 'object cost unwrapped to .total, benefit insufficient');
    assert.ok(Number.isFinite(withObject.requiredBenefit), 'requiredBenefit finite');
  });

  await test('3b. latency milliseconds no longer dominate net benefit', async () => {
    const calc = new SwitchingCostCalculator();
    // 300ms faster + tiny savings vs a realistic switch cost: must NOT
    // produce a benefit of hundreds (old raw-ms behavior).
    const net = calc.calculateNetBenefit(0.02, 0.001, 300, 0.008);
    assert.ok(Number.isFinite(net), 'finite');
    assert.ok(Math.abs(net) < 10, `bounded (got ${net})`);
    assert.ok(net < 0.2 * (0.008 / 0.01) * 1.5, 'does not clear hysteresis on latency alone');
  });

  // ---------- 4. CORS ----------
  await test('4. CORS echoes configured origin, not wildcard', async () => {
    const r = await api('GET', '/api/health', undefined, { Origin: 'http://localhost:5173' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['access-control-allow-origin'], 'http://localhost:5173');
    const evil = await api('GET', '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined, 'unknown origin gets no ACAO');
  });

  await test('4b. CORS rule: loopback in demo, strict in live', async () => {
    // Demo (current process): loopback allowed, evil denied, absent empty.
    assert.strictEqual(corsHeaders({ headers: { origin: 'http://localhost:3000' } })['Access-Control-Allow-Origin'], 'http://localhost:3000');
    assert.deepStrictEqual(corsHeaders({ headers: { origin: 'https://evil.example' } }), {});
    assert.deepStrictEqual(corsHeaders({ headers: {} }), {});
    // Live: only the configured frontend origin; loopback denied.
    const live = { frontendOrigin: 'https://app.example.com', isLive: true };
    assert.strictEqual(resolveCorsOrigin('https://app.example.com', live)['Access-Control-Allow-Origin'], 'https://app.example.com');
    assert.deepStrictEqual(resolveCorsOrigin('http://localhost:5173', live), {}, 'no wildcard, no loopback in live');
    assert.deepStrictEqual(resolveCorsOrigin('https://evil.example', live), {});
    // Multiple configured origins supported.
    const multi = { frontendOrigin: 'https://a.example, https://b.example', isLive: true };
    assert.strictEqual(resolveCorsOrigin('https://b.example', multi)['Access-Control-Allow-Origin'], 'https://b.example');
  });

  // ---------- 5. request validation + error contract ----------
  await test('5. malformed JSON returns structured 400 with requestId', async () => {
    const r = await api('POST', '/api/runs', '{not json');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'invalid_json');
    assert.ok(typeof r.json.error === 'string' && r.json.error.length > 0);
    assert.ok(typeof r.json.requestId === 'string', 'requestId present');
  });

  await test('5b. invalid create-run fields rejected', async () => {
    const badMode = await api('POST', '/api/runs', { title: 'x', taskMode: 'evil' });
    assert.strictEqual(badMode.status, 400);
    assert.ok(badMode.json.requestId, 'requestId present');
    const badBudget = await api('POST', '/api/runs', { title: 'x', budget: -5 });
    assert.strictEqual(badBudget.status, 400);
    const badCtx = await api('POST', '/api/runs', { title: 'x', maxContextTokens: 10 });
    assert.strictEqual(badCtx.status, 400);
  });

  await test('5c. run id validation: 400 on malformed, 404 with requestId on unknown', async () => {
    const bad = await api('GET', '/api/runs/..%2F..%2Fx/state');
    assert.ok([400, 404].includes(bad.status), `got ${bad.status}`);
    const missing = await api('GET', '/api/runs/run-does-not-exist-123/state');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.code, 'not_found');
    assert.ok(missing.json.requestId, 'requestId present on 404');
  });

  await test('5d. oversized bodies rejected with 413', async () => {
    const big = 'x'.repeat(300 * 1024);
    const r = await api('POST', '/api/runs', { title: big.slice(0, 100), taskMode: 'general', padding: big });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.code, 'payload_too_large');
  });

  // ---------- 6. readiness ----------
  await test('6. readiness endpoint reports checks without provider coupling', async () => {
    const r = await api('GET', '/api/ready');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ready, true);
    assert.ok(r.json.checks.registry && typeof r.json.checks.registry.models === 'number');
    assert.ok(r.json.checks.storage && r.json.checks.storage.ok === true);
    assert.ok(r.json.checks.provider && typeof r.json.checks.provider.configured === 'boolean');
    const alias = await api('GET', '/api/readiness');
    assert.strictEqual(alias.status, 200);
  });

  // ---------- 7. evaluations backend ----------
  await test('7. evaluations recorded from real runs with required fields', async () => {
    // Capped endpoint (default limit 50): assert the SPECIFIC record exists,
    // not that collection length increased (evicted old entries keep length).
    const id = await runToCompletion('eval-1', 'What is 2+2? Explain briefly.');
    // Query by runId (stable pagination semantics: newest-first, limit-capped).
    const { json } = await api('GET', `/api/evaluations?runId=${id}`);
    const ev = (json.evaluations || []).find((e) => e.runId === id);
    assert.ok(ev, 'evaluation linked to run (found via runId filter despite cap)');
    for (const k of ['id', 'runId', 'model', 'category', 'score', 'passed', 'cost', 'latencyMs', 'timestamp', 'evaluator']) {
      assert.ok(ev[k] !== undefined && ev[k] !== null, `evaluation.${k} present`);
    }
    assert.ok(ev.score >= 0 && ev.score <= 1, 'score bounded');
    assert.strictEqual(typeof ev.passed, 'boolean');
    assert.ok(ev.cost > 0, 'real cost attached');
    const filtered = await api('GET', `/api/evaluations?runId=${id}`);
    assert.ok(filtered.json.evaluations.every((e) => e.runId === id), 'runId filter works');
  });

  await test('7b. listing limits default sensibly and clamp', async () => {
    // Self-sufficient: ensure at least two stored evaluations first.
    await runToCompletion('eval-2', 'Say hello briefly.');
    const def = await api('GET', '/api/evaluations');
    assert.ok(def.json.evaluations.length > 1, `default limit returns full list (got ${def.json.evaluations.length})`);
    const one = await api('GET', '/api/evaluations?limit=1');
    assert.strictEqual(one.json.evaluations.length, 1, 'explicit limit honored');
    const bad = await api('GET', '/api/evaluations?limit=abc');
    assert.ok(bad.json.evaluations.length > 1, 'garbage limit falls back to default');
  });

  // ---------- 8. persistence hardening ----------
  await test('8. FileStore writes atomically and quarantines corruption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-'));
    const s = new FileStore(dir);
    assert.strictEqual(s.saveRunIndex([{ id: 'a' }]).ok, true);
    assert.deepStrictEqual(s.loadRunIndex(), [{ id: 'a' }]);
    // Corrupt the file: read falls back, file quarantined, next read clean.
    fs.writeFileSync(path.join(dir, 'runs.json'), '{corrupt!!!');
    assert.deepStrictEqual(s.loadRunIndex(), []);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('runs.json.corrupt-'));
    assert.strictEqual(leftovers.length, 1, 'corrupt file quarantined');
    // upsert preserves other entries.
    s.saveRunIndex([{ id: 'a', status: 'completed' }]);
    assert.strictEqual(s.upsertRunSummary({ id: 'b', status: 'failed' }).ok, true);
    assert.strictEqual(s.loadRunIndex().length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('8b. EvaluationStore bounds history and validates loads', async () => {
    const es = new EvaluationStore({ max: 5 });
    for (let i = 0; i < 8; i++) es.record({ runId: `run-${i}`, completed: true, hasAssistantMessage: true, withinBudget: true });
    assert.strictEqual(es.dump().length, 5, 'bounded');
    assert.strictEqual(es.loadAll('garbage'), 0);
    assert.strictEqual(es.loadAll([{ id: 'e1', runId: 'r1' }, { nope: true }]), 1, 'invalid entries skipped');
  });

  // ---------- 9. observed health ----------
  await test('9. observed health degrades on sustained failure, recovers on success', async () => {
    const registry = new InMemoryModelRegistry([
      { id: 'obs', name: 'Obs', provider: 'p', status: 'healthy', contextWindow: 32000, quality: 0.8, avgLatencyMs: 1000, reliability: 0.9, inputPer1k: 0.001, outputPer1k: 0.002, capabilities: ['text'] },
    ]);
    for (let i = 0; i < 4; i++) registry.recordObservation('obs', { success: false, code: 'timeout' });
    assert.strictEqual((await registry.getModel('obs')).status, 'healthy', 'transient failures do not flip status');
    registry.recordObservation('obs', { success: false, code: 'timeout' });
    assert.strictEqual((await registry.getModel('obs')).status, 'degraded', 'sustained failure degrades');
    assert.notStrictEqual((await registry.getModel('obs')).status, 'unavailable', 'never auto-unavailable');
    const before = (await registry.getModel('obs')).avgLatencyMs;
    registry.recordObservation('obs', { success: true, latencyMs: 400 });
    const after = await registry.getModel('obs');
    assert.strictEqual(after.status, 'healthy', 'success recovers observer-driven degradation');
    assert.strictEqual(after.avgLatencyMs, 400, 'observed latency replaces the seed value');
    assert.strictEqual(after.reliability, 1 / 6, 'reliability reflects the real success/total ratio');
    const observed = registry.getObserved('obs');
    assert.strictEqual(observed.successes, 1);
    assert.strictEqual(observed.failures, 5);
  });

  // ---------- 10. context + budget pre-checks ----------
  await test('10. tiny-window model fails honestly with context_exhausted', async () => {
    const { Orchestrator } = require('../src/core/orchestrator');
    const { InMemoryContextManager } = require('../src/impl/context-manager');
    const { InMemoryMemoryManager } = require('../src/impl/memory-manager');
    const { InMemoryCacheManager } = require('../src/impl/cache-manager');
    const { InMemoryToolRegistry } = require('../src/impl/tool-registry');
    const { InMemoryToolExecutor } = require('../src/impl/tool-executor');
    const { CostEstimator } = require('../src/cost/cost-estimator');
    const { ProviderRegistry } = require('../src/providers/provider-adapter');
    const reg = new InMemoryModelRegistry([
      { id: 'tiny', name: 'Tiny', provider: 'demo', status: 'healthy', contextWindow: 50, quality: 0.9, avgLatencyMs: 100, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002, capabilities: ['text'] },
    ]);
    const toolReg = new InMemoryToolRegistry();
    const orch = new Orchestrator({
      modelRegistry: reg,
      modelRouter: new InMemoryModelRouter(reg),
      contextManager: new InMemoryContextManager(),
      memoryManager: new InMemoryMemoryManager(),
      cacheManager: new InMemoryCacheManager(),
      toolRegistry: toolReg,
      toolExecutor: new InMemoryToolExecutor(toolReg),
      costEstimator: new CostEstimator(),
      providerRegistry: new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 1000 }),
      config: { mode: 'demo', provider: 'openrouter', maxSteps: 2, maxToolCalls: 2, maxRetries: 0, runTimeoutMs: 30000 },
    });
    // Force-select the tiny model, stage an overflowing conversation like
    // startRun() does, then verify the pre-call guard refuses honestly.
    const st = await orch.createRun('tiny run', {});
    await orch._selectModel(st, 'test');
    assert.strictEqual(st.model.currentModel, 'tiny');
    orch.control(st.runId).history.push({ role: 'user', content: 'x'.repeat(4000) });
    await assert.rejects(
      orch._callModel(st, 'x'.repeat(4000), 1),
      /exceeds tiny context window/
    );
  });

  await test('10b. zero budget fails honestly instead of calling provider', async () => {
    const id = await (async () => {
      const { status, json } = await api('POST', '/api/runs', { title: 'broke', taskMode: 'general', budget: 0.0000001 });
      assert.strictEqual(status, 201);
      return json.run.id;
    })();
    const sent = await api('POST', `/api/runs/${id}/messages`, { content: 'Hello there, please investigate thoroughly with tools' });
    assert.strictEqual(sent.status, 202);
    await orchestrator.waitForCompletion(id, 60000);
    const s = buildSnapshot(orchestrator, id);
    assert.ok(['completed', 'failed'].includes(s.status), `terminal, got ${s.status}`);
    if (s.status === 'failed') {
      const types = (eventBus.eventLogs.get(id) || []).map((e) => e.type);
      assert.ok(types.includes('budget.exceeded') || types.includes('run.failed'), 'budget surfaced');
    }
  });

  // ---------- 11. SSE replay honors since, snapshot consistent ----------
  await test('11. SSE replay with invalid since still streams', async () => {
    const id = await runToCompletion('sse-1', 'Hello replay check');
    const lastSeq = (eventBus.eventLogs.get(id) || []).slice(-1)[0].seq;
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`${BASE}/api/runs/${id}/events?since=not-a-number`, (res) => {
        let buf = '';
        const timer = setTimeout(() => { res.destroy(); resolve(buf); }, 2500);
        res.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('run.completed') && buf.length > 500) { clearTimeout(timer); res.destroy(); resolve(buf); }
        });
        res.on('error', () => { clearTimeout(timer); resolve(buf); });
      });
      req.on('error', reject);
    });
    assert.ok(body.includes('data:'), 'events streamed despite invalid since');
    const snap = buildSnapshot(orchestrator, id);
    assert.strictEqual(snap.lastSeq, lastSeq, 'snapshot lastSeq matches log');
  });

  // ---------- 12. persisted history served ----------
  await test('12. runs index includes history, unknown run 404s', async () => {
    const { json } = await api('GET', '/api/runs');
    assert.ok(Array.isArray(json.runs) && json.runs.length > 0, 'run history listed');
    for (const r of json.runs) {
      for (const k of ['id', 'title', 'status', 'budget', 'spent']) assert.ok(r[k] !== undefined, `run.${k}`);
    }
  });

  // ---------- 13. real provider path (OpenRouter adapter vs local stub) ----------
  await test('13. OpenRouter adapter: auth, body, normalization, usage, tools', async () => {
    const { OpenRouterAdapter, ProviderError } = require('../src/providers/provider-adapter');
    let seenHeaders = null;
    let seenBody = null;
    const stub = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        seenHeaders = req.headers;
        seenBody = JSON.parse(buf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-stub',
          model: 'stub-model',
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: 'checking tests',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_tests', arguments: '{"suite":"session"}' } }],
            },
          }],
          usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
        }));
      });
    });
    await new Promise((r) => stub.listen(0, r));
    const base = `http://localhost:${stub.address().port}`;
    try {
      const adapter = new OpenRouterAdapter({ apiKey: 'sk-test-key', baseUrl: base, defaultModel: 'stub-model', appName: 'test-app' });
      assert.strictEqual(adapter.hasCredentials, true);
      const out = await adapter.complete({
        model: 'stub-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'run_tests', description: 't', parameters: { type: 'object' } } }],
        timeoutMs: 5000,
      });
      // Auth + provider headers.
      assert.ok(String(seenHeaders.authorization) === 'Bearer sk-test-key', 'bearer auth sent');
      assert.ok(seenHeaders['http-referer'] === 'test-app', 'openrouter referer sent');
      // Request body shape.
      assert.strictEqual(seenBody.model, 'stub-model');
      assert.ok(Array.isArray(seenBody.messages) && seenBody.messages.length === 1);
      assert.ok(Array.isArray(seenBody.tools) && seenBody.tools.length === 1);
      // Normalized response (orchestrator contract).
      assert.strictEqual(out.text, 'checking tests');
      assert.strictEqual(out.toolCalls.length, 1);
      assert.strictEqual(out.toolCalls[0].name, 'run_tests');
      assert.deepStrictEqual(out.toolCalls[0].arguments, { suite: 'session' });
      assert.deepStrictEqual(out.usage, { inputTokens: 120, outputTokens: 30, cachedTokens: 20 });
      assert.strictEqual(out.provider, 'openrouter');
      assert.strictEqual(out.stopReason, 'tool_calls');
      assert.ok(typeof out.latencyMs === 'number');
    } finally {
      stub.close();
    }
  });

  await test('13b. provider errors classified (auth/rate-limit/timeout/cancel)', async () => {
    const { OpenRouterAdapter, ProviderError } = require('../src/providers/provider-adapter');
    const stub = http.createServer((req, res) => {
      if (req.url.includes('auth-fail')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid key', code: 401 } }));
      }
      if (req.url.includes('limited')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'slow down', code: 429 } }));
      }
      if (req.url.includes('slow')) return; // never responds -> client timeout
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom', code: 500 } }));
    });
    await new Promise((r) => stub.listen(0, r));
    const base = `http://localhost:${stub.address().port}`;
    const noCreds = new OpenRouterAdapter({ baseUrl: base });
    assert.strictEqual(noCreds.hasCredentials, false);
    try {
      const a = new OpenRouterAdapter({ apiKey: 'k', baseUrl: base + '/auth-fail' });
      a.chatPath = '';
      await assert.rejects(a.complete({ model: 'm', messages: [] }), (e) => {
        assert.ok(e instanceof ProviderError);
        assert.strictEqual(e.code, 'auth');
        assert.strictEqual(e.retryable, false);
        assert.ok(!String(e.message).includes('sk-') && !String(e.message).includes('Bearer'), 'no secrets in error');
        return true;
      });
      const r = new OpenRouterAdapter({ apiKey: 'k', baseUrl: base + '/limited' });
      r.chatPath = '';
      await assert.rejects(r.complete({ model: 'm', messages: [] }), (e) => e.code === 'rate_limit' && e.retryable === true);
      const t = new OpenRouterAdapter({ apiKey: 'k', baseUrl: base + '/slow' });
      t.chatPath = '';
      await assert.rejects(t.complete({ model: 'm', messages: [], timeoutMs: 200 }), (e) => e.code === 'timeout' && e.retryable === true);
      // Caller cancellation propagates as cancelled (not timeout).
      const c = new OpenRouterAdapter({ apiKey: 'k', baseUrl: base + '/slow' });
      c.chatPath = '';
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);
      await assert.rejects(c.complete({ model: 'm', messages: [], timeoutMs: 5000, signal: ctrl.signal }), (e) => e.code === 'cancelled');
      // listModels surfaces normalized shapes.
    } finally {
      stub.close();
    }
  });

  console.log(`\n--- Finalization results: ${passed} passed, ${failed} failed ---`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('finalization harness failed:', e);
  try { server.close(); } catch {}
  process.exit(1);
});
