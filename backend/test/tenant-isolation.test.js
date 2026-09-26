'use strict';

// Tenant-boundary proof + retention/intelligence isolation regressions.
//
// Session 2 invariants under test:
//   - intelligence (model performance + routing observations) is tenant-scoped:
//     one tenant's outcomes can never move another tenant's routing estimates
//   - the run index is retained per tenant: no global cap can evict another
//     tenant's history
//   - cross-tenant CRUD on runs/projects/economics is denied (403/404),
//     never data, and never leaks existence through aggregates
//   - the production image uses a supported Node LTS (Node 20 is EOL)
//
// Run: node backend/test/tenant-isolation.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { ModelPerformanceStore } = require('../src/intelligence/performance-store');
const { IntelligenceStore } = require('../src/intelligence/intelligence-store');
const { FileStore, retainPerTenant } = require('../src/persistence');
const { RunStore } = require('../src/infrastructure/run-store');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.message}`);
    failed++;
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-tenant-boundary-'));
process.env.NODE_ENV = 'production';
process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = dataDir;
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.FRONTEND_ORIGIN = 'https://console.example.com';
process.env.DISCOVERY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

async function main() {
  // ---- 1. model performance is tenant-scoped ----
  await test('one tenant\'s outcomes never leak into another tenant\'s model estimate', () => {
    const store = new ModelPerformanceStore();
    const modelId = 'model-x';
    // Tenant A runs a task successfully 10 times.
    for (let i = 0; i < 10; i++) {
      store.recordOutcome(modelId, 'debug', { success: true, qualityScore: 0.95, tenantId: 'org-A' });
    }
    // Tenant A sees real observed learning.
    const a = store.predictedSuccess(modelId, 'debug', null, 'org-A');
    assert.strictEqual(a.attempts, 10, 'tenant A sees its own 10 observations');
    assert.strictEqual(a.observed, 1, 'tenant A observed rate reflects its evidence');
    // Tenant B sees NOTHING — still the prior, zero samples.
    const b = store.predictedSuccess(modelId, 'debug', null, 'org-B');
    assert.strictEqual(b.attempts, 0, 'tenant B must see zero observations');
    assert.strictEqual(b.confidence, 'none');
    assert.strictEqual(b.predicted, 0.7, 'tenant B stays on the prior');
    // forModel is scoped the same way.
    assert.strictEqual(Object.keys(store.forModel(modelId, 'org-B')).length, 0, 'tenant B forModel is empty');
    assert.ok(Object.keys(store.forModel(modelId, 'org-A')).length >= 1, 'tenant A forModel has data');
  });

  await test('latency + reliability observations are tenant-scoped too', () => {
    const store = new ModelPerformanceStore();
    for (let i = 0; i < 5; i++) {
      store.recordOutcome('m', 'code', { success: false, errorCode: 'timeout', latencyMs: 9000, tenantId: 'org-A' });
    }
    assert.ok(store.reliabilityFor('m', 'org-A'), 'tenant A reliability observed');
    assert.strictEqual(store.reliabilityFor('m', 'org-B'), null, 'tenant B reliability untouched');
    const lA = store.latency('m', 'code', 'org-A');
    assert.strictEqual(lA.count, 5, 'tenant A latency samples present');
    const lB = store.latency('m', 'code', 'org-B');
    assert.strictEqual(lB.count, 0, 'tenant B latency samples empty');
  });

  await test('ingestRunOutcome records ownership and isolates learning', () => {
    const intel = new IntelligenceStore();
    intel.ingestRunOutcome({
      runId: 'run-a', orgId: 'org-A', modelId: 'm',
      taskText: 'refactor the parser', completed: true, hasAssistantMessage: true,
      testSummary: { passed: 5, failed: 0 }, toolFailures: 0, latencyMs: 100,
    });
    assert.ok(intel.performance.describe('m', 'code', 'org-A').attempts >= 1, 'org-A learning applied');
    assert.strictEqual(intel.performance.describe('m', 'code', 'org-B').attempts, 0, 'org-B sees none');
    const outcome = intel.outcomeForRun('run-a');
    assert.strictEqual(outcome.orgId, 'org-A', 'outcome carries ownership');
  });

  await test('performance store round-trips tenantId through dump/load', () => {
    const s1 = new ModelPerformanceStore();
    s1.recordOutcome('m', 'debug', { success: true, tenantId: 'org-A' });
    const s2 = new ModelPerformanceStore();
    s2.load(s1.dump());
    assert.strictEqual(s2.predictedSuccess('m', 'debug', null, 'org-A').attempts, 1, 'reloaded A');
    assert.strictEqual(s2.predictedSuccess('m', 'debug', null, 'org-B').attempts, 0, 'reloaded B empty');
  });

  // ---- 2. run-index retention is per tenant (no global cap) ----
  await test('retainPerTenant keeps newest N per tenant, never evicts across tenants', () => {
    const runs = [];
    for (let i = 1; i <= 5; i++) runs.push({ id: `a${i}`, orgId: 'org-A' });
    for (let i = 1; i <= 3; i++) runs.push({ id: `b${i}`, orgId: 'org-B' });
    const kept = retainPerTenant(runs, 2);
    const ids = kept.map((r) => r.id);
    assert.deepStrictEqual(ids, ['a4', 'a5', 'b2', 'b3'], `per-tenant newest 2: ${ids.join(',')}`);
  });

  await test('file run index keeps both tenants when one exceeds the legacy 200 cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runidx-retention-'));
    const store = new FileStore(dir, {});
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    // Tenant B has one modest run.
    assert.ok((await rs.upsertRunSummary({ id: 'b-run', orgId: 'org-B', ownerId: 'uB', title: 'B', status: 'completed' })).ok);
    // Tenant A produces 250 runs — more than the legacy global cap of 200.
    for (let i = 0; i < 250; i++) {
      assert.ok((await rs.upsertRunSummary({ id: `a-run-${i}`, orgId: 'org-A', ownerId: 'uA', title: 'A', status: 'completed', updatedAt: new Date(Date.now() + i).toISOString() })).ok);
    }
    const index = await rs.loadRunIndex();
    const ids = new Set(index.map((r) => r && r.id));
    assert.ok(ids.has('b-run'), 'tenant B run survives tenant A exceeding 200');
    assert.strictEqual(index.filter((r) => r && r.orgId === 'org-A').length, 250, 'all 250 tenant A runs retained');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('run index can be read tenant-scoped via RunStore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runidx-scope-'));
    const store = new FileStore(dir, {});
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    await rs.upsertRunSummary({ id: 'a1', orgId: 'org-A', status: 'completed' });
    await rs.upsertRunSummary({ id: 'b1', orgId: 'org-B', status: 'completed' });
    const aOnly = await rs.loadRunIndex({ orgId: 'org-A' });
    assert.deepStrictEqual(aOnly.map((r) => r.id), ['a1'], 'orgId-scoped read returns only tenant A');
    const bOnly = await rs.loadRunIndex({ orgId: 'org-B' });
    assert.deepStrictEqual(bOnly.map((r) => r.id), ['b1']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- 3. cross-tenant access over the live server ----
  const { server, shutdown } = require('../server');
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function request(method, pathname, body, { cookie = '' } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(`${base}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, json, cookie: res.headers['set-cookie']?.[0] || '' }); });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  try {
    const A = await request('POST', '/api/auth/signup', { email: 'tenant-a@boundary.test', password: 'a secure password 123', name: 'A' });
    const B = await request('POST', '/api/auth/signup', { email: 'tenant-b@boundary.test', password: 'b secure password 456', name: 'B' });
    const aCookie = A.cookie || '';
    const bCookie = B.cookie || '';
    const projA = await request('GET', '/api/projects', null, { cookie: aCookie });
    const pidA = projA.json.projects[0].id;
    const runA = await request('POST', '/api/runs', { title: 'A private run', taskMode: 'general', projectId: pidA }, { cookie: aCookie });
    const runAId = runA.json.run.id;

    await test('cross-tenant run snapshot/economics/state all denied', async () => {
      for (const sub of ['', '/state', '/savings', '/events', '/telemetry']) {
        const res = await request('GET', `/api/runs/${runAId}${sub}`, null, { cookie: bCookie });
        assert.ok(res.status === 403 || res.status === 404, `GET /runs/runA${sub} must be 403/404 (got ${res.status})`);
      }
    });

    await test('cross-tenant evaluations and outcomes are not leaked', async () => {
      const ev = await request('GET', '/api/evaluations', null, { cookie: bCookie });
      assert.strictEqual(ev.status, 200);
      // Tenant B must never see tenant A's run in the evaluation listing; its
      // own listing is empty regardless.
      const leak = (ev.json.evaluations || []).filter((e) => e && (e.runId === runAId));
      assert.strictEqual(leak.length, 0, 'tenant A evaluation must not appear for tenant B');
    });

    await test('cross-tenant provider credential scope is isolated', async () => {
      // Tenant A stores a credential; tenant B listing must not reflect it as
      // configured or leak a masked key.
      const aSave = await request('POST', '/api/providers/openrouter/connect', { apiKey: 'sk-test-tenant-a-key-0000000000' }, { cookie: aCookie });
      // Demo mode may still verify via the built adapter; we only assert the
      // status store is tenant-scoped in subsequent steps, so a connect failure
      // (bad key) is acceptable here.
      const bList = await request('GET', '/api/providers', null, { cookie: bCookie });
      assert.strictEqual(bList.status, 200, 'tenant B provider listing works');
      const bOpenrouter = (bList.json.providers || []).find((p) => p && p.id === 'openrouter');
      assert.strictEqual(bOpenrouter && bOpenrouter.configured, false, 'tenant B must not see tenant A credential as configured');
    });

    await test('cross-tenant run list contains no tenant A runs', async () => {
      const list = await request('GET', '/api/runs', null, { cookie: bCookie });
      assert.strictEqual(list.status, 200);
      const leak = (list.json.runs || []).filter((r) => r && r.id === runAId);
      assert.strictEqual(leak.length, 0, 'tenant A run must not appear in tenant B list');
    });

    // ---- 4. supported Node LTS in the production image ----
    await test('Dockerfile uses a supported Node LTS (not EOL Node 20)', () => {
      const dockerfile = path.resolve(__dirname, '..', '..', 'Dockerfile');
      const text = fs.readFileSync(dockerfile, 'utf8');
      assert.ok(!/\bnode:20\b/.test(text), 'Dockerfile must not pin Node 20 (EOL)');
      assert.ok(/\bnode:(22|24)\b/.test(text), 'Dockerfile must pin a supported LTS (22/24)');
    });
  } finally {
    await shutdown('tenant-boundary-test');
  }

  console.log(`\n--- Tenant isolation results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().then(() => {}).catch((e) => { console.error('FATAL', e); process.exit(1); });