'use strict';

// Provider configuration (UI-driven, backend-mediated) + runtime presets +
// model provenance + run comparison. No network: verification probes use
// injected fake adapters via ProviderRegistry createAdapter hook.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CredentialStore } = require('../src/providers/credential-store');
const { RuntimeSettings } = require('../src/runtime-settings');
const { ModelChangeLog } = require('../src/model-changes');
const { PRESETS, validPreset, getPreset, listPresets } = require('../src/policies/presets');
const { ProviderRegistry } = require('../src/providers/provider-adapter');
const { DiscoveryService } = require('../src/providers/model-discovery');
const { InMemoryModelRegistry } = require('../src/impl/model-registry');
const { InMemoryModelRouter } = require('../src/impl/model-router');
const { compareRuns } = require('../src/api/compare');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n  ')}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-prov-'));
}

(async () => {
  // ---------- credential store ----------
  await test('1. credentials encrypt at rest (no plaintext key on disk)', () => {
    const dir = tmpDir();
    const store = new CredentialStore(dir);
    store.setKey('openrouter', 'sk-or-test-key-1234567890');
    const raw = fs.readFileSync(path.join(dir, 'provider-credentials.json'), 'utf8');
    assert.ok(!raw.includes('sk-or-test-key-1234567890'), 'key must not appear in plaintext');
    assert.strictEqual(store.getKey('openrouter'), 'sk-or-test-key-1234567890');
  });

  await test('2. credential metadata never contains the secret', () => {
    const dir = tmpDir();
    const store = new CredentialStore(dir);
    store.setKey('openai', 'sk-openai-abcdefghij1234');
    const meta = store.metaFor('openai');
    const text = JSON.stringify(meta);
    assert.ok(!text.includes('sk-openai-abcdefghij1234'), 'metadata leaks key');
    assert.strictEqual(meta.configured, true);
    assert.ok(meta.keyMasked && meta.keyMasked.endsWith('1234'), 'masked suffix shown');
    assert.deepStrictEqual(store.listMeta().map((m) => m.id).sort(), ['anthropic', 'openai', 'openrouter']);
  });

  await test('3. install key is generated (not hardcoded) and reused', () => {
    const dir = tmpDir();
    const a = new CredentialStore(dir);
    a.setKey('openai', 'sk-openai-abcdefghij1234');
    const keyRaw = fs.readFileSync(path.join(dir, '.install-key'), 'utf8').trim();
    assert.ok(/^[0-9a-f]{64}$/i.test(keyRaw), 'install key is 32 random bytes hex');
    const b = new CredentialStore(dir);
    assert.strictEqual(b.getKey('openai'), 'sk-openai-abcdefghij1234', 'key survives store re-instantiation');
  });

  await test('3a. production credential encryption requires an external 32-byte key', () => {
    const dir = tmpDir();
    assert.throws(() => new CredentialStore(dir, { requireEncryptionKey: true }), /DATA_ENCRYPTION_KEY is required/);
    const key = 'a'.repeat(64);
    const store = new CredentialStore(dir, { encryptionKey: key, requireEncryptionKey: true });
    store.setKey('openai', 'sk-openai-prod-key-123456');
    const fresh = new CredentialStore(dir, { encryptionKey: key, requireEncryptionKey: true });
    assert.strictEqual(fresh.getKey('openai'), 'sk-openai-prod-key-123456');
  });

  await test('4. corrupted store is quarantined, never crashes', () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'provider-credentials.json'), '{not json');
    const store = new CredentialStore(dir);
    assert.strictEqual(store.getKey('openai'), '');
    assert.strictEqual(store.wasCorrupted(), true);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), 'quarantine file exists');
  });

  await test('5. validation rejects bad providers and short keys', () => {
    const dir = tmpDir();
    const store = new CredentialStore(dir);
    assert.throws(() => store.setKey('fakeprovider', 'sk-1234567890'), /unsupported/);
    assert.throws(() => store.setKey('openai', 'short'), /8–500/);
    assert.strictEqual(store.remove('openai'), false);
  });

  // ---------- presets ----------
  await test('6. five presets map to distinct real router weights', () => {
    const ids = listPresets().map((p) => p.id).sort();
    assert.deepStrictEqual(ids, ['balanced', 'economical', 'fast', 'longcontext', 'reasoning']);
    assert.ok(validPreset('fast') && !validPreset('turbo'));
    assert.strictEqual(getPreset('nonsense').id, 'balanced');
    const weights = Object.values(PRESETS).map((p) => JSON.stringify(p.weights));
    assert.strictEqual(new Set(weights).size, 5, 'each preset is a distinct policy');
    assert.ok(PRESETS.fast.weights.latencyWeight > PRESETS.balanced.weights.latencyWeight, 'fast prefers latency');
    assert.ok(PRESETS.economical.weights.costWeight > PRESETS.balanced.weights.costWeight, 'economical prefers cost');
    assert.ok(PRESETS.reasoning.weights.qualityWeight > PRESETS.balanced.weights.qualityWeight, 'reasoning prefers quality');
    assert.ok(PRESETS.longcontext.weights.contextFitWeight > PRESETS.balanced.weights.contextFitWeight, 'long-context prefers fit');
  });

  await test('7. runtime settings persist with sanitization', () => {
    const dir = tmpDir();
    const s = new RuntimeSettings(dir);
    assert.strictEqual(s.load().defaultPreset, 'balanced');
    const next = s.save({ defaultPreset: 'fast', defaultBudgetUsd: 2.5, maxSteps: 20, allowSwitching: false, toolPolicy: 'readonly' });
    assert.strictEqual(next.defaultPreset, 'fast');
    assert.strictEqual(next.allowSwitching, false);
    const fresh = new RuntimeSettings(dir);
    assert.strictEqual(fresh.load().defaultPreset, 'fast', 'settings survive restart');
    const bad = fresh.save({ defaultPreset: 'turbo', defaultBudgetUsd: -5, maxSteps: 999 });
    assert.strictEqual(bad.defaultPreset, 'fast', 'invalid preset ignored');
    assert.ok(bad.defaultBudgetUsd >= 0 && bad.maxSteps <= 50, 'bounds enforced');
  });

  // ---------- router honors per-run policy ----------
  function fakeRuntime(weights, extraPolicy) {
    return {
      runId: 'run-test',
      context: { currentTokens: 100, cacheablePrefixTokens: 0, getUtilization: () => 0.1 },
      model: { currentModel: 'cheap', getPricing: () => ({ outputPer1k: 0.001 }), modelLatency: 500 },
      policy: { routerWeights: weights, ...(extraPolicy || {}) },
    };
  }
  const cheap = { id: 'cheap', name: 'Cheap', provider: 'p', status: 'healthy', contextWindow: 64000, quality: 0.7, avgLatencyMs: 800, reliability: 0.95, inputPer1k: 0.0001, outputPer1k: 0.0002, cachedPer1k: 0.0001 };
  const smart = { id: 'smart', name: 'Smart', provider: 'p', status: 'healthy', contextWindow: 64000, quality: 0.95, avgLatencyMs: 3000, reliability: 0.99, inputPer1k: 0.002, outputPer1k: 0.006, cachedPer1k: 0.001 };

  await test('8. unknown (null) telemetry scores neutral — never free/fastest', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const rt = fakeRuntime(null, {});
    const unknown = { id: 'u', name: 'U', provider: 'p', status: 'healthy', contextWindow: 64000, quality: null, avgLatencyMs: null, reliability: null, inputPer1k: null, outputPer1k: null };
    const s = await router.scoreModel(unknown, {}, rt);
    assert.strictEqual(s.quality, 0.5);
    assert.strictEqual(s.latency, 0.5);
    assert.strictEqual(s.reliability, 0.5);
    assert.strictEqual(s.cost, 0.5, 'unknown price must not score as free');
  });

  await test('9. fast preset outranks reasoning for the same candidates', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const fastScore = (await router.evaluateCandidates({}, fakeRuntime(PRESETS.fast.weights), [cheap, smart])).candidates[0].modelId;
    const reasonScore = (await router.evaluateCandidates({}, fakeRuntime(PRESETS.reasoning.weights), [cheap, smart])).candidates[0].modelId;
    assert.strictEqual(fastScore, 'cheap', 'fast prefers the cheap/fast model');
    assert.strictEqual(reasonScore, 'smart', 'reasoning prefers the quality model');
  });

  await test('10. allowSwitching=false retains a healthy incumbent', async () => {
    const { SwitchingCostCalculator, ModelStickinessManager } = require('../src/decisions/switching-cost');
    const router = new InMemoryModelRouter({ getPricing: () => null }, new SwitchingCostCalculator(), new ModelStickinessManager(), null);
    const rt = fakeRuntime(PRESETS.reasoning.weights, { allowSwitching: false });
    rt.model.currentModel = 'cheap';
    const { selectedModel, decision } = await router.route({}, rt, [cheap, smart], {});
    assert.strictEqual(selectedModel, 'cheap');
    assert.ok(/KEEP/.test(decision.decision), 'retention decision recorded');
  });

  await test('11. preferredModel pins selection with honest reason', async () => {
    const { SwitchingCostCalculator, ModelStickinessManager } = require('../src/decisions/switching-cost');
    const router = new InMemoryModelRouter({ getPricing: () => null }, new SwitchingCostCalculator(), new ModelStickinessManager(), null);
    const rt = fakeRuntime(PRESETS.balanced.weights, { preferredModel: 'smart' });
    rt.model.currentModel = null;
    const { selectedModel, decision } = await router.route({}, rt, [cheap, smart], {});
    assert.strictEqual(selectedModel, 'smart');
    assert.ok(/preferred/i.test(decision.reason || decision.decision), 'reason recorded');
  });

  await test('12. unknown pricing is excluded from production routing unless explicitly allowed', async () => {
    const router = new InMemoryModelRouter({ getPricing: () => null }, null, null, null);
    const unknown = { ...cheap, id: 'unknown-price', inputPer1k: null, outputPer1k: null, cachedPer1k: null };
    const rt = fakeRuntime(PRESETS.balanced.weights, {});
    rt.model.currentModel = null;
    await assert.rejects(() => router.route({}, rt, [unknown], {}), (error) => error.code === 'insufficient_pricing');
    const allowed = fakeRuntime(PRESETS.balanced.weights, { allowUnknownPricing: true });
    allowed.model.currentModel = null;
    const result = await router.route({}, allowed, [unknown], {});
    assert.strictEqual(result.selectedModel, 'unknown-price');
    assert.strictEqual(result.evaluation.candidates[0].expectedCostUsd, null);
  });

  // ---------- discovery provenance + change log ----------
  await test('13. discovery registers unknown models with unknown provenance', async () => {
    const registry = new InMemoryModelRegistry([], null);
    const fakeAdapter = {
      hasCredentials: true,
      defaultModel: null,
      async listModels() {
        return [{ id: 'new-model-z', name: 'New Z', contextWindow: 128000, pricing: { inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0005 }, capabilities: { text: true, tools: true } }];
      },
    };
    const preg = new ProviderRegistry({ provider: 'openrouter', providers: {}, providerTimeoutMs: 1000 }, {
      createAdapter: () => fakeAdapter,
    });
    const dir = tmpDir();
    const changes = new ModelChangeLog(dir);
    const discovery = new DiscoveryService({ registry, providerRegistry: preg, config: { mode: 'live', provider: 'openrouter' }, changeLog: changes });
    const result = await discovery.refreshOnce('openrouter');
    assert.strictEqual(result.discovered, 1);
    const m = await registry.getModel('new-model-z');
    assert.strictEqual(m.quality, null, 'no fabricated quality');
    assert.strictEqual(m.qualitySource, 'unknown');
    assert.strictEqual(m.avgLatencyMs, null, 'no fabricated latency');
    assert.strictEqual(m.pricingSource, 'provider');
    assert.strictEqual(changes.load().length, 1, 'change recorded');
    assert.ok(/new model/i.test(changes.load()[0].label));
  });

  await test('14. verification probe distinguishes auth failure from success', async () => {
    const good = new ProviderRegistry({ provider: 'openai', providers: {}, providerTimeoutMs: 1000 }, {
      createAdapter: () => ({ async verifyCredentials() { return { ok: true }; } }),
    });
    const bad = new ProviderRegistry({ provider: 'openai', providers: {}, providerTimeoutMs: 1000 }, {
      createAdapter: () => {
        const { ProviderError } = require('../src/providers/provider-adapter');
        return { async verifyCredentials() { throw new ProviderError('openai request failed: Incorrect API key', { code: 'auth', status: 401 }); } };
      },
    });
    await good.buildFresh('openai', 'sk-good-key-1234567890').verifyCredentials();
    await assert.rejects(() => bad.buildFresh('openai', 'sk-bad').verifyCredentials(), /Incorrect API key/);
  });

  // ---------- compare ----------
  await test('15. compareRuns summarizes two histories honestly', () => {
    const fakeStore = {
      loadSnapshot: (id) => {
        if (id !== 'a' && id !== 'b') return null;
        return (id === 'a'
          ? { status: 'completed', cost: { spentUsd: 0.01 }, context: { usedTokens: 1000, windowTokens: 8000 }, decisions: [{}, {}], cache: { hitRate: 0.5 }, activeModelId: 'm1', updatedAt: new Date().toISOString() }
          : { status: 'failed', cost: { spentUsd: 0.03 }, context: { usedTokens: 2000, windowTokens: 8000 }, decisions: [{}], cache: { hitRate: 0 }, activeModelId: 'm2', updatedAt: new Date().toISOString() });
      },
      loadRunIndex: () => [{ id: 'a', title: 'A', status: 'completed' }, { id: 'b', title: 'B', status: 'failed' }],
      loadEvents: () => [],
    };
    const fakeBus = { eventLogs: new Map() };
    const fakeOrch = { activeRuns: new Map() };
    const result = compareRuns(fakeOrch, fakeStore, fakeBus, 'a', 'b');
    assert.ok(result.a && result.b, 'both summarized');
    assert.strictEqual(result.delta.costUsd, 0.02);
    assert.strictEqual(compareRuns(fakeOrch, fakeStore, fakeBus, 'a', 'missing'), null);
  });

  console.log(`\n--- Provider-config results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
})();
