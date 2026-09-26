'use strict';

// Distributed locks over the Redis coordinator (SET key token PX ttl NX).
// Falls back to a process-local mutex map when the coordinator backend is
// memory (single-process dev/test). Production multi-instance deployments
// must configure REDIS_URL; otherwise locks are explicitly process-local
// and readiness reports coordination as degraded.

const crypto = require('crypto');
const { compareAndDeleteValue, compareAndExpireValue } = require('./redis-atomic');

class LockManager {
  constructor(coordinator) {
    this.coordinator = coordinator;
    this.localHeld = new Map(); // key -> token (memory backend bookkeeping)
  }

  get backend() {
    return (this.coordinator && this.coordinator.backend) || 'memory';
  }

  async tryAcquire(key, ttlMs = 10000) {
    const token = crypto.randomBytes(16).toString('hex');
    const namespaced = `lock:${key}`;
    const ttl = Math.max(1000, Number(ttlMs) || 10000);
    const res = await this.coordinator.set(namespaced, token, { px: ttl, nx: true });
    if (res === 'OK') {
      this.localHeld.set(namespaced, token);
      return { acquired: true, token };
    }
    return { acquired: false, token: null };
  }

  async release(key, token) {
    const namespaced = `lock:${key}`;
    try {
      const client = this.coordinator && this.coordinator.client;
      if (client) {
        const atomic = await compareAndDeleteValue(client, namespaced, token);
        if (atomic !== null) {
          if (atomic) this.localHeld.delete(namespaced);
          return atomic;
        }
      }
      const current = await this.coordinator.get(namespaced);
      if (current !== token) return false;
      await this.coordinator.del(namespaced);
      this.localHeld.delete(namespaced);
      return true;
    } catch {
      return false;
    }
  }

  async renew(key, token, ttlMs = 10000) {
    const namespaced = `lock:${key}`;
    const ttl = Math.max(1000, Number(ttlMs) || 10000);
    try {
      const client = this.coordinator && this.coordinator.client;
      if (client) {
        const atomic = await compareAndExpireValue(client, namespaced, token, ttl);
        if (atomic !== null) return atomic;
      }
      const current = await this.coordinator.get(namespaced);
      if (current !== token) return false;
      return (await this.coordinator.set(namespaced, token, { px: ttl })) === 'OK';
    } catch {
      return false;
    }
  }

  // Convenience: run fn under the lock; throws code 'lock_busy' when held.
  async withLock(key, ttlMs, fn) {
    const ttl = Math.max(1000, Number(ttlMs) || 10000);
    let claim;
    try {
      claim = await this.tryAcquire(key, ttl);
    } catch (e) {
      const err = new Error(`lock unavailable: ${key}`);
      err.code = 'lock_unavailable';
      err.cause = e;
      throw err;
    }
    const { acquired, token } = claim;
    if (!acquired) {
      const err = new Error(`lock busy: ${key}`);
      err.code = 'lock_busy';
      throw err;
    }
    const renewEvery = Math.max(250, Math.min(30000, Math.floor(ttl / 3)));
    let lost = false;
    let renewing = false;
    const timer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        if (!(await this.renew(key, token, ttl))) lost = true;
      } finally {
        renewing = false;
      }
    }, renewEvery);
    if (timer.unref) timer.unref();
    try {
      const result = await fn();
      if (lost) {
        const err = new Error(`lock lease lost: ${key}`);
        err.code = 'lock_lost';
        throw err;
      }
      return result;
    } finally {
      clearInterval(timer);
      await this.release(key, token);
    }
  }
}

module.exports = { LockManager };
