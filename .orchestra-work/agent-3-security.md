# Agent 3 — Security / Execution Handoff

## What changed (all inside Agent 3 ownership)

**New modules (`backend/src/execution/`)**
- `isolated-executor.js` — explicit executor boundary + stable contract client.
  `getIsolatedExecutorUrl`, `isProductionEnv`, `toolRequiresIsolation`,
  `isolationRequired`, `validateExecuteRequest/Response`, `executeIsolated`,
  `sandboxUnavailableError`, `buildExecutionAudit`.
- `command-guard.js` — strengthened argv validation, single source of truth
  (shell metachars, `$(…)`/backtick/`${…}` substitution, blocked interpreters,
  env-override tricks, traversal, absolute workspace escapes,
  workspace-redirecting flags). Preserves existing safe families.
- `sandbox-env.js` — `buildSandboxEnv()` minimal child env (PATH/LANG/TERM/
  CI/NODE_ENV only, secret keys stripped, proxy vars removed),
  `assertNoSecrets` / `findSecretKeys`.
- `provenance.js` — execution-side trust tagging: repo/tool/fetched/model
  content is `trustedAsInstruction:false, instructionAuthority:'none'` (DATA,
  not instructions). AI runtime files untouched.

**Edited (additive, behavior-preserving outside production)**
- `backend/src/execution/execution-policy.js` — `classifyCommand` /
  `containsShellMetachars` / `isCommandAllowed` now delegate to
  `command-guard.js`. Same exports, same family names.
- `backend/src/execution/environment.js` — `validateCommandArgs` delegates to
  `command-guard.js`; `runAllowlisted` passes a sanitized env (never
  `process.env` wholesale) and returns `isolated:false, executor:
  'local-restricted'` (+ `timed_out` alias). Header comment states execFile
  is not a sandbox.
- `backend/src/execution/changesets.js` — `gitEnv()` strips secret-looking
  keys (git still gets HOME/PATH/GIT_* it needs).
- `backend/src/execution/recovery.js` — `retryDecision` never retries
  `sandbox_unavailable / executor_unavailable / executor_malformed /
  secret_refused` (retrying unchanged fails identically).
- `backend/src/execution/controller.js` — production gate: `run_tests` /
  `build_project` pass the gate only when `ISOLATED_EXECUTOR_URL` (or
  `isolatedExecutorUrl` option) is set, then still go through normal
  policy + approval checks; without it they return `code:
  'sandbox_unavailable'` (fail closed). Everything else still denied.
- `backend/src/impl/tool-executor.js` — `run_tests` / `build_project` route
  via `runCommandSandboxed`: production ⇒ isolated worker (relative node
  targets, no host abs paths, network mode from policy), no-sandbox or
  unreachable ⇒ `sandbox_unavailable` (never local fallback). Every result
  gets `isolated / executor [/ executorVersion] / timedOut + timed_out /
  audit (secret-free) / provenance`. Non-attesting executor responses
  rejected. Timeout contract unchanged and extended with `timed_out` alias.
- `backend/src/impl/tool-registry.js` — `registerTool` refuses raw-shell
  names (`shell`, `exec`, `run_any_command`, `run_shell`, `bash`, `sh`).

**Reference worker (`sandbox-worker/`)** — `server.js` (zero-dep,
`POST /v1/execute` + `GET /v1/health`), `package.json`, `Dockerfile`
(non-root `sandbox` user, no host mounts).

**Tests (`backend/test/agent3/security.test.js`)** — 22 tests, all passing.
Run: `node backend/test/agent3/security.test.js`

## Executor contract (stable, documented in code)

`POST ${ISOLATED_EXECUTOR_URL}/v1/execute`
Request: `{ runId, tenantId, projectId, workspaceId, command, args, cwd,
timeoutMs, maxOutputBytes, networkMode, networkAllowlist }`
Response: `{ ok, exitCode, stdout, stderr, timedOut, durationMs, isolated,
executorVersion }` — `isolated:true` attestation required, else
`executor_malformed`. Request carrying secret-looking keys ⇒
`secret_refused` (client-side, before any I/O).

## Isolation assumptions (explicit, not implied)

1. `execFile` is a command restriction, never a sandbox. Local execution =
   dev/test only, always labeled `executor:'local-restricted'`.
2. A fully isolated runtime cannot be created inside the current app
   container — so production code execution FAILS CLOSED without a reachable
   isolated worker. Nothing fakes isolation.
3. Reference worker provides process + filesystem + env isolation; CPU/time/
   output/process limits in-worker; memory/CPU/network-namespace enforcement
   requires the documented container flags (`--network=none --cpus=1
   --memory=512m --pids-limit=64 --read-only --tmpfs`, non-root user).
   Hostile-DNS models additionally need platform firewall egress rules
   (documented residual TOCTOU already noted in `environment.js`).
4. Worker never receives provider secrets, proxy credentials, or host paths
   outside its ephemeral workspace (enforced both client- and worker-side).

## Production requirements

- `NODE_ENV=production` + `ISOLATED_EXECUTOR_URL=https://<worker>/…` (and
  optionally `ISOLATED_EXECUTOR_TOKEN=<shared secret>` matched by worker
  `SANDBOX_WORKER_TOKEN`).
- Without the URL, `run_tests` / `build_project` return `code:
  'sandbox_unavailable'` at both the controller gate and the executor.
- Deploy the worker per `sandbox-worker/Dockerfile` notes. Never mount the
  host project root or home dir into it.

## Verification

- `backend/test/agent3/security.test.js`: 22/22 pass.
- `backend/test/session3-execution.test.js`: 48/48 pass (no regression).
- `backend/test/ssrf.test.js`: 19/19 pass (SSRF guards preserved/strengthened).
- `backend/test/runtime.test.js`: 43 pass, 2 fail — both failures are
  `ModelRouter` retention expectations owned by another parallel agent
  (`backend/src/impl/model-router.js` shows parallel-agent modifications);
  unrelated to execution files.

## Exact integration point expected by Agent 7

- **Deploy**: run `sandbox-worker/` as a separate service/container per its
  header `DEPLOY NOTES`; set `ISOLATED_EXECUTOR_URL` (and
  `ISOLATED_EXECUTOR_TOKEN` / worker `SANDBOX_WORKER_TOKEN`) in the
  application environment. No `server.js` change is required: both the
  controller gate and `InMemoryToolExecutor` read `ISOLATED_EXECUTOR_URL`
  from env at call time (per-call override also available via
  `attachExecution(orch, { isolatedExecutorUrl })` and
  `new InMemoryToolExecutor(reg, bus, { isolatedExecutor: { baseUrl, token,
  env, executeIsolated } })`).
- **Health check**: `GET <worker>/v1/health` ⇒ `{ ok:true, isolated:true,
  executorVersion }`.
- **Do not**: mount host paths into the worker, forward `process.env` or
  provider keys to it, or add a local-execution fallback in production —
  fail-closed is the requirement.
- **If Agent 7 needs custom routing** (e.g. per-tenant workers), inject
  `executeIsolated` through the `isolatedExecutor` constructor option; the
  response contract (`validateExecuteResponse` + `isolated:true`) is still
  enforced.
