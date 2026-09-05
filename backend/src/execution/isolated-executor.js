'use strict';

// Agent 3 — Explicit executor boundary.
//
// execFile() is a command restriction, NOT a sandbox. Production execution of
// customer/untrusted code must go through an isolated executor:
//
//   POST ${ISOLATED_EXECUTOR_URL}/v1/execute
//
// Request:
//   { runId, tenantId, projectId, workspaceId, command, args, cwd,
//     timeoutMs, maxOutputBytes, networkMode, networkAllowlist }
// Response:
//   { ok, exitCode, stdout, stderr, timedOut, durationMs, isolated,
//     executorVersion }
//
// Rules:
//   - Local restricted execution is for safe development/test operations only.
//   - Production code execution without a reachable isolated executor FAILS
//     CLOSED (code 'sandbox_unavailable') — never silently falls back.
//   - The application NEVER sends provider secrets or host filesystem paths
//     outside the worker workspace to the isolated executor.
//   - Do not make production security depend on an undocumented interface:
//     both shapes are validated explicitly below.

const http = require('http');
const https = require('https');
const { NetworkMode } = require('./execution-policy');
const { assertNoSecrets } = require('./sandbox-env');

const EXECUTOR_VERSION_MIN = '1';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
// Workspace snapshot caps (disposable-snapshot model): bounded file count
// and bytes so a snapshot can never become an exfiltration or DoS vector.
const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
const COLLECT_MAX_PATHS = 20;
const COLLECT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
// Directory/file basenames that are NEVER transferred into a sandbox snapshot:
// dependency trees, VCS metadata, runtime state, and secret-looking files.
const SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '__pycache__', '.venv', 'venv', 'target']);
const SNAPSHOT_SKIP_BASENAME_RE = /(^|\.)(env|secret|secrets|credential|credentials|passwd|shadow)(\.|$)|(^|[_-])(key|keys|token|private|id_rsa|id_ed25519|pem|p12|pfx|keystore)([_.-]|$)/i;
const SNAPSHOT_SKIP_SUFFIX_RE = /\.(pem|key|p12|pfx|jks|keystore|sqlite3?|db)$/i;
const SNAPSHOT_SKIP_PREFIX_RE = /^(\.runtime-data|.*\.corrupt-)/;
const SNAPSHOT_SKIP_RUNTIME_RE = /\.(events|snapshot|billing)\.json$/;

function getIsolatedExecutorUrl(env = process.env) {
  const raw = String((env && env.ISOLATED_EXECUTOR_URL) || '').trim().replace(/\/+$/, '');
  return raw || null;
}

function isProductionEnv(env = process.env) {
  return String((env && env.NODE_ENV) || '').toLowerCase() === 'production';
}

// Tools whose execution spawns customer-influenced subprocesses and therefore
// REQUIRE isolation in production. Read-only metadata tools (read_file,
// search_code, git read-only, env_inspect) stay local under the existing
// workspace sandbox; they never execute customer code.
const ISOLATION_REQUIRED_TOOLS = new Set(['run_tests', 'build_project']);

function toolRequiresIsolation(toolName) {
  return ISOLATION_REQUIRED_TOOLS.has(String(toolName || ''));
}

function isolationRequired({ toolName, env = process.env } = {}) {
  return isProductionEnv(env) && toolRequiresIsolation(toolName);
}

function validateExecuteRequest(body) {
  if (!body || typeof body !== 'object') throw err('bad_params', 'request must be an object');
  for (const k of ['runId', 'command']) {
    if (!body[k] || typeof body[k] !== 'string') throw err('bad_params', `${k} is required`);
  }
  if (body.args !== undefined && !Array.isArray(body.args)) throw err('bad_params', 'args must be an array');
  if (body.timeoutMs !== undefined && !(Number.isFinite(body.timeoutMs) && body.timeoutMs > 0)) {
    throw err('bad_params', 'timeoutMs must be a positive number');
  }
  if (body.maxOutputBytes !== undefined && !(Number.isFinite(body.maxOutputBytes) && body.maxOutputBytes > 0)) {
    throw err('bad_params', 'maxOutputBytes must be a positive number');
  }
  if (body.networkMode !== undefined && !Object.values(NetworkMode).includes(body.networkMode)) {
    throw err('bad_params', `unknown networkMode: ${body.networkMode}`);
  }
  // Boundary hygiene: absolute host paths and secret-bearing payloads are
  // refused client-side before any network call.
  for (const a of body.args || []) {
    if (typeof a === 'string' && (a === '/etc/passwd' || a.startsWith('/etc/') || a.startsWith('/root') || a === '/root')) {
      throw err('denied', 'host path outside worker workspace refused');
    }
  }
  assertNoSecrets(body, 'isolated-executor request');
  // Workspace snapshot + artifact collection (disposable-snapshot model).
  // Shapes are validated here; the worker re-validates on receipt.
  if (body.workspace !== undefined && body.workspace !== null) {
    validateWorkspaceSnapshot(body.workspace);
  }
  if (body.collect !== undefined && body.collect !== null) {
    if (!Array.isArray(body.collect) || body.collect.length > COLLECT_MAX_PATHS) {
      throw err('bad_params', `collect must be an array of at most ${COLLECT_MAX_PATHS} workspace-relative paths`);
    }
    for (const p of body.collect) {
      assertWorkspaceRelPath(p);
    }
  }
  return true;
}

// A workspace-relative path inside the ephemeral sandbox: relative, no
// traversal, no absolute paths, bounded length.
function assertWorkspaceRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 500) throw err('denied', 'bad workspace path length');
  if (p.includes('\0') || p.includes('\n') || p.includes('\r')) throw err('denied', 'control characters are not allowed in workspace paths');
  const norm = String(p).replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)) throw err('denied', 'workspace paths must be relative');
  if (norm.split('/').includes('..')) throw err('denied', 'path traversal is not allowed in workspace paths');
  return norm;
}

function validateWorkspaceSnapshot(ws) {
  if (!ws || typeof ws !== 'object' || !Array.isArray(ws.files)) throw err('bad_params', 'workspace must be { files: [...] }');
  if (ws.files.length > SNAPSHOT_MAX_FILES) throw err('denied', `workspace snapshot exceeds ${SNAPSHOT_MAX_FILES} files`);
  let total = 0;
  for (const f of ws.files) {
    if (!f || typeof f !== 'object') throw err('bad_params', 'workspace file must be an object');
    assertWorkspaceRelPath(f.path);
    const b64 = String(f.contentBase64 || '');
    if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw err('bad_params', 'workspace file content must be base64');
    const bytes = Buffer.byteLength(b64, 'utf8');
    if (bytes > SNAPSHOT_MAX_FILE_BYTES * 4 / 3 + 64) throw err('denied', `workspace file too large: ${f.path}`);
    total += bytes;
    if (total > SNAPSHOT_MAX_TOTAL_BYTES * 4 / 3 + 1024) throw err('denied', 'workspace snapshot exceeds total byte cap');
  }
  return true;
}

// Snapshot metadata is local audit information, not part of the worker
// protocol. In particular, keys such as `skipped.secrets` would be mistaken
// for secret material by the worker's fail-closed request scanner. Transfer
// only the validated file payload.
function workspacePayload(workspace) {
  if (!workspace || typeof workspace !== 'object') return workspace;
  return {
    files: Array.isArray(workspace.files)
      ? workspace.files.map((file) => ({ path: file.path, contentBase64: file.contentBase64 }))
      : workspace.files,
  };
}

// Disposable workspace snapshot of a local directory for transfer into the
// isolated executor. Bounded (file count + bytes), symlink-free (links are
// never followed or transferred), and secret-aware: dependency trees, VCS
// metadata, runtime state, and secret-looking files are skipped, never sent.
// Returns { files: [{ path, contentBase64 }], skipped: { dirs, secrets, oversized, count } }.
// Throws { code:'denied' } when the root itself is unreadable.
function snapshotWorkspace(root, { maxFiles = SNAPSHOT_MAX_FILES, maxTotalBytes = SNAPSHOT_MAX_TOTAL_BYTES, maxFileBytes = SNAPSHOT_MAX_FILE_BYTES } = {}) {
  const fs = require('fs');
  const path = require('path');
  const abs = path.resolve(String(root || ''));
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    throw err('denied', `workspace snapshot failed: ${String((e && e.message) || e).slice(0, 120)}`);
  }
  if (!stat.isDirectory()) throw err('denied', 'workspace snapshot root must be a directory');
  const files = [];
  const skipped = { dirs: 0, secrets: 0, oversized: 0, count: 0 };
  let total = 0;
  const walk = (dir, rel) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= maxFiles || total >= maxTotalBytes) { skipped.count++; continue; }
      if (SNAPSHOT_SKIP_PREFIX_RE.test(name) || SNAPSHOT_SKIP_RUNTIME_RE.test(name)) { skipped.count++; continue; }
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        skipped.count++;
        continue;
      }
      if (st.isSymbolicLink()) { skipped.count++; continue; } // never follow or ship links
      if (st.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(name)) { skipped.dirs++; continue; }
        walk(full, relPath);
        continue;
      }
      if (!st.isFile()) { skipped.count++; continue; }
      if (SNAPSHOT_SKIP_BASENAME_RE.test(name) || SNAPSHOT_SKIP_SUFFIX_RE.test(name)) { skipped.secrets++; continue; }
      if (st.size > maxFileBytes) { skipped.oversized++; continue; }
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        skipped.count++;
        continue;
      }
      if (buf.length > maxFileBytes) { skipped.oversized++; continue; }
      if (total + buf.length > maxTotalBytes) { skipped.count++; continue; }
      total += buf.length;
      files.push({ path: relPath, contentBase64: buf.toString('base64') });
    }
  };
  walk(abs, '');
  return { files, skipped, bytes: total };
}

function validateExecuteResponse(json) {
  if (!json || typeof json !== 'object') throw err('executor_malformed', 'executor returned a non-object response');
  for (const k of ['ok', 'exitCode', 'stdout', 'stderr', 'timedOut', 'durationMs', 'isolated']) {
    if (json[k] === undefined) throw err('executor_malformed', `executor response missing ${k}`);
  }
  if (json.isolated !== true) throw err('executor_malformed', 'executor did not attest isolation (isolated=true required)');
  // Optional artifact surface (workspace manifest + collected file contents).
  // Validated structurally and capped — never trusted blindly.
  let artifacts = [];
  if (json.artifacts !== undefined && json.artifacts !== null) {
    if (!Array.isArray(json.artifacts) || json.artifacts.length > COLLECT_MAX_PATHS) {
      throw err('executor_malformed', 'executor artifacts must be an array within the collect cap');
    }
    let total = 0;
    artifacts = json.artifacts.map((a) => {
      if (!a || typeof a !== 'object') throw err('executor_malformed', 'executor artifact must be an object');
      assertWorkspaceRelPath(a.path);
      const b64 = String(a.contentBase64 || '');
      if (b64 && !/^[A-Za-z0-9+/=]*$/.test(b64)) throw err('executor_malformed', 'executor artifact content must be base64');
      total += Buffer.byteLength(b64, 'utf8');
      if (total > COLLECT_MAX_TOTAL_BYTES * 4 / 3 + 1024) throw err('executor_malformed', 'executor artifacts exceed byte cap');
      return { path: String(a.path).replace(/\\/g, '/'), size: Number.isFinite(a.size) ? a.size : null, contentBase64: b64 || null };
    });
  }
  let workspaceManifest = [];
  if (json.workspaceManifest !== undefined && json.workspaceManifest !== null) {
    if (!Array.isArray(json.workspaceManifest) || json.workspaceManifest.length > 200) {
      throw err('executor_malformed', 'executor workspace manifest must be a bounded array');
    }
    workspaceManifest = json.workspaceManifest.map((m) => ({
      path: String((m && m.path) || '').slice(0, 300),
      size: Number.isFinite(m && m.size) ? m.size : null,
    })).filter((m) => m.path);
  }
  return {
    ok: !!json.ok,
    exitCode: Number.isFinite(json.exitCode) ? json.exitCode : null,
    stdout: String(json.stdout || '').slice(0, 512 * 1024),
    stderr: String(json.stderr || '').slice(0, 256 * 1024),
    timedOut: !!json.timedOut,
    durationMs: Number.isFinite(json.durationMs) ? json.durationMs : 0,
    isolated: !!json.isolated,
    executorVersion: json.executorVersion ? String(json.executorVersion).slice(0, 50) : null,
    artifacts,
    workspaceManifest,
  };
}

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

function sandboxUnavailableError(toolName) {
  return Object.assign(
    new Error(
      `isolated execution required for ${toolName} in production but no isolated executor is available `
      + '(set ISOLATED_EXECUTOR_URL to a reachable sandbox-worker). Failing closed.',
    ),
    { code: 'sandbox_unavailable', toolName, failClosed: true },
  );
}

function postJson(urlString, body, { timeoutMs = 35000, token = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlString); } catch { return reject(err('bad_params', 'invalid executor URL')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(err('bad_params', 'executor URL must be http(s)'));
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout: Math.min(timeoutMs, 120000),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > 1024 * 1024) {
          try { res.destroy(); } catch {}
          reject(err('executor_malformed', 'executor response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(err('executor_unavailable', `isolated executor HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(err('executor_malformed', 'executor returned invalid JSON'));
        }
      });
      res.on('error', (e) => reject(err('executor_unavailable', `executor stream failed: ${e.message}`)));
    });
    req.on('timeout', () => { req.destroy(new Error('executor request timed out')); });
    req.on('error', (e) => reject(err('executor_unavailable', `isolated executor unreachable: ${e.message}`)));
    req.end(payload);
  });
}

// Stable boundary call. Throws {code:'sandbox_unavailable'|'executor_unavailable'|
// 'executor_malformed'|'denied'|'bad_params'} — never returns fake success.
async function executeIsolated(request, options = {}) {
  const env = options.env || process.env;
  const base = (options.baseUrl !== undefined ? options.baseUrl : getIsolatedExecutorUrl(env) || '').replace(/\/+$/, '');
  if (!base) throw sandboxUnavailableError(request && request.toolName ? request.toolName : 'command');
  const body = {
    runId: String(request.runId || ''),
    tenantId: request.tenantId ? String(request.tenantId) : null,
    projectId: request.projectId ? String(request.projectId) : null,
    workspaceId: request.workspaceId ? String(request.workspaceId) : null,
    command: String(request.command || ''),
    args: Array.isArray(request.args) ? request.args.map(String) : [],
    cwd: request.cwd ? String(request.cwd) : '/',
    timeoutMs: Math.min(Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS, 180000),
    maxOutputBytes: Math.min(Number(request.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES, 512 * 1024),
    networkMode: request.networkMode || NetworkMode.DISABLED,
    networkAllowlist: Array.isArray(request.networkAllowlist) ? request.networkAllowlist.map(String).slice(0, 50) : [],
    // Disposable workspace snapshot (files materialized into the ephemeral
    // worker dir, destroyed after execution) + artifact collection allowlist.
    ...(request.workspace ? { workspace: workspacePayload(request.workspace) } : {}),
    ...(request.collect ? { collect: request.collect } : {}),
  };
  validateExecuteRequest(body);
  const token = (options.token !== undefined ? options.token : env.ISOLATED_EXECUTOR_TOKEN) || null;
  let json;
  try {
    json = await postJson(`${base}/v1/execute`, body, {
      timeoutMs: Math.min(body.timeoutMs + 5000, 120000),
      token,
    });
  } catch (e) {
    // Fail closed: an unreachable executor is a denial, not a fallback.
    if (e && (e.code === 'bad_params' || e.code === 'denied')) throw e;
    throw err('executor_unavailable', String((e && e.message) || e).slice(0, 300));
  }
  const parsed = validateExecuteResponse(json);
  if (!parsed.isolated) throw err('executor_malformed', 'executor did not attest isolation (isolated=true required)');
  return parsed;
}

// Secret-free audit record answering: what ran, under which policy, under
// which approval, whether isolated, network mode, duration, exit code.
function buildExecutionAudit({
  command, args, policy, approvalId, isolated, networkMode,
  networkAllowlist, durationMs, exitCode, timedOut, tenantId, projectId, runId,
} = {}) {
  const policyName = policy
    ? String(policy.autonomyMode || policy.approvalMode || 'default').slice(0, 80)
    : 'default';
  return Object.freeze({
    command: String(command || '').slice(0, 300),
    argCount: Array.isArray(args) ? args.length : 0,
    // Argument values are NOT logged (may contain customer code/paths);
    // only the count is auditable without leaking content.
    policy: policyName,
    approvalId: approvalId || null,
    isolated: !!isolated,
    executor: isolated ? 'isolated' : 'local-restricted',
    networkMode: networkMode || NetworkMode.DISABLED,
    networkAllowlisted: Array.isArray(networkAllowlist) ? networkAllowlist.length : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    timedOut: timedOut === true,
    timed_out: timedOut === true,
    tenantId: tenantId || null,
    projectId: projectId || null,
    runId: runId || null,
  });
}

module.exports = {
  EXECUTOR_VERSION_MIN,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  COLLECT_MAX_PATHS,
  COLLECT_MAX_TOTAL_BYTES,
  ISOLATION_REQUIRED_TOOLS,
  getIsolatedExecutorUrl,
  isProductionEnv,
  toolRequiresIsolation,
  isolationRequired,
  validateExecuteRequest,
  validateExecuteResponse,
  validateWorkspaceSnapshot,
  workspacePayload,
  assertWorkspaceRelPath,
  snapshotWorkspace,
  sandboxUnavailableError,
  executeIsolated,
  buildExecutionAudit,
};
