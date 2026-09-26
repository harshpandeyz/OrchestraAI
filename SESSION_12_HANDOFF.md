# SESSION 12 Handoff — Integrate, Verify, and Ship (Evals v2 + Browser v1 + OTLP)

## SESSION Summary
- **Prior state** — the Session 12 brief assumed 1 modified + 31 untracked files stranded locally. On entering this session the working tree was already **clean and pushed**: the Section-1 work (distributed infra layer, security headers, static-console, migration 003, qa/release-gate suite, e2e suite + Playwright config, frontend v2/routing/RunStudio) had been committed across 11 conventional commits and `main` was up to date with `origin/main`. Phase 0 therefore became *verify*, not *rescue*.
- **This session (Session 12)** — verified Phase 0 end-to-end (fixed 2 release-blocking bugs, full `release:check` → `RELEASE READY`, pushed), then shipped Phases 1–3 and 5: Evals v2 golden suite + leaderboard + regression diff, browser/computer-use tool v1 (sandbox-worker + backend + API + e2e), optional OTLP exporter + `OBSERVABILITY.md`, plus `LICENSE`, README badges, `BENCHMARK_REPORT.md`.
- **Still open** — live public URL (no host provisioned from here), Docker Hub publish secrets (CI product jobs all green; only `release-image` login fails), promotion of the golden gate from non-blocking to blocking once stable.

---

## 1. WHAT CHANGED

### Phase 0 — verification + 2 release-blocking fixes
The "esbuild template-literal bug" from `SESSION_11_HANDOFF.md` is **gone** on the current toolchain: `npm run build:frontend` succeeds and all 16 frontend files / 161 tests pass (including the 3 previously-failing files). No template-literal rewrite was needed. Two *different* release blockers were found and fixed instead (both verified by execution, classified per `qa/RELEASE.md` triage):
1. **TEST BUG** — `backend/test/intelligence-analytics.test.js` used fixed Aug-2026 fixture dates with the default 30-day range window; once wall-clock passed ~Sep 20 the fixtures filtered to zero runs and the test failed (`INSUFFICIENT_DATA` vs `DEMO`). Fixtures are now relative to `Date.now()`. The range filter was correct; the test was wrong.
2. **INFRASTRUCTURE BUG** — `qa/secret-scan.js --self-test` planted a contiguous `sk-proj-…` literal that the scanner then flagged *in its own source*, failing the scan (exit 1, blocking). The planted secret is now assembled by concatenation, so the source has no contiguous token while the runtime-planted file still does.

Full matrix green: `test:all` exit 0 (446 ✓ + 3 new suites), `test:frontend` 161 passed, `test:e2e` 28→31 passed, `release:check` (full) → `RELEASE READY` (all 8 blocking gates PASS incl. e2e + container smoke). Migration 003 applied twice against Postgres 16 (second run: indexes skip, `INSERT 0 0`) — idempotent, then test tables dropped. Static-console SPA fallback verified (`/console/runs/abc123` serves the shell; `/api/*` falls through).

### Phase 1 — Evals v2 (golden suite, leaderboard, regression diff)
- `backend/src/evals/golden-tasks.js` — 24 frozen tasks across `coding` (6), `reasoning` (5), `tool-use` (5), `long-context` (4), `cheap-simple` (4), each with a deterministic `expect` predicate. Data only; ids never reused.
- `backend/src/evals/golden-runner.js` — zero-dep deterministic scorer (`scoreAttempt`, `runGoldenSuite`, `diffGoldenRuns`, `demoAttempts`). Cost/latency are caller-supplied measurements; missing attempts fail honestly. Optional `llmJudge` is stored as **secondary-only** and can never flip the verdict. Provenance (`DEMO`/`OBSERVED`) labels every row.
- `GET /api/evals/golden` (additive, auth-gated) — DEMO self-check leaderboard through the real scorer, explicitly labelled.
- Frontend: `EvalsPage` gains a golden-leaderboard card (`getGoldenEvals` in `api/client.ts`); existing surfaces untouched (routing test still passes).
- Release wiring: `qa/evals-golden-check.js` CLI (always exit 0, writes gitignored `qa/evals-golden-report.json`, optional `--save-baseline`; checked-in `qa/evals-golden-baseline.json` is the diff reference) + `evalsGolden` **non-blocking info stage** in `qa/release-check.js` (`WARN` never blocks) + `RELEASE.md` row. Promote by flipping `blocking: true` once stable.
- Baseline: 24/24, rate 1.0, $0.001354 avg, 583ms avg — see `BENCHMARK_REPORT.md` (real numbers only).

### Phase 2 — Browser/computer-use tool v1
Honest v1 scope: `browser_snapshot` (read-only) + `browser_navigate` (snapshot after navigation) share one engine — DEMO deterministic mock (zero network) or LIVE SSRF-guarded fetch (title/headings/links/redacted text + `engine` label). No hidden desktop control; no new dependency (Playwright reuse = existing e2e installation for interactive sessions; the worker snapshot engine stays dependency-free per the zero-dep backend rule).
- `backend/src/execution/browser-tool.js` — routes through `execution-policy` (disabled-by-default opt-in) + `environment.fetchUrlGuarded` (DNS-aware SSRF, per-hop re-validation, caps, redaction). DEMO mock is URL-hash deterministic.
- `tool-system.js` — placeholder (`available:false`, "not implemented") replaced with two real, still-`disabled:true` definitions (`navigate` HIGH+approval, `snapshot` MEDIUM like `fetch_url`); canonical overlay in `controller.js` propagates them to the registry as gated.
- `tool-executor.js` — `browser_navigate`/`browser_snapshot` handlers.
- `sandbox-worker/server.js` — `POST /v1/browse` (same token auth, secret refusal, DEMO mock, allowlist + shape/host guards, bounded fetch, `engine`-labelled responses) + exports for tests.
- `POST /api/browse` (additive, auth-gated) — DEMO mock in demo mode; LIVE requires explicit `networkAllowlist` in the body.
- Coverage: `backend/test/browser-tool.test.js` (definitions, determinism, SSRF/allowlist/policy rejection), 2 new `sandbox-worker` tests (11 passed), `e2e/browser-tool.spec.ts` (3 specs: determinism, no-fetch-in-DEMO, catalog visibility). Tool calls render through the existing generic tool-event rows/graph — no invented UI data.

### Phase 3 — Observability export
- `backend/src/telemetry/otlp-exporter.js` — zero-dep OTLP/HTTP exporter, **off by default** (`OTLP_ENABLED=1` + `OTLP_ENDPOINT` required). Pure `toSpan` mapper + `OtlpExporter` shipper. `telemetry-collector.js` untouched.
- `OBSERVABILITY.md` — full event→span table (GenAI conventions), enablement, failure semantics, non-exported data.
- `backend/test/otlp-exporter.test.js` — disabled-by-default, mapping, error-status mapping.

### Phase 5 — Proof artifacts
- `LICENSE` (ISC, matches `package.json`), README badges (CI workflow — real, license, Node 22 — real per `Dockerfile`), `BENCHMARK_REPORT.md` (real DEMO numbers + regression method), this handoff.

---

## 2. FILES CHANGED

### New files
| File | Lines | Description |
|------|-------|-------------|
| `backend/src/evals/golden-tasks.js` | 40 | 24 frozen golden tasks, 5 categories (data only) |
| `backend/src/evals/golden-runner.js` | ~200 | Deterministic scorer + leaderboard + `diffGoldenRuns` + `demoAttempts` |
| `backend/src/execution/browser-tool.js` | ~120 | Browser v1 engine (DEMO mock / SSRF-guarded fetch) |
| `backend/src/telemetry/otlp-exporter.js` | ~170 | Optional zero-dep OTLP/HTTP exporter (off by default) |
| `backend/test/evals-golden.test.js` | ~60 | Suite shape, determinism, honesty, diff detection |
| `backend/test/browser-tool.test.js` | ~70 | Definitions, determinism, SSRF/allowlist/policy gates |
| `backend/test/otlp-exporter.test.js` | ~50 | Disabled default, GenAI mapping, error status |
| `qa/evals-golden-check.js` | ~60 | Non-blocking CLI gate + baseline/diff writer |
| `qa/evals-golden-baseline.json` | — | Checked-in 24/24 DEMO baseline for regression diffs |
| `e2e/browser-tool.spec.ts` | ~60 | 3 DEMO specs (determinism, no-fetch, catalog) |
| `OBSERVABILITY.md` | ~70 | OTLP event→span mapping + ops guide |
| `BENCHMARK_REPORT.md` | ~60 | Real DEMO numbers + before/after method |
| `LICENSE` | 15 | ISC (matches `package.json`) |
| `SESSION_12_HANDOFF.md` | — | This file |

### Modified files
| File | Change |
|------|--------|
| `backend/test/intelligence-analytics.test.js` | TEST BUG fix: fixtures relative to now (30d window) |
| `qa/secret-scan.js` | INFRA BUG fix: planted secret by concatenation (no self-trip) |
| `backend/server.js` | + `GET /api/evals/golden`, + `POST /api/browse` (both additive, auth-gated) |
| `backend/src/execution/tool-system.js` | Browser placeholder → 2 real gated definitions |
| `backend/src/impl/tool-executor.js` | + `browser_navigate`/`browser_snapshot` handlers |
| `sandbox-worker/server.js` | + `POST /v1/browse` + test exports |
| `sandbox-worker/worker.test.js` | + 2 browse validation tests (9→11) |
| `frontend/src/api/client.ts` | + `getGoldenEvals` |
| `frontend/src/pages/pages.tsx` | `EvalsPage` + golden leaderboard card (existing list untouched) |
| `frontend/src/pages/ops.tsx` | Untouched (extends existing eval surfaces; golden card lives on `EvalsPage`) |
| `package.json` | `test:all` + 3 new suites |
| `qa/release-check.js` | + non-blocking `evalsGolden` info stage (`WARN` never blocks) |
| `qa/.gitignore` | + `evals-golden-report.json` |
| `qa/RELEASE.md` | + `evalsGolden` non-blocking row; e2e row notes browser-tool DEMO |
| `README.md` | + CI / license / Node badges (all real) |

---

## 3. APIs / CONTRACTS CHANGED

Additive only — no existing contract modified (`CONTRACTS.md` untouched):
- `GET /api/evals/golden` → `{ tasks, suite: { modelId, provenance, total, passed, successRate, avgCost, avgLatencyMs, categories[], rows[] }, note }`. Auth-gated like `/api/evaluations`. Provenance always `DEMO` in this build.
- `POST /api/browse` body `{ url, maxBytes?, networkAllowlist? }` → `{ snapshot }` or `{ code, error }` (400 bad params, 403 policy/SSRF, 502 fetch failure). Auth-gated. DEMO → mock; LIVE → allowlisted guarded fetch.
- Sandbox `POST /v1/browse` — same boundary as `/v1/execute` (token, secret refusal, bounds), documented in `server.js` header.
- No event-type changes: browser tool calls flow through existing `tool.*` trace events, so Run Studio / Live Intelligence / execution graph render them with zero UI contract change.

---

## 4. DATABASE CHANGES

No new migration. `backend/migrations/003_run_index_retention.sql` (from prior work) verified idempotent against Postgres 16: first apply creates 3 indexes + `INSERT 0 1`; second apply skips (`NOTICE … already exists`) + `INSERT 0 0`. Test tables dropped afterwards (the verification DB was a shared dev database — confirmed clean).

---

## 5. EVENT CHANGES

None. Browser snapshots reuse the existing tool-result → trace-event path (`tool.completed`/`tool.failed` with `tool: browser_snapshot`), so SSE replay/dedupe/terminal-state semantics are inherited, not reimplemented.

---

## 6. CONFIG / ENVIRONMENT CHANGES

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTLP_ENABLED` | unset (off) | `1` enables the OTLP exporter |
| `OTLP_ENDPOINT` | unset | OTLP/HTTP traces URL (required when enabled) |
| `OTLP_HEADERS` | unset | `k=v,k2=v2` extra headers |
| `OTLP_TIMEOUT_MS` | 5000 (max 15000) | Export timeout |

No other env changes. `RUNTIME_MODE=demo` still means zero keys everywhere (golden CLI, browser mock, e2e all verified keyless). Backend stays zero-dependency: OTLP is raw `http`/`https`, browser LIVE is the existing guarded fetch — `ARCHITECTURE.md` justification holds (no new runtime dep; Playwright reuse is the pre-existing e2e install).

---

## 7. TESTS EXECUTED

```
backend  test:all ................. EXIT 0 (446 ✓ pre-existing + evals-golden + browser-tool + otlp-exporter + sandbox 11)
frontend vitest ................... 16 files, 161 tests, all pass
frontend build .................... tsc --noEmit + vite build OK (409ms)
e2e playwright (chromium) ......... 31 passed (28 prior + 3 browser-tool)
secret-scan ....................... --self-test PASS; full scan: 0 findings / 296 files
clean-install / ci-release-gate ... PASS / 5 passed
release:check --fast .............. FAST GATE PASS
release:check (full) .............. RELEASE READY (8/8: cleanInstall, ciGate, secretScan, backend, frontend, frontendBuild, e2e, containerSmoke)
migration 003 ..................... applied twice on PG16, idempotent; tables cleaned up
static-console .................... / + /console/runs/abc123 → shell (200); /api/* → fallthrough
CI (origin/main, run 36211217139) . backend✓ frontend✓ build✓ e2e✓ docker-build✓ container-smoke✓ compose-smoke✓ | release-image✗ (Docker Hub login: secrets missing) | release-latest skipped
```

---

## 8. TEST RESULTS DETAIL

- New suites: `evals-golden` (shape/determinism/honesty/diff — incl. a synthetic one-task corruption detected as exactly one `coding` regression), `browser-tool` (definitions gated-yet-implemented; DEMO determinism incl. cross-call `deepStrictEqual`; LIVE loopback/allowlist/shell-meta rejection without sockets; policy opt-in check), `otlp-exporter` (disabled default, GenAI attr mapping, ERROR status), sandbox browse (mock determinism + 5-way validation rejection).
- E2E: `browser-tool.spec.ts` initially failed on a wrong expectation (expected 403 for a foreign host in DEMO); corrected to the honest DEMO semantic — DEMO never fetches, so it returns the mock (LIVE rejection stays in unit tests where the live policy can be constructed). 3/3 pass.
- Pre-existing suites: zero regressions. The only failures encountered this session were the two Phase-0 blockers above, both fixed with passing suites, plus the e2e expectation correction.

---

## 9. KNOWN LIMITATIONS

- **Browser v1 is a snapshot tool, not computer-use.** No clickable interaction loop, no multi-step Playwright session inside the sandbox, no DOM-action grounding. The `engine` field (`mock`/`fetch`) always discloses this. Interactive Playwright sessions run operator-side via the e2e install.
- **Evals v2 measures the scorer + fixtures, not production quality.** All leaderboard numbers are `DEMO`-labelled fixtures through the real pipeline. The first `OBSERVED` numbers arrive with the next router change + recorded attempts.
- **Golden gate is non-blocking** (`WARN`) until stability is demonstrated — by design, documented in `RELEASE.md`.
- **OTLP is export-only** (no metrics/logs signals, no tail-sampling, no collector auth beyond static headers).
- **No live public URL.** The compose stack is CI-verified (topology smoke ✓) but no host was provisioned from this session.
- **CI `release-image` fails on Docker Hub login** — missing `DOCKER_HUB_USERNAME`/`DOCKER_HUB_TOKEN` repo secrets. Every product job is green; this is repo-settings work, not code.
- `npm run build:frontend` chunk-size warning (>500kB) is pre-existing and unchanged.

---

## 10. RISKS

- **High** — none open on product paths. The two P0-adjacent blockers (time-bomb fixture, self-tripping scanner) are fixed with regression coverage.
- **Medium** — Docker Hub secrets + public-host provisioning are the only blockers to "shipped + live". Both are ops clicks, but they gate the Definition of Done items below.
- **Medium** — Browser LIVE fetch inherits the documented TOCTOU residual of the SSRF layer (validation vs connect re-resolution); firewall allowlisting remains authoritative for hostile-DNS models. Unchanged from the existing `fetch_url` posture.
- **Low** — Golden-task staleness: frozen tasks drift from product reality over time. Mitigation is the append-new-ids rule in `golden-tasks.js` header + the promotion checklist in §12.

---

## 11. DEPENDENCIES FOR SESSION 13

1. **Repo settings (5 min, owner):** add `DOCKER_HUB_USERNAME` / `DOCKER_HUB_TOKEN` secrets (and optional `IMAGE_REPO` var) → re-run CI → `release-image` + `release-latest` should go green with no code change.
2. **Provision a host** (Oracle Always Free per `deploy/backup-procedures.md`, or Fly.io/Railway): `docker compose -f deploy/docker-compose.yml up --build -d` with `RUNTIME_MODE=demo`, real `DATA_ENCRYPTION_KEY`, `FRONTEND_ORIGIN=https://<host>`; run `smoke-topology.sh`; put the URL at the top of `README.md`.
3. **Promote the golden gate:** after 2–3 green weeks, flip `blocking: true` for `evalsGolden` in `qa/release-check.js` and record the first real before/after router comparison in `BENCHMARK_REPORT.md`.
4. **Browser v2 (if wanted):** Playwright-driven interactive sessions inside the worker (browser install + firewall egress + action grounding + approval per action). The v1 API shape (`/v1/browse`, `engine` label) is forward-compatible — add `engine: 'playwright'` + action endpoints.
5. **Demo video:** drive the `core-journey.spec.ts` steps against the live URL; screenshot the Run Studio execution graph mid-run.

---

## 12. EXACT THINGS SESSION 13 MUST VERIFY

- [ ] `git status` clean; `git log origin/main` contains the Session-12 commits below.
- [ ] `npm run test:all` exit 0; `npm run test:frontend` 161 pass; `npm run test:e2e` 31 pass (fresh `node_modules`).
- [ ] `npm run release:check` → `RELEASE READY` in `qa/release-report.json` (full, incl. container smoke).
- [ ] GitHub Actions green on `origin/main` **including** `release-image` (needs Docker Hub secrets — the only red job in Session 12).
- [ ] `GET /api/evals/golden` returns 24 tasks, `provenance: DEMO`; console Evaluations page shows the golden card.
- [ ] `POST /api/browse { url: 'demo:x' }` → `engine: mock`; sandbox `POST /v1/browse` demo → mock; non-allowlisted LIVE → 403 (unit-covered).
- [ ] `LICENSE`, README badges, `OBSERVABILITY.md`, `BENCHMARK_REPORT.md` present.
- [ ] Public URL live in DEMO mode (or an explicit decision recorded here if deferred).

### Commits shipped (Session 12, on top of `b175f8e`)
- `fix(qa)` time-relative fixtures + non-self-tripping scanner (pushed pre-feature; CI product jobs green)
- `feat(evals)` golden suite + runner + API + console card + non-blocking gate + baseline + report
- `feat(browser)` v1 engine + definitions + executor + sandbox `/v1/browse` + `/api/browse` + e2e
- `feat(telemetry)` OTLP exporter + `OBSERVABILITY.md`
- `docs` LICENSE + badges + RELEASE row + this handoff

### SESSION BOUNDARIES
- **This session:** Phase-0 verification, Evals v2 (non-blocking), Browser v1 (snapshot), OTLP (off-by-default), proof artifacts. No contract breaks, no invented data, zero-dep backend preserved, DEMO keyless preserved.
- **Next session:** repo secrets → green publish; host → live URL; golden-gate promotion; optional browser v2.
- **Do NOT:** invent a public URL, promote the golden gate without stability evidence, enable OTLP by default, or widen browser policy defaults (disabled-by-default stays).

---
**Handoff complete.** The single most valuable remaining step is 5 minutes of repo settings (Docker Hub secrets) + host provisioning — everything shippable is already verified on disk and on CI's product jobs.
