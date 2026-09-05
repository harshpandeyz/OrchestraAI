'use strict';

// Session 1 — durable idempotency foundation for future (Session 3) tool execution.
//
//   process restart != duplicate irreversible operation automatically safe
//
// States: PENDING -> RUNNING -> COMPLETED | FAILED ; UNKNOWN = no record.
// Constraint: idempotency_key UNIQUE (enforced in memory + on disk).
//
// This module is the persistence/API primitive Session 3 builds on. It does
// NOT execute tools itself — it only records the outcome of an operation so
// retries return the stored result instead of re-executing.
//
// Durability: records persist to <dataDir>/idempotency.json atomically
// (tmp + rename). In-memory mirror for O(1) lookups; restored on construction.
// Bounded (default 1000 keys, LRU-ish eviction of oldest COMPLETED/FAILED).

const fs = require('fs');
const path = require('path');

const STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

class IdempotencyStore {
  constructor(dataDir, options = {}) {
    this.file = dataDir ? path.join(dataDir, 'idempotency.json') : null;
    this.max = options.max || 1000;
    this.records = new Map(); // key -> { key, state, result?, error?, createdAt, updatedAt, runId?, op? }
    this.log = options.logger || null;
    // Optional distributed backend (Postgres UNIQUE row or Redis NX key).
    // When set, async beginAsync/completeAsync/failAsync consult the remote
    // first so paid/durable side effects are safe across backend instances.
    // The local Map remains only as a best-effort mirror/cache — never the
    // authority in production. See backend/src/infrastructure/*.
    this.remote = options.remote || options.distributedBackend || null;
    if (this.file) this._restore();
  }

  get distributed() {
    return !!this.remote;
  }

  _warn(msg, extra) {
    try {
      if (this.log && typeof this.log.warn === 'function') this.log.warn(msg, extra || {});
    } catch {}
  }

  _restore() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const r of arr.slice(-this.max)) {
          if (r && typeof r.key === 'string') this.records.set(r.key, r);
        }
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this._warn('idempotency store corrupt, quarantined; starting empty');
    }
  }

  _persist() {
    if (!this.file) return { ok: true, memoryOnly: true };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const arr = Array.from(this.records.values()).slice(-this.max);
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
      try {
        const fd = fs.openSync(tmp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch {}
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (e) {
      this._warn('idempotency persist failed', { error: String((e && e.message) || e).slice(0, 120) });
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  _evictIfNeeded() {
    while (this.records.size > this.max) {
      // Evict oldest terminal record first.
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, r] of this.records) {
        if (r.state === STATES.COMPLETED || r.state === STATES.FAILED) {
          const t = Date.parse(r.updatedAt || r.createdAt || 0) || 0;
          if (t < oldestTs) { oldestTs = t; oldestKey = k; }
        }
      }
      if (!oldestKey) oldestKey = this.records.keys().next().value;
      if (!oldestKey) break;
      this.records.delete(oldestKey);
    }
  }

  // Begin an operation. Returns { fresh: true } for the winner, or
  // { fresh: false, record } when the key already exists (caller must NOT
  // re-execute; return the stored result / observe the in-flight state).
  // NOTE: process-local only. Paid/durable side effects in production MUST
  // use beginAsync (distributed backend) instead — see below.
  begin(key, meta = {}) {
    if (!key || typeof key !== 'string') throw new Error('idempotency key required');
    const existing = this.records.get(key);
    if (existing) return { fresh: false, record: { ...existing } };
    const now = new Date().toISOString();
    const rec = {
      key,
      state: meta.state || STATES.RUNNING,
      runId: meta.runId || null,
      op: meta.op || null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, rec);
    this._evictIfNeeded();
    this._persist();
    return { fresh: true, record: { ...rec } };
  }

  complete(key, result) {
    const rec = this.records.get(key);
    const now = new Date().toISOString();
    if (!rec) {
      const fresh = { key, state: STATES.COMPLETED, result: result ?? null, createdAt: now, updatedAt: now };
      this.records.set(key, fresh);
    } else {
      rec.state = STATES.COMPLETED;
      rec.result = result ?? null;
      rec.error = null;
      rec.updatedAt = now;
    }
    this._evictIfNeeded();
    this._persist();
    return { ...this.records.get(key) };
  }

  fail(key, error) {
    const rec = this.records.get(key);
    const now = new Date().toISOString();
    const safe = String((error && error.message) || error || 'failed').slice(0, 500);
    if (!rec) {
      const fresh = { key, state: STATES.FAILED, error: safe, createdAt: now, updatedAt: now };
      this.records.set(key, fresh);
    } else {
      rec.state = STATES.FAILED;
      rec.error = safe;
      rec.updatedAt = now;
    }
    this._evictIfNeeded();
    this._persist();
    return { ...this.records.get(key) };
  }

  get(key) {
    const rec = this.records.get(key);
    if (!rec) return { state: STATES.UNKNOWN, key };
    return { ...rec };
  }

  // --- Distributed (multi-instance safe) path ---
  // Uses the configured remote backend when present; otherwise falls back to
  // the local implementation with degraded:true so callers can observe that
  // the guarantee is single-process only. Production deployments handling
  // paid/durable side effects must configure a remote (Postgres/Redis) and
  // treat degraded reservations as NOT safe for irreversible work.
  async beginAsync(key, meta = {}) {
    if (!key || typeof key !== 'string') throw new Error('idempotency key required');
    if (this.remote && typeof this.remote.begin === 'function') {
      const out = await this.remote.begin(key, meta);
      const record = out && out.record ? { ...out.record } : this.get(key);
      if (out && out.fresh) {
        this.records.set(key, { key, state: record.state || STATES.RUNNING, ...record, updatedAt: new Date().toISOString() });
        this._evictIfNeeded();
        this._persist();
      }
      return { fresh: !!(out && out.fresh), record, distributed: true, degraded: false };
    }
    const local = this.begin(key, meta);
    return { ...local, distributed: false, degraded: true };
  }

  async completeAsync(key, result) {
    if (this.remote && typeof this.remote.complete === 'function') {
      await this.remote.complete(key, result);
    }
    return this.complete(key, result);
  }

  async failAsync(key, error) {
    if (this.remote && typeof this.remote.fail === 'function') {
      await this.remote.fail(key, error);
    }
    return this.fail(key, error);
  }

  async getAsync(key) {
    if (this.remote && typeof this.remote.get === 'function') {
      try {
        const rec = await this.remote.get(key);
        if (rec) return { ...rec };
      } catch {}
    }
    return this.get(key);
  }

  statusOf(key) {
    const rec = this.records.get(key);
    return rec ? rec.state : STATES.UNKNOWN;
  }

  size() {
    return this.records.size;
  }

  clear() {
    this.records.clear();
    this._persist();
  }
}

// Redis-backed distributed idempotency over a coordinator (SET NX).
// Keys are namespaced and TTL-bounded; terminal states persist for ttlMs.
class RedisIdempotencyBackend {
  constructor(coordinator, { prefix = 'idem:', ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    this.coordinator = coordinator;
    this.prefix = prefix;
    this.ttlMs = ttlMs;
  }

  _k(key) { return `${this.prefix}${key}`; }

  async begin(key, meta = {}) {
    const now = new Date().toISOString();
    const rec = {
      key,
      state: meta.state || STATES.RUNNING,
      runId: meta.runId || null,
      op: meta.op || null,
      createdAt: now,
      updatedAt: now,
    };
    const res = await this.coordinator.set(this._k(key), JSON.stringify(rec), { px: this.ttlMs, nx: true });
    if (res === 'OK') return { fresh: true, record: { ...rec } };
    return { fresh: false, record: await this.get(key) };
  }

  async complete(key, result) {
    const existing = (await this.get(key)) || { key };
    const rec = { ...existing, key, state: STATES.COMPLETED, result: result ?? null, error: null, updatedAt: new Date().toISOString() };
    await this.coordinator.set(this._k(key), JSON.stringify(rec), { px: this.ttlMs });
    return { ...rec };
  }

  async fail(key, error) {
    const existing = (await this.get(key)) || { key };
    const safe = String((error && error.message) || error || 'failed').slice(0, 500);
    const rec = { ...existing, key, state: STATES.FAILED, error: safe, updatedAt: new Date().toISOString() };
    await this.coordinator.set(this._k(key), JSON.stringify(rec), { px: this.ttlMs });
    return { ...rec };
  }

  async get(key) {
    const raw = await this.coordinator.get(this._k(key));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

// Postgres-backed distributed idempotency over PostgresDatastore
// (UNIQUE key => cross-instance winner election in the database).
class PostgresIdempotencyBackend {
  constructor(pgStore) {
    this.pg = pgStore;
  }

  async begin(key, meta = {}) {
    const out = await this.pg.idempotencyBegin(key, meta);
    return { fresh: !!out.fresh, record: out.record ? { ...out.record } : null };
  }

  async complete(key, result) {
    await this.pg.idempotencyFinish(key, { state: STATES.COMPLETED, result });
  }

  async fail(key, error) {
    const safe = String((error && error.message) || error || 'failed').slice(0, 500);
    await this.pg.idempotencyFinish(key, { state: STATES.FAILED, error: safe });
  }

  async get(key) {
    return this.pg.idempotencyGet(key);
  }
}

module.exports = { IdempotencyStore, STATES, RedisIdempotencyBackend, PostgresIdempotencyBackend };
