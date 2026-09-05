'use strict';

// Agent 1 — production config + datastore boundary tests.
// Run: node backend/test/agent1/config-datastore.test.js (no network, no infra)

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const { loadConfig, validateConfig, resolvedDatastoreKind } = require('../../src/config');
const { createDatastore } = require('../../src/infrastructure/datastore');
const { assertNoSilentFallback } = require('../../src/persistence');
const { checkReadiness } = require('../../src/infrastructure/readiness');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : (e && e.message)}`);
  }
}

async function main() {
  await test('new infra env vars centralize in config with safe defaults', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x' });
    assert.strictEqual(c.datastoreProvider, 'auto');
    assert.strictEqual(c.databaseUrl, '');
    assert.strictEqual(c.redisUrl, '');
    assert.strictEqual(c.redisRequired, false);
    assert.strictEqual(c.queueProvider, 'memory');
    assert.strictEqual(c.queueConcurrency, 4);
    assert.strictEqual(c.retentionSweepIntervalMs, 3600000);
    assert.strictEqual(c.retentionGraceMs, 86400000);
    assert.strictEqual(c.session3AutoVerify, true);
    assert.strictEqual(c.isProduction, false);
    assert.strictEqual(c.allowFileDatastoreInProduction, false);
    assert.strictEqual(resolvedDatastoreKind(c), 'file');
  });

  await test('auto resolves to postgres iff DATABASE_URL is set', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', DATABASE_URL: 'postgres://db:5432/app' });
    assert.strictEqual(resolvedDatastoreKind(c), 'postgres');
  });

  await test('postgres without DATABASE_URL fails validation', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', DATASTORE_PROVIDER: 'postgres' });
    assert.throws(() => validateConfig(c, { DATASTORE_PROVIDER: 'postgres' }), /DATABASE_URL/);
  });

  await test('redis queue without REDIS_URL fails validation', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', QUEUE_PROVIDER: 'redis' });
    assert.throws(() => validateConfig(c, { QUEUE_PROVIDER: 'redis' }), /REDIS_URL/);
  });

  await test('REDIS_REQUIRED without REDIS_URL fails validation', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', REDIS_REQUIRED: 'true' });
    assert.throws(() => validateConfig(c, { REDIS_REQUIRED: 'true' }), /REDIS_URL/);
  });

  await test('unknown providers fail validation', () => {
    const badStore = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', DATASTORE_PROVIDER: 'dynamo' });
    assert.throws(() => validateConfig(badStore, {}), /DATASTORE_PROVIDER/);
    const badQueue = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', QUEUE_PROVIDER: 'bullmq' });
    assert.throws(() => validateConfig(badQueue, {}), /QUEUE_PROVIDER/);
  });

  await test('production warns (not throws) on file datastore without opt-in', () => {
    const c = loadConfig({ NODE_ENV: 'production', RUNTIME_DATA_DIR: '/tmp/x', DATA_ENCRYPTION_KEY: 'a'.repeat(64) });
    const { warnings } = validateConfig(c, { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: 'a'.repeat(64) });
    assert.ok(warnings.some((w) => /file datastore/i.test(w)), `expected file-datastore warning, got ${JSON.stringify(warnings)}`);
  });

  await test('datastore factory returns file adapter without pg dependency', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x' });
    const fakeFile = { kind: 'file' };
    const d = createDatastore(c, { fileStore: fakeFile });
    assert.strictEqual(d.kind, 'file');
    assert.strictEqual(d.store, fakeFile);
    assert.strictEqual(d.pg, null);
  });

  await test('datastore factory selects postgres without importing pg until use', () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', DATABASE_URL: 'postgres://db:5432/app' });
    const d = createDatastore(c, { fileStore: { kind: 'file' } });
    assert.strictEqual(d.kind, 'postgres');
    assert.ok(d.pg && d.pg.kind === 'postgres');
  });

  await test('no silent fallback: DATABASE_URL set but file resolved throws', () => {
    assert.throws(
      () => assertNoSilentFallback({ databaseUrl: 'postgres://db:5432/app' }, 'file'),
      /refusing to silently bypass Postgres/,
    );
    assert.strictEqual(assertNoSilentFallback({ databaseUrl: '' }, 'file'), true);
    assert.strictEqual(assertNoSilentFallback({ databaseUrl: 'postgres://db:5432/app' }, 'postgres'), true);
  });

  await test('readiness: dev file deployment without redis is ready with notes', async () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x' });
    const r = await checkReadiness({
      config: c, datastoreKind: 'file', datastoreProbe: { ok: true },
      redis: { backend: 'memory', degraded: false }, authConfig: { enabled: false },
    });
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.checks.datastore.ok, true);
    assert.ok(r.checks.redis.note, 'memory coordination note present');
  });

  await test('readiness: degraded redis with REDIS_URL fails closed', async () => {
    const c = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x', REDIS_URL: 'redis://cache:6379' });
    const r = await checkReadiness({
      config: c, datastoreKind: 'file', datastoreProbe: { ok: true },
      redis: { backend: 'memory-degraded', degraded: true, lastError: 'dial tcp: refused' },
      authConfig: { enabled: false },
    });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.checks.redis.ok, false);
  });

  await test('readiness: production requires encryption + auth + reachable datastore', async () => {
    const prod = { NODE_ENV: 'production' };
    const noEnc = loadConfig({ ...prod, RUNTIME_DATA_DIR: '/tmp/x' });
    const r1 = await checkReadiness({
      config: noEnc, datastoreKind: 'file', datastoreProbe: { ok: true },
      redis: { backend: 'memory' }, authConfig: { enabled: true },
    });
    assert.strictEqual(r1.ready, false, 'missing encryption key is not ready');
    assert.strictEqual(r1.checks.encryption.ok, false);

    const enc = loadConfig({ ...prod, RUNTIME_DATA_DIR: '/tmp/x', DATA_ENCRYPTION_KEY: 'a'.repeat(64) });
    const r2 = await checkReadiness({
      config: enc, datastoreKind: 'postgres', datastoreProbe: { ok: false, error: 'connection refused' },
      redis: { backend: 'redis' }, authConfig: { enabled: true },
    });
    assert.strictEqual(r2.ready, false, 'unreachable postgres is not ready');
    assert.strictEqual(r2.checks.datastore.ok, false);

    const r3 = await checkReadiness({
      config: enc, datastoreKind: 'postgres', datastoreProbe: { ok: true },
      redis: { backend: 'redis' }, authConfig: { enabled: true },
    });
    assert.strictEqual(r3.ready, true, 'healthy production infra is ready');
  });

  console.log(`\n--- Agent1 config/datastore results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
