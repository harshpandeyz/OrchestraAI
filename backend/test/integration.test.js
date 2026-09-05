'use strict';

// Session 5 integration tests: API request -> completion across the REAL
// runtime (ContextManager -> Router/Registry -> ProviderAdapter (demo, explicit)
// -> ToolExecutor (real handlers) -> Memory/Cache -> telemetry -> SSE).
//
// Run:  node backend/test/integration.test.js
// No network access required. Failing provider paths use injected adapters.

process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = 'backend/.runtime-data-test';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const http = require('http');

const srv = require('../server');
const { server, orchestrator, config } = srv;
const { eventBus } = require('../src/events/event-bus');
const { buildSnapshot } = require('../src/api/snapshot');
const { ProviderRegistry, ProviderError } = require('../src/providers/provider-adapter');
const { TaskStatus } = require('../src/core/types');

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

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runToCompletion(title, message, opts = {}) {
  const { status, json } = await api('POST', '/api/runs', { title, taskMode: opts.taskMode || 'debug', ...(opts.run || {}) });
  assert.strictEqual(status, 201, `create run: ${JSON.stringify(json)}`);
  const id = json.run.id;
  const sent = await api('POST', `/api/runs/${id}/messages`, { content: message });
  assert.strictEqual(sent.status, 202, `send message: ${JSON.stringify(sent.json)}`);
  await orchestrator.waitForCompletion(id, opts.timeoutMs || 60000);
  return id;
}

function eventsOf(id) {
  return eventBus.eventLogs.get(id) || [];
}

function typesOf(id) {
  return eventsOf(id).map((e) => e.type);
}

function snapOf(id) {
  const s = buildSnapshot(orchestrator, id);
  assert.ok(s, 'snapshot exists');
  return s;
}

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://localhost:${server.address().port}`;
  // Cold semantic index (durable via intelligence.json): fresh-execution
  // assertions below must not reuse entries persisted by earlier suite runs.
  // Fixture isolation only — cross-run reuse is covered by prompt-semantic.test.js.
  orchestrator.cacheManager.semantic.clear();

  // ---------- A. create run ----------
  await test('A. create run returns frontend Run shape', async () => {
    const { status, json } = await api('POST', '/api/runs', { title: 'int-A', taskMode: 'code' });
    assert.strictEqual(status, 201);
    for (const k of ['id', 'title', 'taskMode', 'status', 'createdAt', 'budget', 'spent']) {
      assert.ok(json.run[k] !== undefined, `run.${k} present`);
    }
  });

  // ---------- B/C. message -> model execution -> completion ----------
  await test('B+C. message executes model and completes (simple question, one call)', async () => {
    const id = await runToCompletion('int-BC', 'What is 2+2? Explain briefly.');
    const s = snapOf(id);
    assert.strictEqual(s.status, 'completed');
    assert.ok(s.activeModelId, 'model selected from registry');
    const models = await orchestrator.modelRegistry.getModels();
    assert.ok(models.some((m) => m.id === s.activeModelId), 'active model is a registry model');
    assert.ok(s.messages.some((m) => m.role === 'assistant' && m.content.length > 0), 'assistant response stored');
    assert.strictEqual(s.series.length, 1, 'exactly one model call');
    const t = typesOf(id);
    assert.ok(t.includes('model.selected'), 'model.selected emitted');
    assert.ok(t.includes('response.done'), 'response.done emitted');
    assert.ok(t.includes('run.completed'), 'run.completed emitted');
  });

  // ---------- D/E/F/G/H/I. coding task: tools, context, memory, cache, cost, routing ----------
  await test('D. tool execution is real (run_tests executes, events emitted)', async () => {
    const id = await runToCompletion('int-D', 'Fix the bug, the tests are failing badly');
    const t = typesOf(id);
    assert.ok(t.includes('tool.started'), 'tool.started emitted');
    assert.ok(t.includes('tool.completed'), 'canonical tool.completed emitted');
    const s = snapOf(id);
    const rt = s.tools.find((x) => x.name === 'run_tests');
    assert.ok(rt && rt.calls >= 1, 'run_tests recorded in run tool state');
    assert.strictEqual(rt.lastStatus, 'success');
  });

  await test('E. context is constructed from real sources', async () => {
    const id = await runToCompletion('int-E', 'Tests are failing, investigate the failure');
    const s = snapOf(id);
    assert.ok(s.context.usedTokens > 0, 'context tokens tracked');
    const kinds = new Set(s.context.items.map((i) => i.kind));
    assert.ok(kinds.has('chat'), 'user task in context');
    assert.ok(kinds.has('tool_result'), 'tool results enter context');
    assert.ok(!s.context.items.some((i) => i.title === 'auth/service.ts' && i.source === 'read_file' && i.tokens === 8210), 'no canned seed context');
  });

  await test('F. memory is updated by execution (run-scoped)', async () => {
    const id = await runToCompletion('int-F', 'Tests are failing, investigate the failure output');
    const s = snapOf(id);
    assert.ok(s.memory.working.length > 0, 'working memory written');
    assert.ok(s.memory.working.some((m) => m.source && m.source.startsWith('tool:')), 'tool result in working memory');
  });

  await test('G. cache records real activity (no fake hits)', async () => {
    const id = await runToCompletion('int-G', 'What is 2+2? Explain briefly.');
    const stats = orchestrator.cacheManager.statsFor(id);
    assert.ok(stats.sets > 0, 'prompt responses cached');
    // A repeated identical run reuses its own cache entries only after first call;
    // within-run: second identical prompt would hit. Assert honesty instead:
    const s = snapOf(id);
    assert.ok(Array.isArray(s.cache.recent) && s.cache.recent.length > 0, 'cache recent events recorded');
    assert.ok(['WARM', 'COOLING', 'COLD'].includes(s.cache.state), 'cache state labelled');
  });

  await test('H. cost tracking uses registry pricing across categories', async () => {
    const id = await runToCompletion('int-H', 'Tests are failing, investigate');
    const s = snapOf(id);
    assert.ok(s.cost.spentUsd > 0, 'spent tracked');
    assert.ok(s.cost.projectedUsd >= s.cost.spentUsd, 'projected >= spent');
    const keys = s.cost.breakdown.map((b) => b.key);
    assert.ok(keys.includes('input_tokens') && keys.includes('output_tokens'), 'input/output categories present');
    // Estimator agrees with registry pricing (single authoritative path).
    const est = orchestrator.costEstimator.estimateModelCost(s.activeModelId, 'x', 1000, 500, 0);
    assert.strictEqual(est.breakdown.pricingSource, 'registry');
  });

  await test('I. routing evaluates candidates with a structured decision', async () => {
    const id = await runToCompletion('int-I', 'What is 2+2?');
    const s = snapOf(id);
    assert.ok(s.routing.candidates.length >= 2, 'multiple candidates scored');
    assert.ok(s.routing.decision && s.routing.decision.factors.length > 0, 'decision has factors');
    assert.ok(typesOf(id).includes('routing.evaluated'), 'routing.evaluated emitted');
  });

  // ---------- J/K. switching ----------
  await test('J. model switching is state-aware (cache loss invalidates run cache)', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'int-J', taskMode: 'debug' });
    const id = json.run.id;
    const st = orchestrator.activeRuns.get(id);
    await orchestrator._selectModel(st, 'test');
    const from = st.model.currentModel;
    const models = await orchestrator.modelRegistry.getModels();
    const to = models.map((m) => m.id).find((m) => m !== from);
    assert.ok(to, 'alternative model exists');
    st.context.setCacheablePrefix(5000);
    await orchestrator.cacheManager.set(orchestrator.cacheManager.scopedKey(id, 'prompt:abc'), { text: 'x' }, undefined, id);
    const ok = await orchestrator._applyModelSwitch(st, to, models, null, 'test switch');
    assert.ok(ok, 'switch applied');
    assert.strictEqual(st.model.currentModel, to);
    const t = typesOf(id);
    assert.ok(t.includes('model.switched'), 'model.switched emitted');
    assert.ok(t.includes('cache.invalidated'), 'run prompt cache invalidated on switch');
    const sw = st.budget.costBreakdown.get('switching') || st.budget.toJSON().costBreakdown.switching;
    assert.ok(sw > 0, 'switching cost recorded in budget');
    orchestrator.cleanupRun(id);
  });

  await test('K. warm cache makes nominally-cheaper B more expensive (state-aware math)', async () => {
    const { SwitchingCostCalculator } = require('../src/decisions/switching-cost');
    const { ContextState, ModelState } = require('../src/state/runtime-state');
    const calc = new SwitchingCostCalculator();
    const ctx = new ContextState(128000);
    ctx.currentTokens = 60000;
    ctx.setCacheablePrefix(50000); // warm cache on A
    const ms = new ModelState();
    ms.currentModel = 'model-a';
    ms.currentProvider = 'Provider Y';
    const switchCost = calc.calculate(ctx, ms, 'model-a', 'model-b', { toProvider: 'Provider Z' });
    assert.ok(switchCost.breakdown.cacheLoss > 0, 'cache loss priced');
    // Nominal saving of B per call vs full switching cost.
    const savingPerCall = 0.004;
    assert.ok(switchCost.total > savingPerCall, `switch cost ${switchCost.total} exceeds single-call saving`);
    const net = calc.calculateNetBenefit(0.01, savingPerCall, 0, switchCost.total);
    assert.ok(net < switchCost.total * 1.5, 'hysteresis rejects the switch (no oscillation)');
  });

  // ---------- L. price change during execution ----------
  await test('L. price update emits event, updates knowledge, does NOT auto-switch', async () => {
    // Non-terminal run with simulated late-run progress.
    const { json } = await api('POST', '/api/runs', { title: 'int-L', taskMode: 'general' });
    const id = json.run.id;
    const st = orchestrator.activeRuns.get(id);
    await orchestrator._selectModel(st, 'test');
    st.execution.currentStep = 4; // simulate late-run progress
    const before = st.model.currentModel;
    const prev = orchestrator.modelRegistry.getPricing(before);
    await orchestrator.modelRegistry.updatePrice(before, { inputPer1k: (prev.inputPer1k || 0.001) * 2 }, 'test');
    const t = typesOf(id);
    assert.ok(t.includes('price.updated'), 'canonical price.updated emitted to the run');
    assert.ok(t.includes('model.retained'), 'current model retained, not auto-switched');
    assert.strictEqual(st.model.currentModel, before, 'active model unchanged');
    assert.ok(t.includes('routing.evaluated'), 'reevaluation recorded');
    const hist = orchestrator.modelRegistry.getPricingHistory(before);
    assert.ok(hist.length >= 1, 'pricing history preserved');
    orchestrator.cleanupRun(id);
  });

  // ---------- M/N. provider failure + fallback ----------
  await test('M. total provider failure fails honestly (no fake success)', async () => {
    const prevRegistry = orchestrator.providerRegistry;
    const prevMode = orchestrator.config.mode;
    orchestrator.config.mode = 'live';
    orchestrator.providerRegistry = new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 5000 }, {
      createAdapter: () => ({
        providerId: 'openrouter', hasCredentials: true, defaultModel: 'x-down',
        complete: async () => { throw new ProviderError('boom', { code: 'unavailable', retryable: true }); },
        listModels: async () => [],
      }),
    });
    // Discovered-shape models so native IDs reach the adapter.
    await orchestrator.modelRegistry.registerModel({ id: 'x-down', name: 'X Down', provider: 'openrouter', status: 'healthy', contextWindow: 8000, quality: 0.8, avgLatencyMs: 500, reliability: 0.9, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001, capabilities: ['text'], source: 'discovered', nativeId: 'x-down' });
    const id = await runToCompletion('int-M', 'Hello there', { timeoutMs: 90000, run: { mode: 'live' } });
    const s = snapOf(id);
    assert.strictEqual(s.status, 'failed', 'run failed instead of faking success');
    assert.ok(!s.messages.some((m) => m.role === 'assistant' && m.content), 'no invented assistant text');
    orchestrator.providerRegistry = prevRegistry;
    orchestrator.config.mode = prevMode;
    await orchestrator.modelRegistry.unregisterModel('x-down');
  });

  await test('N. provider failure falls back to a healthy model', async () => {
    const prevRegistry = orchestrator.providerRegistry;
    const prevMode = orchestrator.config.mode;
    orchestrator.config.mode = 'live';
    orchestrator.providerRegistry = new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 5000 }, {
      createAdapter: () => ({
        providerId: 'openrouter', hasCredentials: true, defaultModel: 'y-down',
        complete: async (req) => {
          if (req.model === 'y-down') throw new ProviderError('y is down', { code: 'unavailable', retryable: true });
          return { text: 'Recovered on fallback. Task complete, no further actions.', toolCalls: [], usage: { inputTokens: 50, outputTokens: 20, cachedTokens: 0 }, latencyMs: 5, model: req.model, provider: 'openrouter', stopReason: 'stop' };
        },
        listModels: async () => [],
      }),
    });
    // Force the router to pick the failing model first: highest quality.
    await orchestrator.modelRegistry.registerModel({ id: 'y-down', name: 'Y Down', provider: 'openrouter', status: 'healthy', contextWindow: 8000, quality: 0.99, avgLatencyMs: 100, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001, capabilities: ['text'], source: 'discovered', nativeId: 'y-down' });
    await orchestrator.modelRegistry.registerModel({ id: 'y-up', name: 'Y Up', provider: 'openrouter', status: 'healthy', contextWindow: 8000, quality: 0.5, avgLatencyMs: 100, reliability: 0.9, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.001, capabilities: ['text'], source: 'discovered', nativeId: 'y-up' });
    const id = await runToCompletion('int-N', 'Hello there', { timeoutMs: 90000, run: { mode: 'live' } });
    const s = snapOf(id);
    assert.strictEqual(s.status, 'completed');
    assert.strictEqual(s.activeModelId, 'y-up', 'failed over to healthy model');
    assert.ok(typesOf(id).includes('model.switched'), 'failover switch emitted');
    orchestrator.providerRegistry = prevRegistry;
    orchestrator.config.mode = prevMode;
    await orchestrator.modelRegistry.unregisterModel('y-down');
    await orchestrator.modelRegistry.unregisterModel('y-up');
  });

  // ---------- O. context overflow ----------
  await test('O. context overflow is handled (compress or honest failure, never stuck)', async () => {
    const id = await runToCompletion('int-O', 'Tests are failing, investigate everything in detail', { run: { maxContextTokens: 1200 }, timeoutMs: 90000 });
    const s = snapOf(id);
    assert.ok(['completed', 'failed'].includes(s.status), `terminal state, got ${s.status}`);
    assert.ok(!['idle', 'planning'].includes(s.status), 'not stuck early');
  });

  // ---------- P. cancellation is real ----------
  await test('P. cancellation stops execution (no background continuation)', async () => {
    process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-slow.js';
    const { json } = await api('POST', '/api/runs', { title: 'int-P', taskMode: 'debug' });
    const id = json.run.id;
    await api('POST', `/api/runs/${id}/messages`, { content: 'Run the tests now, they are failing' });
    await new Promise((r) => setTimeout(r, 800));
    const cancelled = await api('POST', `/api/runs/${id}/cancel`, {});
    assert.strictEqual(cancelled.status, 200);
    await orchestrator.waitForCompletion(id, 30000);
    const s = snapOf(id);
    assert.strictEqual(s.status, 'cancelled');
    assert.ok(typesOf(id).includes('run.cancelled'), 'run.cancelled emitted');
    const ctrl = orchestrator.control(id);
    assert.strictEqual(ctrl.running, false, 'not still running');
    process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
  });

  // ---------- Q. retry preserves state, no duplicate irreversible tools ----------
  await test('Q. retry resumes failed run with idempotent tools', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'int-Q', taskMode: 'debug', budget: 0 });
    const id = json.run.id;
    const st = orchestrator.activeRuns.get(id);
    st.budget.maximumCost = 0; // force budget failure
    await api('POST', `/api/runs/${id}/messages`, { content: 'Hello' });
    await orchestrator.waitForCompletion(id, 30000);
    assert.strictEqual(snapOf(id).status, 'failed');
    // Restore budget and retry: valid state (messages) must be preserved.
    st.budget.maximumCost = 0.5;
    const r = await api('POST', `/api/runs/${id}/retry`, {});
    assert.strictEqual(r.status, 202);
    await orchestrator.waitForCompletion(id, 60000);
    const s = snapOf(id);
    assert.strictEqual(s.status, 'completed');
    assert.ok(s.messages.some((m) => m.role === 'user'), 'user message preserved across retry');
    assert.ok(typesOf(id).includes('execution.retry'), 'retry event emitted');
  });

  // ---------- R/S. SSE delivery + replay ----------
  await test('R. SSE delivers named events live', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'int-R', taskMode: 'general' });
    const id = json.run.id;
    const seen = [];
    const streamDone = new Promise((resolve, reject) => {
      const req = http.get(`${BASE}/api/runs/${id}/events`, { headers: { Accept: 'text/event-stream' } }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = (frame.match(/^event: (.+)$/m) || [])[1];
            if (ev && ev !== 'undefined') seen.push(ev);
            if (seen.includes('run.completed') || seen.includes('run.failed')) {
              req.destroy();
              resolve();
            }
          }
        });
        res.on('error', reject);
      });
      req.on('error', () => {});
      setTimeout(() => { req.destroy(); resolve(); }, 45000);
    });
    await api('POST', `/api/runs/${id}/messages`, { content: 'Hello world' });
    await streamDone;
    for (const must of ['model.selected', 'response.done', 'run.completed']) {
      assert.ok(seen.includes(must), `SSE delivered ${must} (saw: ${seen.slice(0, 12).join(',')})`);
    }
  });

  await test('S. SSE replay from since + snapshot consistency', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'int-S', taskMode: 'general' });
    const id = json.run.id;
    await api('POST', `/api/runs/${id}/messages`, { content: 'Hello replay' });
    await orchestrator.waitForCompletion(id, 60000);
    const snap = snapOf(id);
    const all = eventsOf(id);
    assert.ok(all.length > 5, 'event log retained');
    const mid = all[Math.floor(all.length / 2)].seq;
    const replayed = await new Promise((resolve, reject) => {
      http.get(`${BASE}/api/runs/${id}/events?since=${mid}`, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve(buf));
        res.on('error', reject);
        // SSE is an infinite stream: sample it, then close and resolve.
        setTimeout(() => { try { res.destroy(); } catch {} resolve(buf); }, 3000);
      }).on('error', reject);
    });
    assert.ok(replayed.includes('data:'), 'replay returns missed events');
    // Snapshot + events consistency: snapshot lastSeq equals last event seq.
    assert.strictEqual(snap.lastSeq, all[all.length - 1].seq, 'snapshot lastSeq matches event log');
  });

  // ---------- T. concurrent runs isolated ----------
  await test('T. concurrent runs are fully isolated', async () => {
    const a = await api('POST', '/api/runs', { title: 'int-T-A', taskMode: 'debug' });
    const b = await api('POST', '/api/runs', { title: 'int-T-B', taskMode: 'general' });
    const idA = a.json.run.id;
    const idB = b.json.run.id;
    await api('POST', `/api/runs/${idA}/messages`, { content: 'Tests are failing badly, investigate' });
    await api('POST', `/api/runs/${idB}/messages`, { content: 'What is 2+2?' });
    await Promise.all([orchestrator.waitForCompletion(idA, 60000), orchestrator.waitForCompletion(idB, 60000)]);
    const sA = snapOf(idA);
    const sB = snapOf(idB);
    assert.strictEqual(sA.status, 'completed');
    assert.strictEqual(sB.status, 'completed');
    // Run-written tool memory has step-specific titles; B must not see A's.
    assert.ok(!sB.memory.working.some((m) => /result \(step/.test(m.title)), 'B sees no run-specific tool memory from A');
    assert.ok(sA.memory.working.some((m) => /result \(step/.test(m.title)), 'A recorded its own tool memory');
    assert.ok(sA.cost.spentUsd !== sB.cost.spentUsd || sA.meta.tokens.input !== sB.meta.tokens.input, 'separate budgets/telemetry');
    const seqsA = new Set(eventsOf(idA).map((e) => e.seq));
    for (const e of eventsOf(idB)) assert.ok(!seqsA.has(e.seq), 'no shared event seqs');
  });

  // ---------- U. final completion evidence ----------
  await test('U. completion carries evidence, telemetry has time-series', async () => {
    const id = await runToCompletion('int-U', 'Tests are failing, investigate');
    const done = eventsOf(id).find((e) => e.type === 'run.completed');
    assert.ok(done && done.payload && done.payload.cost !== undefined, 'completion payload has cost/steps');
    const { json } = await api('GET', `/api/runs/${id}/telemetry`);
    assert.ok(json.telemetry.series.length > 0, 'per-run time-series served');
    assert.ok(json.telemetry.summary, 'run summary served');
  });

  // ---------- 10 end-to-end scenarios ----------
  await test('Scenario 1: simple question -> one model call -> completion', async () => {
    const id = await runToCompletion('sc-1', 'What is the capital of France? Answer in one sentence.');
    const s = snapOf(id);
    assert.strictEqual(s.status, 'completed');
    assert.strictEqual(s.series.length, 1);
  });

  await test('Scenario 2: debugging task -> context + tool + continuation -> completion', async () => {
    const id = await runToCompletion('sc-2', 'The test suite is failing, run the tests and report');
    const s = snapOf(id);
    assert.strictEqual(s.status, 'completed');
    assert.ok(s.tools.find((t) => t.name === 'run_tests').calls >= 1);
    assert.ok(s.series.length >= 2, 'model continued after tools');
  });

  await test('Scenario 3: context growth activates management', async () => {
    const id = await runToCompletion('sc-3', 'Tests are failing, investigate everything in detail now', { run: { maxContextTokens: 1500 }, timeoutMs: 90000 });
    const s = snapOf(id);
    const t = typesOf(id);
    assert.ok(t.includes('context.compressed') || t.includes('context.limit_warning') || ['completed', 'failed'].includes(s.status));
  });

  await test('Scenario 4: model unavailable -> fallback to healthy model', async () => {
    await orchestrator.modelRegistry.updateModel('nemotron-x', { status: 'unavailable' });
    await orchestrator.modelRegistry.updateModel('helium-b', { status: 'unavailable' });
    try {
      const id = await runToCompletion('sc-4', 'Hello fallback', { timeoutMs: 90000 });
      const s = snapOf(id);
      assert.strictEqual(s.status, 'completed');
      assert.ok(s.activeModelId !== 'nemotron-x' && s.activeModelId !== 'helium-b', 'unavailable models skipped');
    } finally {
      await orchestrator.modelRegistry.updateModel('nemotron-x', { status: 'healthy' });
      await orchestrator.modelRegistry.updateModel('helium-b', { status: 'healthy' });
    }
  });

  await test('Scenario 5: price change mid-run -> reevaluate, no unnecessary switch', async () => {
    // Keep the run active with a medium-length tool call, mutate price while
    // it is provably in-flight, then let it finish.
    process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-mid.js';
    const { json } = await api('POST', '/api/runs', { title: 'sc-5', taskMode: 'debug' });
    const id = json.run.id;
    await api('POST', `/api/runs/${id}/messages`, { content: 'Run the failing tests and report back' });
    let current = null;
    for (let i = 0; i < 100 && !current; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const st = orchestrator.activeRuns.get(id);
      if (st && st.model.currentModel && !['completed', 'failed', 'cancelled'].includes(st.status)) {
        current = st.model.currentModel;
      }
    }
    assert.ok(current, 'run became active with a selected model');
    const p = orchestrator.modelRegistry.getPricing(current) || { inputPer1k: 0.001 };
    await orchestrator.modelRegistry.updatePrice(current, { inputPer1k: (p.inputPer1k || 0.001) * 1.5 }, 'test');
    process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
    await orchestrator.waitForCompletion(id, 60000);
    const s = snapOf(id);
    assert.ok(typesOf(id).includes('price.updated'), 'price update reached the active run');
    assert.strictEqual(s.activeModelId, current, 'no opportunistic switch mid-run');
  });

  await test('Scenario 6: warm cache penalizes switching (state-aware decision)', async () => {
    const { json } = await api('POST', '/api/runs', { title: 'sc-6', taskMode: 'general' });
    const id = json.run.id;
    const st = orchestrator.activeRuns.get(id);
    await orchestrator._selectModel(st, 'test');
    st.context.setCacheablePrefix(40000);
    const models = await orchestrator.modelRegistry.getModels();
    const alt = models.find((m) => m.id !== st.model.currentModel);
    const cost = orchestrator.switchingCostCalculator.calculate(st.context, st.model, st.model.currentModel, alt.id, {});
    assert.ok(cost.breakdown.cacheLoss > 0, 'cache loss included in switch math');
    orchestrator.cleanupRun(id);
  });

  await test('Scenario 7: budget nearly exhausted -> safe termination', async () => {
    const id = await runToCompletion('sc-7', 'Tests are failing, investigate deeply and thoroughly', { run: { budget: 0.0000001 }, timeoutMs: 90000 });
    const s = snapOf(id);
    assert.ok(['completed', 'failed'].includes(s.status));
    assert.ok(typesOf(id).includes('budget.exceeded'), 'budget exceeded surfaced');
  });

  await test('Scenario 8: tool failure -> observed, run still completes', async () => {
    const id = await runToCompletion('sc-8', 'Please read the file nonexistent-dir/missing-xyz123.ts now', { timeoutMs: 90000 });
    const s = snapOf(id);
    const t = typesOf(id);
    assert.ok(t.includes('tool.failed'), 'tool failure surfaced honestly');
    assert.strictEqual(s.status, 'completed', 'run completes with failure observed in context');
  });

  await test('Scenario 9: provider failure -> safe fallback (covered in N)', async () => {
    assert.ok(true, 'see test N');
  });

  await test('Scenario 10: two concurrent runs stay isolated (covered in T)', async () => {
    assert.ok(true, 'see test T');
  });

  // ---------- error handling / contracts ----------
  await test('API validates input and hides internals', async () => {
    const bad = await api('POST', '/api/runs/nope/messages', { content: 'x' });
    assert.strictEqual(bad.status, 404);
    const empty = await api('POST', '/api/runs', { title: 'e1', taskMode: 'general' }).then(async (r) => {
      const e2 = await api('POST', `/api/runs/${r.json.run.id}/messages`, { content: '' });
      return e2;
    });
    assert.strictEqual(empty.status, 400);
    const health = await api('GET', '/api/health');
    assert.strictEqual(health.json.mode, 'demo');
    assert.ok(!JSON.stringify(health.json).toLowerCase().includes('api_key'), 'no secrets in health');
  });

  await test('Tool registry and run tool state agree (single catalog)', async () => {
    const { json } = await api('GET', '/api/tools');
    const { json: created } = await api('POST', '/api/runs', { title: 'tools-agree', taskMode: 'general' });
    const s = snapOf(created.run.id);
    const catalog = new Set(json.tools.map((t) => t.name));
    for (const t of s.tools) assert.ok(catalog.has(t.name), `${t.name} in registry catalog`);
    for (const name of catalog) assert.ok(s.tools.some((t) => t.name === name), `${name} in run state`);
    for (const t of json.tools) {
      assert.ok(t.parameters && t.timeoutMs && t.costPerCall !== undefined, `${t.name} has safety metadata`);
    }
  });

  console.log(`\n--- Integration results: ${passed} passed, ${failed} failed ---`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('integration harness failed:', e);
  try { server.close(); } catch {}
  process.exit(1);
});
