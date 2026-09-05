'use strict';

// Agent 3 — Strengthened command validation (single source of truth).
//
// execFile() is a command restriction, NOT a sandbox. This module hardens the
// restriction itself so the local restricted executor cannot be trivially
// escaped, and the isolated worker can reuse the same rules. Both
// execution-policy.js (policy-level family gating) and environment.js
// (argv-level hardening) delegate here.
//
// Rejects:
//   - shell metacharacters (including ; & | ` $ ( ) { } ! # ~ * ? < >)
//   - command substitution: $(...), `...`, ${...}
//   - arbitrary interpreters unless explicitly allowed (sh/bash/zsh/dash/
//     powershell/cmd, or -c/-e/--eval/--command/-r flags in flag position)
//   - path traversal (.. segments) and absolute workspace escapes
//   - environment override tricks (FOO=bar assignments, env/export/prefix)
//   - flags that redirect workspace/package roots (--prefix, --workspace,
//     --node-options, --exec, --rootdir, --cache, --userconfig, ...)
// Preserves the existing safe command families (node workspace file,
// npm test/build/lint, pytest, cargo test, go test, git read-only + gated
// git write).

const path = require('path');
const { RiskLevel } = require('./tool-system');
const { resolveWorkspaceRoot } = require('./changesets');

const MAX_ARGS = 20;
const MAX_ARG_LEN = 500;

// Every character that could invoke shell parsing, globbing, history
// expansion, redirection, or backgrounding if the argv ever reached a shell.
const SHELL_META_RE = /[;&|$`(){}<>*?!#~\n\r\0]/;

// Command substitution / expansion forms, checked on the joined command so
// split-argv smuggling ($ + (cmd)) is also caught.
const SUBSTITUTION_RES = [
  /\$\(/, // $(cmd)
  /`/, // `cmd`
  /\$\{/, // ${var}
  /\$\(/,
];

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Interpreters that are never part of the allowlisted families.
const BLOCKED_BINS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh',
  'powershell', 'pwsh', 'cmd', 'cmd.exe',
  'curl', 'wget', 'nc', 'ncat', 'socat', 'ssh', 'scp', 'ftp', 'telnet',
  'ruby', 'perl', 'php', 'lua', 'r', 'R',
  'java', 'javac', 'gradle', 'mvn', 'make', 'cmake',
  'docker', 'podman', 'kubectl', 'systemctl', 'service',
  'sudo', 'su', 'chmod', 'chown', 'rm', 'mv', 'cp', 'dd', 'mkfs',
  'env', 'export', 'source', 'eval', 'exec', 'xargs', 'find',
]);

// Inline-code flags: dangerous only in flag position (first args before the
// workspace file). Script arguments AFTER the file are untouched.
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command', '-r', '--require']);

// Flags that redirect execution outside the workspace / package root.
const WORKSPACE_REDIRECT_RES = [
  /(^|\s)--prefix(\b|=|\s)/,
  /(^|\s)--workspace(\b|=|\s)/,
  /(^|\s)--workspaces(\b|=|\s)/,
  /(^|\s)--node-options[= ]/,
  /(^|\s)--exec(\b|=|\s)/,
  /(^|\s)--rootdir[= ]/,
  /(^|\s)--cache(\b|=|\s)/,
  /(^|\s)--cache-dir[= ]/,
  /(^|\s)--userconfig[= ]/,
  /(^|\s)--global(\b|=|\s)/,
  /(^|\s)--unsafe-perm(\b|=|\s)/,
  /(^|\s)-p(\b|\s)/,
];

function denied(reason, extra = {}) {
  return Object.assign(new Error(reason), { code: 'denied', ...extra });
}

function containsSubstitution(text) {
  return SUBSTITUTION_RES.some((re) => re.test(text));
}

// Full argv validation. Throws {code:'denied'|'bad_params'} on rejection.
// Returns { bin, args } normalized on success.
function validateArgv(argv, workspace) {
  const args = Array.isArray(argv) ? argv.filter(Boolean).map(String) : [];
  if (!args.length) throw Object.assign(new Error('empty command'), { code: 'bad_params' });
  const [bin, ...rest] = args;
  if (!bin || /[/\\]/.test(bin)) throw denied(`command binary must be a bare name: ${bin.slice(0, 60)}`);
  if (BLOCKED_BINS.has(bin)) throw denied(`interpreter/tool not allowlisted: ${bin}`);
  if (rest.length > MAX_ARGS) throw denied('too many command arguments');

  let ws = null;
  try { ws = resolveWorkspaceRoot(workspace); } catch { ws = null; }

  for (const raw of rest) {
    const a = String(raw);
    if (!a) throw denied('empty command argument');
    if (a.length > MAX_ARG_LEN) throw denied('command argument too long');
    if (a.includes('\0') || a.includes('\n') || a.includes('\r')) {
      throw denied('command argument contains control characters');
    }
    if (SHELL_META_RE.test(a)) {
      throw denied(`command argument not allowed: ${a.slice(0, 60)}`);
    }
    if (ENV_ASSIGN_RE.test(a)) {
      throw denied('environment assignments are not allowed in commands');
    }
    // Bracketed pytest selectors (test.py::case[param]) are allowed; the
    // SHELL_META set above already excludes '[' and ']' for that reason.
    if (a.includes('/') || a.includes(path.sep)) {
      const segs = a.split(/[\\/]/);
      if (segs.includes('..')) throw denied('path traversal is not allowed in commands');
      if (ws && path.isAbsolute(a)) {
        const abs = path.resolve(a);
        if (abs !== ws && !abs.startsWith(ws + path.sep)) {
          throw denied('command path escapes workspace');
        }
      }
    }
  }

  const joined = rest.join(' ');
  if (containsSubstitution(args.join(' '))) {
    throw denied('command substitution is not allowed');
  }
  // Flag-position interpreter escapes.
  const first = rest[0] || '';
  if (bin === 'node' && first.startsWith('-')) {
    throw denied('node flags are not allowed; provide a workspace file path');
  }
  if ((bin === 'python' || bin === 'python3') && (first === '-c' || first === '--command')) {
    throw denied('inline code execution is not allowed via python');
  }
  if (INLINE_CODE_FLAGS.has(first) && ['node', 'python', 'python3', 'pytest'].includes(bin)) {
    throw denied(`inline code flag not allowed: ${first}`);
  }
  if (WORKSPACE_REDIRECT_RES.some((re) => re.test(` ${joined}`))) {
    throw denied('workspace-redirecting flags are not allowed');
  }
  return { bin, args: rest };
}

// Classify into the stable command families. Unknown => CRITICAL/danger.
function classifyArgv(argv) {
  const args = Array.isArray(argv) ? argv.filter(Boolean).map(String) : [];
  if (!args.length) return { family: null, risk: RiskLevel.CRITICAL, reason: 'empty command' };
  const [bin, ...rest] = args;
  if (BLOCKED_BINS.has(bin)) {
    return { family: null, risk: RiskLevel.CRITICAL, reason: `interpreter not allowlisted: ${bin}` };
  }
  if (bin === 'node' && rest[0] && !String(rest[0]).startsWith('-')) {
    return { family: 'node_test_file', risk: RiskLevel.LOW, reason: 'node workspace file' };
  }
  if (bin === 'npm' && (rest.join(' ') === 'test' || /^run\s+(test|build|lint)$/.test(rest.join(' ')))) {
    return { family: 'npm_test', risk: RiskLevel.LOW, reason: 'npm test/build/lint' };
  }
  if (bin === 'pytest' || (bin === 'python' && rest[0] === '-m' && rest[1] === 'pytest')) {
    return { family: 'pytest', risk: RiskLevel.LOW, reason: 'pytest' };
  }
  if (bin === 'python3' && rest[0] === '-m' && rest[1] === 'pytest') {
    return { family: 'pytest', risk: RiskLevel.LOW, reason: 'pytest' };
  }
  if (bin === 'cargo' && rest[0] === 'test') return { family: 'cargo_test', risk: RiskLevel.LOW, reason: 'cargo test' };
  if (bin === 'go' && rest[0] === 'test') return { family: 'go_test', risk: RiskLevel.LOW, reason: 'go test' };
  if (bin === 'git' && ['status', 'diff', 'log', 'branch', 'show', 'rev-parse'].includes(rest[0])) {
    return { family: 'git_readonly', risk: RiskLevel.LOW, reason: 'git read-only' };
  }
  if (bin === 'git' && ['add', 'commit', 'branch'].includes(rest[0])) {
    return { family: 'git_write', risk: RiskLevel.MEDIUM, reason: 'git write' };
  }
  if (bin === 'git' && ['push', 'reset', 'clean', 'checkout'].includes(rest[0])) {
    return { family: 'git_write', risk: RiskLevel.HIGH, reason: 'git destructive' };
  }
  if (/^(npm|pip|pip3|yarn|pnpm|cargo|go)\b/.test(args.join(' ')) && /install|add /.test(args.join(' '))) {
    return { family: null, risk: RiskLevel.HIGH, reason: 'package install is a separate capability' };
  }
  return { family: null, risk: RiskLevel.CRITICAL, reason: `command not allowlisted: ${bin}` };
}

// Combined gate used by execution-policy: family first, then argv hardening.
// Never widens: an argv failure always denies even if the family matched.
function assertCommandAllowed(policy, argv) {
  const classification = classifyArgv(argv);
  if (!classification.family) return { allowed: false, ...classification };
  try {
    validateArgv(argv, policy && policy.workspaceRoot);
  } catch (e) {
    return {
      allowed: false,
      family: classification.family,
      risk: RiskLevel.CRITICAL,
      reason: String((e && e.message) || e).slice(0, 200),
    };
  }
  const deniedList = (policy && policy.deniedCommands) || [];
  const allowedList = (policy && policy.allowedCommands) || [];
  const key = argv.join(' ');
  if (deniedList.some((d) => key.startsWith(d))) {
    return { allowed: false, ...classification, reason: `command denied by policy: ${key.slice(0, 120)}` };
  }
  if (allowedList.length && !allowedList.some((a) => key.startsWith(a) || classification.family === a)) {
    return { allowed: false, ...classification, reason: 'command not in policy allowlist' };
  }
  return { allowed: true, ...classification };
}

module.exports = {
  MAX_ARGS,
  MAX_ARG_LEN,
  SHELL_META_RE,
  BLOCKED_BINS,
  validateArgv,
  classifyArgv,
  assertCommandAllowed,
  containsSubstitution,
};
