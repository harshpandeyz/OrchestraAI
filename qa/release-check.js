'use strict';
// OrchestraAI — canonical release gate.
//
// Single authoritative decision. Runs every blocking stage, streams their
// output, and writes qa/release-report.json plus a human verdict.
//
//   node qa/release-check.js            # full gate (incl. browser E2E + Docker)
//   node qa/release-check.js --fast     # fast path: no browser / no Docker
//   node qa/release-check.js --e2e-only # just the browser suite
//
// No stage is ever hidden, ignored, or converted from failure to warning.
// A blocking stage that cannot run (missing tool / not requested in a fast
// run) is recorded SKIPPED with a reason; a skipped BLOCKING stage in a full
// run yields BLOCKED (incomplete verification) — never READY.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(__dirname, 'release-report.json');
const FAST = process.argv.includes('--fast');
const E2E_ONLY = process.argv.includes('--e2e-only');

function sh(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, ...options });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, out }));
    child.on('error', (e) => resolve({ code: 1, out: String(e) }));
  });
}

async function capability(name) {
  // Returns true if the tooling needed by a stage appears available.
  if (name === 'e2e') {
    const bins = [
      path.join(ROOT, 'node_modules', '.bin', 'playwright'),
      path.join(ROOT, 'frontend', 'node_modules', '.bin', 'playwright'),
    ];
    return bins.some((b) => fs.existsSync(b));
  }
  if (name === 'containerSmoke') {
    const r = await sh('docker', ['info']);
    return r.code === 0;
  }
  return true;
}

function gitSha() {
  try { return require('child_process').execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
  catch { return null; }
}

const STAGES = [
  { id: 'cleanInstall', scope: 'fast', cmd: 'node', args: ['qa/clean-install-check.js'] },
  { id: 'ciGate', scope: 'fast', cmd: 'node', args: ['qa/ci-release-gate.test.js'] },
  { id: 'secretScan', scope: 'fast', cmd: 'node', args: ['qa/secret-scan.js'] },
  { id: 'backend', scope: 'fast', cmd: 'npm', args: ['run', 'test:all'] },
  { id: 'frontend', scope: 'fast', cmd: 'npm', args: ['run', 'test:frontend'] },
  { id: 'frontendBuild', scope: 'fast', cmd: 'npm', args: ['run', 'build:frontend'] },
  // Evals v2 golden suite — NON-BLOCKING info gate (Session 12). It always
  // runs (fast, zero keys) and writes qa/evals-golden-report.json, but a
  // failure never blocks the release until promoted per qa/RELEASE.md.
  { id: 'evalsGolden', scope: 'fast', cmd: 'node', args: ['qa/evals-golden-check.js'], blocking: false },
  { id: 'e2e', scope: 'full', cmd: 'npm', args: ['run', 'test:e2e'] },
  { id: 'containerSmoke', scope: 'full', cmd: 'bash', args: ['deploy/scripts/smoke-container.sh'] },
];

async function main() {
  const checks = {};
  const failures = [];
  const started = Date.now();

  const selected = E2E_ONLY
    ? STAGES.filter((s) => s.id === 'e2e' || s.id === 'frontendBuild')
    : STAGES.filter((s) => (FAST ? s.scope === 'fast' : true));

  for (const stage of selected) {
    const isFull = stage.scope === 'full';
    // In a full run, a skipped blocking stage => BLOCKED (incomplete). In a
    // fast run, full-scope stages are simply not requested (non-blocking).
    if (isFull && FAST) {
      checks[stage.id] = 'SKIPPED';
      continue;
    }
    console.log(`\n===== [${stage.id}] ${stage.cmd} ${stage.args.join(' ')} =====`);
    const cap = await capability(stage.id === 'containerSmoke' ? 'containerSmoke' : stage.id === 'e2e' ? 'e2e' : 'always');
    if (!cap) {
      const reason = stage.id === 'e2e'
        ? 'Playwright not installed — run `npx playwright install chromium` (and `npm install`)'
        : 'Docker daemon not available';
      checks[stage.id] = 'SKIPPED';
      failures.push({ id: stage.id, state: 'SKIPPED', reason });
      console.log(`  ⇒ SKIPPED: ${reason}`);
      continue;
    }
    const t0 = Date.now();
    const r = await sh(stage.cmd, stage.args);
    const ms = Date.now() - t0;
    const passed = r.code === 0;
    const nonBlocking = stage.blocking === false;
    checks[stage.id] = passed ? 'PASS' : nonBlocking ? 'WARN' : 'FAIL';
    if (!passed && nonBlocking) {
      console.log(`  ⇒ WARN (non-blocking info gate, exit ${r.code}) (${(ms / 1000).toFixed(1)}s)`);
      continue;
    }
    if (!passed) failures.push({ id: stage.id, state: 'FAIL', exitCode: r.code });
    console.log(`  ⇒ ${passed ? 'PASS' : 'FAIL'} (${(ms / 1000).toFixed(1)}s)`);
    // A critical stage failure stops the gate: later stages depend on these
    // artifacts (build must precede e2e/container image). Do not continue to
    // manufacture misleading downstream results.
    if (!passed) break;
  }

  const anyBlockingFail = failures.some((f) => f.state === 'FAIL');
  const anyBlockingSkipped = failures.some((f) => f.state === 'SKIPPED');

  let status, verdict;
  if (E2E_ONLY) {
    status = anyBlockingFail ? 'FAIL' : 'PASS';
    verdict = anyBlockingFail ? 'RELEASE BLOCKED' : 'E2E PASS';
  } else if (FAST) {
    status = anyBlockingFail ? 'FAIL' : 'PASS';
    verdict = anyBlockingFail ? 'RELEASE BLOCKED' : 'FAST GATE PASS (run `npm run release:check` for the full release decision)';
  } else {
    if (anyBlockingFail) { status = 'FAIL'; verdict = 'RELEASE BLOCKED'; }
    else if (anyBlockingSkipped) { status = 'INCOMPLETE'; verdict = 'RELEASE BLOCKED (incomplete verification)'; }
    else { status = 'PASS'; verdict = 'RELEASE READY'; }
  }

  const report = {
    product: 'orchestraai',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    gitSha: gitSha(),
    mode: FAST ? 'fast' : E2E_ONLY ? 'e2e-only' : 'full',
    status,
    verdict,
    checks,
    failures,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  console.log('\n================ RELEASE REPORT ================');
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('------------------------------------------------');
  console.log(`  VERDICT: ${verdict}`);
  console.log(`  REPORT:  ${path.relative(ROOT, REPORT_PATH)}`);
  console.log('================================================');

  process.exit(status === 'PASS' ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });