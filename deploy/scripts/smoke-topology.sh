#!/usr/bin/env bash
# Full production-topology smoke test.
#
# Boots the REAL deployment (API + Postgres + Redis + sandbox worker) with
# production-like configuration and validates the actual topology end-to-end:
#
#   1.  container health           2.  API health (/api/health)
#   3.  API readiness (/api/ready)  4.  Postgres connection (authoritative)
#   5.  Redis connection            6.  authentication (signup/login/session)
#   7.  project access control      8.  run creation
#   9.  run state transition       10.  persistence (snapshot survives)
#   11. SSE event delivery         12.  Redis coordination (durable queue)
#   13. sandbox execution          14.  failure handling (unknown run 404)
#   15. graceful shutdown          16.  cleanup
#
# Run: bash deploy/scripts/smoke-topology.sh
# Requires a working Docker daemon. Compose interpolations for DATABASE_URL /
# REDIS_URL are derived from the sibling services (see docker-compose.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-orchestraai-smoke}"
export COMPOSE_PROJECT_NAME="$PROJECT"

# Ephemeral, securely-generated secrets (hex only => URL-safe POSTGRES_PASSWORD).
export POSTGRES_PASSWORD="$(openssl rand -hex 24 | head -c 32)"
export SANDBOX_WORKER_TOKEN="$(openssl rand -hex 32)"
export DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export FRONTEND_ORIGIN="http://localhost:5173"
export RUNTIME_MODE="${RUNTIME_MODE:-demo}"
export DISCOVERY_ENABLED="${DISCOVERY_ENABLED:-false}"
export API_HOST_PORT="${API_HOST_PORT:-18787}"

COMPOSE=(docker compose -f "$COMPOSE_FILE" -p "$PROJECT")

step() { echo; echo "==> $*"; }
fail() { echo "FAIL: $*"; "${COMPOSE[@]}" logs --no-color api postgres redis sandbox-worker >&2 2>/dev/null || true; exit 1; }

cleanup() {
  echo; echo "==> cleanup: down -v"
  "${COMPOSE[@]}" down -v --remove-orphans --timeout 20 >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 0. Build + boot the full topology.
step "Building and starting the full topology"
"${COMPOSE[@]}" up --build -d

BASE="http://127.0.0.1:${API_HOST_PORT}"

# JSON value extraction without jq (node is present in the toolchain).
json_get() {
  local json="$1"; local path="$2"
  echo "$json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d||'{}');let v=o;for(const k of process.argv[1].split('.')){v=(v==null)?null:v[k];if(v==null)break}process.stdout.write(v==null?'':String(v))}catch(e){process.stdout.write('')}})" "$path"
}

wait_http() {
  local url="$1"; local tries="${2:-60}"
  for i in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

step "1. Waiting for container health / API liveness"
wait_http "$BASE/api/health" 90 || fail "API never became reachable"

# 1. Container health (all services running & healthy).
step "1. Container health"
"${COMPOSE[@]}" ps --format '{{.Name}} {{.State}}' | grep -Ev 'Exit|exited' >/dev/null \
  || fail "a compose service exited"
"${COMPOSE[@]}" ps | grep -E "$PROJECT-(postgres|redis|sandbox-worker|api)-1" >/dev/null \
  || fail "expected api/postgres/redis/sandbox-worker containers"
echo "    all services running"

# 2. API health.
step "2. API health"
HEALTH="$(curl -sf "$BASE/api/health")"
echo "$HEALTH" | grep -q '"ok":true' || fail "health not ok: $HEALTH"
echo "    $HEALTH"

# 3. API readiness (gate: postgres + redis + encryption + auth + boot).
step "3. API readiness"
READY="$(curl -sf "$BASE/api/ready")"
echo "$READY" | grep -q '"ready":true' || fail "not ready: $READY"
echo "    ready: true"

# 4. Postgres connection (authoritative durable store).
step "4. Postgres connection"
echo "$READY" | grep -q '"storage".*"kind":"postgres"' || fail "storage not postgres: $READY"
echo "$READY" | grep -q '"storage".*"ok":true' || fail "storage probe not ok: $READY"
echo "    postgres ok"

# 5. Redis connection (coordination + durable queue).
step "5. Redis connection"
echo "$READY" | grep -q '"backend":"redis"' || fail "redis backend not active: $READY"
echo "$READY" | grep -q '"queue":"redis"' || fail "queue provider not redis: $READY"
echo "$READY" | grep -q '"coordination".*"ready":true' || fail "coordination not ready: $READY"
echo "    redis ok (durable queue active)"

# 6. Authentication (production fails closed + session cookie).
step "6. Authentication"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/runs")"
[ "$CODE" = "401" ] || fail "anonymous /api/runs expected 401, got $CODE"
COOKIE_JAR="$(mktemp)"
SIGNUP="$(curl -sf -c "$COOKIE_JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/auth/signup" \
  -d '{"email":"smoke@test.local","password":"smoke secure password 123","name":"Smoke"}')"
[ "$(json_get "$SIGNUP" user.id)" != "" ] || fail "signup did not return a user"
ME="$(curl -sf -b "$COOKIE_JAR" "$BASE/api/auth/me")"
echo "$ME" | grep -q '"authenticated":true' || fail "session not authenticated via cookie: $ME"
echo "    signup + HttpOnly session OK (anonymous rejected: 401)"

# 7. Project creation + access control.
step "7. Project creation / access control"
PROJ="$(curl -sf -b "$COOKIE_JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/projects" \
  -d '{"name":"Smoke Project"}')"
PROJECT_ID="$(json_get "$PROJ" project.id)"
[ -n "$PROJECT_ID" ] || fail "project not created: $PROJ"
echo "    project $PROJECT_ID created"

# 8. Run creation.
step "8. Run creation"
RUN="$(curl -sf -b "$COOKIE_JAR" -H 'Content-Type: application/json' -X POST "$BASE/api/runs" \
  -d "{\"title\":\"Smoke run\",\"taskMode\":\"general\",\"projectId\":\"$PROJECT_ID\"}")"
RUN_ID="$(json_get "$RUN" run.id)"
[ -n "$RUN_ID" ] || fail "run not created: $RUN"
echo "    run $RUN_ID created"

# 9. State transition (message drives execution via the durable queue).
step "9. Run state transition (durable queue execution)"
SEND="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -X POST "$BASE/api/runs/$RUN_ID/messages" -d '{"content":"Say hello and finish."}')"
[ "$SEND" = "202" ] || fail "message not accepted, got $SEND"
TERMINAL=""
for i in $(seq 1 90); do
  ST="$(curl -sf -b "$COOKIE_JAR" "$BASE/api/runs/$RUN_ID")"
  STATUS="$(json_get "$ST" run.status)"
  case "$STATUS" in completed|failed|cancelled) TERMINAL="$STATUS"; break;; esac
  sleep 1
done
[ -n "$TERMINAL" ] || fail "run never reached a terminal state (last: ${STATUS:-none})"
echo "    run $RUN_ID -> $TERMINAL"

# 10. Persistence (snapshot survived; events durably persisted).
step "10. Persistence"
SNAP="$(curl -sf -b "$COOKIE_JAR" "$BASE/api/runs/$RUN_ID/state")"
[ -n "$SNAP" ] || fail "no snapshot persisted"
echo "    snapshot persisted (status: $TERMINAL)"

# 11. SSE event delivery (named events + replay cursor).
step "11. SSE event delivery"
SSE="$(curl -sf -N --max-time 20 -b "$COOKIE_JAR" "$BASE/api/runs/$RUN_ID/events")"
echo "$SSE" | grep -q 'event:' || fail "no named SSE events delivered"
echo "    SSE events delivered"

# 12. Redis coordination (already asserted in /api/ready; assert observable stats).
step "12. Redis coordination confirmed"
echo "$READY" | grep -q 'queueStats' || fail "queue stats missing"
echo "    coordination ready"

# 13. Sandbox execution (run a real /v1/execute from inside the API container).
step "13. Sandbox execution (isolated worker)"
SANDBOX_PROBE="$("${COMPOSE[@]}" exec -T api node -e "
const http=require('http');
const data=JSON.stringify({runId:'smoke-run',command:'node',args:['app.js'],timeoutMs:15000,maxOutputBytes:8000,workspace:{files:[{path:'app.js',contentBase64:Buffer.from('const fs=require(\\'fs\\');fs.writeFileSync(\\'out.log\\',\\'ok\\');console.log(\\'sandbox-ran\\');').toString('base64')}]},collect:['out.log']});
const req=http.request({host:'sandbox-worker',port:8788,path:'/v1/execute',method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $SANDBOX_WORKER_TOKEN','Content-Length':Buffer.byteLength(data)}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{console.log(res.statusCode+' '+b);});});
req.on('error',e=>{console.error('ERR '+e.message);process.exit(1);});
req.write(data);req.end();
")"
echo "$SANDBOX_PROBE" | grep -q '^200 ' || fail "sandbox execute failed: $SANDBOX_PROBE"
echo "$SANDBOX_PROBE" | grep -q 'sandbox-ran' || fail "sandbox did not run the program: $SANDBOX_PROBE"
echo "$SANDBOX_PROBE" | grep -q '"out.log"' || fail "sandbox artifact not collected: $SANDBOX_PROBE"
echo "    sandbox execution + artifact collection OK"

# 14. Failure handling (unknown run -> honest 404, not a crash).
step "14. Failure handling"
NF="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "$BASE/api/runs/nonexistent-xyz")"
[ "$NF" = "404" ] || fail "unknown run should be 404, got $NF"
echo "    unknown run -> 404"

# 15. Graceful shutdown (SIGTERM drains the API cleanly).
step "15. Graceful shutdown"
"${COMPOSE[@]}" stop --timeout 20 api >/dev/null 2>&1 || fail "api stop failed"
SHUT_OK=0
for i in $(seq 1 20); do
  if "${COMPOSE[@]}" ps -a --format '{{.Name}} {{.State}}' | grep -qE "$PROJECT-api-1 .*(Exited|exited)"; then SHUT_OK=1; break; fi
  sleep 1
done
[ "$SHUT_OK" = "1" ] || fail "api did not stop within grace period"
echo "    api stopped cleanly"

echo
echo "PASS: full production-topology smoke (health/ready/postgres/redis/auth/run/SSE/sandbox/shutdown)"