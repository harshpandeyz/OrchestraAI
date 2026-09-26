# OrchestraAI — Release Gate & QA Playbook

This document is the authoritative definition of what it means for OrchestraAI
to be **RELEASE READY** versus **RELEASE BLOCKED**. It is owned by Session 5
(QA / E2E / release engineering). The single entry point is:

```bash
npm run release:check
```

which writes a machine-readable decision to `qa/release-report.json` and prints
a `RELEASE READY` / `RELEASE BLOCKED` verdict.

---

## Release decision

A release is **READY** only when every *blocking* gate reports `PASS`. A single
blocking `FAIL` (or a blocking gate that was not actually run) makes the release
**BLOCKED**. Warnings do not block by themselves, but they are reported.

There is intentionally no `|| true`, no error→warning conversion, and no silent
skip. A gate that cannot run is reported as `SKIPPED` with a reason, and if that
gate is release-blocking the overall verdict is `BLOCKED` (incomplete), never
`READY`.

### Machine-readable outcome

`qa/release-report.json`:

```json
{
  "product": "orchestraai",
  "generatedAt": "2026-09-06T00:00:00.000Z",
  "gitSha": "...",
  "status": "PASS",
  "verdict": "RELEASE READY",
  "checks": {
    "cleanInstall": "PASS",
    "ciGate": "PASS",
    "secretScan": "PASS",
    "backend": "PASS",
    "frontend": "PASS",
    "frontendBuild": "PASS",
    "e2e": "PASS",
    "containerSmoke": "SKIPPED"
  },
  "failures": []
}
```

`status` is `PASS`, `FAIL`, or `INCOMPLETE`. The script exits `0` only on
`PASS`.

---

## Gate stages (blocking unless noted)

| Gate                | Command                                   | Blocking | Notes |
| ------------------- | ----------------------------------------- | -------- | ----- |
| Clean install       | `qa/release-check.js` step              | **yes**  | Stray tracked artifacts (`node_modules`, `dist`, `.env`, `.DS_Store`), lockfile drift. |
| CI release gate     | `node qa/ci-release-gate.test.js`         | **yes**  | Publish jobs never reachable from a PR. |
| Secret scan         | `node qa/secret-scan.js`                 | **yes**  | Obvious accidental secrets in tracked source. |
| Backend tests       | `npm run test:all`                        | **yes**  | Runtime, auth, tenant isolation, recovery, queue, sandbox, providers, economics, intelligence. |
| Frontend tests      | `npm run test:frontend`                   | **yes**  | Vitest console tests. |
| Frontend build      | `npm run build:frontend`                  | **yes**  | `tsc --noEmit` typecheck + Vite production build. |
| Browser E2E         | `npm run test:e2e`                        | **yes**  | Core journey, auth, tenant isolation, navigation, SSE, responsive, a11y. |
| Container smoke     | `bash deploy/scripts/smoke-container.sh`  | **yes**  | Production image boots, `/api/health`, `/api/ready`, console served. |
| Full topology smoke | `bash deploy/scripts/smoke-topology.sh`   | **yes*** | Postgres + Redis + sandbox. Slow; requires Docker. `*` runs on push/release CI, not the local fast path. |

### Release-blocking severities

- **P0** — block immediately: data loss, cross-tenant leak, auth bypass, secret
  exposure, unsafe duplicate destructive execution, production cannot boot,
  critical migration failure.
- **P1** — block public release: core workflow broken, run cannot complete, SSE
  loses terminal state, wrong page for a core feature, production build broken,
  critical accessibility failure, critical recovery failure.
- **P2** — fix before broad launch: non-critical UX/navigation regression,
  minor responsive defect, secondary feature broken.
- **P3** — minor polish / technical debt.

---

## How to run

```bash
# Fast path (no Docker, no browser): clean-install + backend + frontend + build
# + CI gate + secret scan.
npm run release:check

# Full path: also boots the browser suite and the production container smoke.
# Requires Docker (daemon running) and Playwright browsers.
npm run release:check -- --full

# Individual stages
npm run test:e2e               # Playwright browser suite (builds dist if needed)
npx playwright install chromium # one-time browser fetch
bash deploy/scripts/smoke-container.sh
bash deploy/scripts/smoke-topology.sh
```

### Required environment

None for the fast path. The backend tests and browser suite run in **DEMO** mode
against an isolated throwaway data directory (never a real database, never a
real provider account, never real customer data).

For the full path:
- `docker` daemon running (container + topology smoke).
- Playwright Chromium installed (`npx playwright install chromium`).

---

## Defect triage

Every failing test is classified before any change is made:

- `PRODUCT BUG` — the application is wrong. **Report to the owning session; do
  not patch the product.**
- `TEST BUG` — the test encodes a wrong expectation. Fix the test (keeping the
  production invariant intact).
- `ENVIRONMENT BUG` — missing dependency, wrong runtime. Fix the environment.
- `INFRASTRUCTURE BUG` — CI/Docker/build tooling. Fix the infrastructure.
- `FLAKY / NONDETERMINISTIC` — intermittent. Diagnose root cause; retries must
  not hide application nondeterminism.

A test must pass because the product is correct. Never weaken an assertion,
fake success, or suppress a failing test to obtain green CI.

### Defect report format

```
ID / Severity / Area / Environment
Steps to reproduce
Expected
Actual
Evidence
Owner
Regression test
```

---

## E2E coverage map

- `e2e/core-journey.spec.ts` — landing → get started → demo → task → run →
  progress/events → completion → history → detail (the primary user journey).
- `e2e/navigation.spec.ts` — every major destination renders the correct page
  (including the confirmed `Evaluations` → `Alerts` and `Traces` →
  `Intelligence` regressions).
- `e2e/auth.spec.ts` — signup/login/logout/protected routes/invalid credentials.
- `e2e/tenant-isolation.spec.ts` — cross-tenant project/run access is denial.
- `e2e/sse.spec.ts` — stream connect, terminal finalization, dedupe.
- `e2e/responsive.spec.ts` — major viewports have no horizontal overflow and a
  usable primary action.
- `e2e/accessibility.spec.ts` — axe-style automated checks on core surfaces.

## Known limitations (honest)

- Deep links are state-driven (`?view=` query parameter), not a full URL router;
  the browser suite exercises the real navigation mechanism rather than
  asserting a router that does not exist.
- Visual-pixel regression is intentionally out of scope of the fast gate to
  avoid false alarms from live metrics/timestamps; layout/overflow/state
  correctness is asserted instead.
- Multi-browser (Firefox/WebKit) is not run by default to bound CI cost;
  Chromium is the required baseline.