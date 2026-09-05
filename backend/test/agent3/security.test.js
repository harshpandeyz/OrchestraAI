'use strict';

// Agent 3 — Execution security boundary tests.
//
// Covers: fail-closed production without a sandbox, sanitized environment,
// host-path escape, command injection, traversal, network deny, allowlisted
// network, redirect SSRF, timeout semantics, approval scope, output caps,
// tenant/workspace isolation, secret absence.
//
// No destructive commands are run against the host: local execution uses only
// fixture scripts in tmp workspaces; production paths use an injected stub
// isolated executor (never real network).
//
// Run: node backend/test/agent3/security.test.js

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const CommandGuard = require('../../src/execution/command-guard');
const SandboxEnv = require('../../src/execution/sandbox-env');
const Isolated = require('../../src/execution/isolated-executor');
const Provenance = require('../../src/execution/provenance');
const ExecutionPolicy = require('../../src/execution/execution-policy');
const Environment = require('../../src/execution/environment');
const { ApprovalStore } = require('../../src/execution/approvals');
const { NetworkMode } = require('../../src/execution/execution-policy');
const ToolExecutor = require('../../src/impl/tool-executor');
const { InMemoryToolRegistry } = require('../../src/impl/tool-registry');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 5).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

function makeTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a3-${name}-`));
}

// Minimal runtimeState stub (no orchestrator needed for executor tests).
function fakeRun(runId = 'run-a3-1', extra = {}) {
  return {
    runId,
    orgId: 'org-a',
    projectId: 'proj-a',
    execution: { currentStep: 1 },
    tools: { recordCall() {} },
    budget: { addCost() {} },
    ...extra,
  };
}

function executorWithTools(workspace, isolatedExecutor = null) {
  const reg = new InMemoryToolRegistry();
  reg.seedTools([
    { name: 'run_tests', description: 'tests', status: 'enabled', costPerCall: 0.002, timeoutMs: 60000, parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'build_project', description: 'build', status: 'enabled', costPerCall: 0.002, timeoutMs: 60000, parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'read_file', description: 'read', status: 'enabled', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
  const exec = new ToolExecutor.InMemoryToolExecutor(reg, null, { workspace, isolatedExecutor });
  return { reg, exec };
}

const PROD_NO_SANDBOX = { env: { NODE_ENV: 'production' }, baseUrl: null };
const stubIsolated = (resp) => ({
  env: { NODE_ENV: 'production', ISOLATED_EXECUTOR_URL: 'http://worker.test' },
  baseUrl: 'http://worker.test',
  executeIsolated: async () => ({ ...resp }),
});
const OK_RESP = { ok: true, exitCode: 0, stdout: 'pass', stderr: '', timedOut: false, durationMs: 7, isolated: true, executorVersion: '1.0.0' };

function withTestCmd(cmd, fn) {
  const prev = process.env.TOOL_RUN_TESTS_CMD;
  process.env.TOOL_RUN_TESTS_CMD = cmd;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.TOOL_RUN_TESTS_CMD;
    else process.env.TOOL_RUN_TESTS_CMD = prev;
  });
}

async function main() {
  // ---------- 1. fail closed: production + no sandbox ----------
  await test('production code execution without a sandbox fails closed (no local fallback)', async () => {
    const ws = makeTmp('failclosed');
    const { exec } = executorWithTools(ws, PROD_NO_SANDBOX);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun(), {});
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.code, 'sandbox_unavailable', `got code ${r.code}`);
      assert.strictEqual(r.isolated, false);
      assert.ok(/failing closed|isolated executor/i.test(r.error), 'fail-closed reason surfaced');
      assert.ok(!/test_failure/.test(String(r.code)), 'never a test failure');
    });
  });

  await test('production build without a sandbox fails closed', async () => {
    const ws = makeTmp('failclosed-build');
    const { exec } = executorWithTools(ws, PROD_NO_SANDBOX);
    const r = await exec.execute('build_project', {}, fakeRun(), {});
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.code, 'sandbox_unavailable');
  });

  await test('unreachable isolated executor fails closed (never silent local run)', async () => {
    const ws = makeTmp('unreachable');
    const broken = {
      env: { NODE_ENV: 'production', ISOLATED_EXECUTOR_URL: 'http://worker.test' },
      baseUrl: 'http://worker.test',
      executeIsolated: async () => { throw Object.assign(new Error('socket hang up'), { code: 'executor_unavailable' }); },
    };
    const { exec } = executorWithTools(ws, broken);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun(), {});
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.code, 'sandbox_unavailable');
    });
  });

  await test('executor that does not attest isolation is rejected (never trusted)', async () => {
    // Contract-level: a response without isolated=true is malformed.
    assert.throws(
      () => Isolated.validateExecuteResponse({ ...OK_RESP, isolated: false }),
      /isolation/,
    );
    assert.throws(() => Isolated.validateExecuteResponse({ ok: true }), /missing/);
    // Routing-level: a lying worker surfaces as failure, never success.
    const ws = makeTmp('lying-worker');
    const lying = {
      env: { NODE_ENV: 'production', ISOLATED_EXECUTOR_URL: 'http://worker.test' },
      baseUrl: 'http://worker.test',
      executeIsolated: async () => ({ ...OK_RESP, isolated: false }),
    };
    const { exec } = executorWithTools(ws, lying);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun(), {});
      assert.strictEqual(r.success, false, 'non-attesting executor must not yield success');
    });
  });

  // ---------- 2. isolated success path + audit ----------
  await test('isolated execution returns attributed results with secret-free audit', async () => {
    const ws = makeTmp('isolated-ok');
    const seen = [];
    const iso = stubIsolated(OK_RESP);
    const orig = iso.executeIsolated;
    iso.executeIsolated = async (body, opts) => { seen.push(body); return orig(body, opts); };
    const { exec } = executorWithTools(ws, iso);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', { suite: 'session' }, fakeRun('run-iso-1'), {});
      assert.strictEqual(r.success, true);
      assert.strictEqual(r.isolated, true);
      assert.strictEqual(r.executor, 'isolated');
      assert.strictEqual(r.result.isolated, true);
      assert.ok(r.audit, 'audit record present');
      assert.strictEqual(r.audit.isolated, true);
      assert.strictEqual(r.audit.runId, 'run-iso-1');
      assert.strictEqual(r.audit.tenantId, 'org-a');
      assert.strictEqual(r.audit.projectId, 'proj-a');
      assert.ok(r.provenance && r.provenance.trustedAsInstruction === false, 'tool output tagged as DATA');
      // Request hygiene: relative node target, no host abs paths, identifiers only.
      assert.strictEqual(seen.length, 1);
      const body = seen[0];
      assert.ok(!path.isAbsolute(body.args[0]), `node target must be relative (got ${body.args[0]})`);
      assert.ok(!body.args.some((a) => a.startsWith('/etc') || a.startsWith('/root')));
      assert.strictEqual(body.networkMode, 'disabled');
      const blob = JSON.stringify({ body, audit: r.audit });
      assert.ok(!/sk-|BEGIN PRIVATE|hunter2/i.test(blob), 'no secret material in request/audit');
    });
  });

  await test('isolated non-zero exit is recorded as a failed tool', async () => {
    const ws = makeTmp('isolated-fail');
    const iso = stubIsolated({ ...OK_RESP, ok: false, exitCode: 1, stderr: 'assertion failed' });
    const { exec } = executorWithTools(ws, iso);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun('run-iso-fail'), {});
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.code, 'test_failure');
      assert.strictEqual(r.status, 'failure');
    });
  });

  // ---------- 3. sanitized environment ----------
  await test('sandbox env never carries secrets and ignores secret overrides', () => {
    process.env.A3_FAKE_API_KEY = 'sk-test-should-never-propagate';
    process.env.A3_SESSION_TOKEN = 'tok-test-should-never-propagate';
    try {
      const env = SandboxEnv.buildSandboxEnv();
      const blob = JSON.stringify(env);
      assert.ok(!blob.includes('sk-test-should-never-propagate'));
      assert.ok(!blob.includes('tok-test-should-never-propagate'));
      assert.ok(!('A3_FAKE_API_KEY' in env) && !('A3_SESSION_TOKEN' in env));
      const withOverride = SandboxEnv.buildSandboxEnv({ OPENAI_API_KEY: 'sk-override', PATH: '/usr/bin:/bin' });
      assert.ok(!('OPENAI_API_KEY' in withOverride), 'secret overrides refused');
      assert.ok(String(withOverride.PATH).length > 0);
      // Proxy vars are stripped so untrusted code gets no ambient egress.
      assert.ok(!('HTTP_PROXY' in env) && !('http_proxy' in env));
    } finally {
      delete process.env.A3_FAKE_API_KEY;
      delete process.env.A3_SESSION_TOKEN;
    }
  });

  await test('isolated request carrying secrets is refused client-side', () => {
    assert.throws(
      () => Isolated.validateExecuteRequest({ runId: 'r', command: 'node', args: ['a.js'], api_key: 'sk-123' }),
      /secret/i,
    );
    assert.throws(
      () => Isolated.validateExecuteRequest({ runId: 'r', command: 'node', args: ['/etc/passwd'] }),
      /host path/i,
    );
  });

  await test('workspace audit metadata is not sent to the isolated worker', () => {
    const payload = Isolated.workspacePayload({
      files: [{ path: 'package.json', contentBase64: 'e30=' }],
      skipped: { secrets: 2, dirs: 1 },
      bytes: 2,
    });
    assert.deepStrictEqual(payload, { files: [{ path: 'package.json', contentBase64: 'e30=' }] });
    assert.doesNotThrow(() => Isolated.validateExecuteRequest({
      runId: 'r', command: 'node', args: ['package.json'], workspace: payload,
    }));
  });

  // ---------- 4. command injection / interpreters / env tricks ----------
  await test('command guard rejects injection, substitution, interpreters, env tricks', () => {
    const ws = process.cwd();
    const bad = [
      ['node', '-e', 'evil()'],
      ['python', '-c', 'import os'],
      ['python3', '--command', 'x'],
      ['sh', '-c', 'id'],
      ['bash', '-c', 'id'],
      ['curl', 'https://x', '|', 'sh'],
      ['pytest', 'a;b'],
      ['pytest', 'a|b'],
      ['pytest', '$(whoami)'],
      ['pytest', '`whoami`'],
      ['pytest', '${HOME}'],
      ['pytest', 'FOO=bar'],
      ['npm', 'test', '--', '--prefix', '/tmp'],
      ['pytest', '--rootdir=/etc', '-q'],
      ['go', 'test', '--exec', '/bin/sh', './...'],
      ['node', '--node-options=--inspect', 'a.js'],
      ['rm', '-rf', '/'],
      ['env'],
      ['sudo', 'id'],
      ['docker', 'run', 'x'],
    ];
    for (const argv of bad) {
      const verdict = ExecutionPolicy.isCommandAllowed(null, argv);
      assert.strictEqual(verdict.allowed, false, `must deny: ${argv.join(' ')} (got ${verdict.reason})`);
      assert.throws(() => CommandGuard.validateArgv(argv, ws), null, argv.join(' '));
    }
  });

  await test('safe command families still pass', () => {
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['npm', 'test']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['npm', 'run', 'build']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['pytest']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['pytest', '-q']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['pytest', 'tests/test_a.py::test_x[param]']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['node', 'backend/test/fixture-pass.js']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['cargo', 'test']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['go', 'test']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['git', 'status']).allowed);
  });

  // ---------- 5. traversal / workspace escape ----------
  await test('traversal and workspace escapes rejected (argv + path + parser)', () => {
    const ws = makeTmp('escape');
    for (const argv of [
      ['node', '../../etc/passwd'],
      ['node', '/etc/passwd'],
      ['pytest', '../../secret'],
    ]) {
      assert.strictEqual(ExecutionPolicy.isCommandAllowed(null, argv).allowed, false, argv.join(' '));
      assert.throws(() => CommandGuard.validateArgv(argv, ws));
    }
    assert.throws(() => Environment.parseTestCommandString('node ../../etc/passwd', ws));
    assert.throws(() => Environment.parseTestCommandString('node /etc/passwd', ws));
  });

  await test('read_file cannot escape the workspace', async () => {
    const ws = makeTmp('read-escape');
    fs.writeFileSync(path.join(ws, 'ok.txt'), 'hi');
    const { exec } = executorWithTools(ws, null);
    for (const p of ['../../etc/passwd', '/etc/passwd', '//etc/passwd']) {
      const r = await exec.execute('read_file', { path: p }, fakeRun(), {});
      assert.strictEqual(r.success, false, p);
      assert.ok(!String(JSON.stringify(r.result || '')).includes('root:'), `no host content for ${p}`);
    }
  });

  // ---------- 6. network deny / allowlist / redirect SSRF ----------
  await test('network default-deny: disabled policy blocks before any I/O', async () => {
    assert.throws(() => Environment.parseAndGuardUrl('https://public.example/', { networkAccess: 'disabled' }));
    let err = null;
    try {
      await Environment.fetchUrlGuarded('https://public.example/', { policy: { networkAccess: 'disabled' } });
    } catch (e) { err = e; }
    assert.ok(err && err.code === 'denied');
  });

  await test('allowlisted network permits listed hosts, denies others, validates redirects', async () => {
    Environment.setDnsResolver(async (host) => {
      const h = String(host).toLowerCase();
      if (h === 'evil-private.example') return [{ address: '10.9.9.9', family: 4 }];
      if (h === 'private.example') return [{ address: '192.168.1.5', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const okPolicy = { networkAccess: NetworkMode.ALLOWLIST, networkAllowlist: ['example.com', 'redirector.example'] };
    try {
      assert.ok(Environment.parseAndGuardUrl('https://example.com/page', okPolicy));
      assert.throws(() => Environment.parseAndGuardUrl('https://evil.example/', okPolicy));
      let err = null;
      try { await Environment.resolveAndGuardHost('evil-private.example'); } catch (e) { err = e; }
      assert.ok(err && err.code === 'denied', 'private DNS answer rejected');
      // Redirect to a private target is rejected at the hop.
      Environment.setFetchTransport(async (url) => {
        if (url.pathname === '/start') {
          return { statusCode: 302, headers: { location: 'https://10.0.0.9/secret' }, stream: Readable.from([Buffer.from('')]) };
        }
        throw new Error('must not fetch private hop');
      });
      let rerr = null;
      try {
        await Environment.fetchUrlGuarded('https://redirector.example/start', { policy: okPolicy });
      } catch (e) { rerr = e; }
      assert.ok(rerr && ['denied', 'bad_params'].includes(rerr.code), `redirect-to-private denied (got ${rerr && rerr.code})`);
      // HTTPS -> HTTP downgrade refused under restricted policy.
      Environment.setFetchTransport(async (url) => {
        if (url.pathname === '/s') {
          return { statusCode: 302, headers: { location: 'http://example.com/plain' }, stream: Readable.from([Buffer.from('')]) };
        }
        throw new Error('downgrade must not be fetched');
      });
      let derr = null;
      try {
        await Environment.fetchUrlGuarded('https://redirector.example/s', { policy: okPolicy });
      } catch (e) { derr = e; }
      assert.ok(derr && derr.code === 'denied', 'scheme downgrade denied');
    } finally {
      Environment.setDnsResolver(null);
      Environment.setFetchTransport(null);
    }
  });

  // ---------- 7. timeout semantics ----------
  await test('local timeout is explicit timed_out (never test_failure)', async () => {
    const ws = makeTmp('timeout');
    fs.writeFileSync(path.join(ws, 'slow.js'), 'setTimeout(() => console.log("done"), 8000);');
    const { exec } = executorWithTools(ws, null);
    const prev = process.env.TOOL_RUN_TESTS_CMD;
    process.env.TOOL_RUN_TESTS_CMD = 'node slow.js';
    try {
      const r = await exec.execute('run_tests', {}, fakeRun(), { timeoutMs: 500, workspace: ws });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.status, 'timed_out');
      assert.strictEqual(r.timedOut, true);
      assert.strictEqual(r.timed_out, true);
      assert.ok(r.code === 'timeout' || r.code === 'timed_out');
      assert.ok(!/test_failure/.test(String(r.code) + String(r.error)));
      const details = r.result || {};
      assert.strictEqual(details.timedOut, true);
      assert.strictEqual(details.timed_out, true);
    } finally {
      if (prev === undefined) delete process.env.TOOL_RUN_TESTS_CMD;
      else process.env.TOOL_RUN_TESTS_CMD = prev;
    }
  });

  await test('isolated timeout maps to the same explicit contract', async () => {
    const ws = makeTmp('iso-timeout');
    const iso = stubIsolated({ ...OK_RESP, ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' });
    const { exec } = executorWithTools(ws, iso);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun(), {});
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.status, 'timed_out');
      assert.strictEqual(r.timedOut, true);
      assert.strictEqual(r.timed_out, true);
      assert.ok(!/test_failure/.test(String(r.code) + String(r.error)));
    });
  });

  // ---------- 8. approval scope preserved ----------
  await test('approvals stay single-use, fingerprinted, expiring, non-widening', async () => {
    const store = new ApprovalStore({ defaultTtlMs: 60000 });
    const params = { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] };
    const req = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params });
    assert.strictEqual(req.status, 'PENDING');
    assert.ok(store.approve(req.id).ok);
    assert.ok(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: req.id }).ok);
    const replay = store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: req.id });
    assert.strictEqual(replay.ok, false, 'replay rejected');
    // Cannot widen scope: different run/action/params all rejected.
    const req2 = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params });
    store.approve(req2.id);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-2', actionType: 'apply_patch', params, approvalId: req2.id }).ok, false);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-1', actionType: 'git_push', params, approvalId: req2.id }).ok, false);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params: { path: 'b.ts' }, approvalId: req2.id }).ok, false);
    // Expiring: approved but past TTL is unusable.
    const exp = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params, expiresInMs: 15 });
    store.approve(exp.id);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: exp.id }).ok, false);
  });

  // ---------- 9. output caps ----------
  await test('isolated output is capped, never unbounded', async () => {
    const ws = makeTmp('caps');
    const big = 'x'.repeat(300000);
    const iso = stubIsolated({ ...OK_RESP, stdout: big, stderr: big });
    const { exec } = executorWithTools(ws, iso);
    await withTestCmd('node backend/test/fixture-pass.js', async () => {
      const r = await exec.execute('run_tests', {}, fakeRun(), {});
      const out = r.result || {};
      assert.ok(Buffer.byteLength(out.stdout || '', 'utf8') <= 6000, `stdout capped (got ${Buffer.byteLength(out.stdout || '', 'utf8')})`);
      assert.ok(Buffer.byteLength(out.stderr || '', 'utf8') <= 3000, 'stderr capped');
      assert.strictEqual(out.truncated, true, 'truncation flagged');
    });
  });

  // ---------- 10. tenant/workspace isolation ----------
  await test('production workspaces are tenant-scoped and id-sanitized', async () => {
    const base = makeTmp('tenant-base');
    const {
      Orchestrator, InMemoryModelRegistry, InMemoryModelRouter, InMemoryContextManager,
      InMemoryMemoryManager, InMemoryCacheManager, CostEstimator, attachExecution,
    } = require('../../src/index');
    const { ProviderRegistry } = require('../../src/providers/provider-adapter');
    const build = () => {
      const toolRegistry = new InMemoryToolRegistry();
      const toolExecutor = new ToolExecutor.InMemoryToolExecutor(toolRegistry, null, { workspace: base });
      const orch = new Orchestrator({
        modelRegistry: new InMemoryModelRegistry([]),
        modelRouter: new InMemoryModelRouter(new InMemoryModelRegistry([])),
        contextManager: new InMemoryContextManager(),
        memoryManager: new InMemoryMemoryManager(),
        cacheManager: new InMemoryCacheManager(),
        toolRegistry, toolExecutor,
        costEstimator: new CostEstimator(),
        providerRegistry: new ProviderRegistry({ provider: 'demo', providers: {} }),
        config: { mode: 'demo' },
      });
      const execution = attachExecution(orch, { workspace: base, productionSafeToolsOnly: true });
      return { orch, execution };
    };
    const { execution } = build();
    const a = execution.workspaceFor({ orgId: 'org-a', projectId: 'proj-1', runId: 'run-1' });
    const b = execution.workspaceFor({ orgId: 'org-b', projectId: 'proj-1', runId: 'run-1' });
    assert.notStrictEqual(a, b, 'different tenants get different workspaces');
    assert.ok(a.includes('org-a') && b.includes('org-b'));
    const evil = execution.workspaceFor({ orgId: '../../etc', projectId: 'p', runId: 'r' });
    assert.ok(!evil.includes('..'), 'ids are sanitized');
    assert.ok(evil.startsWith(base), 'scoped under the execution root');
  });

  await test('production gate: run_tests needs an isolated executor, others stay denied', async () => {
    const base = makeTmp('gate-base');
    const {
      Orchestrator, InMemoryModelRegistry, InMemoryModelRouter, InMemoryContextManager,
      InMemoryMemoryManager, InMemoryCacheManager, CostEstimator, attachExecution,
    } = require('../../src/index');
    const { ProviderRegistry } = require('../../src/providers/provider-adapter');
    const build = (execOpts) => {
      const toolRegistry = new InMemoryToolRegistry();
      const toolExecutor = new ToolExecutor.InMemoryToolExecutor(toolRegistry, null, { workspace: base });
      const orch = new Orchestrator({
        modelRegistry: new InMemoryModelRegistry([]),
        modelRouter: new InMemoryModelRouter(new InMemoryModelRegistry([])),
        contextManager: new InMemoryContextManager(),
        memoryManager: new InMemoryMemoryManager(),
        cacheManager: new InMemoryCacheManager(),
        toolRegistry, toolExecutor,
        costEstimator: new CostEstimator(),
        providerRegistry: new ProviderRegistry({ provider: 'demo', providers: {} }),
        config: { mode: 'demo' },
      });
      return attachExecution(orch, { workspace: base, productionSafeToolsOnly: true, ...execOpts });
    };
    const prevUrl = process.env.ISOLATED_EXECUTOR_URL;
    delete process.env.ISOLATED_EXECUTOR_URL;
    try {
      const closed = build({});
      const rs = { runId: 'run-gate-1' };
      closed.policies.set(rs.runId, ExecutionPolicy.defaultPolicy({ workspaceRoot: base }));
      const denied = await closed._preGate(rs.runId, 'run_tests', {}, { name: 'run_tests' });
      assert.strictEqual(denied.allowed, false);
      assert.strictEqual(denied.code, 'sandbox_unavailable');
      const stillDenied = await closed._preGate(rs.runId, 'install_package', { package: 'x' }, { name: 'install_package' });
      assert.strictEqual(stillDenied.allowed, false);
      process.env.ISOLATED_EXECUTOR_URL = 'http://worker.test';
      const open = build({});
      open.policies.set(rs.runId, ExecutionPolicy.defaultPolicy({ workspaceRoot: base }));
      const allowed = await open._preGate(rs.runId, 'run_tests', {}, { name: 'run_tests', requiresApproval: false, riskLevel: 'LOW' });
      assert.strictEqual(allowed.allowed, true, `isolated-routed run_tests passes the gate (${allowed.reason})`);
    } finally {
      if (prevUrl === undefined) delete process.env.ISOLATED_EXECUTOR_URL;
      else process.env.ISOLATED_EXECUTOR_URL = prevUrl;
    }
  });

  // ---------- 11. provenance boundary ----------
  await test('repo/tool content is tagged DATA, never trusted instructions', () => {
    const repo = Provenance.repoDataProvenance('run-1', 'read_file', 'README.md');
    assert.strictEqual(repo.trustedAsInstruction, false);
    assert.strictEqual(repo.instructionAuthority, 'none');
    const tool = Provenance.toolOutputProvenance('run-1', 'run_tests', null);
    assert.strictEqual(tool.trustedAsInstruction, false);
    const user = Provenance.buildProvenance({ source: 'user', runId: 'run-1' });
    assert.strictEqual(user.trustedAsInstruction, true);
    assert.strictEqual(user.instructionAuthority, 'principal');
  });

  // ---------- 12. registry refuses raw shell tools ----------
  await test('tool registry refuses raw shell registrations', async () => {
    const reg = new InMemoryToolRegistry();
    for (const name of ['shell', 'exec', 'run_any_command']) {
      let threw = false;
      try {
        await reg.registerTool({ name, description: 'x', parameters: { type: 'object', properties: {} } });
      } catch { threw = true; }
      assert.ok(threw, `must refuse ${name}`);
    }
  });

  // ---------- 13. destructive/unknown never auto-retries ----------
  await test('sandbox_unavailable never auto-retries; destructive-unknown never retries', () => {
    const Recovery = require('../../src/execution/recovery');
    assert.strictEqual(Recovery.retryDecision({ code: 'sandbox_unavailable', attempt: 0 }).retry, false);
    assert.strictEqual(Recovery.retryDecision({ code: 'executor_unavailable', attempt: 0 }).retry, false);
    assert.strictEqual(Recovery.retryDecision({ code: 'timeout', attempt: 0, destructive: true }).retry, false);
    const d = Recovery.decideRecovery({ lastCheckpoint: {}, toolRecord: { state: 'unknown', destructive: true, idempotent: false } });
    assert.strictEqual(d.decision, 'mark_unknown');
  });

  console.log(`\n--- Agent3 security results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
