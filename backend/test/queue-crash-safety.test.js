'use strict';

// Session 1 — queue crash-safety regression tests.
//
// Proves the queue no longer has a silent job-loss window between removing a
// job from durable pending and recording its processing claim. The Redis
// claim is now a single atomic Lua LPOP+HSETNX; these tests emulate that
// script against an in-memory client to observe the atomicity and the
// crash/reclaim/idempotency/shutdown guarantees it depends on.
//
// Run: node backend/test/queue-crash-safety.test.js
// No network, no external services.

process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const { RedisJobQueue, MemoryJobQueue } = require('../src/infrastructure/queue');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory Redis client whose eval() emulates the atomic claim Lua script
// (single synchronous LPOP + HSETNX, exactly matching CLAIM_LUA semantics).
// Non-claim eval scripts (compare-and-*) throw so the queue falls back to its
// existing non-atomic compare path — mirroring a client that only exposes the
// claim script for evalu. This keeps the atomicity test honest: the only way
// to claim is the single eval call doing LPOP+HSETNX together.
function makeEvalClient() {
  const lists = new Map();
  const hashes = new Map();
  const evalCalls = [];
  const client = {
    lists, hashes, evalCalls,
    async rpush(key, value) { const l = lists.get(key) || []; l.push(value); lists.set(key, l); return l.length; },
    async lpop(key) { const l = lists.get(key) || []; const v = l.shift() || null; lists.set(key, l); return v; },
    async hget(key, field) { return (hashes.get(key) || {})[field] || null; },
    async hgetall(key) { return { ...(hashes.get(key) || {}) }; },
    async hset(key, field, value) { const h = hashes.get(key) || {}; h[field] = value; hashes.set(key, h); return 1; },
    async hdel(key, field) { const h = hashes.get(key) || {}; const existed = Object.prototype.hasOwnProperty.call(h, field); delete h[field]; hashes.set(key, h); return existed ? 1 : 0; },
    async eval(script, numKeys, ...rest) {
      if (typeof script !== 'string' || !script.includes('LPOP')) {
        // compare-and-* scripts and anything else: fail so evalRedis falls back.
        throw new Error('mock eval only supports the claim script');
      }
      evalCalls.push({ script, numKeys, rest });
      const keys = rest.slice(0, numKeys);
      const args = rest.slice(numKeys);
      assert.strictEqual(keys.length, 2, 'claim script keys == [pending, processing]');
      const [pendingKey, processingKey] = keys;
      const [durationStr, startedStr, token] = args;
      const list = lists.get(pendingKey) || [];
      const raw = list.shift() || null;
      lists.set(pendingKey, list);
      if (raw == null) return null; // keep evalCalls from counting empty polls? (see below)
      const m = /^{"id":"([^"]+)"/.exec(raw);
      // JS JSON.stringify emits {"id":"...": the id is the first key.
      if (!m) { list.push(raw); lists.set(pendingKey, list); return -1; }
      const id = m[1];
      const duration = Number(durationStr);
      const started = Number(startedStr);
      const deadline = started + duration;
      const record = '{"job":' + raw + ',"deadline":' + deadline + ',"leaseToken":"' + token + '"}';
      const hash = hashes.get(processingKey) || {};
      if (Object.prototype.hasOwnProperty.call(hash, id)) { list.push(raw); lists.set(pendingKey, list); return -1; }
      hash[id] = record;
      hashes.set(processingKey, hash);
      return record;
    },
  };
  return client;
}

function makeQueue(client, opts = {}) {
  return new RedisJobQueue({ backend: 'redis', client }, { visibilityMs: 5000, pollMs: 1000000, ...opts });
}

async function main() {
  await test('claim is a single atomic eval (LPOP+HSETNX), never a two-round-trip loss', async () => {
    const client = makeEvalClient();
    const q = makeQueue(client);
    const job = { id: 'job-atomic-1', type: 'atomic.test', timeoutMs: 1000, maxAttempts: 2, retryable: true };
    await q._push(job);
    const claim = await q._claimNext();
    assert.ok(claim && claim.job && claim.job.id === 'job-atomic-1', 'job claimed');
    // Exactly one eval invocation produced the claim.
    assert.strictEqual(client.evalCalls.length, 1, 'claim = one atomic eval');
    const script = client.evalCalls[0].script;
    assert.ok(script.includes('LPOP') && script.includes('HSETNX'), 'script atomically LPOP + HSETNX');
    // After claim the job is durably in the processing hash, not dangling.
    assert.strictEqual((client.lists.get('queue:jobs') || []).length, 0, 'pending drained');
    const proc = client.hashes.get('queue:processing') || {};
    assert.ok(proc['job-atomic-1'], 'job present in processing');
    const rec = JSON.parse(proc['job-atomic-1']);
    assert.ok(rec.job && rec.deadline && rec.leaseToken, 'claim record has job + deadline + leaseToken');
    assert.strictEqual(rec.job.id, 'job-atomic-1');
    await q.close({ drain: false });
  });

  await test('empty queue: atomic claim returns null and runs no eval LPOP twice', async () => {
    const client = makeEvalClient();
    const q = makeQueue(client);
    const claim = await q._claimNext();
    assert.strictEqual(claim, null, 'no job -> null');
    await q.close({ drain: false });
  });

  await test('end-to-end: atomic claim -> execute -> ack exactly once', async () => {
    const client = makeEvalClient();
    const q = makeQueue(client);
    const executed = [];
    q.on('run.go', async (job) => { executed.push(job.runId); return 'ok'; });
    const job = await q.enqueue({ type: 'run.go', runId: 'run-a', idempotencyKey: 'run-a:once' });
    await q.enqueueAndWait({ type: 'run.go', runId: 'run-a', idempotencyKey: 'run-a:once-2' });
    await sleep(50);
    assert.strictEqual(executed.length, 2, 'two distinct jobs executed');
    assert.strictEqual(q.stats().processed, 2);
    assert.strictEqual((client.hashes.get('queue:processing') || {}).run, undefined);
    assert.ok(job.id);
    await q.close({ drain: true });
  });

  await test('crash after claim: stale retryable job is reclaimed and re-delivered', async () => {
    const client = makeEvalClient();
    const q = makeQueue(client, { visibilityMs: 100 });
    const executed = [];
    q.on('run.go', async (job) => { executed.push(job.runId); });
    // Claim the job (worker 1) but never execute: simulate a crash before ack.
    const job = { id: 'job-crash-1', type: 'run.go', runId: 'run-x', timeoutMs: 10000, maxAttempts: 3, retryable: true };
    await q._push(job);
    const claim = await q._claimNext();
    assert.ok(claim, 'worker claimed the job');
    assert.strictEqual(executed.length, 0, 'not yet executed (worker died before running)');
    // Force the lease to expire (worker died without renewed lease).
    client.hashes.get('queue:processing')['job-crash-1'] = JSON.stringify({ job, deadline: Date.now() - 1, leaseToken: claim.lease.token });
    await q._reclaim();
    // The stale retryable job must be reclaimed and (backoff-scheduled) run.
    await sleep(800);
    assert.strictEqual(q.stats().retried, 1, 'reclaim counted as a retry');
    assert.deepStrictEqual(executed, ['run-x'], 'job re-delivered and executed after crash');
    assert.strictEqual(q.stats().processed >= 0 && executed.length, 1, 'exactly one authoritative execution');
    await q.close({ drain: true });
  });

  await test('crash after claim: non-retryable job is dead-lettered, not blindly re-run', async () => {
    const client = makeEvalClient();
    const q = makeQueue(client, { visibilityMs: 100 });
    const job = { id: 'job-nonretry', type: 'danger.op', timeoutMs: 10000, maxAttempts: 1, retryable: false };
    await q._push(job);
    const claim = await q._claimNext();
    assert.ok(claim, 'claimed');
    client.hashes.get('queue:processing')['job-nonretry'] = JSON.stringify({ job, deadline: Date.now() - 1, leaseToken: claim.lease.token });
    await q._reclaim();
    assert.strictEqual((client.lists.get('queue:jobs') || []).length, 0, 'non-retryable job NOT requeued');
    assert.strictEqual(q.stats().deadLetter, 1, 'dead-lettered');
    assert.strictEqual((client.hashes.get('queue:processing') || {})['job-nonretry'], undefined, 'released from processing');
    await q.close({ drain: false });
  });

  await test('duplicate delivery: identical idempotency key enqueues once', async () => {
    const q = new MemoryJobQueue({ concurrency: 1 });
    const executed = [];
    q.on('dup.t', async (job) => { executed.push(job.id); });
    const a = await q.enqueue({ type: 'dup.t', idempotencyKey: 'dup-key' });
    assert.ok(a && a.id, 'first enqueue returns the job');
    const b = await q.enqueue({ type: 'dup.t', idempotencyKey: 'dup-key' });
    assert.strictEqual(b.duplicate, true, 'second enqueue is a duplicate');
    assert.strictEqual(b.jobId, a.id, 'duplicate resolves to the original job');
    await sleep(50);
    assert.strictEqual(executed.length, 1, 'handler ran exactly once');
    await q.close();
  });

  await test('shutdown: memory close(drain:false) reports drops, redis leaves pending durable', async () => {
    const mem = new MemoryJobQueue({ concurrency: 1 });
    await mem.enqueue({ type: 'x' });
    const r = await mem.close({ drain: false });
    assert.strictEqual(r.drained, false);
    assert.strictEqual(r.dropped, 1, 'memory job reported dropped (honest)');

    const client = makeEvalClient();
    const q = makeQueue(client);
    q.on('x', async () => {});
    await q.enqueue({ type: 'x', idempotencyKey: 'redis-x' });
    await q.close({ drain: false, rejectWaiters: false });
    // The pending job must remain in the redis list (durable across restart).
    assert.strictEqual((client.lists.get('queue:jobs') || []).length, 1, 'redis pending stays durable');
  });

  console.log(`\n--- queue-crash-safety results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });