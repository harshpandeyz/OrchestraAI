'use strict';

// Central defensive resource limits (no scattered magic numbers).
// Values come from env with safe defaults; normal usage is never throttled.
//
// Precedence: env process config -> this module defaults.
// Per-run overrides (maxSteps, budget) are resolved in run-config.js, never here.

function num(env, name, fallback, min, max) {
  const v = Number(env[name]);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function loadLimits(env = process.env) {
  return {
    maxBodyBytes: num(env, 'LIMIT_MAX_BODY_BYTES', 256 * 1024, 1024, 10 * 1024 * 1024),
    maxMessageChars: num(env, 'LIMIT_MAX_MESSAGE_CHARS', 4000, 100, 20000),
    maxTitleChars: num(env, 'LIMIT_MAX_TITLE_CHARS', 200, 10, 1000),
    maxToolsPerRun: num(env, 'LIMIT_MAX_TOOLS_PER_RUN', 20, 1, 50),
    maxMemoryItems: num(env, 'LIMIT_MAX_MEMORY_ITEMS', 50, 1, 200),
    maxEventsPerRun: num(env, 'LIMIT_MAX_EVENTS_PER_RUN', 500, 50, 2000),
    maxRunsRetained: num(env, 'LIMIT_MAX_RUNS_RETAINED', 200, 10, 1000),
    maxEvalsRetained: num(env, 'LIMIT_MAX_EVALS_RETAINED', 200, 10, 1000),
    maxFileBytes: num(env, 'LIMIT_MAX_FILE_BYTES', 100000, 1000, 1000000),
    maxToolResultChars: num(env, 'LIMIT_MAX_TOOL_RESULT_CHARS', 2000, 500, 20000),
    maxConcurrentRuns: num(env, 'LIMIT_MAX_CONCURRENT_RUNS', 20, 1, 100),
    requestsPerMinute: num(env, 'LIMIT_REQUESTS_PER_MINUTE', 300, 30, 5000),
    authRequestsPerMinute: num(env, 'LIMIT_AUTH_REQUESTS_PER_MINUTE', 12, 3, 120),
    maxSseSubscribersPerRun: num(env, 'LIMIT_MAX_SSE_SUBSCRIBERS', 50, 1, 500),
    ssePingMs: num(env, 'LIMIT_SSE_PING_MS', 15000, 5000, 60000),
    persistBytesMax: num(env, 'LIMIT_PERSIST_BYTES_MAX', 5_000_000, 100_000, 50_000_000),
  };
}

module.exports = { loadLimits };
