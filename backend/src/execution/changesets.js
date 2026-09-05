'use strict';

// Session 3 — Changesets (first-class) + atomic apply + rollback + Git layer.
//
// Workflow: generate patch -> validate -> dry-run -> risk assessment ->
// approval -> atomic apply -> hash verification -> git diff -> tests.
// Session 1 owns atomic persistence guarantees for ITS store; this module
// owns the agent workspace-edit workflow (tmp-file + rename, hash checks).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { RiskLevel } = require('./tool-system');

const ChangesetStatus = Object.freeze({
  PROPOSED: 'PROPOSED',
  DRY_RUN: 'DRY_RUN',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  APPLYING: 'APPLYING',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
  CONFLICT: 'CONFLICT',
});

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function resolveWorkspaceRoot(root) {
  const resolved = path.resolve(root || process.env.WORKSPACE_ROOT || process.cwd());
  // Resolve symlinks (macOS /tmp -> /private/tmp, etc.) so the sandbox
  // compares real paths against real paths. Fall back to unresolved.
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Workspace sandbox: absolute paths, traversal, symlink escape all rejected.
// Symlinks: resolved via realpath and required to stay inside the workspace.
async function sandboxPath(workspace, requested) {
  const ws = resolveWorkspaceRoot(workspace);
  const rel = String(requested || '').replace(/^\/+/, '').replace(/\0/g, '');
  if (!rel || rel === '.' ) throw Object.assign(new Error('path is required'), { code: 'bad_params' });
  const abs = path.resolve(ws, rel);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw Object.assign(new Error(`Path escapes workspace: ${requested}`), { code: 'path_escape' });
  }
  // Symlink guard: if the path (or its parent) resolves outside, reject.
  try {
    const real = await fs.promises.realpath(abs).catch(async () => {
      const parent = path.dirname(abs);
      const realParent = await fs.promises.realpath(parent);
      return path.join(realParent, path.basename(abs));
    });
    if (real !== ws && !real.startsWith(ws + path.sep)) {
      throw Object.assign(new Error(`Symlink escapes workspace: ${requested}`), { code: 'path_escape' });
    }
  } catch (e) {
    if (e && e.code === 'path_escape') throw e;
    // nonexistent path for a new file: parent check already done above
  }
  return abs;
}

function isBinaryBuffer(buf) {
  // NUL byte heuristic + high non-text ratio on the head sample.
  const sample = buf.slice(0, 8000);
  if (sample.includes(0)) return true;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return sample.length > 0 && odd / sample.length > 0.3;
}

let changesetSeq = 0;

class ChangesetStore {
  constructor() {
    this.changesets = new Map();
  }

  // Build a changeset WITHOUT applying it (dry-run proposal). Reads current
  // files, validates every edit context, computes before/after hashes and a
  // unified-ish summary. No filesystem mutation happens here.
  async propose({ runId, workspace, files, riskLevel }) {
    if (!runId) throw new Error('runId is required');
    if (!Array.isArray(files) || !files.length) throw new Error('files[] is required');
    if (files.length > 20) throw new Error('too many files in one changeset (max 20)');
    const ws = resolveWorkspaceRoot(workspace);
    const entries = [];
    let additions = 0;
    let deletions = 0;
    for (const f of files.slice(0, 20)) {
      const abs = await sandboxPath(ws, f.path);
      const edits = Array.isArray(f.edits) ? f.edits.slice(0, 20) : [];
      if (!edits.length) throw Object.assign(new Error(`edits[] required for ${f.path}`), { code: 'bad_params' });
      let content = await fs.promises.readFile(abs, 'utf8').catch(() => null);
      if (content === null) throw Object.assign(new Error(`File not found: ${f.path}`), { code: 'not_found' });
      if (content.length > 500000) throw Object.assign(new Error(`File too large: ${f.path}`), { code: 'too_large' });
      const beforeHash = sha256(content);
      let next = content;
      for (const ed of edits) {
        if (typeof ed.oldText !== 'string' || typeof ed.newText !== 'string' || !ed.oldText) {
          throw Object.assign(new Error('Each edit needs oldText/newText strings'), { code: 'bad_params' });
        }
        if (!next.includes(ed.oldText)) {
          throw Object.assign(new Error(`Patch context not found in ${f.path}; no changes applied`), { code: 'patch_conflict' });
        }
        // Count line deltas for the summary (first occurrence semantics match apply).
        const oldLines = ed.oldText.split('\n').length;
        const newLines = ed.newText.split('\n').length;
        if (newLines >= oldLines) additions += newLines - oldLines;
        else deletions += oldLines - newLines;
        next = next.replace(ed.oldText, ed.newText);
      }
      entries.push({
        path: f.path, abs,
        edits,
        beforeHash,
        afterHash: sha256(next),
        afterContent: next,
        bytesBefore: content.length,
        bytesAfter: next.length,
      });
    }
    const id = `cs-${Date.now().toString(36)}-${(changesetSeq++).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const record = {
      id,
      runId,
      files: entries.map((e) => ({ path: e.path, beforeHash: e.beforeHash, afterHash: e.afterHash, edits: e.edits.length })),
      additions,
      deletions,
      beforeHashes: Object.fromEntries(entries.map((e) => [e.path, e.beforeHash])),
      afterHashes: Object.fromEntries(entries.map((e) => [e.path, e.afterHash])),
      patch: entries.map((e) => ({ path: e.path, edits: e.edits })),
      riskLevel: riskLevel || RiskLevel.MEDIUM,
      status: ChangesetStatus.PROPOSED,
      createdAt: new Date().toISOString(),
      appliedAt: null,
      _entries: entries, // in-memory apply plan (never serialized to events)
    };
    this.changesets.set(id, record);
    return publicChangeset(record);
  }

  get(id) {
    const r = this.changesets.get(id);
    return r ? publicChangeset(r) : null;
  }

  listForRun(runId) {
    return [...this.changesets.values()].filter((c) => c.runId === runId).map(publicChangeset);
  }

  // Atomic apply: verify current hash == beforeHash (detects user edits since
  // proposal), write tmp + rename per file, re-read and verify afterHash.
  // Any failure aborts BEFORE mutating the next file; already-written files
  // are restored from in-memory backups so the changeset is all-or-nothing.
  async apply(id, { workspace } = {}) {
    const record = this.changesets.get(id);
    if (!record) return { ok: false, error: 'changeset not found' };
    if (![ChangesetStatus.PROPOSED, ChangesetStatus.DRY_RUN, ChangesetStatus.APPROVED, ChangesetStatus.FAILED].includes(record.status)) {
      return { ok: false, error: `changeset is ${record.status}` };
    }
    record.status = ChangesetStatus.APPLYING;
    const ws = resolveWorkspaceRoot(workspace);
    const backups = [];
    try {
      for (const entry of record._entries) {
        const abs = await sandboxPath(ws, entry.path);
        const current = await fs.promises.readFile(abs, 'utf8').catch(() => null);
        if (current === null) throw Object.assign(new Error(`File not found: ${entry.path}`), { code: 'not_found' });
        if (sha256(current) !== entry.beforeHash) {
          record.status = ChangesetStatus.CONFLICT;
          // restore anything already written in this apply pass
          await this._restore(backups);
          return { ok: false, conflict: true, error: `conflict: ${entry.path} changed since proposal (user edit?)` };
        }
        backups.push({ abs, content: current });
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tmp, entry.afterContent, 'utf8');
        await fs.promises.rename(tmp, abs);
        const verify = await fs.promises.readFile(abs, 'utf8');
        if (sha256(verify) !== entry.afterHash) {
          await this._restore(backups);
          record.status = ChangesetStatus.FAILED;
          return { ok: false, error: `hash verification failed for ${entry.path}` };
        }
      }
      record.status = ChangesetStatus.APPLIED;
      record.appliedAt = new Date().toISOString();
      return { ok: true, changeset: publicChangeset(record) };
    } catch (e) {
      await this._restore(backups);
      record.status = ChangesetStatus.FAILED;
      return { ok: false, error: String((e && e.message) || e).slice(0, 500), code: (e && e.code) || 'apply_failed' };
    }
  }

  async _restore(backups) {
    for (const b of backups) {
      try {
        const tmp = `${b.abs}.tmp-restore-${process.pid}`;
        await fs.promises.writeFile(tmp, b.content, 'utf8');
        await fs.promises.rename(tmp, b.abs);
      } catch { /* best effort */ }
    }
  }

  // Safe rollback: only reverts when current hash == afterHash (the agent's
  // own output). If the user edited the file afterwards, refuse and report
  // a conflict instead of destroying their work.
  async rollback(id, { workspace } = {}) {
    const record = this.changesets.get(id);
    if (!record) return { ok: false, error: 'changeset not found' };
    if (record.status !== ChangesetStatus.APPLIED) return { ok: false, error: `cannot rollback ${record.status}` };
    const ws = resolveWorkspaceRoot(workspace);
    const conflicts = [];
    const restored = [];
    for (const entry of record._entries) {
      const abs = await sandboxPath(ws, entry.path);
      const current = await fs.promises.readFile(abs, 'utf8').catch(() => null);
      if (current === null) { conflicts.push({ path: entry.path, reason: 'missing' }); continue; }
      const h = sha256(current);
      if (h !== entry.afterHash && h !== entry.beforeHash) {
        conflicts.push({ path: entry.path, reason: 'modified-after-apply' });
        continue;
      }
      if (h === entry.afterHash) {
        const original = await this._reconstructBefore(entry);
        const tmp = `${abs}.tmp-rollback-${process.pid}`;
        await fs.promises.writeFile(tmp, original, 'utf8');
        await fs.promises.rename(tmp, abs);
        restored.push(entry.path);
      }
    }
    if (conflicts.length) {
      return { ok: false, conflict: true, conflicts, restored, error: 'rollback blocked: files changed after apply' };
    }
    record.status = ChangesetStatus.ROLLED_BACK;
    return { ok: true, restored, changeset: publicChangeset(record) };
  }

  async _reconstructBefore(entry) {
    // Reverse-apply edits to the after-content to recover the before image
    // (exact since edits were exact-match replacements).
    let content = entry.afterContent;
    for (const ed of entry.edits) {
      content = content.replace(ed.newText, ed.oldText);
    }
    if (sha256(content) !== entry.beforeHash) {
      throw new Error(`rollback integrity check failed for ${entry.path}`);
    }
    return content;
  }

  mark(id, status) {
    const r = this.changesets.get(id);
    if (!r) return null;
    r.status = status;
    return publicChangeset(r);
  }

  clearRun(runId) {
    for (const [id, r] of this.changesets.entries()) {
      if (r.runId === runId) this.changesets.delete(id);
    }
  }
}

function publicChangeset(record) {
  const { _entries, ...pub } = record;
  return { ...pub };
}

// --- Git capability layer (real, allowlisted, approval-gated for writes) ---

const GIT_READONLY = new Set(['status', 'diff', 'log', 'branch', 'show', 'rev-parse']);
const GIT_WRITE = new Set(['add', 'commit', 'branch']);
const GIT_HIGH_RISK = new Set(['push', 'reset', 'clean', 'checkout']);

function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function runGit(workspace, args, { timeoutMs = 10000, maxBytes = 32 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd: resolveWorkspaceRoot(workspace),
      timeout: Math.min(timeoutMs, 60000),
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      const err = String(stderr || '');
      const truncated = Buffer.byteLength(out, 'utf8') > maxBytes;
      const sliced = truncated ? Buffer.from(out, 'utf8').slice(0, maxBytes).toString('utf8') : out;
      if (error) {
        const e = new Error(`git ${args[0]} failed: ${(err || error.message).slice(0, 300)}`);
        e.code = error.killed ? 'timeout' : 'git_failure';
        e.details = { stdout: sliced.slice(-1000), stderr: err.slice(-1000) };
        return reject(e);
      }
      resolve({ stdout: sliced, stderr: err.slice(-1000), truncated });
    });
  });
}

function classifyGit(args) {
  const sub = String((args && args[0]) || '');
  if (GIT_READONLY.has(sub)) return { risk: RiskLevel.LOW, needsApproval: false };
  if (GIT_WRITE.has(sub)) return { risk: RiskLevel.MEDIUM, needsApproval: true };
  if (GIT_HIGH_RISK.has(sub)) return { risk: RiskLevel.HIGH, needsApproval: true };
  return { risk: RiskLevel.CRITICAL, needsApproval: true };
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

async function gitStatus(workspace) {
  const porcelain = await runGit(workspace, ['status', '--porcelain=v1', '--branch']);
  const branch = await runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: 'unknown' }));
  // --branch adds a '## main...origin/main' header line: it is branch metadata,
  // not a file. Filter it so files.length counts only real paths.
  const files = porcelain.stdout.split('\n').filter(Boolean).filter((line) => !line.startsWith('##')).slice(0, 100).map((line) => ({
    index: line.slice(0, 1), worktree: line.slice(1, 2), path: line.slice(3),
  }));
  return { branch: branch.stdout.trim(), files, clean: files.length === 0, truncated: porcelain.truncated };
}

async function gitDiff(workspace, { staged = false, path: filePath = null, maxBytes = 32 * 1024 } = {}) {
  const args = ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--', ...(filePath ? [filePath] : [])];
  const r = await runGit(workspace, args, { maxBytes });
  const CLP = r.stdout.split('\n');
  let additions = 0; let deletions = 0;
  for (const l of CLP) {
    if (l.startsWith('+') && !l.startsWith('+++')) additions++;
    else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
  }
  return { diff: r.stdout, additions, deletions, truncated: r.truncated };
}

async function gitLog(workspace, limit = 10) {
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));
  const r = await runGit(workspace, ['log', `--max-count=${n}`, '--pretty=format:%H%x00%an%x00%ad%x00%s', '--date=short']);
  return r.stdout.split('\n').filter(Boolean).slice(0, n).map((line) => {
    const [hash, author, date, ...rest] = line.split('\x00');
    return { hash, author, date, message: rest.join('\x00').slice(0, 300) };
  });
}

async function gitBranches(workspace) {
  const r = await runGit(workspace, ['branch', '--list', '-vv']);
  return r.stdout.split('\n').filter(Boolean).slice(0, 50).map((line) => ({
    current: line.startsWith('*'), name: line.replace(/^\*\s+/, '').trim().split(/\s+/)[0],
  }));
}

async function gitCreateBranch(workspace, name, checkout = true) {
  if (!BRANCH_RE.test(String(name)) || String(name).includes('..')) {
    throw Object.assign(new Error('invalid branch name'), { code: 'bad_params' });
  }
  if (checkout) {
    await runGit(workspace, ['checkout', '-b', String(name)]);
  } else {
    await runGit(workspace, ['branch', String(name)]);
  }
  return { branch: String(name), checkedOut: !!checkout };
}

async function gitAdd(workspace, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 20) {
    throw Object.assign(new Error('paths[] (1-20 explicit files) is required; never -A'), { code: 'bad_params' });
  }
  for (const p of paths) {
    if (String(p) === '.' || String(p) === '-A' || String(p).startsWith('-')) {
      throw Object.assign(new Error(`refusing broad add: ${p}`), { code: 'denied' });
    }
    await sandboxPath(resolveWorkspaceRoot(workspace), p);
  }
  await runGit(workspace, ['add', '--', ...paths.map(String)]);
  return { staged: paths.map(String) };
}

// Safe commit: refuses to include unrelated user changes unless the approval
// explicitly allowed it. Compares the staged diff paths against the agent's
// changeset paths; anything else aborts with a scope error.
async function gitCommit(workspace, message, { allowedPaths = null } = {}) {
  const msg = String(message || '').trim();
  if (msg.length < 4 || msg.length > 500) throw Object.assign(new Error('commit message must be 4-500 chars'), { code: 'bad_params' });
  const staged = await runGit(workspace, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!stagedPaths.length) throw Object.assign(new Error('nothing staged to commit'), { code: 'bad_params' });
  if (Array.isArray(allowedPaths)) {
    const unrelated = stagedPaths.filter((p) => !allowedPaths.includes(p));
    if (unrelated.length) {
      throw Object.assign(
        new Error(`refusing to commit unrelated changes: ${unrelated.slice(0, 5).join(', ')}`),
        { code: 'scope_violation', details: { unrelated } }
      );
    }
  }
  await runGit(workspace, ['commit', '-m', msg]);
  const head = await runGit(workspace, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.stdout.trim(), files: stagedPaths, message: msg };
}

module.exports = {
  ChangesetStatus,
  ChangesetStore,
  sha256,
  resolveWorkspaceRoot,
  sandboxPath,
  isBinaryBuffer,
  GIT_READONLY,
  GIT_WRITE,
  GIT_HIGH_RISK,
  runGit,
  classifyGit,
  gitStatus,
  gitDiff,
  gitLog,
  gitBranches,
  gitCreateBranch,
  gitAdd,
  gitCommit,
};
