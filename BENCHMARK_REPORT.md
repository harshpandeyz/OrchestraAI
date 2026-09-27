# OrchestraAI — Golden Benchmark Report

All numbers below are **real outputs of the deterministic golden suite**
(`backend/src/evals/golden-tasks.js` + `golden-runner.js`), run via
`node qa/evals-golden-check.js`. Provenance is **DEMO** throughout: the
measurements are explicitly labelled mock traffic through the real scorer —
never presented as production observations. Reproduce with:

```bash
node qa/evals-golden-check.js
cat qa/evals-golden-report.json   # gitignored working copy
cat qa/evals-golden-baseline.json # checked-in baseline for diffs
```

## Baseline result (2026-09-26, commit `b175f8e`)

- Model: `demo-baseline`, provenance `DEMO`
- **24/24 passed, success rate 1.0**, avg cost $0.001354/task, avg latency 583ms

| Category | Tasks | Passed | Rate | Avg cost | Avg latency |
|---|---|---|---|---|---|
| coding | 6 | 6 | 1.0 | $0.001 | 400ms |
| reasoning | 5 | 5 | 1.0 | $0.0012 | 500ms |
| tool-use | 5 | 5 | 1.0 | $0.002 | 900ms |
| long-context | 4 | 4 | 1.0 | $0.00175 | 775ms |
| cheap-simple | 4 | 4 | 1.0 | $0.000875 | 375ms |

## Before/after regression method

`diffGoldenRuns(before, after)` compares two suite results task-by-task:

```bash
# 1. Save the "before" baseline (e.g. before a router/prompt change)
node qa/evals-golden-check.js --model router-v1 --save-baseline
# 2. Make the change, then run the "after" candidate
node qa/evals-golden-check.js --model router-v2
# 3. Read qa/evals-golden-report.json -> .diff:
#    { delta, regressions[], fixes[], byCategory[{ category, before, after, delta }] }
```

A negative `delta` or any entry in `regressions[]` means the change must be
investigated and resolved before it is promoted (see the defect triage
process in `qa/RELEASE.md`). The golden check currently runs as a
non-blocking informational gate; it can be promoted to a blocking gate by
setting `blocking: true` in `qa/release-check.js`.

## First regression comparison (pending)

No before/after comparison against a router change has been recorded yet.
The self-consistency check in `backend/test/evals-golden.test.js` verifies
the mechanism (a synthetic one-task corruption is detected as exactly one
`coding` regression, `delta < 0`).

## Honesty notes

- The suite scores **recorded attempt evidence** against frozen task
  predicates; it never calls a provider and never invents costs.
- DEMO measurements are deterministic fixtures (`demoAttempts()`), labelled
  `provenance: 'DEMO'` in every row, the API response, and the console
  leaderboard. Production measurements will carry `OBSERVED`/`VERIFIED`.
- The optional `llmJudge` field is stored as **secondary-only** evidence and
  can never flip the deterministic pass/fail.
