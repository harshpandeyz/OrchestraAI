# Changelog

## 2026-09-26 — Integrate, Verify, and Ship

Release-hardening changes since `674696d`. All release gates pass (`RELEASE READY`).

### `b175f8e` — fix(qa): time-relative fixtures + non-self-tripping scanner
Unblocked the release gate. `backend/test/intelligence-analytics.test.js`
used hardcoded Aug-2026 fixture dates while `buildIntelligence()` applies a
rolling 30-day range window, so past ~Sep 20 the fixtures filtered to zero
runs (`INSUFFICIENT_DATA` vs `DEMO`) — a defect in the test rather than the
product; fixtures are now relative to `Date.now()`.
`qa/secret-scan.js --self-test` planted a contiguous `sk-proj-…` literal the
scanner matched in its own source — a defect in the scanner tooling; the
planted secret is now assembled by concatenation.

### `f7c4617` — feat(evals): Evals v2 golden suite (+687)
`backend/src/evals/golden-tasks.js`: 24 frozen tasks across coding (6),
reasoning (5), tool-use (5), long-context (4), cheap-simple (4), each with a
deterministic rule-based `expect` predicate. `golden-runner.js`: zero-dep
scorer (`scoreAttempt`, `runGoldenSuite`, `diffGoldenRuns`, `demoAttempts`);
missing attempts fail honestly, optional `llmJudge` is secondary-only.
Plus `backend/test/evals-golden.test.js`, `qa/evals-golden-check.js`
(non-blocking gate), and the checked-in `qa/evals-golden-baseline.json`
(24/24 DEMO baseline).

### `5394dfc` — feat(browser): v1 snapshot tool (+450/−15)
`browser_snapshot` (read-only) and `browser_navigate` share one engine:
deterministic URL-hash mock in DEMO (zero network), otherwise the existing
DNS-aware SSRF-guarded fetch with policy opt-in, allowlist, approval
(navigate), caps, and redaction. `tool-system.js` placeholder replaced with
two real `disabled:true` definitions; handlers in `tool-executor.js`; new
sandbox `POST /v1/browse`; `backend/test/browser-tool.test.js`, two new
sandbox boundary tests, and `e2e/browser-tool.spec.ts` (3 specs).

### `eac27e4` — feat(telemetry): OTLP exporter (+258)
`backend/src/telemetry/otlp-exporter.js`: zero-dependency OTLP/HTTP shipper
alongside the untouched `telemetry-collector.js`. Off unless `OTLP_ENABLED=1`
with `OTLP_ENDPOINT`. GenAI-convention span mapping, `OBSERVABILITY.md`
event→span table, `backend/test/otlp-exporter.test.js`.

### `4c13d6d` — feat(runtime): wiring (+77/−3)
Additive only: `GET /api/evals/golden` (DEMO leaderboard) and
`POST /api/browse` (mock in demo, allowlisted fetch in live) in
`backend/server.js`; `getGoldenEvals` client + golden card on `EvalsPage`;
`test:all` covers the three new suites; `release-check` gains the
non-blocking `evalsGolden` info stage.

### `5a90af4` — docs (+285)
ISC `LICENSE` (matches `package.json`), README badges (real CI workflow,
license, Node 22), `BENCHMARK_REPORT.md` (real 24/24 DEMO numbers +
regression procedure).
