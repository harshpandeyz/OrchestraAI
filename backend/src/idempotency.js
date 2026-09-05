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
    if (this.file) this._restore();
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

module.exports = { IdempotencyStore, STATES };
