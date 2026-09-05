'use strict';

// Real tool execution (Session 3 hardened).
//
// One execution path — no mock results, no random failures. Every call goes
// through: registry lookup -> status check -> policy gate -> approval gate ->
// parameter validation -> timeout race -> real handler -> latency/cost
// measurement -> run-state recording.
//
// Safety:
//   - `read_file` / `search_code` are sandboxed to WORKSPACE_ROOT (or cwd):
//     workspace-root enforcement, path normalization, traversal prevention,
//     symlink-escape rejection, max file size, binary detection, encoding
//     handling. /etc/passwd, ../../secrets, ~/.ssh/id_rsa are unreachable
//     through path tricks.
//   - `search_code` is bounded (results, matches, bytes) and returns
//     structured SearchResults {file,line,column,match,context}.
//   - `run_tests` / `build_project` execute ONLY allowlisted development
//     commands via execFile (no shell, no model-supplied argv). Returns
//     {command,cwd,exitCode,duration,stdout,stderr,timedOut,truncated}.
//   - `apply_patch` supports dry-run, requires ALLOW_FILE_WRITES, applies
//     atomically (tmp+rename) with hash verification.
//   - Arbitrary shell execution is NOT exposed as a tool.
//   - Git tools: read-only (status/diff/log/branch) need no approval;
//     mutating git requires approval; push/reset/clean stay policy-denied
//     by default.
//   - Network tools validate URLs, block localhost/private/metadata targets,
//     enforce protocol/size/time limits, re-guard redirects.
//
// Reliability:
//   - idempotencyKey (default: derived from run/step/tool/params hash) — a
//     completed key returns the stored result instead of re-executing, so a
//     retry never duplicates an irreversible operation.
//   - AbortSignal support — cancellation returns code 'cancelled' and kills
//     child processes.
//   - Normalized outcomes: success | failure | timed_out | cancelled |
//     disabled | denied | needs_approval | unknown. Timeouts produce
//     status TIMED_OUT, never a hang.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ToolExecutor } = require('../interfaces');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');
const { createExecutionResult, truncateOutput, validateInput } = require('../execution/tool-system');
const { sandboxPath, isBinaryBuffer, resolveWorkspaceRoot, sha256 } = require('../execution/changesets');
const { validateCommandArgs } = require('../execution/environment');

function hashParams(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 12);
}

function resolveWorkspace() {
  return resolveWorkspaceRoot();
}

const MAX_READ_BYTES = 100000;
const MAX_FILE_STAT_BYTES = 500000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.runtime-data', '.runtime-data-test', '.runtime-data-finalization-test', 'coverage', '.next', 'vendor', 'target']);

async function handleReadFile(params, ctx) {
  const rel = String(params.path || '');
  const abs = await sandboxPath(ctx.workspace, rel);
  let stat = null;
  try { stat = await fs.promises.stat(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) throw Object.assign(new Error(`File not found: ${params.path}`), { code: 'not_found' });
  if (stat.size > MAX_FILE_STAT_BYTES) {
    throw Object.assign(new Error(`File too large (${stat.size} bytes, max ${MAX_FILE_STAT_BYTES}): ${params.path}`), { code: 'too_large' });
  }
  const buf = await fs.promises.readFile(abs).catch(() => null);
  if (buf === null) throw Object.assign(new Error(`Cannot read file: ${params.path}`), { code: 'unreadable' });
  if (isBinaryBuffer(buf)) {
    throw Object.assign(new Error(`Binary file not readable as text: ${params.path}`), { code: 'binary' });
  }
  let content;
  try {
    content = buf.toString('utf8');
    if (content.includes('�') && /[\x80-\xFF]/.test(buf.slice(0, 1000).toString('binary'))) {
      // Likely non-UTF8 encoding: still serve, but flag it.
    }
  } catch {
    throw Object.assign(new Error(`Cannot decode file as text: ${params.path}`), { code: 'unreadable' });
  }
  const maxBytes = Math.min(Number(params.maxBytes) || 20000, MAX_READ_BYTES);
  const lines = content.split('\n');
  const start = Math.max(1, Number(params.startLine) || 1);
  const end = Math.min(lines.length, Number(params.endLine) || lines.length);
  const slice = lines.slice(start - 1, end).join('\n').slice(0, maxBytes);
  const { outputTruncated } = truncateOutput(slice, { maxOutputBytes: maxBytes });
  return {
    path: params.path, startLine: start, endLine: end, totalLines: lines.length,
    content: slice, truncated: slice.length < content.length || outputTruncated,
    sha256: sha256(content),
  };
}

async function handleSearchCode(params, ctx) {
  const query = String(params.query || '').slice(0, 200);
  if (!query) throw Object.assign(new Error('query is required'), { code: 'bad_params' });
  const t0 = Date.now();
  const maxResults = Math.min(Math.max(Number(params.maxResults) || 20, 1), 50);
  const maxBytes = Math.min(Number(params.maxBytes) || 24000, 64000);
  // Extension filtering: safe allowlist-based matcher, never raw RegExp from
  // the model (avoids ReDoS). `include` accepts csv extensions or a plain
  // substring; anything else falls back to the default set.
  const DEFAULT_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.py', '.go', '.rs', '.java', '.rb', '.c', '.h', '.css', '.html', '.yml', '.yaml', '.toml']);
  let exts = null;
  if (params.include) {
    const raw = String(params.include).slice(0, 200).toLowerCase();
    const found = raw.split(/[,;\s|]+/).map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.startsWith('.') ? s : `.${s}`))
      .filter((s) => /^[.a-z0-9]{1,12}$/.test(s));
    if (found.length) exts = new Set(found.slice(0, 20));
  }
  const fileFilter = typeof params.fileFilter === 'string' ? params.fileFilter.slice(0, 120).toLowerCase() : null;
  const extraIgnores = new Set(Array.isArray(params.excludeDir) ? params.excludeDir.map(String).slice(0, 20) : []);
  const results = [];
  const ql = query.toLowerCase();
  let bytesAcc = 0;
  let filesScanned = 0;

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > 8) return;
    if (Date.now() - t0 > Math.min(ctx.timeLeftMs - 500, 12000)) return; // leave headroom for the timeout race
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.name !== '.env.example' && e.name.startsWith('.')) continue;
      if (IGNORED_DIRS.has(e.name) || extraIgnores.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); }
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts ? !exts.has(ext) : !DEFAULT_EXTS.has(ext)) continue;
        const rel = path.relative(ctx.workspace, abs);
        if (fileFilter && !rel.toLowerCase().includes(fileFilter)) continue;
        let content;
        try {
          const stat = await fs.promises.stat(abs);
          if (!stat.isFile() || stat.size > MAX_FILE_STAT_BYTES) continue;
          const buf = await fs.promises.readFile(abs);
          if (isBinaryBuffer(buf)) continue; // binary exclusion
          content = buf.toString('utf8');
        } catch { continue; }
        filesScanned++;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          const line = lines[i];
          if (line.length > 2000) continue; // skip minified/huge lines
          const idx = line.toLowerCase().indexOf(ql);
          if (idx >= 0) {
            const match = line.slice(Math.max(0, idx - 60), idx + query.length + 60).slice(0, 240);
            const before = i > 0 ? lines[i - 1].slice(0, 160) : null;
            const after = i + 1 < lines.length ? lines[i + 1].slice(0, 160) : null;
            const entry = {
              file: rel, line: i + 1, column: idx + 1,
              match, context: (before || after) ? { before, after } : undefined,
              // legacy alias (kept for existing consumers)
              text: line.slice(0, 240),
            };
            const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
            if (bytesAcc + size > maxBytes) return;
            bytesAcc += size;
            results.push(entry);
          }
        }
      }
    }
  }

  await walk(ctx.workspace, 0);
  return { query, matches: results.length, filesScanned, results, truncated: results.length >= maxResults };
}

function describeTestCommand(workspace) {
  // Strict allowlist. Preference order:
  //   1. TOOL_RUN_TESTS_CMD env (must still be allowlisted: `node <ws-file>`)
  //   2. TOOL_TEST_COMMAND env (npm test / pytest / cargo test / go test / node file)
  //   3. sensible default (backend unit test file).
  // An explicitly configured but non-allowlisted command fails loudly rather
  // than silently falling back to a different command.
  const explicit = [process.env.TOOL_RUN_TESTS_CMD, process.env.TOOL_TEST_COMMAND].filter(Boolean);
  for (const raw of explicit) {
    const parsed = tryParseAllowlisted(String(raw).trim(), workspace);
    if (!parsed) {
      throw Object.assign(new Error(`configured test command not allowlisted: ${String(raw).slice(0, 120)}`), { code: 'denied' });
    }
    return parsed;
  }
  const parsed = tryParseAllowlisted('node backend/test/runtime.test.js', workspace || process.cwd());
  if (parsed) return parsed;
  throw Object.assign(new Error('no allowlisted test command available'), { code: 'disabled' });
}

function tryParseAllowlisted(raw, workspace) {
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [bin, ...rest] = parts;
  const ws = resolveWorkspaceRoot(workspace || process.cwd());
  // Shared argument hardening (no shell metachars, no env assignments, no
  // path escape, no interpreter -c/-e flags, no workspace-redirecting
  // flags). Rejections return null -> describeTestCommand fails loudly.
  try {
    validateCommandArgs(bin === 'python' && rest[0] === '-m' ? 'python' : bin, rest, ws);
  } catch { return null; }
  if (bin === 'node' && rest[0]) {
    try {
      const rel = String(rest[0]).replace(/^\/+/, '');
      const abs = path.resolve(ws, rel);
      if (abs !== ws && !abs.startsWith(ws + path.sep)) return null;
      return { cmd: 'node', args: [abs, ...rest.slice(1)], label: raw };
    } catch { return null; }
  }
  if (bin === 'npm' && (rest.join(' ') === 'test' || /^run\s+(test|build|lint)$/.test(rest.join(' ')))) {
    return { cmd: 'npm', args: rest, label: raw };
  }
  if (bin === 'pytest' || (bin === 'python' && rest[0] === '-m' && rest[1] === 'pytest')) {
    return bin === 'pytest' ? { cmd: 'pytest', args: rest, label: raw } : { cmd: 'python', args: rest, label: raw };
  }
  if (bin === 'cargo' && rest[0] === 'test') return { cmd: 'cargo', args: rest, label: raw };
  if (bin === 'go' && rest[0] === 'test') return { cmd: 'go', args: rest, label: raw };
  return null;
}

function handleRunTests(params, ctx) {
  return new Promise((resolve, reject) => {
    let spec;
    // Resolve the allowlisted command against the RUN's workspace (not
    // process.cwd()): a tmp workspace containing slow.js must resolve there,
    // otherwise the runner fails with test_failure instead of timing out.
    try { spec = describeTestCommand(ctx && ctx.workspace); }
    catch (e) { return reject(e); }
    const t0 = Date.now();
    const child = execFile(spec.cmd, spec.args, {
      cwd: ctx.workspace, timeout: ctx.timeLeftMs, maxBuffer: 512 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      const duration = Date.now() - t0;
      const cap = (s, n) => {
        const str = String(s || '');
        const truncated = Buffer.byteLength(str, 'utf8') > n;
        return { text: truncated ? Buffer.from(str, 'utf8').slice(-n).toString('utf8') : str, truncated };
      };
      const out = cap(stdout, 4000);
      const err = cap(stderr, 2000);
      const truncated = out.truncated || err.truncated;
      if (error) {
        const timeout = error.killed && error.signal === 'SIGTERM';
        if (timeout) {
          const e = new Error('Test command timed out');
          e.code = 'timeout';
          e.details = { command: spec.label, cwd: ctx.workspace, exitCode: null, durationMs: duration, stdout: out.text, stderr: err.text, timedOut: true, truncated };
          return reject(e);
        }
        const e = new Error(`Tests failed (exit ${error.code ?? '?'}): ${(out.text + err.text).slice(-500)}`);
        e.code = 'test_failure';
        // Structured failure carries the full contract so VERIFY can inspect.
        e.details = { command: spec.label, cwd: ctx.workspace, exitCode: error.code ?? 1, durationMs: duration, stdout: out.text, stderr: err.text, timedOut: false, truncated, passed: false };
        return reject(e);
      }
      resolve({
        suite: params.suite || 'default',
        passed: true,
        command: spec.label, cwd: ctx.workspace, exitCode: 0,
        durationMs: duration, stdout: out.text, stderr: err.text,
        timedOut: false, truncated,
      });
    });
    if (ctx.signal) {
      if (ctx.signal.aborted) { try { child.kill('SIGKILL'); } catch {} }
      else ctx.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }
  });
}

async function handleApplyPatch(params, ctx) {
  if (params.dryRun) {
    // Dry-run: validate everything, return the proposed diff, change nothing.
    const abs = await sandboxPath(ctx.workspace, params.path);
    const edits = Array.isArray(params.edits) ? params.edits : null;
    if (!edits || !edits.length) throw Object.assign(new Error('edits[] is required'), { code: 'bad_params' });
    const content = await fs.promises.readFile(abs, 'utf8').catch(() => null);
    if (content === null) throw Object.assign(new Error(`File not found: ${params.path}`), { code: 'not_found' });
    if (content.length > MAX_FILE_STAT_BYTES) throw Object.assign(new Error('File too large'), { code: 'too_large' });
    let additions = 0; let deletions = 0;
    for (const ed of edits.slice(0, 20)) {
      if (typeof ed.oldText !== 'string' || typeof ed.newText !== 'string' || !ed.oldText) {
        throw Object.assign(new Error('Each edit needs oldText/newText strings'), { code: 'bad_params' });
      }
      if (!content.includes(ed.oldText)) {
        throw Object.assign(new Error(`Patch context not found in ${params.path}; no changes applied`), { code: 'patch_conflict' });
      }
      const o = ed.oldText.split('\n').length; const n = ed.newText.split('\n').length;
      if (n >= o) additions += n - o; else deletions += o - n;
    }
    return {
      path: params.path, editsProposed: edits.length, additions, deletions,
      dryRun: true, applied: false,
      message: `Patch proposed: ${params.path} (+${additions}/-${deletions}). No changes applied.`,
    };
  }
  if (!/^(1|true|yes)$/i.test(process.env.ALLOW_FILE_WRITES || '')) {
    throw Object.assign(new Error('apply_patch is disabled (set ALLOW_FILE_WRITES=true to enable)'), { code: 'disabled' });
  }
  const abs = await sandboxPath(ctx.workspace, params.path);
  const edits = Array.isArray(params.edits) ? params.edits : null;
  if (!edits || !edits.length) throw Object.assign(new Error('edits[] is required'), { code: 'bad_params' });
  let content = await fs.promises.readFile(abs, 'utf8').catch(() => null);
  if (content === null) throw Object.assign(new Error(`File not found: ${params.path}`), { code: 'not_found' });
  if (content.length > MAX_FILE_STAT_BYTES) throw Object.assign(new Error('File too large'), { code: 'too_large' });
  if (isBinaryBuffer(Buffer.from(content.slice(0, 8000)))) {
    throw Object.assign(new Error('refusing to patch binary file'), { code: 'denied' });
  }
  const beforeHash = sha256(content);
  for (const ed of edits.slice(0, 20)) {
    if (typeof ed.oldText !== 'string' || typeof ed.newText !== 'string' || !ed.oldText) {
      throw Object.assign(new Error('Each edit needs oldText/newText strings'), { code: 'bad_params' });
    }
    if (!content.includes(ed.oldText)) {
      throw Object.assign(new Error(`Patch context not found in ${params.path}; no changes applied`), { code: 'patch_conflict' });
    }
    content = content.replace(ed.oldText, ed.newText);
  }
  // Atomic apply: tmp file + rename, then hash-verify.
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, abs);
  const verify = await fs.promises.readFile(abs, 'utf8');
  const afterHash = sha256(verify);
  if (afterHash !== sha256(content)) {
    throw Object.assign(new Error('hash verification failed after patch'), { code: 'apply_failed' });
  }
  // Session-1 aliases (originalHash/resultingHash/atomic) preserved alongside
  // the Session-3 names (beforeHash/afterHash/applied): one result, no
  // competing contracts.
  return {
    path: params.path, editsApplied: edits.length,
    beforeHash, afterHash, applied: true,
    originalHash: beforeHash, resultingHash: afterHash, atomic: true,
  };
}

// Git read tools delegate to the execution/git layer (same sandbox + caps).
async function handleGitRead(kind, params, ctx) {
  const { gitStatus, gitDiff, gitLog, gitBranches } = require('../execution/changesets');
  const ws = ctx.workspace;
  if (kind === 'git_status') return gitStatus(ws);
  if (kind === 'git_diff') {
    return gitDiff(ws, { staged: !!params.staged, path: params.path || null, maxBytes: Math.min(Number(params.maxBytes) || 32000, 64000) });
  }
  if (kind === 'git_log') return { commits: await gitLog(ws, params.limit || 10) };
  if (kind === 'git_branch') return { branches: await gitBranches(ws) };
  throw Object.assign(new Error(`unknown git tool: ${kind}`), { code: 'not_found' });
}

async function handleEnvInspect(params, ctx) {
  const { environmentProfile } = require('../execution/environment');
  return environmentProfile(ctx.workspace);
}

async function handleBuildProject(params, ctx) {
  // Build runs the detected/project build command (still allowlisted).
  const { detectProject, runAllowlisted } = require('../execution/environment');
  const { isCommandAllowed } = require('../execution/execution-policy');
  const project = await detectProject(ctx.workspace).catch(() => null);
  const raw = (project && project.buildCommand) || process.env.TOOL_BUILD_COMMAND || 'npm run build';
  const parts = String(raw).split(/\s+/).filter(Boolean);
  const gate = isCommandAllowed(null, parts);
  if (!gate.allowed) throw Object.assign(new Error(`build command not allowed: ${gate.reason}`), { code: 'denied' });
  const t0 = Date.now();
  try {
    const r = await runAllowlisted(parts, { cwd: ctx.workspace, timeoutMs: Math.min(ctx.timeLeftMs, 120000), signal: ctx.signal });
    r.durationMs = Date.now() - t0;
    return { ...r, passed: true };
  } catch (e) {
    if (e && e.details) {
      e.details.durationMs = Date.now() - t0;
      const err = new Error(`Build failed: ${(e.details.stdout + e.details.stderr).slice(-500)}`);
      err.code = e.code;
      err.details = { ...e.details, passed: false };
      throw err;
    }
    throw e;
  }
}

async function handleFetchUrl(params, ctx) {
  const { fetchUrlGuarded } = require('../execution/environment');
  const url = String(params.url || '');
  if (!url) throw Object.assign(new Error('url is required'), { code: 'bad_params' });
  const r = await fetchUrlGuarded(url, {
    policy: ctx.policy || { networkAccess: 'disabled' },
    timeoutMs: Math.min(ctx.timeLeftMs, 20000),
    maxBytes: Math.min(Number(params.maxBytes) || 65536, 262144),
  });
  return { url: r.url, status: r.status, body: r.body.slice(0, 8000), truncated: r.truncated || r.body.length > 8000, bytes: r.bytes };
}

const HANDLERS = {
  read_file: handleReadFile,
  search_code: handleSearchCode,
  run_tests: handleRunTests,
  apply_patch: handleApplyPatch,
  git_status: (p, c) => handleGitRead('git_status', p, c),
  git_diff: (p, c) => handleGitRead('git_diff', p, c),
  git_log: (p, c) => handleGitRead('git_log', p, c),
  git_branch: (p, c) => handleGitRead('git_branch', p, c),
  env_inspect: handleEnvInspect,
  build_project: handleBuildProject,
  fetch_url: handleFetchUrl,
};

class InMemoryToolExecutor extends ToolExecutor {
  constructor(toolRegistry, eventBus = null, options = {}) {
    super();
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.executionHistory = [];
    // idempotencyKey -> completed result (per process; keyed by run in keygen)
    this.completedKeys = new Map();
    // executionId -> record (for crash-recovery UNKNOWN analysis)
    this.inFlight = new Map();
    this.workspace = options.workspace || resolveWorkspace();
    this.policy = options.policy || null;
    this.approvals = options.approvals || null; // ApprovalStore (optional)
    // Durable idempotency foundation (Session 1 IdempotencyStore). When
    // present, COMPLETED records survive restarts — the in-memory
    // completedKeys map is only the fast path, never a competing source.
    this.idempotencyStore = options.idempotencyStore || null;
    this.gate = options.gate || null; // async ({toolName, params, definition, risk}) -> {allowed} | {needsApproval, approvalId?}
    this.config = {
      timeoutMs: options.timeoutMs || 30000,
      maxParallel: options.maxParallel || 3,
      ...options
    };
  }

  idempotencyKeyFor(runId, toolName, params, step) {
    return `${runId}:${toolName}:${step}:${hashParams(params)}`;
  }

  async execute(toolName, params, runtimeState, options = {}) {
    const runId = runtimeState.runId;
    const tool = await this.toolRegistry.getTool(toolName);

    if (!tool) {
      return this._createResult(toolName, false, null, `Tool ${toolName} not found`, 0, { code: 'not_found', status: 'failure' });
    }
    if (tool.status !== 'enabled') {
      return this._createResult(toolName, false, null, `Tool ${toolName} is disabled`, 0, { code: 'disabled', status: 'failure' });
    }

    const validation = await this.validateParams(toolName, params || {});
    if (!validation.valid) {
      return this._createResult(toolName, false, null, validation.error, 0, { code: 'bad_params', status: 'failure' });
    }

    // Policy + approval gate (Session 3). The optional gate hook lets the
    // orchestrator enforce ExecutionPolicy + ApprovalStore without this
    // executor owning policy state.
    if (this.gate) {
      try {
        const g = await this.gate({ toolName, params: params || {}, definition: tool, runtimeState, options });
        if (g && g.allowed === false) {
          const code = g.needsApproval ? 'needs_approval' : (g.code || 'denied');
          return this._createResult(toolName, false, null, g.reason || 'denied by policy', 0, {
            code, status: g.needsApproval ? 'needs_approval' : 'failure', approvalId: g.approvalId || null,
          });
        }
        if (g && g.approvalId) options = { ...options, approvalId: g.approvalId };
      } catch (e) {
        return this._createResult(toolName, false, null, String((e && e.message) || e), 0, { code: 'denied', status: 'failure' });
      }
    }

    const idempotencyKey = options.idempotencyKey || this.idempotencyKeyFor(runId, toolName, params, runtimeState.execution.currentStep);
    if (this.completedKeys.has(idempotencyKey)) {
      const cached = this.completedKeys.get(idempotencyKey);
      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_COMPLETED, {
          executionId: cached.executionId, tool: toolName, status: 'success',
          durationMs: 0, cost: 0, deduped: true, idempotencyKey,
        });
      }
      return { ...cached, deduped: true };
    }
    // Durable idempotency (Session 1 store): a COMPLETED record from a
    // previous process must NOT re-execute. The stored result is the
    // response (deduped), mirrored into the in-memory fast path.
    if (this.idempotencyStore && typeof this.idempotencyStore.get === 'function') {
      try {
        const rec = this.idempotencyStore.get(idempotencyKey);
        if (rec && rec.state === 'completed' && rec.result && typeof rec.result === 'object') {
          const stored = { ...rec.result, deduped: true, idempotencyKey };
          this.completedKeys.set(idempotencyKey, stored);
          if (this.completedKeys.size > 500) {
            const first = this.completedKeys.keys().next().value;
            this.completedKeys.delete(first);
          }
          if (this.eventBus) {
            this.eventBus.emit(runId, EventType.TOOL_COMPLETED, {
              executionId: stored.executionId || 'durable', tool: toolName, status: 'success',
              durationMs: 0, cost: 0, deduped: true, idempotencyKey,
            });
          }
          return stored;
        }
      } catch { /* durable check is advisory; fall through to execute */ }
    }

    if (options.signal && options.signal.aborted) {
      return this._createResult(toolName, false, null, 'Tool execution cancelled', 0, { code: 'cancelled', status: 'cancelled' });
    }

    const handler = HANDLERS[toolName];
    if (!handler) {
      return this._createResult(toolName, false, null, `No handler registered for tool ${toolName}`, 0, { code: 'not_found', status: 'failure' });
    }

    const executionId = generateId('exec');
    const startedAt = now();
    const startTime = Date.now();
    const timeoutMs = Math.min(options.timeoutMs || tool.timeoutMs || this.config.timeoutMs, this.config.timeoutMs * 4);

    this.inFlight.set(executionId, { executionId, toolName, runId, startedAt, idempotencyKey, state: 'in_flight' });

    if (this.eventBus) {
      this.eventBus.emit(runId, EventType.TOOL_STARTED, {
        executionId, tool: toolName, params: this._sanitizeParams(params), idempotencyKey,
      });
    }

    const ctx = {
      workspace: options.workspace || (this.policy && this.policy.workspaceRoot) || this.workspace,
      signal: options.signal || null,
      timeLeftMs: timeoutMs,
      runId,
      policy: (this.policy && this.policy.policy) || this.policy || null,
    };

    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const e = new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`);
        e.code = 'timeout';
        // Canonical timeout details so the result contract carries
        // timedOut=true even when the executor-level race (not the handler)
        // wins. Never reported as test_failure.
        e.details = { tool: toolName, timedOut: true, timeoutMs, timedOutBy: 'executor-race' };
        reject(e);
      }, timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();
    });
    const abortPromise = options.signal ? new Promise((_, reject) => {
      if (options.signal.aborted) {
        const e = new Error('Tool execution cancelled');
        e.code = 'cancelled';
        reject(e);
      } else {
        options.signal.addEventListener('abort', () => {
          const e = new Error('Tool execution cancelled');
          e.code = 'cancelled';
          reject(e);
        }, { once: true });
      }
    }) : null;

    try {
      const raw = await Promise.race([
        handler(params || {}, ctx),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      clearTimeout(timeoutTimer);
      this.inFlight.delete(executionId);
      const latencyMs = Date.now() - startTime;
      const cost = tool.costPerCall || 0.001;
      // Tool result validation: a tool's self-reported success never
      // overrides actual execution evidence (exit codes, error codes).
      const validated = validateToolOutput(toolName, raw);
      const executionResult = this._createResult(toolName, validated.success, validated.output, validated.error, latencyMs, cost, {
        executionId, idempotencyKey, startedAt, approvalId: options.approvalId || null,
      });

      this.completedKeys.set(idempotencyKey, executionResult);
      if (this.completedKeys.size > 500) {
        const first = this.completedKeys.keys().next().value;
        this.completedKeys.delete(first);
      }
      // Mirror success into the durable store so restarts reuse it.
      if (this.idempotencyStore && typeof this.idempotencyStore.complete === 'function') {
        try { this.idempotencyStore.complete(idempotencyKey, executionResult); } catch {}
      }

      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_COMPLETED, {
          executionId, tool: toolName, status: 'success', durationMs: latencyMs, cost,
          result: this._sanitizeResult(validated.output), idempotencyKey,
        });
      }

      this.executionHistory.push({ ...executionResult, executionId, timestamp: now() });
      if (this.executionHistory.length > 100) this.executionHistory.shift();

      runtimeState.tools.recordCall(toolName, { success: true, latencyMs, cost, result: validated.output, status: executionResult.status, code: executionResult.code });
      runtimeState.budget.addCost('tool_execution', cost, { tool: toolName });

      return executionResult;
    } catch (error) {
      clearTimeout(timeoutTimer);
      this.inFlight.delete(executionId);
      const latencyMs = Date.now() - startTime;
      const code = (error && error.code) || (String(error && error.message || '').includes('timed out') ? 'timeout' : 'failure');
      const status = code === 'timeout' ? 'timed_out' : code === 'cancelled' ? 'cancelled' : 'failure';
      // Structured error details (command failures) become the output so
      // VERIFY steps can inspect exit codes instead of parsing strings.
      const errOutput = error && error.details ? error.details : null;
      const executionResult = this._createResult(toolName, false, errOutput, String((error && error.message) || error), latencyMs, 0, {
        executionId, idempotencyKey, startedAt, code, status, approvalId: options.approvalId || null,
      });

      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_FAILED, {
          executionId, tool: toolName, status: code === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'timed_out' : 'failed',
          durationMs: latencyMs, error: String((error && error.message) || error), code, idempotencyKey,
        });
      }

      this.executionHistory.push({ ...executionResult, executionId, timestamp: now() });
      if (this.executionHistory.length > 100) this.executionHistory.shift();

      runtimeState.tools.recordCall(toolName, { success: false, latencyMs, error: String((error && error.message) || error), status: executionResult.status, code: executionResult.code });

      return executionResult;
    }
  }

  async executeParallel(toolCalls, runtimeState, options = {}) {
    const maxParallel = options.maxParallel || this.config.maxParallel;
    const results = [];
    const executing = [];

    for (const call of toolCalls) {
      const promise = this.execute(call.toolName, call.params, runtimeState, options);
      executing.push(promise);

      if (executing.length >= maxParallel) {
        const completed = await Promise.all(executing);
        results.push(...completed);
        executing.length = 0;
      }
    }

    if (executing.length > 0) {
      const completed = await Promise.all(executing);
      results.push(...completed);
    }

    return results;
  }

  async validateParams(toolName, params) {
    const tool = await this.toolRegistry.getTool(toolName);
    if (!tool) return { valid: false, error: `Tool ${toolName} not found` };
    const schema = tool.inputSchema || tool.parameters || null;
    if (!schema) return { valid: true };
    return validateInput(schema, params || {});
  }

  // Crash-recovery introspection: in-flight records at crash time are UNKNOWN.
  inFlightRecords() {
    return [...this.inFlight.values()].map((r) => ({ ...r, state: 'unknown' }));
  }

  _createResult(toolName, success, result, error, latencyMs, cost = 0, extra = {}) {
    // Root-cause fix: gate/policy early-return call sites pass
    // (toolName, success, result, error, latencyMs, extra) with cost omitted,
    // so the 6th positional is the extra object, not a numeric cost. Detect
    // and shift so code/status/approvalId are never silently dropped (this
    // was turning needs_approval into failure/null and breaking the approval
    // gate contract end-to-end).
    if (cost && typeof cost === 'object' && cost !== null && (extra === undefined || (typeof extra === 'object' && Object.keys(extra).length === 0))) {
      extra = cost;
      cost = 0;
    }
    if (typeof cost !== 'number' || !Number.isFinite(cost)) cost = 0;
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) latencyMs = 0;
    const startedAt = extra.startedAt || new Date(Date.now() - (latencyMs || 0)).toISOString();
    const normalized = createExecutionResult({
      executionId: extra.executionId || null,
      toolName,
      status: extra.status || (success ? 'success' : 'failure'),
      startedAt,
      completedAt: now(),
      durationMs: latencyMs,
      output: result,
      error,
      cost,
      approvalId: extra.approvalId || null,
      idempotencyKey: extra.idempotencyKey || null,
      code: extra.code,
    });
    // Legacy Session-1 shape preserved alongside the normalized contract.
    return {
      toolName,
      success: normalized.success,
      result: normalized.output,
      error: normalized.error,
      latencyMs: normalized.durationMs,
      cost: normalized.cost,
      timestamp: normalized.timestamp,
      code: normalized.code,
      ...normalized,
      toolName,
      success: normalized.success,
      result: normalized.output,
      latencyMs: normalized.durationMs,
    };
  }

  _sanitizeParams(params) {
    const sanitized = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (/api[_-]?key|secret|token|password|authorization/i.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 100) {
        sanitized[key] = value.slice(0, 100) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  _sanitizeResult(result) {
    if (!result) return null;
    if (typeof result === 'string' && result.length > 200) {
      return result.slice(0, 200) + '...';
    }
    if (typeof result === 'object') {
      return JSON.stringify(result).slice(0, 500);
    }
    return result;
  }

  getToolState(runtimeState) {
    return runtimeState.tools.toJSON();
  }

  getExecutionHistory(limit = 20) {
    return this.executionHistory.slice(-limit);
  }

  on(event, handler) {}
}

// A tool claiming {success:true} never overrides actual execution evidence:
// non-zero exit codes, error codes, and timeouts win.
function validateToolOutput(toolName, raw) {
  if (raw && typeof raw === 'object' && ('exitCode' in raw) && raw.exitCode !== 0 && raw.exitCode !== null) {
    return { success: false, output: raw, error: `${toolName} exited with code ${raw.exitCode}` };
  }
  if (raw && typeof raw === 'object' && raw.passed === false) {
    return { success: false, output: raw, error: raw.stderr ? String(raw.stderr).slice(-300) : `${toolName} reported failure` };
  }
  return { success: true, output: raw, error: null };
}

module.exports = {
  InMemoryToolExecutor,
  HANDLERS,
  validateToolOutput,
  MAX_READ_BYTES,
  MAX_FILE_STAT_BYTES,
};
