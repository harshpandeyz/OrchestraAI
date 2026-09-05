'use strict';

// Workspace transfer boundary tests (disposable-snapshot model):
// snapshotWorkspace skips secrets/links/oversized content within caps, the
// isolated request carries the snapshot (never host paths), and executor
// artifact responses are validated and capped.
//
// Run: node backend/test/agent3/workspace-transfer.test.js

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Isolated = require('../../src/execution/isolated-executor');

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

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-transfer-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dir, 'README.md'), '# docs');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), 'module.exports = 1;');
  // Must never transfer: secrets, env files, VCS, deps, runtime state.
  fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-live-secret');
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'PRIVATE KEY');
  fs.writeFileSync(path.join(dir, 'cert.pem'), 'CERT');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'x');
  fs.writeFileSync(path.join(dir, 'run-1.events.json'), '[]');
  // Symlinks are never followed or shipped.
  try { fs.symlinkSync('/etc/passwd', path.join(dir, 'link-evil')); } catch {}
  try { fs.symlinkSync(path.join(dir, 'app.js'), path.join(dir, 'link-ok')); } catch {}
  return dir;
}

async function main() {
  await test('snapshot ships code, skips secrets/vcs/deps/state/links', () => {
    const dir = makeWorkspace();
    const snap = Isolated.snapshotWorkspace(dir);
    const paths = snap.files.map((f) => f.path).sort();
    assert.ok(paths.includes('app.js'), 'app.js shipped');
    assert.ok(paths.includes('README.md'), 'docs shipped');
    assert.ok(paths.includes('src/util.js'), 'nested file shipped');
    assert.ok(!paths.some((p) => p.includes('.env') || p.includes('id_rsa') || p.includes('.pem')), 'no secrets shipped');
    assert.ok(!paths.some((p) => p.includes('.git') || p.includes('node_modules')), 'no vcs/deps shipped');
    assert.ok(!paths.some((p) => p.includes('events.json')), 'no runtime state shipped');
    assert.ok(!paths.some((p) => p.includes('link-')), 'no symlinks shipped');
    assert.ok(snap.skipped.secrets >= 2, `secrets counted, got ${JSON.stringify(snap.skipped)}`);
    const appContent = Buffer.from(snap.files.find((f) => f.path === 'app.js').contentBase64, 'base64').toString('utf8');
    assert.strictEqual(appContent, 'console.log("app");');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('snapshot content carries no secret-bearing keys', () => {
    const dir = makeWorkspace();
    const snap = Isolated.snapshotWorkspace(dir);
    // Client-side request validation must accept the snapshot we produce.
    Isolated.validateExecuteRequest({
      runId: 'r1', command: 'node', args: ['app.js'],
      workspace: { files: snap.files.map((f) => ({ path: f.path, contentBase64: f.contentBase64 })) },
      collect: ['out.log'],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('snapshot honors file-count and byte caps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-caps-'));
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x'.repeat(100));
    const snap = Isolated.snapshotWorkspace(dir, { maxFiles: 3, maxTotalBytes: 100000, maxFileBytes: 100000 });
    assert.ok(snap.files.length <= 3, `capped at 3 files, got ${snap.files.length}`);
    assert.ok(snap.skipped.count > 0, 'skips reported');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('snapshot refuses an unreadable root instead of shipping empty', () => {
    assert.throws(
      () => Isolated.snapshotWorkspace(path.join(os.tmpdir(), 'ws-transfer-missing-xyz')),
      /snapshot failed/,
    );
  });

  await test('assertWorkspaceRelPath refuses traversal and absolute paths', () => {
    for (const p of ['../x', '/abs', 'C:/w', 'a/../../b', '']) {
      assert.throws(() => Isolated.assertWorkspaceRelPath(p), /./, `refused: ${JSON.stringify(p)}`);
    }
    assert.strictEqual(Isolated.assertWorkspaceRelPath('src/app.js'), 'src/app.js');
  });

  await test('executor artifact responses are validated and capped', () => {
    const good = Isolated.validateExecuteResponse({
      ok: true, exitCode: 0, stdout: 'hi', stderr: '', timedOut: false, durationMs: 5, isolated: true,
      artifacts: [{ path: 'out.log', size: 2, contentBase64: Buffer.from('hi').toString('base64') }],
      workspaceManifest: [{ path: 'app.js', size: 20 }],
    });
    assert.strictEqual(good.artifacts.length, 1);
    assert.strictEqual(good.workspaceManifest.length, 1);
    assert.throws(
      () => Isolated.validateExecuteResponse({
        ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, isolated: true,
        artifacts: [{ path: '../evil', size: 1, contentBase64: '' }],
      }),
      /./,
      'traversal artifact refused',
    );
    assert.throws(
      () => Isolated.validateExecuteResponse({
        ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, isolated: false,
      }),
      /isolation/,
      'missing isolation attestation refused',
    );
  });

  console.log(`\n--- Workspace-transfer results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
