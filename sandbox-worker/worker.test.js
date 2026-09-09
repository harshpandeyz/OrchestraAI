'use strict';

// sandbox-worker boundary tests: request validation, workspace snapshot
// materialization, artifact collection, manifest, ephemeral cleanup, bind host.
//
// Run: node sandbox-worker/worker.test.js
// (SANDBOX_ALLOW_ROOT=1 is set below for CI containers running as root;
// production still refuses uid 0 without it — see server.js.)

process.env.SANDBOX_ALLOW_ROOT = '1';
// The worker sanitizes PATH for children; point it at this interpreter so
// `node` resolves on any dev machine (the container image has node on PATH).
process.env.SANDBOX_PATH = `${require('path').dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
// Dedicated reusable workspace root for these tests. The root itself is
// REUSED across executions and must PERSIST; only the ephemeral `run-*` dirs
// materialized inside it must be destroyed after every execution.
const fsMod = require('fs');
const osMod = require('os');
const pathMod = require('path');
process.env.SANDBOX_WORKSPACE_ROOT = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'sandbox-worker-test-'));
const WORKSPACE_ROOT = process.env.SANDBOX_WORKSPACE_ROOT;

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker = require('./server');

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

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// The reusable workspace root holds ephemeral `run-*` dirs during execution.
// These helpers snapshot/compare the root so a leaked run workspace is caught
// without ever requiring the shared root itself to disappear.
function runWorkspaceEntries() {
  try { return new Set(fs.readdirSync(WORKSPACE_ROOT).filter((n) => n.startsWith('run-'))); } catch { return new Set(); }
}
function runWorkspaceLeaked(before) {
  const after = runWorkspaceEntries();
  const leaked = [];
  for (const n of after) if (!before.has(n) && n.startsWith('run-')) leaked.push(n);
  return leaked;
}

// The worker throws plain { status, code, message } objects (not Errors).
// Assert on the structured code instead of message matching.
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.strictEqual(e && e.code, code, `expected code ${code}, got ${JSON.stringify(e && e.code)}`);
    return e;
  }
  throw new Error(`expected throw with code ${code}, but nothing threw`);
}

async function main() {
  await test('validateRequest accepts a minimal command', () => {
    const v = worker.validateRequest({ runId: 'r1', command: 'node', args: ['app.js'] });
    assert.strictEqual(v.command, 'node');
    assert.deepStrictEqual(v.collect, []);
  });

  await test('validateRequest accepts a bounded workspace snapshot + collect list', () => {
    const v = worker.validateRequest({
      runId: 'r1', command: 'node', args: ['app.js'],
      workspace: { files: [{ path: 'app.js', contentBase64: b64('console.log(1)') }] },
      collect: ['out.log'],
    });
    assert.strictEqual(v.workspaceFiles.length, 1);
    assert.strictEqual(v.workspaceFiles[0].path, 'app.js');
    assert.deepStrictEqual(v.collect, ['out.log']);
  });

  await test('validateRequest refuses traversal/absolute snapshot paths', () => {
    for (const p of ['../evil.js', '/etc/passwd', 'a/../../b', 'C:/win.js']) {
      throwsCode(
        () => worker.validateRequest({ runId: 'r1', command: 'node', args: ['x'], workspace: { files: [{ path: p, contentBase64: b64('x') }] } }),
        'denied',
      );
    }
  });

  await test('validateRequest refuses oversized snapshots and collect lists', () => {
    const big = [];
    for (let i = 0; i < 201; i++) big.push({ path: `f${i}.js`, contentBase64: b64('x') });
    throwsCode(
      () => worker.validateRequest({ runId: 'r1', command: 'node', args: ['x'], workspace: { files: big } }),
      'denied',
    );
    throwsCode(
      () => worker.validateRequest({ runId: 'r1', command: 'node', args: ['x'], collect: new Array(21).fill('a.log') }),
      'bad_params',
    );
  });

  await test('validateRequest refuses secret-bearing payloads', () => {
    throwsCode(
      () => worker.validateRequest({ runId: 'r1', command: 'node', args: ['x'], apiKey: 'sk-live-123' }),
      'secret_refused',
    );
  });

  await test('execute materializes the snapshot, runs, collects, manifests, destroys', async () => {
    const before = runWorkspaceEntries();
    const validated = worker.validateRequest({
      runId: 'run-ws-1', command: 'node', args: ['app.js'],
      workspace: {
        files: [
          { path: 'app.js', contentBase64: b64('const fs=require("fs");fs.writeFileSync("out.log","hello-artifact");console.log("ran");') },
        ],
      },
      collect: ['out.log', 'missing.log'],
      timeoutMs: 15000, maxOutputBytes: 8000,
    });
    const r = await worker.executeInEphemeralWorkspace(validated);
    assert.strictEqual(r.exitCode, 0, `exit 0, stderr: ${r.stderr.slice(0, 200)}`);
    assert.ok(r.stdout.includes('ran'), 'stdout captured');
    assert.strictEqual(r.artifacts.length, 1, 'one artifact collected (missing file skipped)');
    assert.strictEqual(r.artifacts[0].path, 'out.log');
    assert.strictEqual(Buffer.from(r.artifacts[0].contentBase64, 'base64').toString('utf8'), 'hello-artifact');
    const names = r.workspaceManifest.map((m) => m.path);
    assert.ok(names.includes('app.js') && names.includes('out.log'), `manifest lists workspace files: ${names.join(',')}`);
    // Ephemeral cleanup: no NEW run-* workspace remains under the reusable root,
    // and the reusable root itself persists (it is shared, not per-request).
    const leaked = runWorkspaceLeaked(before);
    assert.strictEqual(leaked.length, 0, `ephemeral run workspace leaked: ${leaked.join(', ')}`);
    assert.ok(fs.existsSync(WORKSPACE_ROOT), 'reusable workspace root must persist');
  });

  await test('concurrent executions are isolated (no cross-run workspace visibility)', async () => {
    const before = runWorkspaceEntries();
    const mk = (marker, runId) => worker.validateRequest({
      runId, command: 'node', args: ['w.js'],
      workspace: {
        files: [{
          path: 'w.js',
          contentBase64: b64(`const fs=require("fs");fs.writeFileSync("marker.txt","${marker}");console.log("${marker}");`),
        }],
      },
      collect: ['marker.txt'],
      timeoutMs: 20000, maxOutputBytes: 8000,
    });
    const [a, b] = await Promise.all([
      worker.executeInEphemeralWorkspace(mk('alpha', 'run-conc-a')),
      worker.executeInEphemeralWorkspace(mk('beta', 'run-conc-b')),
    ]);
    // Each run produced only its own artifact — no bleed of the other's files.
    const aText = Buffer.from(a.artifacts[0].contentBase64, 'base64').toString('utf8');
    const bText = Buffer.from(b.artifacts[0].contentBase64, 'base64').toString('utf8');
    assert.strictEqual(aText, 'alpha', 'run A artifact isolated');
    assert.strictEqual(bText, 'beta', 'run B artifact isolated');
    assert.strictEqual(a.stdout.trim(), 'alpha');
    assert.strictEqual(b.stdout.trim(), 'beta');
    const aManifest = a.workspaceManifest.map((m) => m.path);
    const bManifest = b.workspaceManifest.map((m) => m.path);
    assert.ok(aManifest.includes('marker.txt') && !aManifest.includes('unrelated'), `run A manifest: ${aManifest.join(', ')}`);
    assert.ok(bManifest.includes('marker.txt'), `run B manifest: ${bManifest.join(', ')}`);
    // Both ephemeral run workspaces are destroyed; the shared root persists.
    const leaked = runWorkspaceLeaked(before);
    assert.strictEqual(leaked.length, 0, `concurrent run workspace leaked: ${leaked.join(', ')}`);
    assert.ok(fs.existsSync(WORKSPACE_ROOT), 'reusable workspace root must persist');
  });

  await test('execute refuses a snapshot that escapes the ephemeral dir', async () => {
    // Bypass validateRequest to simulate a compromised caller: the executor
    // must still confine writes (defense in depth).
    let threw = false;
    try {
      await worker.executeInEphemeralWorkspace({
        command: 'node', args: ['x'], timeoutMs: 5000, maxOutputBytes: 1024,
        workspaceFiles: [{ path: '../escape.js', content: Buffer.from('x') }],
        collect: [],
      });
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'escape refused');
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'escape.js')), 'no file written outside');
  });

  await test('childEnv carries no secrets or proxy config', () => {
    const env = worker.childEnv('disabled');
    assert.ok(!env.OPENROUTER_API_KEY && !env.HTTPS_PROXY && !env.HTTP_PROXY, 'sanitized');
    assert.strictEqual(env.SANDBOX_ISOLATED, '1');
  });

  console.log(`\n--- Sandbox-worker results: ${passed} passed, ${failed} failed ---`);
  try { fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
