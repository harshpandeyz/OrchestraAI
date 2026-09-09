# OrchestraAI — Adaptive Agent Runtime

Three-panel **OrchestraAI console**: runs on the left, agent workspace in the
center, runtime intelligence on the right.

The backend is a real end-to-end runtime: user task → context → model routing →
real provider call (OpenRouter/OpenAI/Anthropic) or explicit DEMO mock → tool
execution → memory/cache/telemetry → SSE → reevaluate → complete. See
`ARCHITECTURE.md` / `CONTRACTS.md` / `.env.example`.

## Run it
```bash
# terminal 1 — runtime API + SSE
npm start          # :8787 (deployment health is LIVE iff a deployment key exists; otherwise DEMO)

# terminal 2 — console
cd frontend && npm install && npm run dev   # :5173 (proxies /api → :8787)
```

No `.env` editing required: open the console → welcome guide → **Settings →
Providers** → paste a key → **Test & save**. Keys are verified against the
real provider, encrypted at rest, and never rendered again. `.env` remains
for deployment/bootstrap preconfiguration (see `.env.example`).

## Production deployment

```bash
POSTGRES_PASSWORD=... SANDBOX_WORKER_TOKEN=... \
DATA_ENCRYPTION_KEY=... FRONTEND_ORIGIN=https://console.example \
docker compose -f deploy/docker-compose.yml up --build -d
```

What you get: API control plane + **Postgres** (authoritative durable store:
users, sessions, orgs, projects, runs, events, snapshots, idempotency,
evaluations, intelligence, billing, audit — migrations in
`backend/migrations/`, applied by the entrypoint, fatal on failure) +
**Redis** (locks, rate limits, durable `run.execute` queue) + **isolated
sandbox worker** (customer code runs there via bounded workspace snapshots,
never in the API process).

`DATABASE_URL` and `REDIS_URL` are **derived automatically** from the
compose `postgres`/`redis` services (`postgres://orchestraai:<password>@postgres:5432/orchestraai`
and `redis://redis:6379`) — you normally do not set them. Set them only to
point at an external datastore. `ISOLATED_EXECUTOR_TOKEN` (the API's client
token for the sandbox worker) is likewise derived from `SANDBOX_WORKER_TOKEN`
unless explicitly overridden. Required input secrets are `POSTGRES_PASSWORD`
(URL-safe), `SANDBOX_WORKER_TOKEN`, `DATA_ENCRYPTION_KEY` (32 random bytes as
64 hex or 44 base64 chars), and `FRONTEND_ORIGIN`. Missing secrets fail
compose interpolation; unreachable Postgres/Redis fail `/api/ready`, never
silent fallback. No object store is provisioned (no app path needs one); no
default passwords or public artifact policies anywhere. See
`ARCHITECTURE.md` (operational assumptions) and `deploy/backup-procedures.md`.
Production: `cd frontend && npm run build` → `frontend/dist`, which the runtime serves itself on :8787 (one port: console + API). Docker: `docker build -t orchestraai .` (Dockerfile provided; requires a running Docker daemon). Run the full topology smoke test with `bash deploy/scripts/smoke-topology.sh`.

## Test it
```bash
npm run test:all   # canonical: runtime + session1 + intelligence + session3 + recovery +
                   #   ssrf + persistence + event-contract + economics + failover +
                   #   prompt/semantic + finalization + integration + providers + boundaries +
                   #   privacy + auth + savings + analytics
npm run test:frontend  # console tests (vitest)
npm run build:frontend # production build (tsc + vite)
npm run release:check  # backend + frontend tests + frontend build
```
All suites green (including focused production-boundary checks and frontend UI tests). `node_modules`/`dist`/`.vite` and
`backend/.runtime-data*` are gitignored build/runtime artifacts, not source.

## Modes
- `LIVE`: real provider calls. For an authenticated tenant, LIVE requires that
  tenant's own verified provider credential; deployment-wide credentials are not
  used as another tenant's key. The active model always comes from Model
  Intelligence (registry + router); catalog aliases resolve to provider-native
  IDs; unknown provider IDs fail honestly with configuration guidance — never
  fake success.
- `DEMO`: deterministic mock provider, explicitly labelled in `/api/health`, every snapshot (`meta.mode`), and the UI badge. Same agent loop, same real tools — only the model call is mocked. Used for tests and offline development.

## Event naming (canonical)
Dotted lowercase (`model.switched`, `memory.written`, `tool.completed`, `tool.failed`, `cost.updated`, `price.updated`). The frontend additionally accepts legacy aliases `tool.finished` and `memory.write` (Session 4 names); the backend only emits canonical names.
The wire contract lives in `backend/src/events/event-contract.js` and is enforced by `backend/test/event-contract.test.js`: every backend event must be handled by the console's `KNOWN_EVENTS`, so backend additions cannot silently disappear from the UI. SSE delivery guarantees replay (`?since=`), gap detection with snapshot resync, dedupe, and reconnect with backoff.

## Docs
- `ARCHITECTURE.md` / `CONTRACTS.md` / `MODEL_INTELLIGENCE.md` / `CONTEXT_MEMORY_CACHE.md` — backend contracts consumed (Sessions 1–3 surface).
- `FRONTEND.md` — console architecture, state, events, testing, and current integration boundaries.

## Known limitations (honest)
- **Browser tools**: the `browser` capability category exists for policy/routing
  reasoning, but no browser automation is implemented (`available: false`,
  disabled — calls are rejected, never faked).
- **Provider streaming**: OpenAI-compatible providers (including OpenRouter) and
  Anthropic use native provider SSE when running LIVE. DEMO mode has no provider
  stream and emits one labelled completion event; it never pretends to be live.
- **Performance prior**: one successful run moves a new model's predicted
  success 0.70 → 0.76 (Bayesian smoothing, prior 0.7 over 4 pseudo-samples),
  never to 1.0. Single samples carry `confidence: none`.
- **User feedback**: one weighted signal, never sole truth. Low-confidence
  negative feedback cannot overturn passing tests; high-confidence
  disagreement yields `taskSuccess: null` (conflict), not failure.
- **Context protection**: user task, hard constraints, success criteria and
  system instructions are excluded from compression candidates entirely.
- **Approvals**: single-use (`runId` + `actionType` + params fingerprint),
  expire automatically, cannot escalate scope. Expired approvals are
  unusable even if previously approved.
- **Memory/learning**: intelligence (`intelligence.json`: model performance,
  routing history, benchmarks, semantic cache, outcome evals) is durable
  across restarts; agent working/long-term memory is process-local.
  Self-reported success alone never creates a learning update.
- **Prompt/tokens**: the PromptPlan is the single prompt definition; token
  counts are length/4 estimates (plan totals drive guards, cache keys and
  router fit), while cost uses observed provider usage. Cost renders
  `estimated` whenever provider pricing is unknown for the run.
- **Economics**: every provider call and local cache hit is represented by one
  canonical economic record. Provider-reported usage/cost wins when available;
  otherwise the captured pricing snapshot is used. Savings are modeled from
  observed optimized-run tokens × the explicitly configured reference-model
  snapshot, and remain distinct from invoice reconciliation. A local response
  cache hit makes no provider call and records $0 provider inference cost.
- **Model identity**: live execution requires a provider-native model mapping
  — unmapped candidates are excluded, never silently substituted.
- **Semantic reuse**: lexical similarity (not embeddings) with similarity,
  freshness, context-fingerprint, tool-dependency, same-model and
  cross-run gates; pure answers only. Anything unproven is a miss.
- **Auth**: production fails closed and supports signup/login sessions plus
  bearer tokens. Non-production is dev-open only when `AUTH_ENABLED` is omitted;
  enable it explicitly for a protected staging deployment. Ownership and
  project/run tenant checks are enforced when auth is enabled, including
  provider credentials and historical run economics.
- **Restart**: in-flight execution never auto-resumes across restarts. Runs
  active at shutdown/restart are marked failed (`interrupted: true`) and stay
  auditable; a FAILED run can then be retried via `POST /runs/:id/retry`,
  which runs the real recovery flow (validate checkpoint → inspect last side
  effect → consult idempotency → resume/skip/retry or refuse with
  `execution.recovery_blocked`). Recovery refuses to blindly re-run
  destructive or unknown-outcome actions.
- **Recovery**: checkpoints are versioned, integrity-sealed, freshness-checked
  (`CHECKPOINT_MAX_AGE_MS` 7 days), and capture runtime + provider-conversation
  state, so resumed runs keep step numbers, budget spend, and event sequence.
  Every completed step also persists a snapshot (best-effort hook), bounding
  crash loss to the in-flight step.
- **Network**: `fetch_url` enforces DNS-aware SSRF protection — every resolved
  address of a hostname must be public (loopback/RFC1918/link-local/multicast/
  unique-local/metadata all rejected), every redirect hop is independently
  re-validated with per-hop transport selection, and HTTPS is required unless
  networking is explicitly ENABLED. Residual TOCTOU between DNS validation and
  connect is documented in `src/execution/environment.js`; hostile-DNS
  deployments should add firewall egress rules.
- **Storage**: per-run files for runs that are neither active nor indexed are
  garbage-collected after a grace period (`RETENTION_GRACE_MS`, hourly
  `RETENTION_SWEEP_INTERVAL_MS`; active/indexed runs are never touched).
  `intelligence.json` is structurally compacted to per-collection caps on
  every write. Corrupt files are quarantined, never loaded.
- **Shutdown**: SIGTERM/SIGINT drains (503 on new runs), aborts in-flight
  provider/tool work, persists snapshots + index, then exits.
- **Billing**: V1 is BYOK. Provider inference is paid directly by the customer;
  platform-fee accounting consumes SavingsEngine output. Stripe self-serve
  subscriptions and automatic provider-invoice reconciliation are not enabled;
  billing is explicitly modeled/manual until those paths are implemented.
- **Production secrets**: `API_TOKEN` (or session auth), `FRONTEND_ORIGIN`, and
  `DATA_ENCRYPTION_KEY` must be supplied outside the image. The encryption key
  is separate from the runtime data volume and is required before production
  startup.
