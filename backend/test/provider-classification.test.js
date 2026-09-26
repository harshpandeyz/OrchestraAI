'use strict';

// Session 1 — provider failure classification (deterministic retry matrix).
//
// Proves every provider HTTP status maps to a stable { code, retryable }
// decision so the orchestrator never retries non-retryable errors and
// transient timeouts (408) are retried instead of failing the run.
//
// Run: node backend/test/provider-classification.test.js
// No real network (one stub fetch only).

process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const { classifyHttpStatus, OpenRouterAdapter, ProviderError } = require('../src/providers/provider-adapter');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : (e && e.message)}`);
  }
}

async function main() {
  await test('classification matrix is deterministic (retry vs fail)', () => {
    assert.deepStrictEqual(classifyHttpStatus(400), { code: 'bad_request', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(401), { code: 'auth', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(403), { code: 'auth', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(404), { code: 'not_found', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(408), { code: 'timeout', retryable: true }, '408 request timeout is transient');
    assert.deepStrictEqual(classifyHttpStatus(409), { code: 'conflict', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(422), { code: 'bad_request', retryable: false });
    assert.deepStrictEqual(classifyHttpStatus(429), { code: 'rate_limit', retryable: true });
    assert.deepStrictEqual(classifyHttpStatus(500), { code: 'unavailable', retryable: true });
    assert.deepStrictEqual(classifyHttpStatus(502), { code: 'unavailable', retryable: true });
    assert.deepStrictEqual(classifyHttpStatus(503), { code: 'unavailable', retryable: true });
    assert.deepStrictEqual(classifyHttpStatus(418), { code: 'unknown', retryable: false }, 'unmapped status fails safe (non-retryable)');
  });

  await test('adapted 408 response surfaces as retryable timeout (wired end-to-end)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 408,
      text: async () => JSON.stringify({ error: { message: 'request timeout', code: 408 } }),
    });
    try {
      const a = new OpenRouterAdapter({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
      a.chatPath = '';
      await assert.rejects(a.complete({ model: 'm', messages: [] }), (e) => {
        assert.ok(e instanceof ProviderError);
        assert.strictEqual(e.code, 'timeout', `got ${e.code}`);
        assert.strictEqual(e.retryable, true, '408 must be retryable');
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  console.log(`\n--- provider-classification results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });