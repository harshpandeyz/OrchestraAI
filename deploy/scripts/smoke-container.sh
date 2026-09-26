#!/usr/bin/env bash
# Single-container production-image smoke test (demo topology, no publish).
# Builds the production image and validates that the API process boots, serves
# /api/health (liveness), /api/ready (readiness), and the compiled console.
#
# This is the FAST path run on pull requests. The full-topology test
# (Postgres + Redis + sandbox worker) lives in smoke-topology.sh and runs on
# release validation.
#
# Run: bash deploy/scripts/smoke-container.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-orchestraai:smoke}"
HOST_PORT="${SMOKE_PORT:-39080}"
NAME="orchestraai-smoke-$$"

echo "==> Building ${IMAGE} (production image)"
docker build -t "${IMAGE}" .

echo "==> Starting container ${NAME} on :${HOST_PORT} (demo mode)"
docker run -d --name "${NAME}" -p "${HOST_PORT}:8787" \
  -e NODE_ENV=production \
  -e RUNTIME_MODE=demo \
  -e DATA_ENCRYPTION_KEY="$(printf 'a%.0s' {1..64})" \
  -e FRONTEND_ORIGIN=http://localhost:5173 \
  -e DISCOVERY_ENABLED=false \
  -e LOG_LEVEL=error \
  "${IMAGE}"

cleanup() {
  echo "==> Cleaning up container ${NAME}"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  docker rmi "${IMAGE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

BASE="http://127.0.0.1:${HOST_PORT}"

echo "==> Waiting for liveness (/api/health)"
ok=0
for i in $(seq 1 30); do
  if curl -sf "${BASE}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { echo "FAIL: /api/health never became reachable"; exit 1; }

echo "==> Validating /api/health"
HEALTH="$(curl -sf "${BASE}/api/health")"
echo "${HEALTH}" | grep -q '"ok":true' || { echo "FAIL: health not ok: ${HEALTH}"; exit 1; }
echo "${HEALTH}" | grep -q '"mode":"demo"' || { echo "FAIL: expected demo mode: ${HEALTH}"; exit 1; }
echo "    health OK: ${HEALTH}"

echo "==> Validating /api/ready"
for i in $(seq 1 20); do
  READY="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/ready" || true)"
  [ "$READY" = "200" ] && break
  sleep 1
done
[ "$READY" = "200" ] || { echo "FAIL: /api/ready did not reach 200 (last=${READY})"; curl -s "${BASE}/api/ready" || true; exit 1; }
echo "    ready OK"

echo "==> Validating compiled console is served"
CONSOLE="$(curl -sf "${BASE}/" || true)"
echo "${CONSOLE}" | grep -qi 'orchestra' || { echo "FAIL: console shell not served"; exit 1; }
echo "    console OK"

echo "PASS: single-container smoke"