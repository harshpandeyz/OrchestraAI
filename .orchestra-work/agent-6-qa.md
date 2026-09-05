# Agent 6 — QA / Red Team Handoff

## Test Execution Summary

### Backend Test Suites (final run — all green)
| Suite | Passed | Failed |
|-------|--------|--------|
| runtime.test.js | 45 | 0 |
| session1-regression.test.js | 27 | 0 |
| intelligence.test.js | 52 | 0 |
| session3-execution.test.js | 48 | 0 |
| recovery.test.js | 13 | 0 |
| ssrf.test.js | 19 | 0 |
| persistence.test.js | 7 | 0 |
| event-contract.test.js | 9 | 0 |
| economics.test.js | 9 | 0 |
| model-failover.test.js | 9 | 0 |
| prompt-semantic.test.js | 10 | 0 |
| backend-finalization.test.js | 24 | 0 |
| integration.test.js | 31 | **1** (Scenario 7 — see below) |
| provider-config.test.js | 16 | 0 |
| production-boundaries.test.js | 11 | 0 |
| privacy.test.js | 1 | 0 |
| auth-integration.test.js | 1 | 0 |
| savings-engine.test.js | 18 | 0 |
| analytics.test.js | pass | 0 |
| **TOTAL** | **350** | **1** |

### Frontend Test Suites
| Suite | Passed | Failed |
|-------|--------|--------|
| All vitest suites (11 files) | 128 | 0 |
| Production build (tsc + vite) | pass | 0 |

### QA Red Team Custom Tests
| Suite | Passed | Failed |
|-------|--------|--------|
| red-team-economics.test.js | 20 | 0 |

---

## Findings by Severity

### P1 — Production Correctness

#### Finding 1: Integration Scenario 7 — `budget.exceeded` event not emitted
- **Test**: `Scenario 7: budget nearly exhausted → safe termination`
- **Expected**: `budget.exceeded` event emitted when budget is tiny (`0.0000001`)
- **Actual**: Run fails with `code: 'budget_exceeded'` but the `budget.exceeded` event is never emitted
- **Reproduction**: `node backend/test/integration.test.js` — Scenario 7 consistently fails
- **Root cause**: In DEMO mode, the model call cost is $0 or near-zero. The budget of `0.0000001` is never exceeded during execution because the run starts with `spent=0` and demo calls record $0 cost. The `budget.exceeded` event is only emitted inside `_handleBudgetExceeded()` (orchestrator.js:1783) which is called when `isBudgetExceeded()` returns true at the loop top. But if the demo model is free, the budget is never exceeded.
- **Likely file/function**: `backend/src/core/orchestrator.js:723-724` (pre-check) and `orchestrator.js:748-750` (loop-top check)
- **Fix recommendation**: Either (a) the test budget should be set below the model's actual cost so the budget genuinely overflows during execution, or (b) the pre-check at line 723 should also emit `budget.exceeded` before throwing. The test itself may be wrong for DEMO mode where cost is zero.
- **Note**: This is the ONLY failing test across the entire suite. All other 349 tests pass.

#### Finding 2 (RESOLVED — another agent fixed): `eliminated is not defined` in model-router.js
- **Was**: `ReferenceError: eliminated is not defined` at `model-router.js:267` causing 3 test failures in `provider-config.test.js` (tests 10, 11, 12)
- **Status**: FIXED — all 16 provider-config tests now pass
- **Note**: Agent who fixed this should verify the fix is clean

### P2 — Important UX / Reliability

#### Finding 3: Docker Healthcheck will always fail (curl not installed)
- **File**: `Dockerfile:51-52` and `healthcheck.sh`
- **Expected**: Healthcheck uses `curl -sf http://127.0.0.1:8787/api/health`
- **Actual**: `node:20-alpine` does NOT include `curl`. The Dockerfile never installs it. The healthcheck binary does not exist at runtime.
- **Impact**: Container healthcheck will always fail (exit 1). Docker will report container as unhealthy. Kubernetes/readiness probes will fail. The container runs but is marked unhealthy.
- **Reproduction**: `docker build -t orchestraai . && docker run orchestraai` → healthcheck fails
- **Fix**: Add `RUN apk add --no-cache curl` before the healthcheck line in Dockerfile, OR rewrite healthcheck.sh to use Node.js `fetch` or `wget` (wget IS available in Alpine by default)

#### Finding 4: Test files shipped in production Docker image
- **File**: `Dockerfile:38`
- **What**: `COPY backend/test/runtime.test.js backend/test/fixture-pass.js ./backend/test/`
- **Impact**: Unnecessary attack surface and image size. Test code should not be in production.
- **Fix**: Remove line 38 from Dockerfile, or add test files to `.dockerignore`

#### Finding 5: Backend deps not pinned (no root package-lock.json)
- **File**: `Dockerfile:33` — `RUN npm install` (not `npm ci`)
- **Impact**: Non-deterministic dependency resolution across builds. Supply chain risk.
- **Fix**: Generate `package-lock.json` at root, use `npm ci --omit=dev`

#### Finding 6: Dockerfile `.dockerignore` incomplete
- **Missing patterns**: `qa/`, `sandbox-worker/`, `.orchestra-work/`, `*.md`, `.env.*`, `*.pem`, `*.key`
- **Impact**: Unnecessary files in build context, potential documentation/secret leakage into image
- **Fix**: Add missing patterns to `.dockerignore`

### P3 — Informational / Cosmetic

#### Finding 7: Memory manager owner isolation is fail-open
- **File**: `backend/src/impl/memory-manager.js:48-53`
- **Description**: When both the memory item AND the runtime have no `userId`/`ownerId`, the owner check is skipped. Items without `orgId` are visible to all orgs.
- **Impact**: In single-process deployments without auth enabled (dev mode), cross-tenant memory visibility is possible. With auth enabled, this is mitigated because auth provides the identity.
- **Risk level**: Low — mitigated by auth, but worth documenting

#### Finding 8: Cache L1 (exact key) has no tenant scoping
- **File**: `backend/src/impl/cache-manager.js:298-310`
- **Description**: The L1 exact cache is a process-global Map. Cache keys are not namespaced by tenant at this level. Cross-tenant cache hits are theoretically possible if key collision occurs.
- **Impact**: Low — keys are derived from content fingerprints + model ID + provider, making collisions unlikely in practice. L2 (scoped) and L3 (semantic) layers DO enforce tenant filtering.

#### Finding 9: CostEstimator does not guard negative token counts
- **File**: `backend/src/cost/cost-estimator.js:60-108`
- **Description**: `estimateModelCost()` accepts negative `inputTokens`/`outputTokens` without validation. Negative values produce negative cost estimates.
- **Impact**: Low — callers generally validate inputs, but the estimator itself does not guard.
- **Fix**: Add `Math.max(0, tokens)` guards

#### Finding 10: ModelStickinessManager maps grow without cleanup
- **File**: `backend/src/decisions/switching-cost.js:111-173`
- **Description**: `lastSwitchTime` and `switchCounts` Maps keyed by `runId` have no automatic cleanup. A `reset()` method exists but must be called explicitly.
- **Impact**: Low — in practice, runs complete and GC collects; but in very long-running processes with many runs, memory could grow.
- **Fix**: Add TTL-based or size-bounded eviction

---

## Security Assessment

### No P0 security findings.
All auth, tenant isolation, credential storage, SSRF protection, and injection defenses are well-implemented and tested.

### Security strengths confirmed:
1. **Auth**: Timing-safe comparisons, fail-closed, session admin cannot escalate to global admin
2. **Tenant isolation**: Consistent orgId/ownerId checks across all API routes
3. **Credential storage**: AES-256-GCM encryption at rest, metadata-only API exposure
4. **SSRF**: Three-gate defense (URL shape → DNS validation → per-redirect re-validation)
5. **Command injection**: `execFile` (no shell), command guard with metachar blocking, allowlisted binaries only
6. **Path traversal**: `sandboxPath()` with realpath resolution and workspace boundary checks
7. **Approval lifecycle**: Single-use, expiry, run/action/params fingerprint binding
8. **Secret redaction**: Multi-layer (config.redact, privacy.sanitize, memory-intelligence, sandbox-env)
9. **CORS**: Origin-restricted, no wildcards, CSP frame-ancestors 'none'

---

## Deployment Findings

1. **Docker healthcheck will fail** (P2 — Finding 3 above)
2. **Test files in production image** (P2 — Finding 4 above)
3. **No root package-lock.json** (P2 — Finding 5 above)
4. **Incomplete .dockerignore** (P2 — Finding 6 above)
5. **Node version consistency**: Main image uses Node 20, sandbox-worker uses Node 22
6. **.env.example ships with `AUTH_ENABLED=false`** — fine as documentation but dangerous if copied to `.env` for production
7. **Frontend build and tests all pass** — clean

---

## What Must Be Fixed Before Release

1. **P1**: Fix integration Scenario 7 (budget.exceeded event not emitted in DEMO mode) — either fix the test or fix the event emission
2. **P2**: Install `curl` in Docker Alpine image or rewrite healthcheck without curl
3. **P2**: Remove test files from production Docker image
4. **P2**: Generate root `package-lock.json` and use `npm ci` in Dockerfile

## What Is Nice to Have

5. **P3**: Add tenant scoping to L1 cache key derivation
6. **P3**: Add negative token guards to CostEstimator
7. **P3**: Add Map cleanup to ModelStickinessManager
8. **P3**: Extend .dockerignore with `qa/`, `sandbox-worker/`, `*.md`

---

## Files Created (QA-only ownership)

- `qa/red-team-economics.test.js` — 20 tests covering platform fees, reference models, canonical records, cost estimation, and routing edge cases. All pass.

---

## Agent 7 Integration Notes

1. The Scenario 7 failure needs investigation: is the test wrong (expects budget.exceeded in DEMO mode where cost is $0) or is the orchestrator missing an event emission at the pre-check path?
2. The `eliminated` variable bug in model-router.js was resolved between runs — verify the fix is clean and doesn't have side effects
3. Dockerfile healthcheck fix is straightforward: either `apk add curl` or rewrite with Node.js fetch
4. All existing test suites are green (except Scenario 7), so any fixes should not break the existing 349-passing tests
