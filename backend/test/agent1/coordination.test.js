'use strict';

// Agent 1 — coordination (Redis/memory), locks, rate limits, queue, SSE
// durable event-log tests. No network, no external services.
// Run: node backend/test/agent1/coordination.test.js

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const { createMemoryCoordinatorForTests } = require('../../src/infrastructure/redis');
const { LockManager } = require('../../src/infrastructure/locks');
const { RateLimiter } = require('../../src/infrastructure/rate-limit');
const { createJobQueue, RedisJobQueue } = require('../../src/infrastructure/queue');
const { parseCursor, parseLastEventIdHeader, dedupeBySeq, readDurableSince } = require('../../src/infrastructure/event-log');

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

async function main() {
  await test('memory coordinator implements the KV contract', async () => {
    const c = createMemoryCoordinatorForTests();
    assert.strictEqual(c.backend, 'memory');
    assert.deepStrictEqual(await c.ping(), { ok: true, backend: 'memory' });
    assert.strictEqual(await c.get('missing'), null);
    assert.strictEqual(await c.set('k', 'v', { px: 50 }), 'OK');
    assert.strictEqual(await c.get('k'), 'v');
    assert.strictEqual(await c.set('k', 'other', { nx: true }), null, 'NX does not overwrite');
    assert.strictEqual(await c.incr('n'), 1);
    assert.strictEqual(await c.incr('n'), 2);
    await sleep(70);
    assert.strictEqual(await c.get('k'), null, 'PX expiry applies');
  });

  await test('distributed lock: single winner, wrong-token release refused', async () => {
    const locks = new LockManager(createMemoryCoordinatorForTests());
    const first = await locks.tryAcquire('run-1', 5000);
    assert.strictEqual(first.acquired, true);
    const second = await locks.tryAcquire('run-1', 5000);
    assert.strictEqual(second.acquired, false, 'held lock is not re-acquired');
    assert.strictEqual(await locks.release('run-1', 'wrong-token'), false);
    assert.strictEqual(await locks.release('run-1', first.token), true);
    const third = await locks.tryAcquire('run-1', 5000);
    assert.strictEqual(third.acquired, true, 'released lock is acquirable');
    await locks.release('run-1', third.token);
  });

  await test('withLock throws lock_busy when held', async () => {
    const locks = new LockManager(createMemoryCoordinatorForTests());
    const held = await locks.tryAcquire('job-a', 5000);
    assert.strictEqual(held.acquired, true);
    await assert.rejects(() => locks.withLock('job-a', 1000, async () => 'never'), /lock busy/);
    await locks.release('job-a', held.token);
    const out = await locks.withLock('job-a', 1000, async () => 'ran');
    assert.strictEqual(out, 'ran');
  });

  await test('withLock renews a lease while a long operation runs', async () => {
    const coordinator = createMemoryCoordinatorForTests();
    const locks = new LockManager(coordinator);
    const running = locks.withLock('long-job', 1000, async () => {
      await sleep(1500);
      return 'finished';
    });
    await sleep(1200);
    const competing = await locks.tryAcquire('long-job', 1000);
    assert.strictEqual(competing.acquired, false, 'renewed lease remains exclusive');
    assert.strictEqual(await running, 'finished');
  });

  await test('rate limiter enforces a fixed window locally', async () => {
    const rl = new RateLimiter(createMemoryCoordinatorForTests());
    assert.strictEqual(rl.distributed, false, 'memory coordinator is process-local');
    for (let i = 1; i <= 3; i++) {
      const r = await rl.allow({ key: 'ip:api', limit: 3, windowMs: 60000 });
      assert.strictEqual(r.allowed, true, `attempt ${i} allowed`);
    }
    const blocked = await rl.allow({ key: 'ip:api', limit: 3, windowMs: 60000 });
    assert.strictEqual(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    const other = await rl.allow({ key: 'other:api', limit: 3, windowMs: 60000 });
    assert.strictEqual(other.allowed, true, 'buckets are per-key');
  });

  await test('memory job queue preserves the orchestrator-facing interface', async () => {
    const q = createJobQueue({ provider: 'memory', concurrency: 2 });
    assert.strictEqual(q.provider, 'memory');
    const seen = [];
    q.on('run.execute', async (job) => { seen.push(job.runId); });
    const j1 = await q.enqueue({ type: 'run.execute', runId: 'run-a', idempotencyKey: 'run-a:execute:1' });
    assert.ok(j1.id && j1.enqueuedAt && j1.idempotencyKey === 'run-a:execute:1');
    await q.enqueue({ type: 'run.execute', runId: 'run-b' });
    await sleep(100);
    assert.deepStrictEqual(seen.sort(), ['run-a', 'run-b']);
    await q.close();
  });

  await test('enqueueAndClaim: duplicate key rejects, fast busy surfaces honestly', async () => {
    const q = createJobQueue({ provider: 'memory', concurrency: 2 });
    q.on('slow.job', async () => { await sleep(800); return 'done'; });
    q.on('busy.job', async () => { throw Object.assign(new Error('already running'), { code: 'busy' }); });
    // Duplicate while pending/running rejects with code 'duplicate'.
    const first = q.enqueueAndClaim({ type: 'slow.job', idempotencyKey: 'dup-key' }, { waitMs: 5000 });
    await assert.rejects(
      q.enqueueAndClaim({ type: 'slow.job', idempotencyKey: 'dup-key' }, { waitMs: 1000 }),
      (e) => e && e.code === 'duplicate',
      'duplicate rejects',
    );
    const claimed = await first;
    assert.ok(claimed.claimed, 'first job claimed');
    // Fast terminal failure after claim still surfaces its real code.
    await assert.rejects(
      q.enqueueAndClaim({ type: 'busy.job' }, { waitMs: 5000 }),
      (e) => e && e.code === 'busy',
      'busy surfaces honestly',
    );
    await sleep(1000); // let the slow job settle
    const st = q.stats();
    assert.strictEqual(st.running, 0, 'no stranded runners');
    assert.ok(st.processed >= 1 && st.failed >= 1, `stats track outcomes: ${JSON.stringify(st)}`);
    await q.close();
  });

  await test('redis queue renews leases and does not release a replacement claim', async () => {
    const lists = new Map();
    const hashes = new Map();
    const client = {
      async rpush(key, value) { const list = lists.get(key) || []; list.push(value); lists.set(key, list); return list.length; },
      async lpop(key) { const list = lists.get(key) || []; const value = list.shift() || null; lists.set(key, list); return value; },
      async hset(key, field, value) { const hash = hashes.get(key) || {}; hash[field] = value; hashes.set(key, hash); return 1; },
      async hget(key, field) { return (hashes.get(key) || {})[field] || null; },
      async hgetall(key) { return { ...(hashes.get(key) || {}) }; },
      async hdel(key, field) { const hash = hashes.get(key) || {}; const existed = Object.prototype.hasOwnProperty.call(hash, field); delete hash[field]; hashes.set(key, hash); return existed ? 1 : 0; },
    };
    const q = new RedisJobQueue({ backend: 'redis', client }, { visibilityMs: 5000, pollMs: 10000 });
    const job = { id: 'job-lease', type: 'lease.test', timeoutMs: 1000, maxAttempts: 2, retryable: true };
    const lease = await q._claim(job);
    const before = JSON.parse(await client.hget('queue:processing', job.id));
    await sleep(20);
    assert.strictEqual(await q._renew(job, lease), true);
    const after = JSON.parse(await client.hget('queue:processing', job.id));
    assert.ok(after.deadline > before.deadline, 'active handler lease is extended');

    await client.hset('queue:processing', job.id, JSON.stringify({ job, deadline: Date.now() + 5000, leaseToken: 'replacement' }));
    assert.strictEqual(await q._release(job, lease), false, 'old worker cannot release a replacement claim');
    assert.ok(await client.hget('queue:processing', job.id), 'replacement claim remains intact');
    await q.close({ drain: false });
  });

  await test('redis reclaim honors maxAttempts and dead-letters exhausted jobs', async () => {
    const hash = {};
    const list = [];
    const client = {
      async rpush(key, value) { list.push([key, value]); return list.length; },
      async hget(key, field) { return hash[field] || null; },
      async hgetall() { return { ...hash }; },
      async hdel(key, field) { const existed = !!hash[field]; delete hash[field]; return existed ? 1 : 0; },
    };
    const q = new RedisJobQueue({ backend: 'redis', client }, { visibilityMs: 5000, pollMs: 10000 });
    const job = { id: 'job-exhausted', type: 'lost.test', attempts: 0, maxAttempts: 1, retryable: true };
    hash[job.id] = JSON.stringify({ job, deadline: Date.now() - 1, leaseToken: 'lost' });
    await q._reclaim();
    assert.strictEqual(hash[job.id], undefined, 'stale processing record is removed');
    assert.strictEqual(list.length, 0, 'exhausted job is not requeued');
    assert.strictEqual(q.stats().deadLetter, 1);
    await q.close({ drain: false });
  });

  await test('SSE cursor: ?since= wins, Last-Event-ID is the fallback', () => {
    assert.strictEqual(parseCursor({ since: 12, lastEventId: 9 }), 12);
    assert.strictEqual(parseCursor({ since: 0, lastEventId: 9 }), 9);
    assert.strictEqual(parseCursor({ since: NaN, lastEventId: 0 }), 0);
    assert.strictEqual(parseLastEventIdHeader({ headers: { 'last-event-id': '42' } }), 42);
    assert.strictEqual(parseLastEventIdHeader({ headers: {} }), 0);
  });

  await test('durable event read merges disk + bus without duplicates', async () => {
    const disk = [
      { seq: 1, runId: 'r', type: 'task.created', ts: 't', payload: {} },
      { seq: 2, runId: 'r', type: 'model.selected', ts: 't', payload: {} },
    ];
    const bus = {
      getEventsSinceWithGap: () => ({
        events: [
          { seq: 2, runId: 'r', type: 'model.selected', ts: 't', payload: {} },
          { seq: 3, runId: 'r', type: 'run.completed', ts: 't', payload: {} },
        ],
      }),
    };
    const fakeStore = { loadEvents: () => disk };
    const full = await readDurableSince({ eventBus: bus, store: fakeStore, runId: 'r', since: 0 });
    assert.deepStrictEqual(full.events.map((e) => e.seq), [1, 2, 3]);
    assert.strictEqual(full.gap, false);
    const tail = await readDurableSince({ eventBus: bus, store: fakeStore, runId: 'r', since: 2 });
    assert.deepStrictEqual(tail.events.map((e) => e.seq), [3]);
    const gapped = await readDurableSince({ eventBus: bus, store: fakeStore, runId: 'r', since: 0 });
    assert.strictEqual(gapped.oldestSeq, 1);
    assert.strictEqual(gapped.latestSeq, 3);
  });

  await test('durable event read flags a truncated-window gap', async () => {
    const bus = {
      getEventsSinceWithGap: (runId, since) => ({ events: [], gap: false, oldestSeq: 0, latestSeq: 0 }),
    };
    void bus;
    const store = { loadEvents: () => [{ seq: 100, runId: 'r', type: 'x', ts: 't', payload: {} }] };
    const memBus = {
      getEventsSinceWithGap: () => ({ events: [], gap: false, oldestSeq: 0, latestSeq: 0 }),
      getEventsSince: () => [],
    };
    const out = await readDurableSince({ eventBus: memBus, store, runId: 'r', since: 5 });
    assert.strictEqual(out.gap, true, 'cursor predating the retained window is a gap');
    assert.strictEqual(out.oldestSeq, 100);
  });

  await test('dedupe keeps envelope shape { seq, runId, type, ts, payload }', () => {
    const merged = dedupeBySeq([
      { seq: 2, runId: 'r', type: 'b', ts: 't', payload: {} },
      { seq: 1, runId: 'r', type: 'a', ts: 't', payload: {} },
      { seq: 2, runId: 'r', type: 'b', ts: 't', payload: {} },
    ]);
    assert.deepStrictEqual(merged.map((e) => e.seq), [1, 2]);
    for (const e of merged) {
      assert.ok(e.seq && e.runId && e.type && e.ts && ('payload' in e), 'wire envelope preserved');
    }
  });

  console.log(`\n--- Agent1 coordination results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
