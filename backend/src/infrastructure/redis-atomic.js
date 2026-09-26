'use strict';

// Small Redis compare-and-* primitives used by leases and locks. The primary
// client in production is ioredis; the alternate call shape keeps the
// boundary compatible with node-redis without making either client a hard
// dependency of the test/runtime modules.

async function evalRedis(client, script, keys, args) {
  if (!client || typeof client.eval !== 'function') return null;
  try {
    const result = await client.eval(script, keys.length, ...keys, ...args);
    return Number(result);
  } catch {
    try {
      const result = await client.eval(script, { keys, arguments: args });
      return Number(result);
    } catch {
      return null;
    }
  }
}

async function compareAndDeleteValue(client, key, expected) {
  const result = await evalRedis(
    client,
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
    [key],
    [String(expected)],
  );
  return result === null ? null : result === 1;
}

async function compareAndExpireValue(client, key, expected, ttlMs) {
  const result = await evalRedis(
    client,
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end',
    [key],
    [String(expected), String(Math.max(1, Math.floor(ttlMs)))],
  );
  return result === null ? null : result === 1;
}

async function compareAndDeleteHash(client, key, field, expected) {
  const result = await evalRedis(
    client,
    'if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then return redis.call("HDEL", KEYS[1], ARGV[1]) else return 0 end',
    [key],
    [String(field), String(expected)],
  );
  return result === null ? null : result === 1;
}

async function compareAndSetHash(client, key, field, expected, next) {
  const result = await evalRedis(
    client,
    'if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then redis.call("HSET", KEYS[1], ARGV[1], ARGV[3]) return 1 else return 0 end',
    [key],
    [String(field), String(expected), String(next)],
  );
  return result === null ? null : result === 1;
}

module.exports = {
  compareAndDeleteValue,
  compareAndExpireValue,
  compareAndDeleteHash,
  compareAndSetHash,
};
