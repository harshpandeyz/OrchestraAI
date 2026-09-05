'use strict';

// Reference isolated executor for OrchestraAI customer tool/code execution.
//
// Stable boundary: POST /v1/execute
//   Request:  { runId, tenantId, projectId, workspaceId, command, args, cwd,
//               timeoutMs, maxOutputBytes, networkMode, networkAllowlist,
//               workspace?, collect? }
//     workspace: { files: [{ path, contentBase64 }] } — disposable snapshot
//       of the customer workspace, materialized into the ephemeral dir
//       before execution and destroyed afterwards. NEVER a host mount.
//     collect: [workspace-relative paths] — allowlisted result files whose
//       contents are returned as artifacts (bounded).
//   Response: { ok, exitCode, stdout, stderr, timedOut, durationMs, isolated,
//               executorVersion, artifacts?, workspaceManifest? }
//
// Security properties (reference implementation):
//   - Runs as non-root (refuses to start as uid 0 unless SANDBOX_ALLOW_ROOT=1
//     for CI; the Dockerfile creates and uses a dedicated user).
//   - Ephemeral workspace per request under SANDBOX_WORKSPACE_ROOT (a tmpfs-
//     friendly empty dir); destroyed after completion (success or failure).
//   - NEVER mounts the host project root or host home directory.
//   - Starts every child with an empty/sanitized environment (PATH default +
//     LANG only). NEVER receives provider secrets: requests carrying
//     secret-looking keys are refused; proxy/credential env is stripped.
//   - NEVER receives host filesystem paths outside its workspace: absolute
//     host paths (/etc, /root, ..) and traversal are refused; node targets
//     resolve inside the ephemeral workspace only.
//   - No network by default: children run without proxy vars; allowlisted
//     egress only (explicit networkMode=allowlist + host allowlist). Full
//     egress enforcement for hostile-DNS models needs platform firewall
//     rules — see DEPLOY NOTES below.
//   - Caps: stdout/stderr bytes, execution duration (SIGKILL on expiry).
//   - Restricts CPU/time/memory/processes where the platform permits via
//     EXEC_TIMEOUT_MS / MAX_OUTPUT_BYTES caps and documented container flags.
//
// DEPLOY NOTES (production): run this worker in its own container with:
//   docker run --user sandbox --network=<private-net> --cpus=1 --memory=512m
//     --pids-limit=64 --read-only --tmpfs /tmp:exec,size=256m
//     -e SANDBOX_WORKER_TOKEN=... sandbox-worker
// The worker binds SANDBOX_HOST (default 127.0.0.1 for single-host dev; set
// 0.0.0.0 INSIDE the container so peer containers on the private compose
// network can reach it — the container network namespace is the isolation
// boundary, never the public internet). For allowlisted egress, use a
// filtered bridge and firewall rules permitting only the allowlisted hosts.
// This reference enforces the allowlist at the request-validation layer;
// the platform firewall is the authoritative egress control.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXECUTOR_VERSION = '1.0.0';
const PORT = Number(process.env.SANDBOX_PORT || 8788);
// Bind host: 127.0.0.1 default (single-host/dev). Inside a container set
// SANDBOX_HOST=0.0.0.0 so peers on the PRIVATE container network can reach
// the worker; never publish this port to the public internet.
const HOST = String(process.env.SANDBOX_HOST || '127.0.0.1');
const WORKSPACE_ROOT = process.env.SANDBOX_WORKSPACE_ROOT || path.join(os.tmpdir(), 'sandbox-worker-ws');
// Body cap covers a maxed-out workspace snapshot (8 MiB files -> ~10.7 MiB
// base64 + JSON overhead). Snapshots themselves stay bounded by WS_* caps.
const MAX_BODY_BYTES = 12 * 1024 * 1024;
// Workspace snapshot caps (must stay in sync with the application-side
// validator in backend/src/execution/isolated-executor.js — the worker
// never trusts the caller and enforces them again locally).
const WS_MAX_FILES = 200;
const WS_MAX_FILE_BYTES = 1024 * 1024;
const WS_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const COLLECT_MAX_PATHS = 20;
const COLLECT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MANIFEST_MAX_ENTRIES = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 180000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const HARD_MAX_OUTPUT = 512 * 1024;

// Same command restriction as the application side (duplicated here so the
// worker never trusts the caller: validate locally even when the app already
// validated). Keep in sync with backend/src/execution/command-guard.js.
const SHELL_META_RE = /[;&|$`(){}<>*?!#~\n\r\0]/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BLOCKED_BINS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'cmd', 'cmd.exe',
  'curl', 'wget', 'nc', 'ncat', 'socat', 'ssh', 'scp', 'ftp', 'telnet',
  'ruby', 'perl', 'php', 'lua', 'env', 'export', 'source', 'eval', 'exec',
  'docker', 'podman', 'kubectl', 'sudo', 'su', 'chmod', 'chown', 'rm',
]);
const ALLOWED_BINS = new Set(['node', 'npm', 'pytest', 'python', 'python3', 'cargo', 'go', 'git']);
const REDIRECT_FLAG_RES = [
  /(^|\s)--prefix(\b|=|\s)/, /(^|\s)--workspace(\b|=|\s)/, /(^|\s)--node-options[= ]/,
  /(^|\s)--exec(\b|=|\s)/, /(^|\s)--rootdir[= ]/, /(^|\s)--cache(\b|=|\s)/,
  /(^|\s)--userconfig[= ]/, /(^|\s)--global(\b|=|\s)/,
];
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|bearer|authorization|private[_-]?key|client[_-]?secret|session|cookie|stripe)/i;
const VALID_NETWORK_MODES = new Set(['disabled', 'allowlist', 'enabled']);

function fail(res, status, code, message) {
  const body = JSON.stringify({ ok: false, code, error: String(message).slice(0, 500), isolated: true, executorVersion: EXECUTOR_VERSION });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function findSecretKeys(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  for (const k of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(k)) out.push(k);
    findSecretKeys(obj[k], depth + 1, out);
  }
  return [...new Set(out)];
}

function validateRequest(body) {
  if (!body || typeof body !== 'object') throw { status: 400, code: 'bad_params', message: 'body must be JSON' };
  if (!body.runId || typeof body.runId !== 'string') throw { status: 400, code: 'bad_params', message: 'runId is required' };
  if (!body.command || typeof body.command !== 'string') throw { status: 400, code: 'bad_params', message: 'command is required' };
  const secrets = findSecretKeys(body);
  if (secrets.length) {
    throw { status: 400, code: 'secret_refused', message: `request must never carry secrets (found: ${secrets.slice(0, 3).join(', ')})` };
  }
  const command = body.command;
  if (!ALLOWED_BINS.has(command) || BLOCKED_BINS.has(command)) {
    throw { status: 403, code: 'denied', message: `command not allowlisted: ${command.slice(0, 60)}` };
  }
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  if (args.length > 20) throw { status: 403, code: 'denied', message: 'too many arguments' };
  for (const a of args) {
    if (!a || a.length > 500) throw { status: 403, code: 'denied', message: 'bad argument length' };
    if (SHELL_META_RE.test(a)) throw { status: 403, code: 'denied', message: `argument not allowed: ${a.slice(0, 60)}` };
    if (ENV_ASSIGN_RE.test(a)) throw { status: 403, code: 'denied', message: 'environment assignments are not allowed' };
    if (a.includes('\0') || a.includes('\n') || a.includes('\r')) {
      throw { status: 403, code: 'denied', message: 'control characters are not allowed' };
    }
    const segs = a.split(/[\\/]/);
    if (segs.includes('..')) throw { status: 403, code: 'denied', message: 'path traversal is not allowed' };
    // Host filesystem paths outside the ephemeral workspace are never
    // accepted: absolute host paths and host-sensitive prefixes refused.
    if (path.isAbsolute(a) || a === '/etc/passwd' || a.startsWith('/etc/') || a.startsWith('/root') || a.startsWith('/home/')) {
      throw { status: 403, code: 'denied', message: 'host paths outside the worker workspace are refused' };
    }
  }
  if (/\$\(|`|\$\{/.test([command, ...args].join(' '))) {
    throw { status: 403, code: 'denied', message: 'command substitution is not allowed' };
  }
  const first = args[0] || '';
  if (command === 'node' && !first) throw { status: 400, code: 'bad_params', message: 'node requires a workspace-relative file' };
  if (command === 'node' && first.startsWith('-')) {
    throw { status: 403, code: 'denied', message: 'node flags are not allowed' };
  }
  if ((command === 'python' || command === 'python3') && (first === '-c' || first === '--command')) {
    throw { status: 403, code: 'denied', message: 'inline code execution is not allowed' };
  }
  if (REDIRECT_FLAG_RES.some((re) => re.test(` ${args.join(' ')}`))) {
    throw { status: 403, code: 'denied', message: 'workspace-redirecting flags are not allowed' };
  }
  const networkMode = body.networkMode || 'disabled';
  if (!VALID_NETWORK_MODES.has(networkMode)) {
    throw { status: 400, code: 'bad_params', message: `unknown networkMode: ${networkMode}` };
  }
  if (networkMode === 'enabled') {
    throw { status: 403, code: 'denied', message: 'networkMode=enabled is not supported by the reference worker (allowlist only)' };
  }
  const networkAllowlist = Array.isArray(body.networkAllowlist) ? body.networkAllowlist.map(String).slice(0, 50) : [];
  // Disposable workspace snapshot: validated file-by-file (relative paths
  // only, per-file + total caps). Materialized into the ephemeral dir.
  let workspaceFiles = [];
  if (body.workspace !== undefined && body.workspace !== null) {
    workspaceFiles = validateWorkspaceSnapshot(body.workspace);
  }
  // Artifact collection allowlist: which result files to return contents for.
  let collect = [];
  if (body.collect !== undefined && body.collect !== null) {
    if (!Array.isArray(body.collect) || body.collect.length > COLLECT_MAX_PATHS) {
      throw { status: 400, code: 'bad_params', message: `collect must be an array of at most ${COLLECT_MAX_PATHS} workspace-relative paths` };
    }
    collect = body.collect.map((p) => assertWorkspaceRelPath(p));
  }
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const maxOutputBytes = Math.min(Math.max(Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT, 1024), HARD_MAX_OUTPUT);
  return { command, args, networkMode, networkAllowlist, workspaceFiles, collect, timeoutMs, maxOutputBytes };
}

// Workspace-relative path inside the ephemeral dir: relative, no traversal,
// no absolute paths, bounded length. Shared by snapshot + collect paths.
function assertWorkspaceRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 500) {
    throw { status: 403, code: 'denied', message: 'bad workspace path length' };
  }
  if (p.includes('\0') || p.includes('\n') || p.includes('\r')) {
    throw { status: 403, code: 'denied', message: 'control characters are not allowed in workspace paths' };
  }
  const norm = String(p).replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)) {
    throw { status: 403, code: 'denied', message: 'workspace paths must be relative' };
  }
  if (norm.split('/').includes('..')) {
    throw { status: 403, code: 'denied', message: 'path traversal is not allowed in workspace paths' };
  }
  return norm;
}

function validateWorkspaceSnapshot(ws) {
  if (!ws || typeof ws !== 'object' || !Array.isArray(ws.files)) {
    throw { status: 400, code: 'bad_params', message: 'workspace must be { files: [...] }' };
  }
  if (ws.files.length > WS_MAX_FILES) {
    throw { status: 403, code: 'denied', message: `workspace snapshot exceeds ${WS_MAX_FILES} files` };
  }
  let total = 0;
  const out = [];
  for (const f of ws.files) {
    if (!f || typeof f !== 'object') throw { status: 400, code: 'bad_params', message: 'workspace file must be an object' };
    const rel = assertWorkspaceRelPath(f.path);
    const b64 = String(f.contentBase64 || '');
    if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw { status: 400, code: 'bad_params', message: 'workspace file content must be base64' };
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > WS_MAX_FILE_BYTES) throw { status: 403, code: 'denied', message: `workspace file too large: ${rel.slice(0, 80)}` };
    total += buf.length;
    if (total > WS_MAX_TOTAL_BYTES) throw { status: 403, code: 'denied', message: 'workspace snapshot exceeds total byte cap' };
    out.push({ path: rel, content: buf });
  }
  return out;
}

// Empty/sanitized environment for every child: no inherited secrets, no
// proxy/credential vars. Allowlisted egress (when enabled at the platform
// layer) is granted per-request, never by ambient environment.
function childEnv(networkMode) {
  const env = {
    // Deployment-configured tool PATH (image default), never inherited from
    // the caller's environment.
    PATH: String(process.env.SANDBOX_PATH || '/usr/local/bin:/usr/bin:/bin').slice(0, 2000),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    SANDBOX_ISOLATED: '1',
  };
  if (networkMode !== 'disabled') env.SANDBOX_NETWORK = networkMode;
  return env;
}

function capBytes(str, n) {
  const buf = Buffer.from(String(str || ''), 'utf8');
  if (buf.length <= n) return { text: buf.toString('utf8'), truncated: false };
  return { text: buf.slice(-n).toString('utf8'), truncated: true };
}

async function executeInEphemeralWorkspace({ command, args, timeoutMs, maxOutputBytes, workspaceFiles = [], collect = [] }) {
  await fs.promises.mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
  const dir = await fs.promises.mkdtemp(path.join(WORKSPACE_ROOT, 'run-'));
  const t0 = Date.now();
  try {
    // Materialize the disposable workspace snapshot (validated relative
    // paths only — writes can never escape the ephemeral dir).
    for (const f of workspaceFiles) {
      const dest = path.join(dir, f.path);
      const resolved = path.resolve(dest);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        throw Object.assign(new Error('workspace path escapes ephemeral dir'), { code: 'denied' });
      }
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(resolved, f.content, { mode: 0o600 });
    }
    const result = await new Promise((resolve) => {
      const child = execFile(command, args, {
        cwd: dir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: childEnv('disabled'),
      }, (error, stdout, stderr) => {
        const durationMs = Date.now() - t0;
        const out = capBytes(stdout, maxOutputBytes);
        const errOut = capBytes(stderr, Math.floor(maxOutputBytes / 2));
        if (error) {
          const timedOut = !!(error.killed && (error.signal === 'SIGTERM' || /timed out/i.test(error.message)));
          resolve({
            ok: false,
            // Spawn failures surface string codes (ENOENT); the contract is
            // numeric exitCode or null on timeout.
            exitCode: timedOut ? null : (Number.isFinite(error.code) ? error.code : 1),
            stdout: out.text, stderr: errOut.text,
            timedOut: timedOut === true, durationMs,
          });
          return;
        }
        resolve({ ok: true, exitCode: 0, stdout: out.text, stderr: errOut.text, timedOut: false, durationMs });
      });
      // Hard kill on expiry is enforced by execFile timeout (SIGTERM); ensure
      // no orphan survives by escalating to SIGKILL shortly after.
      child.on('exit', () => {});
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 2000).unref?.();
    });
    // Collect allowlisted result files + manifest BEFORE destroying the dir.
    const artifacts = await collectArtifacts(dir, collect);
    const workspaceManifest = await manifestWorkspace(dir);
    return { ...result, artifacts, workspaceManifest };
  } finally {
    // Destroy the ephemeral workspace after completion — always.
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

// Read allowlisted result files out of the ephemeral dir (bounded total).
// Paths were validated at request time and are re-confined here.
async function collectArtifacts(dir, collect) {
  const out = [];
  let total = 0;
  for (const rel of collect || []) {
    const resolved = path.resolve(path.join(dir, rel));
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) continue;
    let st;
    try {
      st = await fs.promises.lstat(resolved);
    } catch {
      continue; // missing after execution is not an error
    }
    if (!st.isFile() || st.size > WS_MAX_FILE_BYTES) continue;
    let buf;
    try {
      buf = await fs.promises.readFile(resolved);
    } catch {
      continue;
    }
    if (buf.length > WS_MAX_FILE_BYTES) continue;
    if (total + buf.length > COLLECT_MAX_TOTAL_BYTES) break;
    total += buf.length;
    out.push({ path: rel, size: buf.length, contentBase64: buf.toString('base64') });
  }
  return out;
}

// Manifest of files created in the ephemeral dir (names + sizes only, no
// contents). Bounded entries; symlinks listed but never followed.
async function manifestWorkspace(dir) {
  const out = [];
  async function walk(current, rel) {
    if (out.length >= MANIFEST_MAX_ENTRIES) return;
    let names;
    try {
      names = await fs.promises.readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MANIFEST_MAX_ENTRIES) return;
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await fs.promises.lstat(path.join(current, name));
      } catch {
        continue;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        await walk(path.join(current, name), relPath);
      } else {
        out.push({ path: relPath, size: st.isFile() ? st.size : null });
      }
    }
  }
  await walk(dir, '');
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413, code: 'oversized' }));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, isolated: true, executorVersion: EXECUTOR_VERSION }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/execute') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'not_found', isolated: true, executorVersion: EXECUTOR_VERSION }));
      return;
    }
    const expected = process.env.SANDBOX_WORKER_TOKEN || null;
    if (expected) {
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== expected) return fail(res, 401, 'unauthorized', 'invalid worker token');
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e && e.status) return fail(res, e.status, e.code || 'bad_params', e.message);
      return fail(res, 400, 'bad_params', 'invalid JSON body');
    }
    let validated;
    try {
      validated = validateRequest(body);
    } catch (e) {
      return fail(res, (e && e.status) || 403, (e && e.code) || 'denied', (e && e.message) || 'denied');
    }
    const r = await executeInEphemeralWorkspace(validated);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      isolated: true,
      executorVersion: EXECUTOR_VERSION,
      artifacts: r.artifacts || [],
      workspaceManifest: r.workspaceManifest || [],
    }));
  } catch (e) {
    try { fail(res, 500, 'executor_failure', (e && e.message) || 'internal error'); } catch {}
  }
});

if (require.main === module) {
  // Non-root enforcement: refuse to serve as uid 0 unless explicitly allowed
  // (CI only). Production deployments use the Dockerfile's sandbox user.
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0 && process.env.SANDBOX_ALLOW_ROOT !== '1') {
      console.error('sandbox-worker refuses to run as root (set SANDBOX_ALLOW_ROOT=1 only for local CI).');
      process.exit(1);
    }
  } catch {}
  server.listen(PORT, HOST, () => {
    console.log(`sandbox-worker v${EXECUTOR_VERSION} listening on ${HOST}:${PORT} (isolated=true)`);
  });
}

module.exports = { server, validateRequest, assertWorkspaceRelPath, validateWorkspaceSnapshot, collectArtifacts, manifestWorkspace, childEnv, executeInEphemeralWorkspace, EXECUTOR_VERSION };
