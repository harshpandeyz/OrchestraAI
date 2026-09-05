'use strict';

// Agent 3 — Sanitized sandbox environment.
//
// Rule: NEVER pass the application process environment wholesale to customer
// code. Child processes spawned for customer tool/code execution receive only
// this curated minimal environment. Provider secrets, session tokens, and
// host-specific configuration are never included.
//
// The isolated worker (sandbox-worker/) starts from an empty environment and
// receives only these safe keys; this module is the single source of truth
// for what "safe" means on the application side too (runAllowlisted).

const SECRET_ENV_RE = /(api[_-]?key|secret|token|password|passwd|bearer|authorization|private[_-]?key|client[_-]?secret|session|cookie|stripe|openai|anthropic|openrouter|aws_|gcp_|azure)/i;

// Minimal safe keys. PATH is sanitized to system defaults (not the host's
// full PATH, which can point at attacker-controlled dirs in some deploys).
// NODE_ENV is passed as a plain mode string, never with secrets.
const SAFE_ENV_KEYS = Object.freeze(['PATH', 'NODE_ENV', 'CI', 'TERM', 'LANG', 'SHELL']);

const DEFAULT_SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

function sanitizePath(value) {
  const raw = String(value || '').split(':').filter(Boolean);
  const safe = raw.filter((seg) => (
    seg.startsWith('/usr/local/bin')
    || seg.startsWith('/usr/bin')
    || seg.startsWith('/bin')
    || seg.startsWith('/opt/')
  ));
  const out = safe.join(':').slice(0, 2000);
  return out || DEFAULT_SAFE_PATH;
}

function buildSandboxEnv(overrides = {}) {
  const env = {
    PATH: sanitizePath(process.env.PATH || DEFAULT_SAFE_PATH),
    LANG: String(process.env.LANG || 'C.UTF-8').slice(0, 100),
    TERM: String(process.env.TERM || 'dumb').slice(0, 50),
  };
  if (process.env.CI) env.CI = String(process.env.CI).slice(0, 20);
  if (process.env.NODE_ENV) env.NODE_ENV = String(process.env.NODE_ENV).slice(0, 30);
  // Explicit caller overrides win ONLY for non-secret keys.
  for (const [k, v] of Object.entries(overrides || {})) {
    if (SECRET_ENV_RE.test(k)) continue;
    if (!SAFE_ENV_KEYS.includes(k)) continue;
    env[k] = String(v).slice(0, 2000);
  }
  // Belt and suspenders: drop anything secret-looking that slipped in.
  for (const k of Object.keys(env)) {
    if (SECRET_ENV_RE.test(k)) delete env[k];
  }
  // Never propagate proxy/credential-bearing vars to untrusted code by
  // default; the isolated worker documents egress separately.
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  return env;
}

// Fail-closed scan: returns names of secret-looking keys present in obj.
// The isolated-executor client refuses to send a request that carries them.
function findSecretKeys(obj, depth = 0) {
  const hits = [];
  if (!obj || typeof obj !== 'object' || depth > 4) return hits;
  for (const k of Object.keys(obj)) {
    if (SECRET_ENV_RE.test(k)) hits.push(k);
    const v = obj[k];
    if (v && typeof v === 'object') hits.push(...findSecretKeys(v, depth + 1));
  }
  return [...new Set(hits)];
}

function assertNoSecrets(obj, what = 'isolated-executor request') {
  const hits = findSecretKeys(obj);
  if (hits.length) {
    throw Object.assign(
      new Error(`${what} must never carry provider secrets (found: ${hits.slice(0, 5).join(', ')})`),
      { code: 'secret_refused' },
    );
  }
}

module.exports = {
  SAFE_ENV_KEYS,
  SECRET_ENV_RE,
  DEFAULT_SAFE_PATH,
  sanitizePath,
  buildSandboxEnv,
  findSecretKeys,
  assertNoSecrets,
};
