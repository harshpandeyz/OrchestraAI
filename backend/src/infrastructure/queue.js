'use strict';

// Queue/job adapter: durable execution-scheduling boundary in front of the
// orchestrator. The orchestrator API is unchanged; this adapter is the ONLY
// path the API uses to schedule run execution and background maintenance.
//
// Providers:
//   memory — single-process FIFO with deferred dispatch (default; tests/demo).
//   redis  — durable list-based queue over the shared coordinator/redis
//            client. Enqueue is RPUSH; claim is an atomic Lua LPOP+HSETNX
//            (see CLAIM_LUA) so a job is never removed from durable pending
//            without a recoverable processing record. Pending jobs survive
//            API restarts; a future BullMQ backend can implement the same
//            JobQueue interface.
//
// Job shape: { id, type, runId, payload, idempotencyKey, enqueuedAt, attempts,
//              maxAttempts, timeoutMs, retryable }
//
// Guarantees (both providers):
//   - idempotent enqueue: a job whose idempotencyKey is already pending or
//     running is NOT duplicated (caller gets { duplicate:true }).
//   - safe retries: retryable jobs are retried with backoff up to maxAttempts;
//     non-retryable jobs (e.g. run execution — unknown side effects must never
//     be blindly re-run) fail once and stay failed.
//   - timeouts: a handler that exceeds timeoutMs is marked failed (timed_out);
//     the late handler result is ignored, never double-applied.
//   - explicit terminal states: every job ends as completed | failed |
//     dead_letter, visible via stats().
//   - graceful shutdown: close({ drain:true }) stops intake, waits for running
//     jobs up to a grace period, and (redis) leaves pending jobs durable.

const crypto = require('crypto');
const {
  compareAndDeleteHash,
  compareAndSetHash,
} = require('./redis-atomic');

function newJobId() {
  return `job-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const RETRY_BASE_MS = 500;
const COMPLETED_KEY_TTL_MS = 10 * 60 * 1000;
const MAX_COMPLETED_KEYS = 2000;

// Atomic claim: LPOP from the pending list and HSETNX into the processing
// hash in ONE server-side transaction. This closes the crash window where a
// worker removed a job from durable pending but died before recording the
// claim (the job would exist in neither place and be silently lost).
//
// Returns (single value):
//   nil        -> pending list empty (nothing to do)
//   -1         -> popped entry could not be claimed (malformed id or a
//                 duplicate processing key); it is RPUSH'd to the tail so it
//                 is never silently lost and is retried next poll
//   "<record>" -> the serialized { job, deadline, leaseToken } claim record,
//                 already present in the processing hash
//
// The lease duration is computed in JS (ARGV[1]) and the deadline is
// now + duration (ARGV[2] is the JS-side claim timestamp), so the record's
// `deadline` minus the caller's start time yields the exact lease duration
// used for renewal — no formula is re-derived from the job body.
const CLAIM_LUA = [
  "local raw = redis.call('LPOP', KEYS[1])",
  "if not raw then return nil end",
  "local id = raw:match('^{\"id\":\"([^\"]+)\"')",
  "if not id then redis.call('RPUSH', KEYS[1], raw); return -1 end",
  "local duration = tonumber(ARGV[1])",
  "local deadline = tonumber(ARGV[2]) + duration",
  "local record = '{\"job\":' .. raw .. ',\"deadline\":' .. deadline .. ',\"leaseToken\":\"' .. ARGV[3] .. '\"}'",
  "if redis.call('HSETNX', KEYS[2], id, record) == 0 then redis.call('RPUSH', KEYS[1], raw); return -1 end",
  "return record",
].join('\n');

class BaseJobQueue {
  constructor({ concurrency = 4, logger = null } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.log = logger;
    this.handlers = new Map(); // type -> [handler]
    this.running = 0;
    this.closed = false;
    this.waiters = new Map(); // jobId -> { resolve, reject }
    this.claimWaiters = new Map(); // jobId -> { resolve, reject } (fired when a worker starts the job)
    this.settledCache = new Map(); // jobId -> { err, result, at } (brief, race-proofing enqueueAndClaim)
    this.inflightKeys = new Map(); // idempotencyKey -> jobId (pending+running only)
    this.completedKeys = new Map(); // idempotencyKey -> { at } (bounded, for exactly-once side effects)
    this.processed = 0;
    this.failed = 0;
    this.retried = 0;
    this.duplicates = 0;
    this.deadLetter = 0;
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  _rememberCompleted(key) {
    if (!key) return;
    this.completedKeys.set(key, { at: Date.now() });
    if (this.completedKeys.size > MAX_COMPLETED_KEYS) {
      const oldest = this.completedKeys.keys().next().value;
      this.completedKeys.delete(oldest);
    }
  }

  _recentlyCompleted(key) {
    if (!key) return false;
    const rec = this.completedKeys.get(key);
    if (!rec) return false;
    if (Date.now() - rec.at > COMPLETED_KEY_TTL_MS) {
      this.completedKeys.delete(key);
      return false;
    }
    return true;
  }

  _releaseKey(job) {
    if (job && job.idempotencyKey) this.inflightKeys.delete(job.idempotencyKey);
  }

  _handlersFor(type) {
    return this.handlers.get(type) || [];
  }

  _warn(msg, extra = {}) {
    try {
      if (this.log && typeof this.log.warn === 'function') this.log.warn(msg, extra);
    } catch {}
  }

  // Run all handlers for one job with a timeout. Resolves { ok, result } or
  // rejects with the handler error (augmented with code when known).
  async _invoke(job) {
    const handlers = this._handlersFor(job.type);
    if (!handlers.length) {
      const err = new Error(`no handler registered for job type "${job.type}"`);
      err.code = 'no_handler';
      throw err;
    }
    this._notifyClaim(job);
    const timeoutMs = Math.max(1000, Number(job.timeoutMs) || DEFAULT_TIMEOUT_MS);
    let timer = null;
    try {
      const work = (async () => {
        let out;
        for (const h of handlers) out = await h(job);
        return out;
      })();
      const result = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`job ${job.id} timed out after ${timeoutMs}ms`);
            err.code = 'timed_out';
            reject(err);
          }, timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      return { ok: true, result };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _settleWaiter(job, err, result) {
    const w = this.waiters.get(job.id);
    if (w) {
      this.waiters.delete(job.id);
      if (err) w.reject(err);
      else w.resolve(result);
    } else {
      // No waiter (yet): cache the terminal outcome briefly so a racy
      // enqueueAndClaim observes the real result instead of hanging.
      this.settledCache.set(job.id, { err, result, at: Date.now() });
      if (this.settledCache.size > 500) {
        const oldest = this.settledCache.keys().next().value;
        this.settledCache.delete(oldest);
      }
    }
    // A job that settles was necessarily started (or never startable):
    // release any claim waiter so enqueueAndClaim never hangs.
    const c = this.claimWaiters.get(job.id);
    if (c) {
      this.claimWaiters.delete(job.id);
      if (err) c.reject(err);
      else c.resolve({ claimed: true, settled: true, result });
    }
  }

  _notifyClaim(job) {
    const c = this.claimWaiters.get(job.id);
    if (c) {
      this.claimWaiters.delete(job.id);
      try { c.resolve({ claimed: true }); } catch {}
    }
  }

  async _afterSuccess(job, result) {
    this.processed++;
    this._releaseKey(job);
    // Exactly-once side effects opt in via dedupeCompleted:true; run
    // execution uses inflight-only dedupe so a later message can continue
    // the same run after the previous job finished.
    if (job.dedupeCompleted) this._rememberCompleted(job.idempotencyKey);
    this._settleWaiter(job, null, result);
  }

  // Returns { retry: boolean }: true when the job was requeued for another
  // attempt (waiter stays open), false when it reached a terminal state.
  async _afterFailure(job, err, requeue) {
    const attempts = (job.attempts || 0) + 1;
    job.attempts = attempts;
    const max = Math.max(1, Number(job.maxAttempts) || 1);
    const retryable = job.retryable !== false && !(err && (err.code === 'terminal' || err.code === 'not_found' || err.code === 'busy' || err.code === 'bad_params' || err.code === 'denied'));
    if (retryable && attempts < max && !this.closed) {
      this.retried++;
      const delay = Math.min(30000, RETRY_BASE_MS * (2 ** (attempts - 1)));
      this._warn('job failed, retrying', { jobId: job.id, type: job.type, attempt: attempts, max, delayMs: delay });
      // Waiter stays open across the retry; the key stays inflight so a
      // duplicate enqueue during backoff is still rejected.
      await requeue(job, delay);
      return { retry: true };
    }
    this.failed++;
    if (retryable && attempts >= max) this.deadLetter++;
    this._releaseKey(job);
    this._settleWaiter(job, err, null);
    return { retry: false };
  }

  _normalizeEnqueue({ type, runId = null, payload = {}, idempotencyKey = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, timeoutMs = DEFAULT_TIMEOUT_MS, retryable = true, dedupeCompleted = false }) {
    if (!type || typeof type !== 'string') {
      const err = new Error('job type is required');
      err.code = 'bad_params';
      throw err;
    }
    if (idempotencyKey) {
      const inflight = this.inflightKeys.get(idempotencyKey);
      if (inflight) {
        this.duplicates++;
        return { duplicate: true, jobId: inflight };
      }
      if (dedupeCompleted && this._recentlyCompleted(idempotencyKey)) {
        this.duplicates++;
        return { duplicate: true, completed: true };
      }
    }
    const job = {
      id: newJobId(),
      type,
      runId,
      payload,
      idempotencyKey,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts,
      timeoutMs,
      retryable,
      dedupeCompleted: dedupeCompleted === true,
    };
    if (idempotencyKey) this.inflightKeys.set(idempotencyKey, job.id);
    return { duplicate: false, job };
  }

  // Enqueue and resolve once a worker CLAIMS the job (starts it) — the
  // HTTP "202 accepted & started" semantic. Settle errors that happen before
  // any claim (busy duplicate, unknown run, refused continuation) reject
  // here so the API can answer 409/404 honestly; post-claim outcomes travel
  // over SSE/run state, never over this promise.
  //
  // Fast-settle window: after a claim, fast terminal outcomes (e.g. the run
  // is already executing elsewhere -> busy) still surface with their REAL
  // code when they arrive within claimGraceMs. Slower executions resolve as
  // claimed. Rejects with code 'duplicate' when the same idempotencyKey is
  // already pending or running (the API maps that to 409 busy).
  async enqueueAndClaim(opts, { waitMs = 15000, claimGraceMs = 250 } = {}) {
    const stored = await this.enqueue(opts);
    if (stored && stored.duplicate) {
      const err = new Error('duplicate job already pending or running');
      err.code = 'duplicate';
      throw err;
    }
    const job = stored;
    // Race-proofing: the worker may settle (fast failure) before this
    // continuation registers its waiter. _settleWaiter caches terminal
    // outcomes briefly, so check there first.
    const cached = this.settledCache && this.settledCache.get(job.id);
    if (cached) {
      this.settledCache.delete(job.id);
      if (cached.err) throw cached.err;
      return { claimed: true, settled: true, result: cached.result };
    }
    const claim = deferred();
    const settled = deferred();
    // Swallow unhandled rejection warnings; the race below observes it.
    settled.promise.then(() => {}, () => {});
    this.claimWaiters.set(job.id, claim);
    this.waiters.set(job.id, settled);
    const graceMs = Math.max(0, Math.min(2000, Number(claimGraceMs) || 0));
    const grace = () => new Promise((res) => {
      const t = setTimeout(() => res({ claimed: true }), graceMs);
      if (t.unref) t.unref();
    });
    const settleOutcome = settled.promise.then(
      (result) => ({ claimed: true, settled: true, result }),
      (err) => { throw err; },
    );
    // A settle that arrives before any claim (fast validation failure)
    // rejects immediately with the real error. After a claim, a fast
    // terminal outcome (busy/terminal within the grace window) still
    // surfaces honestly; slower executions resolve as claimed.
    const postClaim = claim.promise.then(() => Promise.race([settleOutcome, grace()]));
    let timer = null;
    try {
      return await Promise.race([
        settleOutcome,
        postClaim,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timed out waiting for worker claim on job ${job.id}`);
            err.code = 'claim_timeout';
            reject(err);
          }, Math.max(1000, Number(waitMs) || 15000));
          if (timer.unref) timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.claimWaiters.delete(job.id);
      // The settle waiter stays registered: a post-claim completion still
      // resolves it (harmless), and waiters are always cleaned on settle.
    }
  }

  stats() {
    return {
      provider: this.provider,
      pending: this.size(),
      running: this.running,
      processed: this.processed,
      failed: this.failed,
      retried: this.retried,
      duplicates: this.duplicates,
      deadLetter: this.deadLetter,
    };
  }

  async close() {
    this.closed = true;
  }
}

class MemoryJobQueue extends BaseJobQueue {
  constructor({ concurrency = 4, logger = null } = {}) {
    super({ concurrency, logger });
    this.provider = 'memory';
    this.pending = [];
    this._draining = false;
  }

  async enqueue(opts) {
    const norm = this._normalizeEnqueue(opts || {});
    if (norm.duplicate) return { duplicate: true, jobId: norm.jobId || null, completed: !!norm.completed };
    this.pending.push(norm.job);
    setImmediate(() => this._drain().catch(() => {}));
    return norm.job;
  }

  // Enqueue and resolve when the worker settles the job (completion, failure,
  // or timeout). Rejects on duplicate (err.code 'duplicate') so the API can
  // answer 409 busy without executing twice.
  async enqueueAndWait(opts, { waitMs = DEFAULT_TIMEOUT_MS } = {}) {
    const norm = this._normalizeEnqueue(opts || {});
    if (norm.duplicate) {
      const err = new Error('duplicate job already pending or running');
      err.code = 'duplicate';
      throw err;
    }
    const job = norm.job;
    const d = deferred();
    this.waiters.set(job.id, d);
    this.pending.push(job);
    setImmediate(() => this._drain().catch(() => {}));
    let timer = null;
    try {
      return await Promise.race([
        d.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timed out waiting for job ${job.id}`);
            err.code = 'wait_timeout';
            this.waiters.delete(job.id);
            reject(err);
          }, Math.max(1000, Number(waitMs) || DEFAULT_TIMEOUT_MS));
          if (timer.unref) timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _drain() {
    if (this.closed || this._draining) return;
    this._draining = true;
    try {
      while (this.pending.length && this.running < this.concurrency) {
        const job = this.pending.shift();
        const handlers = this._handlersFor(job.type);
        if (!handlers.length) {
          // No consumer: terminal failure, never silent loss.
          this._releaseKey(job);
          this.failed++;
          this._settleWaiter(job, Object.assign(new Error(`no handler for job type "${job.type}"`), { code: 'no_handler' }), null);
          continue;
        }
        this.running++;
        job.attempts = (job.attempts || 0);
        this._invoke(job).then(
          async (out) => { await this._afterSuccess(job, out.result); },
          async (err) => {
            await this._afterFailure(job, err, async (j, delay) => {
              setTimeout(() => {
                if (this.closed) {
                  this.failed++;
                  this._releaseKey(j);
                  this._settleWaiter(j, err, null);
                  return;
                }
                this.pending.push(j);
                setImmediate(() => this._drain().catch(() => {}));
              }, delay).unref?.();
            });
          },
        ).finally(() => {
          this.running--;
          if (this.pending.length) setImmediate(() => this._drain().catch(() => {}));
        });
      }
    } finally {
      this._draining = false;
    }
  }

  size() { return this.pending.length; }

  async close({ drain = true, graceMs = 10000, rejectWaiters = true } = {}) {
    this.closed = true;
    if (!drain) {
      const dropped = this.pending.length;
      this.pending = [];
      return { drained: false, dropped };
    }
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const dropped = this.pending.length;
    this.pending = [];
    // Waiters for dropped jobs must never hang: fail them closed.
    if (rejectWaiters) {
      for (const [id, w] of this.waiters.entries()) {
        this.waiters.delete(id);
        try { w.reject(Object.assign(new Error('queue closed before job completed'), { code: 'queue_closed' })); } catch {}
      }
      for (const [id, w] of this.claimWaiters.entries()) {
        this.claimWaiters.delete(id);
        try { w.reject(Object.assign(new Error('queue closed before job claimed'), { code: 'queue_closed' })); } catch {}
      }
    }
    this.inflightKeys.clear();
    return { drained: this.running === 0, dropped };
  }
}

// Redis-list job queue. Pending jobs are durable in the redis list; running
// jobs are tracked in a processing hash with a visibility deadline so a
// crashed worker's jobs are reclaimed and requeued (duplicate-safe because
// handlers must be idempotent — run execution guards on run state).
class RedisJobQueue extends BaseJobQueue {
  constructor(coordinator, { queueKey = 'queue:jobs', processingKey = 'queue:processing', concurrency = 4, logger = null, pollMs = 250, visibilityMs = 60000 } = {}) {
    super({ concurrency, logger });
    this.provider = 'redis';
    this.coordinator = coordinator;
    this.queueKey = queueKey;
    this.processingKey = processingKey;
    this.pollMs = Math.max(50, pollMs);
    this.visibilityMs = Math.max(5000, visibilityMs);
    this.local = []; // fallback FIFO when no redis client is attached
    this.localProcessing = new Map(); // jobId -> { job, deadline }
    this._draining = false;
    this._timer = setInterval(() => this._drain().catch(() => {}), this.pollMs);
    if (this._timer.unref) this._timer.unref();
    this._reclaimTimer = setInterval(() => this._reclaim().catch(() => {}), Math.max(1000, Math.floor(this.visibilityMs / 4)));
    if (this._reclaimTimer.unref) this._reclaimTimer.unref();
  }

  _redis() {
    const c = this.coordinator;
    if (c && c.backend === 'redis' && c.client) return c.client;
    return null;
  }

  _useLocal() { return !this._redis(); }

  _localFallbackAllowed() {
    return !this.coordinator || this.coordinator.backend === 'memory';
  }

  _queueError(code, cause) {
    const err = new Error(`redis queue unavailable: ${String((cause && cause.message) || cause || 'operation failed').slice(0, 160)}`);
    err.code = code;
    return err;
  }

  async _push(job) {
    const client = this._redis();
    if (client && typeof client.rpush === 'function') {
      try {
        await client.rpush(this.queueKey, JSON.stringify(job));
        return;
      } catch (e) {
        throw this._queueError('queue_unavailable', e);
      }
    }
    if (!this._localFallbackAllowed()) throw this._queueError('queue_unavailable');
    this.local.push(job);
  }

  async enqueue(opts) {
    const norm = this._normalizeEnqueue(opts || {});
    if (norm.duplicate) return { duplicate: true, jobId: norm.jobId || null, completed: !!norm.completed };
    const job = norm.job;
    try {
      await this._push(job);
    } catch (e) {
      this._releaseKey(job);
      throw e;
    }
    setImmediate(() => this._drain().catch(() => {}));
    return job;
  }

  async enqueueAndWait(opts, { waitMs = DEFAULT_TIMEOUT_MS } = {}) {
    const norm = this._normalizeEnqueue(opts || {});
    if (norm.duplicate) {
      const err = new Error('duplicate job already pending or running');
      err.code = 'duplicate';
      throw err;
    }
    const job = norm.job;
    const d = deferred();
    this.waiters.set(job.id, d);
    try {
      await this._push(job);
    } catch (e) {
      this.waiters.delete(job.id);
      this._releaseKey(job);
      throw e;
    }
    setImmediate(() => this._drain().catch(() => {}));
    let timer = null;
    try {
      return await Promise.race([
        d.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timed out waiting for job ${job.id}`);
            err.code = 'wait_timeout';
            this.waiters.delete(job.id);
            reject(err);
          }, Math.max(1000, Number(waitMs) || DEFAULT_TIMEOUT_MS));
          if (timer.unref) timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _nextJob() {
    const client = this._redis();
    if (client && typeof client.lpop === 'function') {
      try {
        const raw = await client.lpop(this.queueKey);
        if (raw) return JSON.parse(raw);
      } catch (e) {
        throw this._queueError('queue_unavailable', e);
      }
    }
    if (!client && !this._localFallbackAllowed()) throw this._queueError('queue_unavailable');
    return this.local.shift() || null;
  }

  // Run the atomic claim Lua script over an eval-capable client (ioredis in
  // production). Single call, never retried: a retried LPOP could silently
  // skip a job (the "unknown outcome" problem), so an eval error propagates
  // and the job is left recoverable (still pending, or already claimed and
  // reclaimable once its lease expires).
  async _evalClaim(client, durationMs, startedMs, leaseToken) {
    return client.eval(
      CLAIM_LUA,
      2,
      this.queueKey,
      this.processingKey,
      String(durationMs),
      String(startedMs),
      leaseToken,
    );
  }

  // Claim the next job. Prefers the atomic LPOP+HSETNX when the client is
  // eval-capable; otherwise falls back to the two-step LPOP + HSET for
  // single-process/mock clients (no real crash window there). Returns
  // { job, lease } or null when there is no claimable job. Throws
  // queue_claim_failed on a Redis failure (nothing to silently retry).
  async _claimNext() {
    const client = this._redis();
    if (client && typeof client.eval === 'function') {
      // Lease duration is at least the default handler timeout + margin,
      // matching the previous per-job _claim() bound without re-deriving it
      // from the (not-yet-known) job body. Renewal keeps longer jobs alive.
      const duration = Math.max(this.visibilityMs, DEFAULT_TIMEOUT_MS + 5000);
      const leaseToken = crypto.randomBytes(16).toString('hex');
      const startedMs = Date.now();
      let record;
      try {
        record = await this._evalClaim(client, duration, startedMs, leaseToken);
      } catch (e) {
        throw this._queueError('queue_claim_failed', e);
      }
      if (record === null || record === undefined || record === -1) return null;
      let parsed;
      try {
        parsed = JSON.parse(record);
      } catch (e) {
        throw this._queueError('queue_claim_failed', e);
      }
      const job = parsed && parsed.job;
      if (!job) throw this._queueError('queue_claim_failed', new Error('claim returned no job'));
      return { job, lease: { token: parsed.leaseToken, duration: parsed.deadline - startedMs, raw: record } };
    }
    // Non-eval fallback (mock clients in tests, or a coordinator without
    // eval): LPOP then HSET. On claim failure the popped job is put back.
    const job = await this._nextJob();
    if (!job) return null;
    let lease;
    try {
      lease = await this._claim(job);
    } catch (e) {
      try { await this._push(job); } catch (requeueError) {
        this.failed++;
        this._releaseKey(job);
        this._settleWaiter(job, requeueError, null);
      }
      this._warn('job claim failed; job returned to queue', { jobId: job.id, error: String((e && e.message) || e).slice(0, 160) });
      throw e;
    }
    return { job, lease };
  }

  async _claim(job) {
    const timeoutMs = Math.max(1000, Number(job.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const duration = Math.max(this.visibilityMs, timeoutMs + 5000);
    const deadline = Date.now() + duration;
    const leaseToken = crypto.randomBytes(16).toString('hex');
    const record = { job, deadline, leaseToken };
    const raw = JSON.stringify(record);
    const client = this._redis();
    if (client && typeof client.hset === 'function') {
      try {
        await client.hset(this.processingKey, job.id, raw);
      } catch (e) {
        throw this._queueError('queue_claim_failed', e);
      }
    } else if (this._localFallbackAllowed()) {
      this.localProcessing.set(job.id, record);
    } else {
      throw this._queueError('queue_claim_failed');
    }
    return { token: leaseToken, duration, raw };
  }

  async _release(job, lease = null) {
    const token = lease && lease.token;
    const client = this._redis();
    if (client && typeof client.hdel === 'function') {
      if (token) {
        const atomic = await compareAndDeleteHash(client, this.processingKey, job.id, lease.raw);
        if (atomic !== null) return atomic;
        try {
          const current = typeof client.hget === 'function' ? await client.hget(this.processingKey, job.id) : null;
          if (current !== lease.raw) return false;
        } catch { return false; }
      }
      try { await client.hdel(this.processingKey, job.id); return true; } catch { return false; }
    } else if (this._localFallbackAllowed()) {
      const current = this.localProcessing.get(job.id);
      if (token && (!current || current.leaseToken !== token)) return false;
      this.localProcessing.delete(job.id);
      return true;
    }
    return false;
  }

  async _renew(job, lease) {
    const deadline = Date.now() + lease.duration;
    const next = JSON.stringify({ job, deadline, leaseToken: lease.token });
    const client = this._redis();
    if (client && typeof client.hset === 'function') {
      const atomic = await compareAndSetHash(client, this.processingKey, job.id, lease.raw, next);
      if (atomic !== null) {
        if (atomic) lease.raw = next;
        return atomic;
      }
      try {
        const current = typeof client.hget === 'function' ? await client.hget(this.processingKey, job.id) : null;
        if (!current) return false;
        const parsed = JSON.parse(current);
        if (parsed.leaseToken !== lease.token) return false;
        await client.hset(this.processingKey, job.id, next);
        lease.raw = next;
        return true;
      } catch { return false; }
    }
    if (!this._localFallbackAllowed()) return false;
    const current = this.localProcessing.get(job.id);
    if (!current || current.leaseToken !== lease.token) return false;
    current.deadline = deadline;
    lease.raw = next;
    return true;
  }

  _startLeaseRenewal(job, lease) {
    const every = Math.max(250, Math.min(30000, Math.floor(lease.duration / 3)));
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const ok = await this._renew(job, lease);
        if (!ok) {
          clearInterval(timer);
          this._warn('job lease was lost while handler was running', { jobId: job.id, type: job.type });
        }
      } catch {
        clearInterval(timer);
      } finally {
        refreshing = false;
      }
    }, every);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  // Crash recovery: requeue jobs whose visibility deadline expired without
  // completion (worker crash, timeout kill, deploy). Non-retryable jobs go
  // to dead-letter instead of being re-run blindly.
  async _reclaim() {
    if (this.closed) return;
    const now = Date.now();
    const stale = [];
    const client = this._redis();
    if (client && typeof client.hgetall === 'function') {
      let all = null;
      try { all = await client.hgetall(this.processingKey); } catch { all = null; }
      if (all) {
        for (const [id, raw] of Object.entries(all)) {
          try {
            const rec = JSON.parse(raw);
            if (rec && rec.deadline && rec.deadline <= now && rec.job) stale.push({ id, raw, job: rec.job });
            else if (!rec || !rec.deadline) {
              try { await client.hdel(this.processingKey, id); } catch {}
            }
          } catch {
            try { await client.hdel(this.processingKey, id); } catch {}
          }
        }
      }
    } else {
      for (const [id, rec] of this.localProcessing.entries()) {
        if (rec.deadline <= now) {
          this.localProcessing.delete(id);
          stale.push({ id, raw: null, job: rec.job });
        }
      }
    }
    for (const item of stale) {
      const job = item.job;
      const client2 = this._redis();
      if (client2 && typeof client2.hdel === 'function') {
        const atomic = item.raw
          ? await compareAndDeleteHash(client2, this.processingKey, item.id, item.raw)
          : null;
        if (atomic === false) continue;
        if (atomic === null) {
          try {
            const current = typeof client2.hget === 'function' ? await client2.hget(this.processingKey, item.id) : null;
            if (item.raw && current !== item.raw) continue;
            await client2.hdel(this.processingKey, item.id);
          } catch { continue; }
        }
      }
      job.attempts = (job.attempts || 0) + 1;
      const max = Math.max(1, Number(job.maxAttempts) || 1);
      if (job.retryable !== false && job.attempts < max && !this.closed) {
        this.retried++;
        const delay = Math.min(30000, RETRY_BASE_MS * (2 ** Math.max(0, job.attempts - 1)));
        setTimeout(async () => {
          try {
            if (this.closed) throw Object.assign(new Error('queue closed before reclaimed job was requeued'), { code: 'queue_closed' });
            await this._push(job);
            setImmediate(() => this._drain().catch(() => {}));
          } catch (e) {
            this.failed++;
            this._releaseKey(job);
            this._settleWaiter(job, e, null);
          }
        }, delay).unref?.();
        this._warn('reclaimed stale job after worker crash/timeout', { jobId: job.id, type: job.type });
      } else {
        // Non-retryable (e.g. run execution with unknown side effects):
        // never re-run blindly — dead-letter and fail the waiter closed.
        this.failed++;
        this.deadLetter++;
        this._releaseKey(job);
        this._settleWaiter(job, Object.assign(new Error(`job ${job.id} lost its worker and is not retryable`), { code: 'worker_lost' }), null);
        this._warn('non-retryable job lost its worker; dead-lettered, NOT re-run', { jobId: job.id, type: job.type });
      }
    }
  }

  async _drain() {
    if (this.closed || this._draining) return;
    this._draining = true;
    try {
      while (this.running < this.concurrency) {
        let claim;
        try {
          claim = await this._claimNext();
        } catch (e) {
          // Atomic path: nothing to requeue (the job is still pending or
          // already durably claimed and will be reclaimed) — just stop and
          // retry on the next poll. Fallback path already requeued on failure.
          this._warn('job claim failed', { error: String((e && e.message) || e).slice(0, 160) });
          break;
        }
        if (!claim) break;
        const { job, lease } = claim;
        const handlers = this._handlersFor(job.type);
        if (!handlers.length) {
          // Claimed then found no consumer: release the processing record so
          // the reclaim path never sees a phantom in-flight job.
          await this._release(job, lease);
          this._releaseKey(job);
          this.failed++;
          this._settleWaiter(job, Object.assign(new Error(`no handler for job type "${job.type}"`), { code: 'no_handler' }), null);
          continue;
        }
        job.attempts = (job.attempts || 0);
        this.running++;
        const stopRenewal = this._startLeaseRenewal(job, lease);
        this._invoke(job).then(
          async (out) => {
            stopRenewal();
            await this._release(job, lease);
            await this._afterSuccess(job, out.result);
          },
          async (err) => {
            stopRenewal();
            await this._release(job, lease);
            await this._afterFailure(job, err, async (j, delay) => {
              setTimeout(async () => {
                if (this.closed) {
                  this.failed++;
                  this._releaseKey(j);
                  this._settleWaiter(j, err, null);
                  return;
                }
                try {
                  await this._push(j);
                  setImmediate(() => this._drain().catch(() => {}));
                } catch (e) {
                  this.failed++;
                  this._releaseKey(j);
                  this._settleWaiter(j, e, null);
                }
              }, delay).unref?.();
            });
          },
        ).finally(() => { this.running--; });
      }
    } finally {
      this._draining = false;
    }
  }

  size() { return this.local.length; }

  async close({ drain = true, graceMs = 10000, rejectWaiters = true } = {}) {
    this.closed = true;
    try { clearInterval(this._timer); } catch {}
    try { clearInterval(this._reclaimTimer); } catch {}
    if (drain) {
      const deadline = Date.now() + Math.max(0, graceMs);
      while (this.running > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (rejectWaiters) {
      for (const [id, w] of this.waiters.entries()) {
        this.waiters.delete(id);
        try { w.reject(Object.assign(new Error('queue closed before job completed'), { code: 'queue_closed' })); } catch {}
      }
      for (const [id, w] of this.claimWaiters.entries()) {
        this.claimWaiters.delete(id);
        try { w.reject(Object.assign(new Error('queue closed before job claimed'), { code: 'queue_closed' })); } catch {}
      }
    }
    this.inflightKeys.clear();
    // Pending jobs in redis stay durable for the next worker; local fallback
    // jobs are reported as dropped (single-process limitation, never silent).
    return { drained: this.running === 0, droppedLocal: this.local.length };
  }
}

function createJobQueue({ provider = 'memory', coordinator = null, concurrency = 4, logger = null } = {}) {
  if (String(provider).toLowerCase() === 'redis') {
    return new RedisJobQueue(coordinator, { concurrency, logger });
  }
  return new MemoryJobQueue({ concurrency, logger });
}

module.exports = { createJobQueue, MemoryJobQueue, RedisJobQueue, BaseJobQueue, newJobId };
