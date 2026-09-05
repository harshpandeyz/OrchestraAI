'use strict';

// Agent 1 — tenant-store failure semantics + distributed idempotency tests.
// Run: node backend/test/agent1/tenant-idempotency.test.js (no network)

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TenantStore, ownsProject } = require('../../src/tenant-store');
const { IdempotencyStore, STATES, RedisIdempotencyBackend } = require('../../src/idempotency');
const { createMemoryCoordinatorForTests } = require('../../src/infrastructure/redis');

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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {
  await test('missing tenant files boot as empty (fresh install)', () => {
    const dir = tmpDir('orchestra-tenant-fresh-');
    try {
      const store = new TenantStore(dir);
      assert.deepStrictEqual(store.users, []);
      assert.deepStrictEqual(store.projects, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('corrupt tenant storage throws operational error, never empty set', () => {
    const dir = tmpDir('orchestra-tenant-corrupt-');
    try {
      fs.writeFileSync(path.join(dir, 'users.json'), '{not json', 'utf8');
      assert.throws(() => new TenantStore(dir), /tenant store corrupt/, 'corrupt users.json throws');
      const quarantined = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
      assert.strictEqual(quarantined.length, 1, 'corrupt file quarantined');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('empty tenant file is corrupt (not an empty tenant set)', () => {
    const dir = tmpDir('orchestra-tenant-empty-');
    try {
      fs.writeFileSync(path.join(dir, 'users.json'), '   ', 'utf8');
      assert.throws(() => new TenantStore(dir), /tenant store corrupt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('non-array tenant file is corrupt', () => {
    const dir = tmpDir('orchestra-tenant-shape-');
    try {
      fs.writeFileSync(path.join(dir, 'users.json'), '{"admin":true}', 'utf8');
      assert.throws(() => new TenantStore(dir), /tenant store corrupt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('project ownership enforced at the datastore boundary', () => {
    const dir = tmpDir('orchestra-tenant-owns-');
    try {
      const store = new TenantStore(dir);
      const alice = store.signup({ email: 'alice@example.com', password: 'correct horse battery staple' });
      const bob = store.signup({ email: 'bob@example.com', password: 'another secure password' });
      const alicePrincipal = { id: alice.user.id, orgId: alice.user.orgId, role: 'admin', source: 'session' };
      const bobPrincipal = { id: bob.user.id, orgId: bob.user.orgId, role: 'operator', source: 'session' };
      const globalAdmin = { id: 'admin', role: 'admin', source: 'env' };

      assert.strictEqual(ownsProject(alicePrincipal, alice.project), true);
      assert.strictEqual(ownsProject(bobPrincipal, alice.project), false, 'cross-tenant denied');
      assert.strictEqual(ownsProject(globalAdmin, alice.project), true, 'global env admin bypasses');
      assert.strictEqual(store.getProject(alice.project.id, bobPrincipal), null);
      assert.strictEqual(store.updateProject(alice.project.id, bobPrincipal, { name: 'hijacked' }), null, 'cross-tenant mutation denied');
      const updated = store.updateProject(alice.project.id, alicePrincipal, { name: 'Alice renamed' });
      assert.strictEqual(updated.name, 'Alice renamed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('local idempotency API unchanged (begin/complete/get)', () => {
    const dir = tmpDir('orchestra-idem-local-');
    try {
      const store = new IdempotencyStore(dir);
      assert.strictEqual(store.distributed, false);
      const first = store.begin('k1', { op: 'tool', runId: 'r1' });
      assert.strictEqual(first.fresh, true);
      const second = store.begin('k1', { op: 'tool', runId: 'r1' });
      assert.strictEqual(second.fresh, false, 'duplicate key is not fresh');
      store.complete('k1', { ok: true });
      assert.strictEqual(store.get('k1').state, STATES.COMPLETED);
      assert.strictEqual(store.statusOf('missing'), STATES.UNKNOWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('async idempotency without remote reports degraded single-process mode', async () => {
    const dir = tmpDir('orchestra-idem-degraded-');
    try {
      const store = new IdempotencyStore(dir);
      const r = await store.beginAsync('paid:op:1', { op: 'stripe_webhook' });
      assert.strictEqual(r.fresh, true);
      assert.strictEqual(r.degraded, true, 'local-only reservation is flagged degraded');
      assert.strictEqual(r.distributed, false);
      await store.completeAsync('paid:op:1', { received: true });
      assert.strictEqual(store.get('paid:op:1').state, STATES.COMPLETED);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('redis-backed idempotency elects one winner across instances', async () => {
    const coordinator = createMemoryCoordinatorForTests();
    coordinator.backend = 'redis'; // simulate a real redis coordinator over the same KV contract
    const backend = new RedisIdempotencyBackend(coordinator);
    const dirA = tmpDir('orchestra-idem-a-');
    const dirB = tmpDir('orchestra-idem-b-');
    try {
      const instanceA = new IdempotencyStore(dirA, { remote: backend });
      const instanceB = new IdempotencyStore(dirB, { remote: backend });
      assert.strictEqual(instanceA.distributed, true);
      const winA = await instanceA.beginAsync('paid:charge:7', { op: 'charge', runId: 'run-1' });
      const winB = await instanceB.beginAsync('paid:charge:7', { op: 'charge', runId: 'run-1' });
      assert.strictEqual(winA.fresh, true, 'first instance wins');
      assert.strictEqual(winB.fresh, false, 'second instance must NOT re-execute');
      assert.strictEqual(winB.distributed, true);
      assert.strictEqual(winB.degraded || false, false);
      await instanceA.completeAsync('paid:charge:7', { charged: true });
      const seenByB = await instanceB.getAsync('paid:charge:7');
      assert.strictEqual(seenByB.state, STATES.COMPLETED, 'completion visible cross-instance');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  console.log(`\n--- Agent1 tenant/idempotency results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
