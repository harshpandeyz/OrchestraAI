'use strict';

// Focused release-boundary tests for the product additions. This file is run
// as a separate Node process because the legacy backend harnesses are also
// process-oriented and intentionally use assert/exit rather than a test lib.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadAuthConfig } = require('../src/auth');
const { TenantStore } = require('../src/tenant-store');
const { SavingsEngine, SavingsStatus } = require('../src/savings');
const { aggregate } = require('../src/billing');
const { CredentialStore } = require('../src/providers/credential-store');
const { OpenAIAdapter, AnthropicAdapter, ProviderRegistry, parseSseData } = require('../src/providers/provider-adapter');
const { verifyStripeSignature, eventMetadata } = require('../src/billing-webhooks');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

function registry(models) {
  return { models: new Map(models.map((m) => [m.id, m])) };
}

async function main() {
  await test('production auth fails closed without configured tokens', () => {
    const cfg = loadAuthConfig({ NODE_ENV: 'production' });
    assert.strictEqual(cfg.enabled, true);
  });

  await test('tenant sessions persist as opaque hashes and project access is isolated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-tenant-'));
    try {
      const store = new TenantStore(dir);
      const alice = store.signup({ email: 'alice@example.com', password: 'correct horse battery staple' });
      const bob = store.signup({ email: 'bob@example.com', password: 'another secure password' });
      const login = store.login({ email: 'alice@example.com', password: 'correct horse battery staple' });
      assert.ok(login.token && !login.user.passwordHash, 'login response must not expose password material');
      assert.ok(store.userForSession(login.token), 'session token resolves');
      assert.deepStrictEqual(store.listProjects({ id: bob.user.id, orgId: bob.user.orgId, role: 'operator' }).map((p) => p.ownerId), [bob.user.id]);
      const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
      assert.ok(!raw.includes(login.token), 'raw session token must not be persisted');
      assert.ok(store.getProject(alice.project.id, { id: bob.user.id, orgId: bob.user.orgId, role: 'operator' }) === null, 'cross-tenant project must be denied');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('encrypted provider credentials are namespaced by organization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-credentials-'));
    try {
      const store = new CredentialStore(dir);
      store.setKey('openai', 'sk-org-a-secret-1234', 'org-a');
      store.setKey('openai', 'sk-org-b-secret-5678', 'org-b');
      assert.strictEqual(store.getKey('openai', 'org-a'), 'sk-org-a-secret-1234');
      assert.strictEqual(store.getKey('openai', 'org-b'), 'sk-org-b-secret-5678');
      assert.strictEqual(store.getKey('openai', 'org-c'), '');
      const raw = fs.readFileSync(path.join(dir, 'provider-credentials.json'), 'utf8');
      assert.ok(!raw.includes('sk-org-a-secret-1234') && !raw.includes('sk-org-b-secret-5678'));
      const registry = new ProviderRegistry({ provider: 'openai', providers: { openai: { baseUrl: 'https://provider.test' } }, providerTimeoutMs: 1000 }, { credentialResolver: (_id, scope) => ({ apiKey: store.getKey('openai', scope) }) });
      assert.strictEqual(registry.getAdapterForScope('openai', 'org-a').apiKey, 'sk-org-a-secret-1234');
      assert.strictEqual(registry.getAdapterForScope('openai', 'org-b').apiKey, 'sk-org-b-secret-5678');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('platform fee and customer economics use the SavingsEngine result', () => {
    const models = registry([
      { id: 'reference', provider: 'openai', inputPer1k: 0.01, outputPer1k: 0.02, cachedPer1k: 0.005 },
      { id: 'optimized', provider: 'openrouter', inputPer1k: 0.002, outputPer1k: 0.004, cachedPer1k: 0.001 },
    ]);
    const result = SavingsEngine.calculateSavings({
      referenceModel: { modelId: 'reference', provider: 'openai', source: 'explicit' },
      steps: [{ step: 1, provider: 'openrouter', model: 'optimized', inputTokens: 1000, outputTokens: 1000, cachedTokens: 0 }],
      modelRegistry: models,
      platformFeePct: 0.25,
    });
    assert.strictEqual(result.status, SavingsStatus.VERIFIED_MODELED);
    assert.strictEqual(result.baselineCost, 0.03);
    assert.strictEqual(result.actualCost, 0.006);
    assert.strictEqual(result.savings, 0.024);
    assert.strictEqual(result.platformFee, 0.006);
    assert.strictEqual(result.customerFinalCost, 0.012);
    assert.strictEqual(result.customerNetSavings, 0.018);
    const bill = aggregate([{ savings: result }]);
    assert.strictEqual(bill.platformFee, result.platformFee);
    assert.strictEqual(bill.customerNetSavings, result.customerNetSavings);
    assert.strictEqual(bill.dataQuality.verifiedCount, 1, 'verified modeled line must count as verified');
    assert.strictEqual(bill.positiveModeledSavings, result.savings, 'positive modeled savings must exclude the platform fee');
  });

  await test('provider-reported charge overrides registry estimate', () => {
    const models = registry([{ id: 'm', provider: 'openai', inputPer1k: 0.01, outputPer1k: 0.02, cachedPer1k: 0.005 }]);
    const result = SavingsEngine.calculateSavings({
      referenceModel: { modelId: 'm', provider: 'openai', source: 'explicit' },
      steps: [{ step: 1, provider: 'openai', model: 'm', inputTokens: 1000, outputTokens: 1000, providerCostUsd: 0.123 }],
      modelRegistry: models,
    });
    assert.strictEqual(result.actualCost, 0.123);
    assert.strictEqual(result.pricingSnapshot.find((p) => p.type === 'actual').pricingSource, 'provider_reported');
  });

  await test('negative savings never creates an eligible platform fee', () => {
    const models = registry([
      { id: 'reference', provider: 'p', inputPer1k: 0.001, outputPer1k: 0.001 },
      { id: 'expensive', provider: 'p', inputPer1k: 0.01, outputPer1k: 0.01 },
    ]);
    const result = SavingsEngine.calculateSavings({
      referenceModel: { modelId: 'reference', provider: 'p', source: 'explicit' },
      steps: [{ step: 1, provider: 'p', model: 'expensive', inputTokens: 1000, outputTokens: 1000 }],
      modelRegistry: models,
      platformFeePct: 0.3,
    });
    assert.strictEqual(result.status, SavingsStatus.COST_INCREASE);
    assert.strictEqual(result.eligibleSavings, 0);
    assert.strictEqual(result.platformFee, 0);
    assert.ok(result.customerNetSavings < 0);
  });

  await test('billing webhooks require a fresh signed payload and expose sanitized metadata', () => {
    const crypto = require('crypto');
    const payload = JSON.stringify({ id: 'evt_123', type: 'invoice.paid', livemode: true, data: { object: { secret: 'do-not-persist' } } });
    const timestamp = 1700000000;
    const signature = crypto.createHmac('sha256', 'whsec_test').update(`${timestamp}.${payload}`).digest('hex');
    assert.strictEqual(verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, 'whsec_test', { now: timestamp }).ok, true);
    assert.strictEqual(verifyStripeSignature(payload, `t=${timestamp},v1=bad`, 'whsec_test', { now: timestamp }).ok, false);
    assert.strictEqual(verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, 'whsec_test', { now: timestamp + 301 }).code, 'stale_signature');
    const safe = eventMetadata(JSON.parse(payload));
    assert.deepStrictEqual(safe, { eventId: 'evt_123', type: 'invoice.paid', created: null, livemode: true, apiVersion: null, receivedAt: safe.receivedAt });
    assert.ok(!JSON.stringify(safe).includes('do-not-persist'));
  });

  await test('OpenAI-compatible streaming yields provider deltas and terminal usage', async () => {
    const originalFetch = global.fetch;
    let request;
    const frames = [
      'data: {"id":"chat-1","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-1","choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":1},"cost":0.00042}}\n\n',
      'data: [DONE]\n\n',
    ];
    global.fetch = async (_url, options) => {
      request = JSON.parse(options.body);
      const stream = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const adapter = new OpenAIAdapter({ apiKey: 'sk-test-stream-key', baseUrl: 'https://provider.test' });
      const parts = [];
      for await (const part of adapter.stream({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] })) parts.push(part);
      assert.deepStrictEqual(parts.filter((p) => !p.done).map((p) => p.delta), ['Hel', 'lo']);
      const done = parts[parts.length - 1];
      assert.strictEqual(done.text, 'Hello');
      assert.strictEqual(done.usage.inputTokens, 10);
      assert.strictEqual(done.usage.cachedTokens, 4);
      assert.strictEqual(done.usage.reasoningTokens, 1);
      assert.strictEqual(done.usage.costUsd, 0.00042);
      assert.strictEqual(request.stream, true);
      assert.strictEqual(request.stream_options.include_usage, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('SSE parser handles CRLF, multiline data, comments, malformed frames, and a flushed final frame', () => {
    const parsed = parseSseData(': heartbeat\r\n\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: not-json\r\n\r\n', { flush: false });
    assert.deepStrictEqual(parsed.events, [{ a: 1 }]);
    assert.strictEqual(parsed.remainder, '');
    const final = parseSseData('data: {"done":true}\n', { flush: true });
    assert.deepStrictEqual(final.events, [{ done: true }]);
    assert.strictEqual(final.remainder, '');
  });

  await test('provider error messages redact full and provider-echoed key fragments', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided: LLM_1375************************************4mWo.' },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
    try {
      const adapter = new OpenAIAdapter({ apiKey: 'LLM_1375************************************4mWo', baseUrl: 'https://provider.test' });
      await assert.rejects(
        () => adapter.verifyCredentials(),
        (error) => error.code === 'auth'
          && !error.message.includes('LLM_1375')
          && error.message.includes('[REDACTED]')
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('Anthropic preserves assistant tool_use and user tool_result blocks', async () => {
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        id: 'msg-1', model: 'claude-test', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 20, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const adapter = new AnthropicAdapter({ apiKey: 'sk-ant-test', baseUrl: 'https://provider.test' });
      const result = await adapter.complete({
        model: 'claude-test',
        messages: [
          { role: 'system', content: 'You are a tool-using assistant.' },
          { role: 'user', content: 'Inspect the file.' },
          { role: 'assistant', content: 'I will inspect it.', tool_calls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }] },
          { role: 'tool', tool_call_id: 'tool-1', name: 'read_file', content: '{"ok":true}' },
        ],
      });
      assert.strictEqual(result.requestId, 'msg-1');
      assert.strictEqual(request.system, 'You are a tool-using assistant.');
      assert.deepStrictEqual(request.messages[1], {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
        ],
      });
      assert.deepStrictEqual(request.messages[2], {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '{"ok":true}' }],
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(`\n--- Production boundary results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
