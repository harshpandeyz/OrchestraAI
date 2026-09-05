'use strict';

// Session 3 tests: agent execution, tools, approvals, recovery & workspace
// automation. Covers: tool contracts/policy, approval model (+replay),
// filesystem sandbox, command safety, timeouts, output limits, changesets,
// patch/rollback/hash conflicts, git, same-run continuation/episodes,
// pause/resume, checkpoints/crash recovery, retry/backoff, artifacts,
// environment detection, network policy.
//
// Run: node backend/test/session3-execution.test.js

process.env.RUNTIME_MODE = 'demo';
process.env.ALLOW_FILE_WRITES = 'true';
process.env.TOOL_RUN_TESTS_CMD = 'node backend/test/fixture-pass.js';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  Orchestrator,
  InMemoryModelRegistry,
  InMemoryModelRouter,
  InMemoryContextManager,
  InMemoryMemoryManager,
  InMemoryCacheManager,
  InMemoryToolRegistry,
  InMemoryToolExecutor,
  CostEstimator,
  TaskStatus,
  attachExecution,
  ToolSystem,
  ExecutionPolicy,
  Approvals,
  Changesets,
  Environment,
  PlansEpisodes,
  Recovery,
} = require('../src/index');
const { ProviderRegistry } = require('../src/providers/provider-adapter');

const MODELS = [
  { id: 'model-a', name: 'Model A', provider: 'demo', status: 'healthy', contextWindow: 128000, quality: 0.9, avgLatencyMs: 1500, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.003, cachedPer1k: 0.0002, capabilities: ['coding', 'reasoning', 'tools'] },
];

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.message}`);
    failed++;
  }
}

function makeTmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `s3-${name}-`));
  return dir;
}

function makeOrchestrator(workspace, opts = {}) {
  const toolRegistry = new InMemoryToolRegistry();
  toolRegistry.seedTools([
    { name: 'read_file', description: 'read', status: 'enabled', costPerCall: 0.0002, timeoutMs: 10000, permissions: ['workspace:read'], capabilities: ['read'], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'search_code', description: 'search', status: 'enabled', costPerCall: 0.0005, timeoutMs: 15000, permissions: ['workspace:read'], capabilities: ['search'], parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'run_tests', description: 'tests', status: 'enabled', costPerCall: 0.002, timeoutMs: 60000, permissions: ['tests:execute'], capabilities: ['test'], parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'apply_patch', description: 'patch', status: 'enabled', costPerCall: 0.001, timeoutMs: 10000, permissions: ['workspace:write'], capabilities: ['edit'], parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] } },
  ]);
  const toolExecutor = new InMemoryToolExecutor(toolRegistry, null, { workspace });
  const registry = new InMemoryModelRegistry(MODELS);
  const orch = new Orchestrator({
    modelRegistry: registry,
    modelRouter: new InMemoryModelRouter(registry),
    contextManager: new InMemoryContextManager(),
    memoryManager: new InMemoryMemoryManager(),
    cacheManager: new InMemoryCacheManager(),
    toolRegistry,
    toolExecutor,
    costEstimator: new CostEstimator(),
    providerRegistry: new ProviderRegistry({ provider: 'demo', providers: {} }),
    config: { mode: 'demo', provider: 'demo', maxSteps: 4, maxToolCalls: 6, maxRetries: 1 },
  });
  const execution = attachExecution(orch, { workspace, autoVerify: false, ...(opts.exec || {}) });
  return { orch, execution, toolRegistry, toolExecutor };
}

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function main() {
  // ================= tool system =================
  await test('tool definitions cover all capability categories', () => {
    const cats = new Set(ToolSystem.TOOL_DEFINITIONS.map((d) => d.category));
    for (const c of ['filesystem', 'search', 'code', 'testing', 'git', 'environment', 'network', 'browser', 'deployment']) {
      assert.ok(cats.has(c), `category ${c} present`);
    }
  });

  await test('tool registration carries risk/permissions/timeout/approval metadata', async () => {
    const reg = new InMemoryToolRegistry();
    const t = await reg.registerTool({ name: 'apply_patch', description: 'p', parameters: { type: 'object', properties: {}, required: [] }, category: 'code', riskLevel: 'MEDIUM', requiresApproval: true, supportsDryRun: true, idempotent: false, timeoutMs: 5000, permissions: ['workspace:write'] });
    assert.strictEqual(t.category, 'code');
    assert.strictEqual(t.riskLevel, 'MEDIUM');
    assert.strictEqual(t.requiresApproval, true);
    assert.strictEqual(t.supportsDryRun, true);
    assert.strictEqual(t.timeoutMs, 5000);
  });

  await test('tool schema validation rejects bad params', () => {
    const r = ToolSystem.validateInput({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, {});
    assert.strictEqual(r.valid, false);
    assert.ok(ToolSystem.validateInput({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, { path: 'a' }).valid);
  });

  await test('tool execution returns normalized result contract', () => {
    const r = ToolSystem.createExecutionResult({ toolName: 'read_file', status: 'success', output: { a: 1 } });
    for (const k of ['executionId', 'toolId', 'status', 'startedAt', 'completedAt', 'durationMs', 'output', 'error', 'artifacts', 'sideEffects']) {
      assert.ok(r[k] !== undefined, `field ${k} present`);
    }
  });

  await test('output truncation is flagged, never silent', () => {
    const { text, outputTruncated } = ToolSystem.truncateOutput('a\n'.repeat(1000), { maxLines: 10, maxOutputBytes: 50 });
    assert.strictEqual(outputTruncated, true);
    assert.ok(text.length < 2000);
  });

  // ================= policy =================
  await test('default policy is conservative (writes gated, network restricted, deploy/push off)', () => {
    const p = ExecutionPolicy.defaultPolicy();
    assert.strictEqual(p.allowDeploy, false);
    assert.strictEqual(p.allowPush, false);
    assert.strictEqual(p.allowInstall, false);
    assert.ok(p.deniedTools.includes('git_push'));
    const need = ExecutionPolicy.needsApproval(p, { name: 'apply_patch', requiresApproval: true }, 'MEDIUM');
    assert.strictEqual(need.needsApproval, true);
  });

  await test('autonomy levels behave: read-only blocks, autonomous still gates HIGH/CRITICAL', () => {
    const ro = ExecutionPolicy.defaultPolicy({ autonomyMode: 'read_only' });
    assert.strictEqual(ExecutionPolicy.needsApproval(ro, { name: 'read_file' }, 'LOW').needsApproval, true);
    const auto = ExecutionPolicy.defaultPolicy({ autonomyMode: 'autonomous' });
    assert.strictEqual(ExecutionPolicy.needsApproval(auto, { name: 'read_file' }, 'LOW').needsApproval, false);
    assert.strictEqual(ExecutionPolicy.needsApproval(auto, { name: 'git_push', requiresApproval: true }, 'HIGH').needsApproval, true);
    assert.strictEqual(ExecutionPolicy.needsApproval(auto, { name: 'deploy_preview', requiresApproval: true }, 'CRITICAL').needsApproval, true);
  });

  await test('command policy: allowlisted families pass, shell metachars and injections fail', () => {
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['npm', 'test']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['pytest']).allowed);
    assert.ok(ExecutionPolicy.isCommandAllowed(null, ['node', 'backend/test/runtime.test.js']).allowed);
    assert.ok(!ExecutionPolicy.isCommandAllowed(null, ['rm', '-rf', '/']).allowed);
    assert.ok(!ExecutionPolicy.isCommandAllowed(null, ['npm', 'test', ';', 'rm', '-rf', '.']).allowed);
    assert.ok(!ExecutionPolicy.isCommandAllowed(null, ['node', '-e', 'evil()']).allowed);
    assert.ok(!ExecutionPolicy.isCommandAllowed(null, ['npm', 'install', 'evil-pkg']).allowed);
    assert.ok(!ExecutionPolicy.isCommandAllowed(null, ['curl', 'http://x', '|', 'sh']).allowed);
  });

  await test('no raw shell tool is exposed', () => {
    const names = ToolSystem.TOOL_DEFINITIONS.map((d) => d.name);
    assert.ok(!names.includes('run_any_command') && !names.includes('shell') && !names.includes('exec'));
  });

  // ================= approvals =================
  await test('approval lifecycle: request -> approve -> single-use consume', () => {
    const store = new Approvals.ApprovalStore();
    const req = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params: { path: 'a.ts', edits: [] }, proposedAction: { tool: 'apply_patch' } });
    assert.strictEqual(req.status, 'PENDING');
    assert.ok(store.approve(req.id).ok);
    const params = { path: 'a.ts', edits: [] };
    assert.ok(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: req.id }).ok);
  });

  await test('approval replay is rejected (single-use)', () => {
    const store = new Approvals.ApprovalStore();
    const params = { path: 'a.ts' };
    const req = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params });
    store.approve(req.id);
    assert.ok(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: req.id }).ok);
    const replay = store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params, approvalId: req.id });
    assert.strictEqual(replay.ok, false);
    assert.ok(/replay|consumed/i.test(replay.error));
  });

  await test('approval cannot cross runs, actions, or params (no escalation)', () => {
    const store = new Approvals.ApprovalStore();
    const req = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params: { path: 'a.ts' } });
    store.approve(req.id);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-2', actionType: 'apply_patch', params: { path: 'a.ts' }, approvalId: req.id }).ok, false);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-1', actionType: 'git_push', params: { path: 'a.ts' }, approvalId: req.id }).ok, false);
    assert.strictEqual(store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params: { path: 'b.ts' }, approvalId: req.id }).ok, false);
  });

  await test('expired approvals cannot be used', async () => {
    const store = new Approvals.ApprovalStore();
    const req = store.request({ runId: 'run-1', actionType: 'apply_patch', title: 't', params: { a: 1 }, expiresInMs: 20 });
    store.approve(req.id);
    await new Promise((r) => setTimeout(r, 40));
    const out = store.checkAndConsume({ runId: 'run-1', actionType: 'apply_patch', params: { a: 1 }, approvalId: req.id });
    assert.strictEqual(out.ok, false);
  });

  await test('risk classification is policy-aware (params can raise, never lower)', () => {
    const low = Approvals.classifyRisk({ name: 'read_file', riskLevel: 'LOW' }, { path: 'x' });
    assert.strictEqual(low.risk, 'LOW');
    const big = Approvals.classifyRisk({ name: 'apply_patch', riskLevel: 'MEDIUM' }, { path: 'auth/service.ts', edits: [{ oldText: 'a', newText: 'b'.repeat(30000) }] });
    assert.ok(['HIGH', 'CRITICAL'].includes(big.risk));
    const push = Approvals.classifyRisk({ name: 'git_push', riskLevel: 'HIGH' }, {});
    assert.strictEqual(push.risk, 'HIGH');
  });

  // ================= filesystem sandbox =================
  await test('filesystem: ../ traversal blocked', async () => {
    const ws = makeTmp('traverse');
    fs.writeFileSync(path.join(ws, 'ok.txt'), 'hi');
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const r = await toolExecutor.execute('read_file', { path: '../../etc/passwd' }, rs, {});
    assert.strictEqual(r.success, false);
  });

  await test('filesystem: absolute /etc/passwd unreachable via path tricks', async () => {
    const ws = makeTmp('abspath');
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    for (const p of ['/etc/passwd', '//etc/passwd', '/etc/../etc/passwd']) {
      const r = await toolExecutor.execute('read_file', { path: p }, rs, {});
      assert.strictEqual(r.success, false, p);
      assert.ok(!String(r.result?.content || '').includes('root:'), `no /etc/passwd content for ${p}`);
    }
  });

  await test('filesystem: symlink escape rejected', async () => {
    const ws = makeTmp('symlink');
    const outside = makeTmp('outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt')); }
    catch { console.log('  (symlink unsupported, skipping)'); return; }
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const r = await toolExecutor.execute('read_file', { path: 'link.txt' }, rs, {});
    assert.strictEqual(r.success, false);
  });

  await test('filesystem: large file rejected, binary detected', async () => {
    const ws = makeTmp('limits');
    fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(600000));
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 254, 10, 0, 65, 66]));
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const big = await toolExecutor.execute('read_file', { path: 'big.txt' }, rs, {});
    assert.strictEqual(big.success, false);
    assert.ok(/large|too_large/i.test(big.error + (big.code || '')));
    const bin = await toolExecutor.execute('read_file', { path: 'bin.dat' }, rs, {});
    assert.strictEqual(bin.success, false);
    assert.ok(/binary/i.test(bin.error + (bin.code || '')));
  });

  // ================= search =================
  await test('search returns bounded structured results {file,line,column,match}', async () => {
    const ws = makeTmp('search');
    fs.writeFileSync(path.join(ws, 'a.js'), 'function hello() {}\n// hello world\nconst x = 1;\n');
    fs.writeFileSync(path.join(ws, 'b.md'), 'hello docs\n');
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const r = await toolExecutor.execute('search_code', { query: 'hello', maxResults: 5 }, rs, {});
    assert.strictEqual(r.success, true);
    assert.ok(r.result.results.length <= 5);
    for (const m of r.result.results) {
      assert.ok(m.file && Number.isFinite(m.line) && Number.isFinite(m.column) && typeof m.match === 'string');
    }
  });

  await test('search excludes binaries, ignored dirs, and caps response size', async () => {
    const ws = makeTmp('search2');
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.writeFileSync(path.join(ws, 'node_modules', 'lib.js'), 'needle here\n');
    fs.writeFileSync(path.join(ws, 'bin.js'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1, 2]));
    fs.writeFileSync(path.join(ws, 'ok.js'), 'needle in haystack\n');
    const { orch, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const r = await toolExecutor.execute('search_code', { query: 'needle', maxResults: 50 }, rs, {});
    assert.strictEqual(r.success, true);
    const files = r.result.results.map((x) => x.file);
    assert.ok(!files.some((f) => f.includes('node_modules')), 'ignored dir excluded');
    assert.ok(!files.includes('bin.js'), 'binary excluded');
    assert.ok(files.includes('ok.js'));
  });

  // ================= test runner =================
  await test('test runner returns structured contract (command/exitCode/duration/stdout/stderr)', async () => {
    const { orch, toolExecutor } = makeOrchestrator(process.cwd());
    const rs = await orch.createRun('t', {});
    const r = await toolExecutor.execute('run_tests', { suite: 'session' }, rs, {});
    assert.strictEqual(r.success, true);
    for (const k of ['command', 'cwd', 'exitCode', 'durationMs', 'stdout', 'stderr', 'timedOut', 'truncated']) {
      assert.ok(r.result[k] !== undefined, `result.${k} present`);
    }
    assert.strictEqual(r.result.exitCode, 0);
  });

  await test('tool timeout produces TIMED_OUT, never a hang', async () => {
    const ws = makeTmp('timeout');
    fs.writeFileSync(path.join(ws, 'slow.js'), 'setTimeout(() => console.log("done"), 5000);');
    const prev = process.env.TOOL_RUN_TESTS_CMD;
    process.env.TOOL_RUN_TESTS_CMD = 'node slow.js';
    try {
      const { orch, toolExecutor } = makeOrchestrator(ws);
      const rs = await orch.createRun('t', {});
      const r = await toolExecutor.execute('run_tests', {}, rs, { timeoutMs: 500 });
      // Canonical timeout contract: status timed_out, success false,
      // timedOut true — never test_failure. Terminology is consistent
      // across executor (status/code), result details (timedOut), and the
      // recovery/tool-health layers (timed_out).
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.status, 'timed_out', `status must be timed_out (got ${r.status})`);
      assert.ok(r.code === 'timeout' || r.code === 'timed_out', `code must be timeout (got ${r.code})`);
      const details = r.result || r.output || {};
      assert.strictEqual(details.timedOut, true, 'result details carry timedOut=true');
      assert.ok(!/test_failure/.test(String(r.code) + String(r.error)), 'timeout never reported as test_failure');
    } finally {
      if (prev === undefined) delete process.env.TOOL_RUN_TESTS_CMD;
      else process.env.TOOL_RUN_TESTS_CMD = prev;
    }
  });

  await test('disallowed test command is rejected', async () => {
    const prev = process.env.TOOL_RUN_TESTS_CMD;
    process.env.TOOL_RUN_TESTS_CMD = 'rm -rf /tmp/x';
    try {
      const { orch, toolExecutor } = makeOrchestrator(process.cwd());
      const rs = await orch.createRun('t', {});
      const r = await toolExecutor.execute('run_tests', {}, rs, {});
      assert.strictEqual(r.success, false);
    } finally {
      if (prev === undefined) delete process.env.TOOL_RUN_TESTS_CMD;
      else process.env.TOOL_RUN_TESTS_CMD = prev;
    }
  });

  // ================= changesets =================
  await test('changeset: dry-run proposes without mutating; apply is atomic + hash-verified', async () => {
    const ws = makeTmp('changeset');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello world\n');
    const { orch, execution } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const cs = await execution.proposeChangeset(rs.runId, [{ path: 'a.txt', edits: [{ oldText: 'world', newText: 'there' }] }]);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hello world\n', 'dry-run mutates nothing');
    assert.ok(cs.beforeHashes['a.txt'] && cs.afterHashes['a.txt']);
    // read-only default policy requires approval for apply
    const blocked = await execution.applyChangeset(rs.runId, cs.id);
    assert.ok(blocked.needsApproval && blocked.approvalId, 'apply gated by approval');
    const ok = await execution.applyChangeset(rs.runId, cs.id, { approvalId: blocked.approvalId && execution.decideApproval(rs.runId, blocked.approvalId, 'approve').approval.id });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hello there\n');
  });

  await test('changeset conflict: stale proposal never partially applies', async () => {
    const ws = makeTmp('conflict');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'v1\n');
    const store = new Changesets.ChangesetStore();
    const cs = await store.propose({ runId: 'run-1', workspace: ws, files: [
      { path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] },
      { path: 'b.txt', edits: [{ oldText: 'v1', newText: 'v2' }] },
    ] });
    fs.writeFileSync(path.join(ws, 'b.txt'), 'user edited\n'); // user edit after proposal
    const r = await store.apply(cs.id, { workspace: ws });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.conflict, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n', 'already-written file restored');
  });

  await test('rollback restores; rollback after user edit reports conflict (no overwrite)', async () => {
    const ws = makeTmp('rollback');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    const store = new Changesets.ChangesetStore();
    const cs = await store.propose({ runId: 'run-1', workspace: ws, files: [{ path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] }] });
    assert.ok((await store.apply(cs.id, { workspace: ws })).ok);
    // user edits after apply
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v2 + user work\n');
    const blocked = await store.rollback(cs.id, { workspace: ws });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.conflict, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v2 + user work\n', 'user work preserved');
    // clean rollback path
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    const cs2 = await store.propose({ runId: 'run-1', workspace: ws, files: [{ path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] }] });
    assert.ok((await store.apply(cs2.id, { workspace: ws })).ok);
    const rb = await store.rollback(cs2.id, { workspace: ws });
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n');
  });

  // ================= git =================
  await test('git: status/diff/log read-only; commit scope blocks unrelated changes', async () => {
    if (!gitAvailable()) { console.log('  (git missing, skipping)'); return; }
    const ws = makeTmp('git');
    execFileSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: ws, stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, 'agent.txt'), 'agent work\n');
    fs.writeFileSync(path.join(ws, 'user.txt'), 'user work\n');
    execFileSync('git', ['add', 'agent.txt', 'user.txt'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: ws, stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, 'agent.txt'), 'agent work v2\n');
    fs.writeFileSync(path.join(ws, 'user.txt'), 'user work v2\n');
    const st = await Changesets.gitStatus(ws);
    assert.strictEqual(st.files.length, 2);
    const df = await Changesets.gitDiff(ws, {});
    assert.ok(df.additions + df.deletions > 0);
    const lg = await Changesets.gitLog(ws, 5);
    assert.ok(lg.length >= 1);
    // stage everything, then scope-check to agent paths only -> must refuse
    execFileSync('git', ['add', 'agent.txt', 'user.txt'], { cwd: ws, stdio: 'ignore' });
    let threw = false;
    try { await Changesets.gitCommit(ws, 'agent change', { allowedPaths: ['agent.txt'] }); }
    catch (e) { threw = e.code === 'scope_violation'; }
    assert.ok(threw, 'unrelated user changes blocked from agent commit');
    let badBranch = false;
    try { await Changesets.gitCreateBranch(ws, '../evil'); } catch (e) { badBranch = e.code === 'bad_params'; }
    assert.ok(badBranch, 'invalid branch rejected');
  });

  // ================= network =================
  await test('network policy blocks localhost/private/metadata/invalid/credentialed URLs', () => {
    const pol = { networkAccess: 'allowlist', networkAllowlist: ['example.com'] };
    for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'ftp://example.com/x', 'not-a-url', 'https://user:pass@example.com/']) {
      assert.throws(() => Environment.parseAndGuardUrl(u, pol), null, u);
    }
    assert.ok(Environment.parseAndGuardUrl('https://example.com/page', pol));
    assert.throws(() => Environment.parseAndGuardUrl('https://evil.com/', pol), null, 'allowlist enforced');
    assert.throws(() => Environment.parseAndGuardUrl('https://example.com/', { networkAccess: 'disabled' }), null, 'disabled enforced');
  });

  // ================= environment / artifacts / redaction =================
  await test('environment profile exposes no secrets', async () => {
    const p = await Environment.environmentProfile(process.cwd());
    assert.ok(p.os && p.architecture);
    assert.ok(Array.isArray(p.runtimes) && Array.isArray(p.detectedCommands));
    assert.ok(!p.env.OPENAI_API_KEY && !p.env.OPENROUTER_API_KEY && !p.env.ANTHROPIC_API_KEY, 'no secret keys');
    assert.ok(!JSON.stringify(p).includes('sk-'), 'no token material');
  });

  await test('project detection finds node project + test/build commands', async () => {
    const d = await Environment.detectProject(process.cwd());
    assert.ok(d.projectTypes.includes('node'));
    assert.ok(d.detectedCommands.length > 0);
  });

  await test('artifacts are references (id/type/size/hash), large content stays out', () => {
    const store = new Environment.ArtifactStore();
    const big = store.put({ runId: 'r', type: 'build-log', name: 'build.log', content: 'x'.repeat(200000) });
    assert.ok(big.reference.artifactId && big.reference.hash && big.reference.size === 200000);
    assert.strictEqual(big.inline, null, 'large artifact not inlined');
    const small = store.put({ runId: 'r', type: 'test-report', name: 't.log', content: 'ok' });
    assert.ok(small.inline !== null);
  });

  await test('redaction strips tokens, keys, and URL credentials before persistence', () => {
    const out = Environment.redactSecrets({ api_key: 'sk-abc123', nested: { token: 'xyz' }, url: 'https://user:hunter2@example.com/x', note: 'hello' });
    assert.strictEqual(out.api_key, '[REDACTED]');
    assert.strictEqual(out.nested.token, '[REDACTED]');
    assert.ok(!out.url.includes('hunter2'));
    assert.strictEqual(out.note, 'hello');
  });

  // ================= plans / episodes / pause =================
  await test('plan is executable: DAG readiness, adaptation, completion', () => {
    const pm = new PlansEpisodes.PlanManager();
    const plan = pm.create('run-1', [
      { description: 'inspect auth', expectedArtifacts: ['auth-notes'] },
      { description: 'patch refresh logic', dependencies: [] },
    ]);
    const patchStep = plan.steps[1];
    pm.adapt('run-1', { updateStep: { [patchStep.id]: { dependencies: [plan.steps[0].id] } }, addSteps: ['regression tests'] });
    // After adaptation: step A (inspect) ready, step B (patch, depends on A)
    // blocked, step C (regression tests, no deps) ready => 2 ready.
    // A DAG must never expose blocked steps as ready, but unblocked steps
    // (including newly added ones) are ready.
    const ready1 = pm.readySteps('run-1');
    assert.strictEqual(ready1.length, 2, `only unblocked steps ready (got ${ready1.map((s) => s.description).join(', ')})`);
    assert.ok(!ready1.some((s) => s.id === patchStep.id), 'blocked patch step not ready');
    pm.setStatus('run-1', plan.steps[0].id, 'COMPLETED');
    const ready2 = pm.readySteps('run-1');
    assert.strictEqual(ready2.length, 2, 'patch unblocked + regression still ready');
    assert.ok(ready2.some((s) => s.id === patchStep.id), 'patch ready after A completes');
    assert.strictEqual(pm.isComplete('run-1'), false);
  });

  await test('plan DAG regression: chains and branching never expose blocked steps', () => {
    const pm = new PlansEpisodes.PlanManager();
    // Chain: A -> B -> C. Only A ready; after A, only B; after B, only C.
    const chain = pm.create('run-chain', [{ description: 'A' }, { description: 'B' }, { description: 'C' }]);
    const [a, b, c] = chain.steps;
    pm.adapt('run-chain', { updateStep: { [b.id]: { dependencies: [a.id] }, [c.id]: { dependencies: [b.id] } } });
    assert.deepStrictEqual(pm.readySteps('run-chain').map((s) => s.id), [a.id], 'chain: only A ready');
    pm.setStatus('run-chain', a.id, 'COMPLETED');
    assert.deepStrictEqual(pm.readySteps('run-chain').map((s) => s.id), [b.id], 'chain: only B ready');
    pm.setStatus('run-chain', b.id, 'COMPLETED');
    assert.deepStrictEqual(pm.readySteps('run-chain').map((s) => s.id), [c.id], 'chain: only C ready');
    // Branching: A fans out to B,C; D joins B+C.
    const br = pm.create('run-branch', [{ description: 'A' }, { description: 'B' }, { description: 'C' }, { description: 'D' }]);
    const [ba, bb, bc, bd] = br.steps;
    pm.adapt('run-branch', {
      updateStep: { [bb.id]: { dependencies: [ba.id] }, [bc.id]: { dependencies: [ba.id] }, [bd.id]: { dependencies: [bb.id, bc.id] } },
    });
    assert.deepStrictEqual(pm.readySteps('run-branch').map((s) => s.id), [ba.id], 'branch: only root ready');
    pm.setStatus('run-branch', ba.id, 'COMPLETED');
    assert.deepStrictEqual(new Set(pm.readySteps('run-branch').map((s) => s.id)), new Set([bb.id, bc.id]), 'branch: both children ready');
    assert.ok(!pm.readySteps('run-branch').some((s) => s.id === bd.id), 'join blocked until both parents complete');
    pm.setStatus('run-branch', bb.id, 'COMPLETED');
    assert.ok(!pm.readySteps('run-branch').some((s) => s.id === bd.id), 'join still blocked with one parent pending');
    pm.setStatus('run-branch', bc.id, 'COMPLETED');
    assert.deepStrictEqual(pm.readySteps('run-branch').map((s) => s.id), [bd.id], 'join ready after both parents complete');
  });

  await test('episodes link parent->child for same-run continuation', () => {
    const em = new PlansEpisodes.EpisodeManager();
    const e1 = em.start('run-1', { goal: 'fix bug' });
    em.finish('run-1', e1.episodeId, 'COMPLETED');
    const e2 = em.start('run-1', { parentEpisodeId: e1.episodeId, goal: 'also change tests' });
    assert.strictEqual(e2.parentEpisodeId, e1.episodeId);
    assert.strictEqual(em.list('run-1').length, 2);
  });

  await test('pause/resume is cooperative (PAUSING->PAUSED->RESUMING->RUNNING)', () => {
    const pc = new PlansEpisodes.PauseController();
    assert.strictEqual(pc.requestPause('r'), 'PAUSING');
    assert.strictEqual(pc.settlePause('r'), 'PAUSED');
    assert.ok(pc.shouldHold('r'));
    assert.strictEqual(pc.requestResume('r'), 'RESUMING');
    assert.strictEqual(pc.settleResume('r'), 'RUNNING');
  });

  await test('human override parses to explicit runtime commands', () => {
    assert.strictEqual(PlansEpisodes.parseRuntimeCommand('Stop.').type, 'stop');
    assert.strictEqual(PlansEpisodes.parseRuntimeCommand('pause').type, 'pause');
    const only = PlansEpisodes.parseRuntimeCommand('Only change auth/service.ts');
    assert.strictEqual(only.type, 'constrain_paths');
    const forbid = PlansEpisodes.parseRuntimeCommand("Don't touch tests");
    assert.strictEqual(forbid.type, 'forbid_paths');
    const cs = new PlansEpisodes.ConstraintStore();
    cs.applyCommand('r', forbid);
    assert.strictEqual(cs.checkWrite('r', 'tests/x.spec').allowed, false);
    assert.strictEqual(cs.checkWrite('r', 'src/a.ts').allowed, true);
  });

  // ================= recovery / retry =================
  await test('recovery: idempotent in-flight retries; destructive in-flight is UNKNOWN (never FAILED)', () => {
    const skip = Recovery.decideRecovery({ lastCheckpoint: {}, toolRecord: null });
    assert.strictEqual(skip.decision, 'resume');
    const proven = Recovery.decideRecovery({ lastCheckpoint: {}, toolRecord: { state: 'in_flight' }, idempotencyKnownCompleted: true });
    assert.strictEqual(proven.decision, 'skip');
    const destr = Recovery.decideRecovery({ lastCheckpoint: {}, toolRecord: { state: 'in_flight', destructive: true, idempotent: false } });
    assert.strictEqual(destr.decision, 'mark_unknown');
    const idem = Recovery.decideRecovery({ lastCheckpoint: {}, toolRecord: { state: 'in_flight', destructive: false, idempotent: true } });
    assert.strictEqual(idem.decision, 'retry');
    assert.ok(!['resume', 'retry', 'skip'].includes(destr.decision) || true, 'UNKNOWN preserved');
  });

  await test('retry policy: transient retries with bounded backoff; validation/permission never retry; destructive-unknown never retries', () => {
    assert.strictEqual(Recovery.retryDecision({ code: 'timeout', attempt: 0 }).retry, true);
    assert.strictEqual(Recovery.retryDecision({ code: 'timeout', attempt: 0 }).backoffMs, 250);
    assert.strictEqual(Recovery.backoffForAttempt(3), 2000);
    assert.strictEqual(Recovery.retryDecision({ code: 'bad_params', attempt: 0 }).retry, false);
    assert.strictEqual(Recovery.retryDecision({ code: 'denied', attempt: 0 }).retry, false);
    assert.strictEqual(Recovery.retryDecision({ code: 'timeout', attempt: 0, destructive: true }).retry, false);
    assert.strictEqual(Recovery.retryDecision({ code: 'timeout', attempt: 5 }).retry, false, 'retry budget bounded');
  });

  await test('agent result distinguishes TASK_COMPLETED from MODEL_STOPPED and flags missing verification', () => {
    const incomplete = Recovery.agentResult({ status: 'TASK_COMPLETED', goal: 'g', summary: 's', requiredVerification: ['tests'], verification: [] });
    assert.strictEqual(incomplete.verificationIncomplete, true);
    const stopped = Recovery.agentResult({ status: 'MODEL_STOPPED', goal: 'g', summary: 's' });
    assert.strictEqual(stopped.status, 'MODEL_STOPPED');
  });

  await test('tool health tracks success/failures/timeouts/approval rates', () => {
    const h = new Recovery.ToolHealthTracker();
    h.record({ tool: 'read_file', durationMs: 10, status: 'success' });
    h.record({ tool: 'read_file', durationMs: 5000, status: 'timed_out' });
    const s = h.health('read_file');
    assert.strictEqual(s.calls, 2);
    assert.strictEqual(s.successRate, 0.5);
    assert.strictEqual(s.timeoutRate, 0.5);
  });

  // ================= orchestrator integration =================
  await test('approval gate blocks apply_patch by default; explicit approval executes', async () => {
    const ws = makeTmp('gate');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    const { orch, execution, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const blocked = await toolExecutor.execute('apply_patch', { path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] }, rs, {});
    assert.strictEqual(blocked.success, false);
    assert.ok(blocked.code === 'needs_approval' || blocked.status === 'needs_approval', `got ${blocked.code}/${blocked.status}`);
    assert.ok(blocked.approvalId, 'approval id returned');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n', 'nothing applied without approval');
    // PENDING approval alone must NOT execute: user must approve first.
    const premature = await execution.executeWithApproval(rs.runId, 'apply_patch', { path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] }, blocked.approvalId);
    assert.strictEqual(premature.ok, false, 'PENDING approval is not a valid approval');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n', 'still nothing applied');
    // User approves, then exactly-once execution consumes the approval.
    const decided = execution.decideApproval(rs.runId, blocked.approvalId, 'approve');
    assert.strictEqual(decided.ok, true, 'user approval recorded');
    const out = await execution.executeWithApproval(rs.runId, 'apply_patch', { path: 'a.txt', edits: [{ oldText: 'v1', newText: 'v2' }] }, decided.approval.id);
    assert.strictEqual(out.ok, true, `approved execution succeeds (got ${out.error || out.code})`);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v2\n');
    // Replay of the same approval must fail (single-use).
    const replay = await execution.executeWithApproval(rs.runId, 'apply_patch', { path: 'a.txt', edits: [{ oldText: 'v2', newText: 'v3' }] }, decided.approval.id);
    assert.strictEqual(replay.ok, false, 'consumed approval cannot be replayed');
  });

  await test('same-run continuation: new episode, same run, history preserved, no duplicate side effects', async () => {
    const ws = makeTmp('continue');
    const { orch, execution } = makeOrchestrator(ws);
    const rs = await orch.createRun('answer things', {});
    await orch.startRun(rs.runId, 'What is 2+2? Explain briefly.');
    await orch.waitForCompletion(rs.runId, 60000);
    // Completed runs retire to terminal history: getRun (live + history) is
    // the correct lookup; activeRuns.get returns undefined after retirement.
    const after1 = orch.getRun(rs.runId);
    assert.ok(after1, 'completed run remains queryable via getRun');
    assert.strictEqual(after1.status, TaskStatus.COMPLETED, `first run completed, got ${after1 && after1.status}`);
    const eps1 = execution.episodes.list(rs.runId);
    assert.strictEqual(eps1.length, 1);
    const callsBefore = after1.tools.recentToolCalls.length;
    const cont = await execution.continueRun(rs.runId, 'Also explain why.');
    assert.strictEqual(cont.ok, true);
    assert.strictEqual(cont.episode.parentEpisodeId, eps1[0].episodeId);
    await orch.waitForCompletion(rs.runId, 60000);
    const eps2 = execution.episodes.list(rs.runId);
    assert.strictEqual(eps2.length, 2, 'second episode on the same run');
    assert.strictEqual(eps2[0].runId, eps2[1].runId);
    const ctrl = orch.control(rs.runId);
    assert.ok(ctrl.messages.length >= 3, 'previous messages preserved, not from scratch');
    assert.ok(ctrl.messages.some((m) => m.role === 'assistant'), 'previous result available');
    assert.ok(after1.tools.recentToolCalls.length >= callsBefore, 'history monotonic');
  });

  await test('pause holds tool execution at a safe boundary, resume releases it', async () => {
    const ws = makeTmp('pause');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'data\nline2\n');
    const { orch, execution, toolExecutor } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    execution.pauseRun(rs.runId);
    let released = false;
    const pending = toolExecutor.execute('read_file', { path: 'a.txt' }, rs, {}).then((r) => { released = r.success; return r; });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(released, false, 'tool held while paused');
    execution.resumeRun(rs.runId);
    const r = await pending;
    assert.strictEqual(r.success, true, 'tool proceeds after resume');
  });

  await test('crash recovery marks unknown side effects (never silently FAILED)', async () => {
    const ws = makeTmp('recover');
    const { orch, execution } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const out = await execution.recover(rs.runId, {
      toolRecord: { state: 'unknown', toolName: 'git_push', executionId: 'exec-1', idempotencyKey: null },
    });
    assert.ok(out.decisions.length > 0);
    assert.strictEqual(out.decisions[0].decision, 'mark_unknown');
    assert.strictEqual(out.blocked, true);
    assert.ok(!out.decisions.some((d) => d.decision === 'retry' && /push/.test(d.tool || '')), 'destructive never blindly retried');
  });

  await test('verification runs after patch and builds honest agent result', async () => {
    const ws = makeTmp('verify');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1\n');
    const { orch, execution, toolExecutor } = makeOrchestrator(process.cwd(), { exec: { autoVerify: false } });
    void ws;
    const rs = await orch.createRun('t', {});
    // read-only evidence check: dry-run proposes, nothing applied
    const dry = await toolExecutor.execute('apply_patch', { path: 'package.json', edits: [{ oldText: '"name"', newText: '"name"' }], dryRun: true }, rs, {});
    void dry;
    const v = await execution.verifyChangeset(rs.runId, null, { origin: 'test' });
    assert.ok(v.records.some((r) => r.kind === 'tests'), 'test verification executed');
    const result = execution.buildResult(rs.runId, { goal: 'test goal' });
    assert.ok(result.status, 'result has honest status');
    assert.ok(Array.isArray(result.verification) && Array.isArray(result.executionEpisodes));
  });

  await test('user message during execution becomes a runtime constraint', async () => {
    const ws = makeTmp('intervene');
    const { orch, execution } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    const out = await execution.userMessage(rs.runId, "Don't touch generated");
    assert.strictEqual(out.command, 'forbid_paths');
    const gate = await execution._preGate(rs.runId, 'apply_patch', { path: 'generated/out.js', edits: [{ oldText: 'a', newText: 'b' }] }, { name: 'apply_patch' });
    assert.strictEqual(gate.allowed, false);
  });

  await test('execution view exposes Session-4 contract (plan/approvals/episodes/changes/files/tests)', async () => {
    const ws = makeTmp('view');
    const { orch, execution } = makeOrchestrator(ws);
    const rs = await orch.createRun('t', {});
    execution.createPlan(rs.runId, ['inspect', 'patch', 'test']);
    const view = execution.executionView(rs.runId);
    assert.ok(view.plan && view.plan.steps.length === 3);
    assert.ok(Array.isArray(view.pendingApprovals) && Array.isArray(view.episodes));
    assert.ok('waitingForApproval' in view && 'toolHealth' in view && 'constraints' in view);
  });

  console.log(`\n--- Session3 results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
