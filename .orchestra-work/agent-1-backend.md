# Agent 1 — Backend / Infrastructure handoff

## Files changed (owned only)
- `backend/src/config.js` — centralized all new env vars; added `resolvedDatastoreKind()`; prod validation for `DATASTORE_PROVIDER`/`QUEUE_PROVIDER`/`REDIS_REQUIRED`; loud warnings (not throws) for file-datastore / missing-Redis in production.
- `backend/src/persistence.js` — additive only: `assertNoSilentFallback()` + `isFileAdapter()`; `FileStore` behavior unchanged (explicit dev/test adapter).
- `backend/src/tenant-store.js` — corrupt/empty/non-array storage now quarantines + throws `tenant_store_corrupt` (never an empty tenant set); `ENOENT` still boots empty; added `ownsProject()`/`requireProjectAccess()`; `updateProject` now uses the same ownership rule as list/get (cross-tenant mutation returns null).
- `backend/src/idempotency.js` — kept sync `begin/complete/fail/get` API; added optional `remote` backend + `beginAsync/completeAsync/failAsync/getAsync` (`degraded:true` when local-only); added `RedisIdempotencyBackend` (SET NX) + `PostgresIdempotencyBackend` (UNIQUE row).
- `backend/server.js` — additive wiring only: datastore factory + `assertNoSilentFallback` fail-fast; memory-first coordinator with async Redis upgrade; `LockManager`/`RateLimiter`/job-queue handles; distributed idempotency for Stripe webhook (`beginAsync/completeAsync`); distributed rate-limit check after local shed; `/api/ready` extended with additive `datastore/redis/encryption/auth/coordination` checks (legacy fields unchanged); SSE `Last-Event-ID` cursor + Postgres durable-replay branch (file path uses existing `serveRunEvents`); startup probes logged at boot; shutdown closes queue/coordinator/pg pool after existing drain/persist; scattered `process.env` for retention/SESSION3/NODE_ENV/HSTS/cookies replaced with `config.*`; new exports (`datastore`, `coordinator()`, `locks()`, `jobQueue()`, `idempotencyStore`, `allowRequestDistributed`).

## New files
- `backend/src/infrastructure/postgres.js` — `PostgresDatastore` (lazy `pg`, parameterized queries, `withTransaction`, run/events/snapshot/idempotency surface). Ciphertext only; never logs secrets.
- `backend/src/infrastructure/redis.js` — `createCoordinator` (ioredis → node-redis → degraded-memory, never throws); `MemoryCoordinator` dev/test adapter.
- `backend/src/infrastructure/locks.js` — `LockManager` (SET NX PX + token; `lock_busy` on contention).
- `backend/src/infrastructure/rate-limit.js` — `RateLimiter` (Redis INCR window when distributed, same fixed-window locally).
- `backend/src/infrastructure/queue.js` — `createJobQueue` (`memory` FIFO default; `redis` list adapter with identical `{ on, enqueue, size, close }` interface for later BullMQ swap). Orchestrator NOT rewritten.
- `backend/src/infrastructure/datastore.js` — `createDatastore` factory (auto→postgres iff `DATABASE_URL`, else file; postgres-without-URL/pg-missing throws, never falls back).
- `backend/src/infrastructure/readiness.js` — `checkReadiness` (datastore/redis/encryption/auth; provider outage never affects readiness).
- `backend/src/infrastructure/event-log.js` — `parseCursor`/`parseLastEventIdHeader`/`readDurableSince`/`dedupeBySeq` (envelope shape unchanged).
- `backend/migrations/001_init.sql` — `schema_migrations, users, sessions, projects, run_index, run_events, run_snapshots, idempotency`. Apply: `psql "$DATABASE_URL" -f backend/migrations/001_init.sql`.
- `backend/test/agent1/config-datastore.test.js`, `coordination.test.js`, `tenant-idempotency.test.js` — 30 tests, all passing.

## New env vars (all via config.js; `.env.example` untouched — outside ownership)
`DATASTORE_PROVIDER` (auto|file|postgres, default auto), `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX` (10), `DATABASE_STATEMENT_TIMEOUT_MS` (10000), `REDIS_URL`, `REDIS_REQUIRED` (false), `QUEUE_PROVIDER` (memory|redis), `QUEUE_CONCURRENCY` (4), `ALLOW_FILE_DATASTORE_IN_PRODUCTION` (false). Centralized existing: `RETENTION_SWEEP_INTERVAL_MS/GACE_MS`, `SESSION3_AUTO_VERIFY`, `NODE_ENV→config.isProduction`.

## Production startup requirements
1. `DATABASE_URL` + `DATASTORE_PROVIDER=postgres` (+ `npm install pg`), schema migrated (`001_init.sql`).
2. `REDIS_URL` (+ `npm install ioredis`) for multi-instance locks/rate-limits/idempotency; without it coordination is process-local (readiness notes it; `REDIS_REQUIRED=true` makes it fail closed).
3. `DATA_ENCRYPTION_KEY` (fail-fast, as before), auth enabled in production (fail-closed, as before).
4. `/api/ready` gates on registry + storage reachability + infra checks; `/api/health` stays liveness-only. Demo mode unchanged (no infra needed; file/memory adapters).

## Tests run / results
- agent1 (30/30 pass): config-datastore 13, coordination 9, tenant-idempotency 8.
- Existing targeted: persistence 7/7, privacy pass, event-contract 9/9, production-boundaries 11/11, auth-integration pass, economics 9/9, integration 31/32.
- Full suite NOT run (parallel agents editing concurrently; would be noisy).

## Integration assumptions for Agent 7
- Postgres/Redis npm packages are NOT added to `package.json` (avoid parallel-install conflicts); `npm install pg ioredis` is a deploy step when enabling those providers. All adapters degrade explicitly without them.
- File datastore in production stays bootable (back-compat for current tests/harnesses) with loud warnings; set `ALLOW_FILE_DATASTORE_IN_PRODUCTION=true` to acknowledge single-node, or `DATABASE_URL` for durable multi-instance.
- SSE contract unchanged: `?since=` still primary; `Last-Event-ID` accepted as equivalent; `gap` frame shape unchanged.
- Stripe webhook response shape unchanged; now uses distributed reservation when a remote is wired.
- `TenantStore` constructor now throws on corrupt storage (code `tenant_store_corrupt` after quarantining to `*.corrupt-*`); boot must surface this, never swallow.
- New server exports are additive; orchestrator/AI/sandbox untouched.

## Unresolved issue (outside my ownership)
- `integration.test.js` Scenario 7 ("budget nearly exhausted → safe termination") fails (31/32). None of my files participate in budget/orchestrator semantics (config defaults unchanged); concurrent edits to cost/economics/orchestrator/policy by other agents are the likely cause. Needs owner verification.
- Transient observation: `backend/src/intelligence/memory-intelligence.js` had a syntax error mid-session (another agent's in-flight edit, since fixed — production-boundaries passes). I did not touch it.
