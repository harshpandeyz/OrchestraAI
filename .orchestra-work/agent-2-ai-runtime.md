# Agent 2 — AI Runtime / Optimization Handoff

## Optimizer objective (plain English)

Selection minimizes **expected total task cost per expected success** over the
eligible pool (lower wins):

- `expectedTotalCostUsd = provider(input, output, cached-input)`
  `+ bounded-retry(reliability, maxRetries ≤ 5)`
  `+ switching(incumbent → candidate)`
  `+ tool/continuation (policy-provided numbers only, else 0)`
  `+ latency penalty (only when policy prices latency via`
  `policy.latencyCostPerMsUsd, else 0)`
- `costPerSuccessUsd = expectedTotalCostUsd / max(success, 0.05)`
- `objectiveValue = costPerSuccessUsd` when any success signal exists,
  else `expectedTotalCostUsd`. Unknown pricing → `null` (never $0, never
  competes on cost).
- `success` prefers empirical `predictedSuccess`, then `taskFitScore`, then
  registry `quality` (basis recorded per candidate).
- Winner: lowest objective; ties → higher weighted score → modelId asc.
  The weighted score is unchanged and stays the ranking/explanation signal.

Pure deterministic code: `backend/src/decisions/routing-objective.js`
(no training, no randomness). Formula string exported as
`OBJECTIVE_FORMULA` and attached to every `evaluation.objective` and
`decision.metadata.objectiveFormula`.

## Invariant changes (behavioral)

1. **Canonical eligibility pipeline** (`runEligibility` in `model-router.js`):
   availability → provider → pricing → capability/context → quality →
   latency → reliability → budget → scoring → selection. One pool threads
   through; excluded models never re-enter. **Bug fixed**: quality floor used
   to refilter the broad pool and resurrect unpriced models; it now filters
   survivors only. Empty-after-availability throws `no_models` (failover
   contract preserved); empty-after-pricing throws `insufficient_pricing`.
2. **Pinned economics**: preferred/retained paths report real expected cost
   via `realExpectedCostFor` (never 0). Decisions carry
   `selectionReason` (`user_preference` | `optimized` | `stickiness`) and
   `optimizationBypassed` (bool). An ineligible pin (e.g. unpriced) falls
   back to the eligible pool with a `pinned_ineligible` factor.
3. **Retention honesty**: incumbent winning on cost while a challenger leads
   on score yields `MODEL_RETENTION` with both sides compared
   (`score_challenger`, `objective`, `switch_cost` factors) — no fake
   hysteresis. Switch path `expectedCost` is now the post-switch expected
   total, not just the switching fee.
4. **Budget gate**: hard budget (explicit, `budgetEnforcement:'hard'`, or
   remaining ≤ $0.01 dust) excludes with `budget_constraint`; otherwise
   candidates stay eligible (soft penalty flows through the objective).
5. **Cache dollars removed**: `getCacheState` no longer contains a hardcoded
   rate. `savedUsd` derives from caller-supplied pricing via
   `economics/economic-states.cacheValueUsd`, else 0 labelled `unpriced`
   with `valueBasis`. New facts: `describeEntry`, `describeValue`,
   `resolveReuse` (L1 local exact → L2 scoped exact → L3 semantic project).
   All prior gates kept (tenant/project isolation, fingerprint drift,
   freshness incl. per-entry maxAge, tool deps, model-compat and pure-answer
   gates in `resolveReuse`); a gated miss is never upgraded.
6. **Context categories**: `MUST_KEEP / SHOULD_KEEP / OPTIONAL /
   NEVER_COMPRESS` (`categorizeContextItem`). MUST_KEEP (user task,
   constraints, success criteria, system) selects first, bypasses the
   relevance threshold, is never compressed; NEED-not-fit closure omits the
   dependent with an explicit reason instead of detaching it. `overBudget`
   flag surfaces the pathological MUST_KEEP-overflow case honestly.
   `compressContext` additionally excludes NEVER_COMPRESS.
7. **Memory candidates**: `proposeMemory` → classify → confidence →
   policy/visibility → persist. `writeLongTermMemory` quarantines
   unvetted `model:*` keyword-like output, secret-bearing content, and
   policy-banned durable writes to working memory (flagged
   `quarantined` + reasons); direct long-term calls for other sources
   persist as before. All writes redact secrets (`redactSecrets`).
   Retrieval demotes conflicted records ×0.7 (still visible). Owner/user
   isolation added fail-open (applies only when both sides carry identity).
   `approveMemoryCandidate` promotes with provenance.
8. **Economic states**: new `economics/economic-states.js` labels
   `estimated | observed | modeled_baseline | modeled_savings |
   verified_savings | invoice_reconciled` (canonical record untouched as
   source of truth). `CostEstimator.estimateModelCostStrict` returns null
   on unknown registry pricing (forecasting path keeps its fallback).
9. **Learning**: performance records keep model×category counters plus
   per-workload slices (context bucket s/m/l × tool profile); slices with
   <2 attempts defer to the category rate. `predictedSuccess(id, cat,
   workload?)` is backward compatible; router passes `{contextTokens}`.
   `evaluateOutcome` adds `status` (`succeeded|failed|unknown|conflicted|
   verification_required`), `executionCompleted`, `conflicted`;
   `taskSuccess` tri-state semantics unchanged.

## Changed files (Agent 2 only)

- `backend/src/decisions/routing-objective.js` (new)
- `backend/src/impl/model-router.js`
- `backend/src/impl/cache-manager.js`
- `backend/src/impl/context-manager.js`
- `backend/src/impl/memory-manager.js`
- `backend/src/economics/economic-states.js` (new)
- `backend/src/cost/cost-estimator.js` (additive method only)
- `backend/src/intelligence/context-engine.js`
- `backend/src/intelligence/router-intelligence.js`
- `backend/src/intelligence/performance-store.js`
- `backend/src/intelligence/intelligence-store.js`
- `backend/src/intelligence/outcome-evaluator.js`
- `backend/src/intelligence/memory-intelligence.js`
- `backend/src/intelligence/semantic-cache.js`
- `backend/test/agent2/ai-runtime.test.js` (new, 18 tests)

## Tests

- New: `node backend/test/agent2/ai-runtime.test.js` → 18/18 pass
  (unpriced re-entry ×2, pinned cost ×2, expected-cost routing, budget
  hard/soft, cache economics + unsafe-reuse, MUST_KEEP, closure,
  compression protection, memory quarantine, secret redaction, conflict
  demotion, outcome status, learning priors, workload ingest).
- Regression (all green): intelligence 52/52, runtime 45/45, failover 9/9,
  economics 9/9, savings 18/18, prompt-semantic 10/10, finalization 24/24,
  session1 27/27.

## Interface assumptions / notes for other agents

- **Agent 1 (persistence)**: `performance.records` entries now carry
  `workloads: {key: {attempts, successes}}`; `load()` tolerates absence.
  Semantic-cache entries carry `pureAnswer`, `compatibleModels`,
  `maxAgeMs` (all optional, old dumps load fine). Memory records may carry
  `candidateKind/candidateConfidence/quarantined/quarantinedFrom/
  quarantineReasons`. Routing-history entries unchanged. No persistence
  redesign; dump/load remain plain JSON.
- **Agent 3/7 (orchestrator/API/frontend)**: no contract breaks.
  `GET /state` snapshot untouched (snapshot.js already prices cache from
  registry; `cache-manager.getCacheState` now optionally takes pricing as
  2nd arg). Routing decisions gain `selectionReason`,
  `optimizationBypassed`, `metadata.objectiveFormula`,
  `metadata.eligibility`; candidates gain `objective {...}`; context
  selection entries gain `category`; outcome evals gain `status`,
  `executionCompleted`, `conflicted`. All additive.
  The orchestrator's keyword-triggered `writeLongTermMemory` for
  `model:*` output will now quarantine to working memory — this is the
  intended fix; use `approveMemoryCandidate` (or `durable:true`) for
  genuinely vetted facts.
- Watch: `resolveReuse` increments hit/miss stats; orchestrator cache-call
  sites were not rewired (kept local to avoid cross-agent conflicts) —
  adopt it in the model-call path when ready.
