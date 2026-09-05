'use strict';

// RunStore authoritative-persistence tests (file adapter; postgres is
// verified live against docker in CI/production validation, plus the
// fail-closed contract below which needs no server).
//
// Covers: file-mode round-trips (index/events/snapshot/evals/intelligence/
// billing), postgres-kind fail-closed reads/writes without a server, dual
// sync/async TenantStore in file mode, dual compareRuns/serveRunEvents.
//
// Run: node backend/test/agent1/run-store.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileStore } = require('../../src/persistence');
const { RunStore } = require('../../src/infrastructure/run-store');
const { TenantStore } = require('../../src/tenant-store');
const { compareRuns, summarizeRun } = require('../../src/api/compare');
const { serveRunEvents } = require('../../src/services/sse-service');
const { EventBus } = require('../../src/events/event-bus');

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

function makeFileStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-'));
  return { dir, store: new FileStore(dir, {}) };
}

async function main() {
  await test('file RunStore round-trips index/events/snapshot', async () => {
    const { dir, store } = makeFileStore();
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    assert.strictEqual(rs.kind, 'file');
    assert.ok((await rs.upsertRunSummary({ id: 'r1', title: 't', status: 'completed' })).ok);
    assert.ok((await rs.loadRunIndex()).some((r) => r && r.id === 'r1'));
    const ev = [{ seq: 1, runId: 'r1', type: 'task.created', ts: new Date().toISOString(), payload: {} }];
    assert.ok((await rs.saveEvents('r1', ev)).ok);
    assert.strictEqual((await rs.loadEvents('r1')).length, 1);
    assert.ok((await rs.saveSnapshot('r1', { runId: 'r1', status: 'completed' })).ok);
    assert.strictEqual((await rs.loadSnapshot('r1')).status, 'completed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('file RunStore round-trips evals/intelligence/billing', async () => {
    const { dir, store } = makeFileStore();
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    assert.ok((await rs.saveEvals([{ id: 'e1', runId: 'r1' }])).ok);
    assert.strictEqual((await rs.loadEvals()).length, 1);
    assert.ok((await rs.saveIntelligence({ v: 1 })).ok);
    assert.deepStrictEqual((await rs.loadIntelligence()).v, 1);
    assert.ok((await rs.saveBilling('r1', { total: 0.25 })).ok);
    assert.deepStrictEqual((await rs.loadBilling('r1')).total, 0.25);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('postgres-kind RunStore fails closed with no server (never file fallback)', async () => {
    const { dir, store } = makeFileStore();
    // A FileStore exists in the process but MUST NOT be consulted: postgres
    // kind reads throw datastore_unavailable, writes return { ok:false }.
    const { PostgresDatastore } = require('../../src/infrastructure/postgres');
    const pg = new PostgresDatastore({ connectionString: 'postgres://u:bad@localhost:55434/nope' });
    const rs = new RunStore({ datastore: { kind: 'postgres', store: pg, pg }, fileStore: store, logger: null });
    let threw = false;
    try {
      await rs.loadRunIndex();
    } catch (e) {
      threw = e && e.code === 'datastore_unavailable';
    }
    assert.ok(threw, 'reads throw datastore_unavailable');
    const w = await rs.saveEvents('r1', []);
    assert.strictEqual(w.ok, false, 'writes report ok:false');
    // The file adapter must be untouched: no runs.json created.
    assert.ok(!fs.existsSync(path.join(dir, 'runs.json')), 'no silent file writes');
    await pg.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('TenantStore file mode stays synchronous (existing callers unaffected)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-sync-'));
    const store = new TenantStore(dir);
    assert.strictEqual(store.remote, null);
    const alice = store.signup({ email: 'alice@example.com', password: 'correct horse battery staple' });
    assert.ok(alice && alice.user && alice.user.id && !(alice instanceof Promise), 'signup returns value, not Promise');
    const login = store.login({ email: 'alice@example.com', password: 'correct horse battery staple' });
    assert.ok(login.token && !(login instanceof Promise), 'login returns value, not Promise');
    const who = store.userForSession(login.token);
    assert.strictEqual(who && who.email, 'alice@example.com');
    assert.ok(!(who instanceof Promise), 'userForSession returns value, not Promise');
    const projects = store.listProjects(who);
    assert.strictEqual(projects.length, 1);
    const renamed = store.updateProject(projects[0].id, who, { name: 'Renamed' });
    assert.strictEqual(renamed.name, 'Renamed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('compareRuns works sync (file fakes) and async (RunStore)', async () => {
    const fakeBus = { eventLogs: new Map() };
    const fakeOrch = { activeRuns: new Map() };
    const syncStore = {
      loadSnapshot: (id) => (id === 'a' ? { status: 'completed', cost: { spentUsd: 0.01 }, context: { usedTokens: 1, windowTokens: 8 }, decisions: [], cache: { hitRate: 0 }, activeModelId: 'm', updatedAt: new Date().toISOString() } : null),
      loadRunIndex: () => [{ id: 'a', title: 'A', status: 'completed' }],
      loadEvents: () => [],
    };
    const syncResult = compareRuns(fakeOrch, syncStore, fakeBus, 'a', 'a');
    assert.ok(!(syncResult instanceof Promise), 'sync store -> sync result');
    assert.ok(syncResult.a, 'summarized');
    const { dir, store } = makeFileStore();
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    await rs.upsertRunSummary({ id: 'a', title: 'A', status: 'completed' });
    const asyncResult = await compareRuns(fakeOrch, rs, fakeBus, 'a', 'missing');
    assert.strictEqual(asyncResult, null, 'missing run -> null (async path)');
    assert.ok(typeof summarizeRun === 'function');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('serveRunEvents works sync (file fakes) and async (RunStore)', async () => {
    const bus = new EventBus();
    bus.emit('run-y', 'tool.started', { i: 0 });
    const writes = [];
    const res = { writeHead: () => {}, write: (s) => writes.push(s), end: () => { res.ended = true; }, ended: false };
    const syncOut = serveRunEvents({ eventBus: bus, store: { loadEvents: () => [] } }, {}, res, { runId: 'run-y', since: 0, live: false });
    assert.ok(!(syncOut instanceof Promise), 'in-memory run -> sync result');
    assert.strictEqual(syncOut.served, true);
    const { dir, store } = makeFileStore();
    const rs = new RunStore({ datastore: { kind: 'file', store, pg: null }, fileStore: store, logger: null });
    const missing = await serveRunEvents({ eventBus: new EventBus(), store: rs }, {}, res, { runId: 'nope', since: 0, live: false });
    assert.strictEqual(missing.served, false, 'unknown run not served (async path)');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n--- RunStore results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
