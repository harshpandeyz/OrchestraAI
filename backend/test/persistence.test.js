'use strict';

// Persistence durability: retention/GC, intelligence bounds, corruption
// handling, atomic-write error semantics, and startup config validation.
//
// Run: node backend/test/persistence.test.js (no network)

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FileStore,
  pruneIntelligenceDoc,
  intelligenceOverflow,
  INTELLIGENCE_CAPS,
} = require('../src/persistence');
const { loadConfig, validateConfig } = require('../src/config');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-persist-'));
}
function touch(full, ageMs) {
  fs.writeFileSync(full, '{}', 'utf8');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(full, t, t);
}

async function main() {
  // ---------- retention sweep ----------
  await test('sweep deletes only orphaned, aged-out run files', () => {
    const dir = tmpDir();
    const store = new FileStore(dir);
    const hour = 3600000;
    // Active run files: kept regardless of age.
    touch(path.join(dir, 'run-active.events.json'), 10 * hour);
    touch(path.join(dir, 'run-active.snapshot.json'), 10 * hour);
    // Indexed run files: kept.
    touch(path.join(dir, 'run-indexed.events.json'), 10 * hour);
    touch(path.join(dir, 'run-indexed.billing.json'), 10 * hour);
    // Orphaned but fresh: kept (grace period).
    touch(path.join(dir, 'run-fresh.events.json'), 1000);
    // Orphaned and old: deleted.
    touch(path.join(dir, 'run-old.events.json'), 48 * hour);
    touch(path.join(dir, 'run-old.snapshot.json'), 48 * hour);
    touch(path.join(dir, 'run-old.billing.json'), 48 * hour);
    // Stale tmp + surplus corrupt.
    touch(path.join(dir, 'runs.json.tmp-123-456'), 3 * hour);
    for (let i = 0; i < 25; i++) touch(path.join(dir, `runs.json.corrupt-${1000 + i}`), (30 + i) * hour);

    const report = store.sweepRetention({ activeIds: ['run-active'], indexIds: ['run-indexed'], graceMs: 24 * hour });
    assert.ok(fs.existsSync(path.join(dir, 'run-active.events.json')), 'active kept');
    assert.ok(fs.existsSync(path.join(dir, 'run-indexed.events.json')), 'indexed kept');
    assert.ok(fs.existsSync(path.join(dir, 'run-fresh.events.json')), 'fresh orphan kept');
    assert.ok(!fs.existsSync(path.join(dir, 'run-old.events.json')), 'old orphan events deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'run-old.snapshot.json')), 'old orphan snapshot deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'run-old.billing.json')), 'old orphan billing deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'runs.json.tmp-123-456')), 'stale tmp deleted');
    const corruptLeft = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.ok(corruptLeft.length <= 20, `corrupt capped, left ${corruptLeft.length}`);
    assert.ok(report.deleted.length >= 3, 'report lists deletions');
    assert.ok(report.freedBytes >= 0, 'report accounts bytes');
    assert.strictEqual(report.keptActive, 2);
    assert.strictEqual(report.keptIndexed, 2);
    assert.strictEqual(report.keptFresh, 1);
    // Dry run deletes nothing.
    touch(path.join(dir, 'run-old2.events.json'), 48 * hour);
    const dry = store.sweepRetention({ activeIds: [], indexIds: [], graceMs: 24 * hour, dryRun: true });
    assert.ok(fs.existsSync(path.join(dir, 'run-old2.events.json')), 'dry run is read-only');
    assert.ok(dry.deleted.includes('run-old2.events.json'), 'dry run still reports');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('sweep derives the index itself and never throws', () => {
    const dir = tmpDir();
    const store = new FileStore(dir);
    store.saveRunIndex([{ id: 'run-keep' }]);
    touch(path.join(dir, 'run-keep.events.json'), 48 * 3600000);
    touch(path.join(dir, 'run-gone.events.json'), 48 * 3600000);
    const report = store.sweepRetention({ activeIds: [] });
    assert.ok(fs.existsSync(path.join(dir, 'run-keep.events.json')), 'indexed kept via stored index');
    assert.ok(!fs.existsSync(path.join(dir, 'run-gone.events.json')), 'orphan collected');
    assert.deepStrictEqual(report.errors, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- intelligence bounds ----------
  await test('intelligence document is compacted to caps (newest kept)', () => {
    const big = (n, seed) => Array.from({ length: n }, (_, i) => ({ i: seed + i, v: 'x'.repeat(20) }));
    const doc = {
      outcomeEvals: big(500, 0),
      routingHistory: { history: big(600, 1000) },
      benchmarks: { entries: big(900, 2000) },
      unknownHugeList: big(1200, 3000),
      small: [1, 2, 3],
    };
    assert.ok(intelligenceOverflow(doc) > 0, 'overflow detected');
    const compacted = pruneIntelligenceDoc(doc);
    assert.ok(compacted.outcomeEvals.length <= INTELLIGENCE_CAPS.outcomeEvals);
    assert.ok(compacted.routingHistory.history.length <= INTELLIGENCE_CAPS.history);
    assert.ok(compacted.benchmarks.entries.length <= INTELLIGENCE_CAPS.entries);
    assert.ok(compacted.unknownHugeList.length <= 500, 'generic cap applies to unknown arrays');
    assert.deepStrictEqual(compacted.small, [1, 2, 3], 'small arrays untouched');
    // Newest kept (append-ordered history).
    assert.strictEqual(compacted.outcomeEvals[compacted.outcomeEvals.length - 1].i, 499);
    assert.strictEqual(intelligenceOverflow(compacted), 0, 'no overflow after compaction');
    // Original untouched (no aliasing surprises for the live store).
    assert.strictEqual(doc.outcomeEvals.length, 500);
  });

  await test('saveIntelligence persists compacted doc and round-trips', () => {
    const dir = tmpDir();
    const store = new FileStore(dir, { maxBytes: 20000 });
    const doc = { outcomeEvals: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const r = store.saveIntelligence(doc);
    assert.ok(r.ok, `save ok: ${r.error || ''}`);
    const loaded = store.loadIntelligence();
    assert.ok(loaded && loaded.outcomeEvals.length <= INTELLIGENCE_CAPS.outcomeEvals);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------- corruption + error semantics ----------
  await test('corrupt files are quarantined, reads stay safe', () => {
    const dir = tmpDir();
    const store = new FileStore(dir);
    fs.writeFileSync(path.join(dir, 'runs.json'), '{not json', 'utf8');
    const index = store.loadRunIndex();
    assert.deepStrictEqual(index, [], 'corrupt index reads as empty');
    const quarantined = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.strictEqual(quarantined.length, 1, 'corrupt file quarantined');
    // Writes still work after quarantine.
    assert.ok(store.saveRunIndex([{ id: 'a' }]).ok);
    assert.deepStrictEqual(store.loadRunIndex(), [{ id: 'a' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('critical write failures are returned, not swallowed', () => {
    const dir = tmpDir();
    const store = new FileStore(dir, { maxBytes: 50 });
    const r = store.saveEvents('run-x', Array.from({ length: 100 }, (_, i) => ({ i, pad: 'y'.repeat(100) })));
    // 100 fleshed-out events cannot fit in 50 bytes even pruned to 10.
    assert.strictEqual(r.ok, false, 'oversized write rejected with an error');
    assert.ok(r.error, 'error is reported');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('production config fails fast on missing secrets, warns on weak defaults', () => {
    const prod = { NODE_ENV: 'production' };
    const base = loadConfig({ ...prod, RUNTIME_DATA_DIR: '/tmp/x', DATA_ENCRYPTION_KEY: 'a'.repeat(64) });
    const { warnings } = validateConfig(base, { ...prod, DATA_ENCRYPTION_KEY: 'a'.repeat(64) });
    assert.ok(Array.isArray(warnings), 'warnings returned');

    const noKey = loadConfig({ ...prod, RUNTIME_DATA_DIR: '/tmp/x' });
    assert.throws(() => validateConfig(noKey, prod), /DATA_ENCRYPTION_KEY/, 'missing key throws in prod');

    const badMode = loadConfig({ RUNTIME_MODE: 'lively', RUNTIME_DATA_DIR: '/tmp/x' });
    assert.throws(() => validateConfig(badMode, { RUNTIME_MODE: 'lively' }), /RUNTIME_MODE/, 'bad mode throws');

    // Non-production never throws for missing optional secrets.
    const dev = loadConfig({ RUNTIME_DATA_DIR: '/tmp/x' });
    assert.doesNotThrow(() => validateConfig(dev, {}), 'dev stays permissive');
  });
}

main().then(() => {
  console.log(`\n--- Persistence results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
