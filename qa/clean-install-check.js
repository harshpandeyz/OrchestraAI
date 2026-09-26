'use strict';
// OrchestraAI — clean-source hygiene gate.
//
// Lightweight static guard that verifies the repository is free of committed
// build/runtime artifacts and that lockfiles exist for reproducibility. The
// heavyweight clean-room install (`rm -rf node_modules && npm ci && build`)
// is exercised by CI's `install` job and the Docker build (npm ci --omit=dev),
// not by this script.
//
// Blocking findings:
//   * tracked node_modules / dist / .vite / build output
//   * tracked .DS_Store or *.log files
//   * any tracked `.env` file other than `.env.example`
//   * untracked non-ignored `.env*` files (a real .env sitting in the tree)
//   * missing package-lock.json (root) or frontend/package-lock.json
//
// Run: node qa/clean-install-check.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const BAD_TRACKED = [
  { re: /(^|\/)(node_modules|dist|\.vite|coverage|playwright-report|test-results)(\/|$)/, msg: 'committed build/runtime artifacts' },
  { re: /\.log$/, msg: 'committed log files' },
  { re: /(^|\/)\.DS_Store$/, msg: 'committed macOS metadata' },
  { re: /(^|\/)\.env$/, msg: 'committed .env (secrets)' },
  { re: /(^|\/)\.env\.(production|local|staging|prod|dev)$/, msg: 'committed environment secret file' },
];
const OK_ENV = new Set(['.env.example']);

function main() {
  const findings = [];
  const tracked = git(['ls-files', '-z']);
  const trackedFiles = (tracked.stdout || '').split('\0').filter(Boolean);

  for (const f of trackedFiles) {
    if (OK_ENV.has(f)) continue;
    const base = f.split('/').pop();
    if (base.startsWith('.env') && !OK_ENV.has(base)) {
      findings.push(`${f}: ${base} should not be committed`);
      continue;
    }
    for (const rule of BAD_TRACKED) {
      if (rule.re.test(f)) {
        findings.push(`${f}: ${rule.msg}`);
        break;
      }
    }
  }

  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const untracked = (status.stdout || '').split('\n').filter((l) => l.startsWith('??'));
  for (const line of untracked) {
    const p = line.slice(3).trim();
    const base = p.split('/').pop();
    if ((base.startsWith('.env') || /\.(pem|key)$/.test(base)) && base !== '.env.example') {
      findings.push(`${p}: untracked environment/secret file present in the working tree`);
    }
  }

  const locks = ['package-lock.json', 'frontend/package-lock.json'];
  for (const lock of locks) {
    if (!fs.existsSync(path.join(root, lock))) {
      findings.push(`${lock}: missing lockfile (install is not reproducible)`);
    }
  }

  if (findings.length === 0) {
    console.log(`✓ clean-install: source tree is clean (${trackedFiles.length} tracked files, lockfiles present)`);
    return;
  }

  console.error('✗ clean-install: issues found');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}

main();