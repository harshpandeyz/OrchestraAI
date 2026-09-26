'use strict';

// Redis-backed transient coordination with an explicit in-memory fallback.
// No hard dependency: `ioredis` (preferred) or `redis` are loaded lazily.
// When REDIS_URL is unset, the coordinator reports backend:'memory' and
// behaves as a single-process adapter (correct for demo/tests). When
// REDIS_URL is set but no client library or server is reachable, the
// coordinator reports backend:'memory-degraded' with lastError set —
// production readiness treats that as NOT ready instead of silently
// pretending Redis coordination works.
//
// Never logs credentials: connection URLs are redacted to host only.

function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[redacted]';
  }
}

function tryRequire(name) {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require(name);
  } catch {
    return null;
  }
}

class MemoryCoordinator {
  constructor({ degraded = false, lastError = null } = {}) {
    this.backend = degraded ? 'memory-degraded' : 'memory';
    this.degraded = degraded;
    this.lastError = lastError;
    this.kv = new Map(); // key -> { value, expiresAt }
    this.counters = new Map();
  }

  _expired(entry) {
    return entry && entry.expiresAt && entry.expiresAt <= Date.now();
  }

  async ping() {
    return { ok: true, backend: this.backend };
  }

  async get(key) {
    const entry = this.kv.get(key);
    if (!entry || this._expired(entry)) {
      if (entry) this.kv.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, { px = 0, nx = false } = {}) {
    if (nx) {
      const existing = await this.get(key);
      if (existing !== null) return null; // not set
    }
    this.kv.set(key, { value, expiresAt: px > 0 ? Date.now() + px : 0 });
    return 'OK';
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys) if (this.kv.delete(k)) n++;
    return n;
  }

  async incr(key) {
    const cur = Number((await this.get(key)) || 0);
    const next = cur + 1;
    const entry = this.kv.get(key);
    this.kv.set(key, { value: String(next), expiresAt: (entry && entry.expiresAt) || 0 });
    return next;
  }

  async expire(key, seconds) {
    const entry = this.kv.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + (seconds * 1000);
    return 1;
  }

  async close() {}
}

class IoredisCoordinator {
  constructor(client, host) {
    this.client = client;
    this.host = host;
    this.backend = 'redis';
    this.degraded = false;
    this.lastError = null;
  }

  async ping() {
    await this.client.ping();
    return { ok: true, backend: 'redis' };
  }

  get(key) { return this.client.get(key); }

  async set(key, value, { px = 0, nx = false } = {}) {
    const args = [key, value];
    if (px > 0) args.push('PX', px);
    if (nx) args.push('NX');
    return this.client.set(...args);
  }

  del(...keys) { return this.client.del(...keys); }
  incr(key) { return this.client.incr(key); }
  expire(key, seconds) { return this.client.expire(key, seconds); }
  async close() { try { await this.client.quit(); } catch { try { this.client.disconnect(); } catch {} } }
}

// Creates a coordinator from config. Never throws for missing Redis in
// dev/test: returns the memory adapter. In production with REDIS_URL set,
// connection failures are surfaced via degraded=true (readiness fails).
async function createCoordinator(config, logger = null) {
  const url = config && config.redisUrl ? String(config.redisUrl) : '';
  if (!url) {
    return new MemoryCoordinator();
  }
  const IORedis = tryRequire('ioredis');
  if (IORedis) {
    try {
      const client = new IORedis(url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      await client.ping();
      return new IoredisCoordinator(client, redactUrl(url));
    } catch (e) {
      try {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('redis unreachable, using degraded memory coordinator', { host: redactUrl(url) });
        }
      } catch {}
      const mem = new MemoryCoordinator({ degraded: true, lastError: String((e && e.message) || e).slice(0, 200) });
      mem.host = redactUrl(url);
      return mem;
    }
  }
  const redisLib = tryRequire('redis');
  if (redisLib && typeof redisLib.createClient === 'function') {
    try {
      const client = redisLib.createClient({ url });
      await client.connect();
      await client.ping();
      const wrap = {
        backend: 'redis', degraded: false, lastError: null, host: redactUrl(url),
        ping: async () => { await client.ping(); return { ok: true, backend: 'redis' }; },
        get: (k) => client.get(k),
        set: async (k, v, { px = 0, nx = false } = {}) => client.set(k, v, { ...(px > 0 ? { PX: px } : {}), ...(nx ? { NX: true } : {}) }),
        del: (...ks) => client.del(ks),
        incr: (k) => client.incr(k),
        expire: (k, s) => client.expire(k, s),
        close: async () => { try { await client.quit(); } catch {} },
      };
      return wrap;
    } catch (e) {
      const mem = new MemoryCoordinator({ degraded: true, lastError: String((e && e.message) || e).slice(0, 200) });
      mem.host = redactUrl(url);
      return mem;
    }
  }
  // REDIS_URL configured but no client library installed: explicit degraded
  // state (never silent). Install `ioredis` to enable real coordination.
  try {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('REDIS_URL set but no redis client installed (ioredis); using degraded memory coordinator', { host: redactUrl(url) });
    }
  } catch {}
  const mem = new MemoryCoordinator({ degraded: true, lastError: 'no redis client library installed (need ioredis)' });
  mem.host = redactUrl(url);
  return mem;
}

function createMemoryCoordinatorForTests() {
  return new MemoryCoordinator();
}

module.exports = { createCoordinator, createMemoryCoordinatorForTests, MemoryCoordinator, redactUrl };
