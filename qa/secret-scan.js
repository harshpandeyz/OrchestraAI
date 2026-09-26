'use strict';
// OrchestraAI — release secret scanner.
//
// Zero-dependency leak detector for *obvious accidental secrets* in tracked
// source. It is regression detection, not a security audit. It runs over
// `git ls-files` (qualified into the caller's repository) so node_modules,
// dist, .git and untracked runtime data are never scanned, but a committed
// `.env` file (which is tracked) IS scanned.
//
// Exit 0 = no findings; exit 1 = findings (blocking). `--self-test` proves the
// scanner itself detects a planted secret (used as its own regression test).
//
// Run: node qa/secret-scan.js
//      node qa/secret-scan.js --root /abs/path
//      node qa/secret-scan.js --self-test

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveRoot() {
  const idx = process.argv.indexOf('--root');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return path.resolve(__dirname, '..');
}

// Patterns that look secret-like. Each is matched per logical line.
const RULES = [
  { id: 'AWS_ACCESS_KEY', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'GITHUB_TOKEN', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { id: 'STRIPE_LIVE_KEY', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { id: 'SLACK_TOKEN', re: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
  { id: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'EMBEDDED_CRED_URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{8,}@[^/\s@]+\b/ },
  { id: 'SECRET_ASSIGNMENT', re: /\b(API_TOKEN|OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|DATA_ENCRYPTION_KEY|SANDBOX_WORKER_TOKEN|ISOLATED_EXECUTOR_TOKEN|POSTGRES_PASSWORD|STRIPE_WEBHOOK_SECRET|DOCKER_HUB_TOKEN)\s*=\s*['"]?[A-Za-z0-9_+/\-]{20,}['"]?/ },
];

// Binaries / generated artifacts to skip (not source).
const SKIP_NAME = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp3|mp4|pdf|zip|gz|tgz|lock)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|\.vite|\.git|build)(\/|$)/;
// Test/fixture directories and files legitimately contain fake credentials
// (e.g. "sk-test-...") to prove keys never leak. Skipping them removes the
// dominant false-positive class; a real secret is far likelier near config,
// deploy, or application source. The scanner still detects planted secrets on
// non-skipped paths (see --self-test).
const SKIP_TEST_DIR = /(^|\/)(test|tests|__tests__)(\/|$)/;
const SKIP_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// A line that mentions any of these tokens is treated as documentation /
// example / template, not a real leaked credential, to avoid false positives
// on `.env.example`, `docker-compose.yml` interpolation, and test fixtures.
function isPlaceholder(line) {
  return /\.\.\.|<[a-zA-Z0-9_.-]+>|\$\{|example|changeme|CHANGEME|not-a-real|fake|dummy|placeholder|your-|_KEY_|localhost|127\.0\.0\.1/.test(line);
}

function walkFiles(root) {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return { files: [], error: (res.stderr || 'git ls-files failed').toString().trim() };
  return {
    files: (res.stdout || '').split('\0').filter(Boolean),
    error: null,
  };
}

function scanFile(root, rel) {
  if (SKIP_NAME.test(rel) || SKIP_DIR.test(rel) || SKIP_TEST_DIR.test(rel) || SKIP_TEST_FILE.test(rel)) return [];
  const abs = path.join(root, rel);
  let text;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return []; // binary
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isPlaceholder(line)) continue;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) {
        findings.push({ file: rel, line: i + 1, rule: rule.id, snippet: line.trim().slice(0, 160) });
        break; // one finding per line is enough for triage
      }
    }
  }
  return findings;
}

function selfTest(root) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'secret-scan-'));
  const planted = path.join(dir, 'planted.js');
  fs.writeFileSync(planted, 'const OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n');
  const findings = scanFile(dir, 'planted.js');
  fs.rmSync(dir, { recursive: true, force: true });
  if (findings.length === 0) {
    console.error('✗ self-test FAILED: planted secret was not detected');
    process.exit(1);
  }
  console.log(`✓ self-test PASSED: planted secret detected (rule ${findings[0].rule})`);
}

function main() {
  const root = resolveRoot();
  const { files, error } = walkFiles(root);
  if (error) {
    console.error(`✗ secret scan could not enumerate files: ${error}`);
    process.exit(1);
  }
  const findings = [];
  for (const rel of files) {
    findings.push(...scanFile(root, rel));
  }

  const report = {
    tool: 'secret-scan',
    scannedFiles: files.length,
    findings,
  };

  if (findings.length === 0) {
    console.log(`✓ secret scan: no obvious secrets in ${files.length} tracked files`);
    console.log(JSON.stringify(report));
    return;
  }

  console.error(`✗ secret scan: ${findings.length} potential secret(s) detected`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.snippet}`);
  }
  console.error(JSON.stringify(report));
  process.exit(1);
}

if (process.argv.includes('--self-test')) selfTest(resolveRoot());
else main();