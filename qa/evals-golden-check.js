'use strict';
// OrchestraAI — golden eval check (Evals v2, initially NON-BLOCKING).
//
// Runs the deterministic golden suite in DEMO mode (zero keys) and writes
// qa/evals-golden-report.json with the leaderboard + a regression diff
// against the checked-in baseline (qa/evals-golden-baseline.json when
// present). Exit code is ALWAYS 0: this gate is informational until the
// suite is stable enough to promote to blocking per qa/RELEASE.md.
//
//   node qa/evals-golden-check.js [--model <id>] [--save-baseline]

const fs = require('fs');
const path = require('path');
const { runGoldenSuite, demoAttempts, diffGoldenRuns } = require('../backend/src/evals/golden-runner');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'evals-golden-report.json');
const BASELINE = path.join(__dirname, 'evals-golden-baseline.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

function main() {
  const modelId = arg('--model') || 'demo-baseline';
  const result = runGoldenSuite(demoAttempts(modelId), { modelId, provenance: 'DEMO' });
  let diff = null;
  if (fs.existsSync(BASELINE)) {
    try {
      const before = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      diff = diffGoldenRuns(before, result);
    } catch (e) {
      diff = { error: `baseline unreadable: ${String((e && e.message) || e).slice(0, 200)}` };
    }
  }
  const report = { ...result, baseline: fs.existsSync(BASELINE) ? path.basename(BASELINE) : null, diff };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  if (process.argv.includes('--save-baseline')) {
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n');
    console.log(`✓ golden baseline saved: ${path.relative(ROOT, BASELINE)}`);
  }
  console.log(`✓ golden suite: ${result.passed}/${result.total} passed (rate ${result.successRate}) [${result.provenance}, model ${result.modelId}]`);
  for (const c of result.categories) {
    console.log(`    ${c.category.padEnd(14)} ${c.passed}/${c.total} rate=${c.successRate} avgCost=${c.avgCost ?? '—'} avgLat=${c.avgLatencyMs ?? '—'}ms`);
  }
  if (diff && !diff.error) {
    console.log(`    regression diff vs baseline: delta=${diff.delta} regressions=${diff.regressions.length} fixes=${diff.fixes.length}`);
    for (const r of diff.regressions) console.log(`    REGRESSION ${r.taskId} (${r.category})`);
  }
  console.log(`  report: ${path.relative(ROOT, REPORT)} (non-blocking info gate)`);
}

main();
