'use strict';

// Rate limiting over the Redis coordinator (fixed window via INCR+EXPIRE)
// with an in-memory fallback that preserves the existing single-process
// semantics (see server allowRequest). Production multi-instance rate
// limits require REDIS_URL; without it each instance enforces its own
// local window (explicit, reported as degraded in readiness).

class RateLimiter {
  constructor(coordinator, { prefix = 'rl:' } = {}) {
    this.coordinator = coordinator;
    this.prefix = prefix;
    // Local fallback buckets when coordinator is memory-based: key -> { startedAt, count }.
    // (The Redis path does not use these; it uses INCR counters instead.)
    this.local = new Map();
  }

  get distributed() {
    return !!this.coordinator && this.coordinator.backend === 'redis';
  }

  async allow({ key, limit, windowMs = 60000 }) {
    const namespaced = `${this.prefix}${key}`;
    if (this.distributed) {
      const count = await this.coordinator.incr(namespaced);
      if (count === 1) await this.coordinator.expire(namespaced, Math.ceil(windowMs / 1000));
      return { allowed: count <= limit, count, retryAfterMs: count <= limit ? 0 : windowMs };
    }
    const now = Date.now();
    let bucket = this.local.get(namespaced);
    if (!bucket || bucket.startedAt + windowMs <= now) bucket = { startedAt: now, count: 0 };
    bucket.count += 1;
    this.local.set(namespaced, bucket);
    if (this.local.size > 5000) {
      for (const [k, v] of this.local) if (v.startedAt + windowMs <= now) this.local.delete(k);
    }
    return { allowed: bucket.count <= limit, count: bucket.count, retryAfterMs: bucket.count <= limit ? 0 : (bucket.startedAt + windowMs - now) };
  }
}

module.exports = { RateLimiter };
