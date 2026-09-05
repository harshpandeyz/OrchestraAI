# OrchestraAI — DevOps / Production Agent Handoff
# Agent: Agent 4 — DevOps / Production
# Repository: OrchestraAI adaptive agent runtime

## DEPLOYMENT TOPOLOGY

### Services (Docker Compose - deploy/docker-compose.yml)

| Service | Image | Purpose | Key Env Vars |
|---------|-------|---------|-------------|
| `api` | `orchestraai` (built from Dockerfile) | Main runtime API + console UI on :8787 | NODE_ENV, FRONTEND_ORIGIN, PROVIDER, OPENROUTER_API_KEY, DATA_ENCRYPTION_KEY, RUNTIME_MODE, LOG_LEVEL |
| `postgres` | `postgres:16-alpine` | Persistent storage (FileStore upgrade path) | POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD |
| `redis` | `redis:7-alpine` | Caching & coordination (process-local in V1) | REDIS_URL (optional) |
| `minio` | `minio/minio:latest` | Object storage for run artifacts | MINIO_ROOT_USER, MINIO_ROOT_PASSWORD |
| `mc` | `minio/mc:latest` | MinIO CLI helper | — |

### Build Artifacts
- **Docker image**: `orchestraai` (multi-stage: frontend-build -> runtime)
- **Frontend dist**: `frontend/dist` (built via `npm run build:frontend`)
- **Backend**: `backend/server.js` + `backend/src/` (Node.js, no modifications)
- **Migration script**: `deploy/scripts/migrate.js` (run at container startup)
- **Backup procedures**: `deploy/backup-procedures.md`

### Runtime Data
- **RUNTIME_DATA_DIR** (default: `backend/.runtime-data`): run index, events, snapshots, intelligence, evaluations, idempotency records
- **Encrypted with DATA_ENCRYPTION_KEY**: stored provider credentials
- **NOT copied into Docker image**: initialized at container startup via migrate.js

## COMMANDS

### Build from scratch
```bash
# Frontend build
npm run build:frontend   # or: npm --prefix frontend run build

# Docker image
docker build -t orchestraai .

# Or with compose
docker compose -f deploy/docker-compose.yml up --build -d
```

### Run locally (development)
```bash
# Using npm start (dev mode, Vite proxy + API)
npm start               # :8787 (API) + :5173 (console with /api proxy)

# Or Docker with demo mode
docker run -p 8787:8787 \
  -e NODE_ENV=development \
  -e RUNTIME_MODE=demo \
  -e DATA_ENCRYPTION_KEY=test-key \
  .
```

### Run in production (Docker Compose)
```bash
docker compose -f deploy/docker-compose.yml up -d
```

### Check health
```bash
# Liveness (process always alive)
curl http://localhost:8787/api/health

# Readiness (storage + registry available)
curl http://localhost:8787/api/ready

# Docker health status
docker inspect --format='{{.State.Health.Status}}' <container-name>
```

### Run migrations (at container startup, automatic)
```bash
# The migrate.js script runs automatically on container start.
# It ensures RUNTIME_DATA_DIR structure and validates DATA_ENCRYPTION_KEY
# in production mode. Exit non-zero if key is missing in production.

# Manual run (if needed):
node deploy/scripts/migrate.js
```

### Backup runtime data
```bash
docker exec <api-container> \
  tar czf /tmp/runtime-backup.tar -C /var/lib/orchestraai .

docker cp <api-container>:/tmp/runtime-backup.tar ./backup-$(date +%Y%m%d).tar
```

### Restore runtime data
```bash
docker stop <api-container>
docker cp backup-20240101.tar <api-container>:/tmp/restore.tar
docker exec <api-container> tar xzf /tmp/restore.tar -C /var/lib/orchestraai/
docker start <api-container>
```

## REQUIRED ENVIRONMENT VARIABLES (.env.example)

See `.env.example` for the complete list. Key categories:

- **Database URL**: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (PostgreSQL service)
- **Redis URL**: `REDIS_URL` (Redis service, optional in V1)
- **Auth**: `AUTH_ENABLED`, `API_TOKEN`, `OPERATOR_TOKEN`, `READ_TOKEN`
- **Encryption key**: `DATA_ENCRYPTION_KEY` (32 bytes as 64 hex chars or base64; REQUIRED in production)
- **Provider credentials**: `PROVIDER`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- **Frontend origin**: `FRONTEND_ORIGIN` (required in production for CORS)
- **Execution isolation**: `WORKSPACE_ROOT` (sandboxed workspace root)
- **Limits**: `LIMIT_REQUESTS_PER_MINUTE`, `LIMIT_AUTH_REQUESTS_PER_MINUTE`, `LIMIT_MAX_CONCURRENT_RUNS`
- **Retention**: `RETENTION_SWEEP_INTERVAL_MS`, `RETENTION_GRACE_MS`, `LOG_LEVEL`
- **Mode**: `RUNTIME_MODE` (live|demo|auto)

## HEALTH / READINESS BEHAVIOR

### Process lifecycle states

| State | Indicator | Endpoint |
|-------|-----------|----------|
| **Liveness** | Process is alive | `GET /api/health` — always returns OK, never fails on dependency outage |
| **Readiness** | Ready to serve requests | `GET /api/ready` — returns 200 if registry + storage OK; 503 if unavailable |
| **DB unavailable** | Storage layer failed | Included in `/api/ready` checks (`storage.ok`); service still runs in degraded mode |
| **Redis unavailable** | Coordination layer failed | Noted in `/api/ready` (`redis.ok: false`); ephemeral process-local coordination; no impact on core functionality |
| **Missing encryption key** | Production guardrail | `validateConfig()` throws if NODE_ENV=production and DATA_ENCRYPTION_KEY missing; server refuses to start |
| **Provider config unavailable** | No valid provider credentials | `modeStateForProvider()` returns `LIVE_UNCONFIGURED`; `/api/models` renders models with `qualitySource: demo`; no real provider calls |

### Docker healthcheck
- **Interval**: 40s, **Timeout**: 5s, **Start-period**: 20s, **Retries**: 3
- **Exit code 0**: liveness OK (always passes since /api/health never fails on dependency outage)
- **Exit code 1**: readiness not met (storage or model registry unavailable)
- **Status visible via**: `docker inspect --format='{{.State.Health.Status}}'`

### Startup diagnostics (visible in container logs)
- Restored persisted run index + event replay
- Discovery service status (enabled/disabled)
- Model registry population (seed vs discovered)
- Encryption key verification (production: required; development: optional)
- Retention sweep status
- Rate limit config

## CI CHECKS (.github/workflows/ci.yml)

```yaml
# Jobs:
#   install          — npm ci (root + frontend)
#   backend-tests    — node backend/test/runtime.test.js + provider-config, boundaries, auth, SSRF, event-contract, savings, analytics
#   frontend-tests   — vitest (128 tests in 11 files)
#   frontend-build   — npm --prefix frontend run build
#   docker-build     — docker build -t orchestraai .
#   deployment-smoke — build + run container; validate /api/health and /api/ready; exit cleanly
```

## INFRASTRUCTURE ASSUMPTIONS

- **Single-process V1 runtime**: horizontal coordination not supported; one instance per deployment
- **FileStore backend**: local JSON files in RUNTIME_DATA_DIR; PostgreSQL available as upgrade path
- **No distributed execution**: in-run tool isolation only; no consensus or distributed scheduling
- **One API port**: :8787 serves UI + API (one-port deployment)
- **Development mode default**: without provider credentials, runs in labelled DEMO mode
- **Production fails closed**: NODE_ENV=production requires DATA_ENCRYPTION_KEY; AUTH_ENABLED=false implies open auth with warning
- **Docker daemon required** for build and compose operations

## FILES CHANGED

### Modified (within ownership)
- `Dockerfile` — multi-stage build, non-root user (appuser:appgroup), HEALTHCHECK, migration COPY
- `.dockerignore` — added runtime data, git, coverage, temp files exclusion
- `.env.example` — expanded with all deployment-time configuration variables

### Created (within ownership)
- `deploy/docker-compose.yml` — production stack: API, PostgreSQL, Redis, MinIO
- `deploy/scripts/migrate.js` — one-time data directory setup + encryption key validation
- `deploy/backup-procedures.md` — backup, restore, retention guidance, encryption key warning
- `.github/workflows/ci.yml` — CI: install, backend tests, frontend tests/build, Docker build, deployment smoke
- `healthcheck.sh` — **removed** (healthcheck now uses Node.js fetch directly in Dockerfile)

### NOT modified (out of bounds)
- `backend/**` — application source, business logic
- `frontend/**` — console UI, React components
- `package.json` / `package-lock.json` — root package metadata
- `README.md` / `ARCHITECTURE.md` / `CONTRACTS.md` — documentation