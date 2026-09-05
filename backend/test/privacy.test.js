'use strict';

const assert = require('assert');
const { persistedEvents, persistedSnapshot, REDACTED } = require('../src/privacy');
const { SemanticCacheIndex } = require('../src/intelligence/semantic-cache');

const event = {
  type: 'response.done',
  model: 'gpt-test',
  payload: { content: 'customer secret', usage: { inputTokens: 12, outputTokens: 4 } },
};

const metadata = persistedEvents([event], 'metadata_only');
assert.strictEqual(metadata.length, 1);
assert.strictEqual(metadata[0].model, 'gpt-test');
assert.strictEqual(metadata[0].payload.content, REDACTED);
assert.strictEqual(metadata[0].payload.usage.inputTokens, 12);
assert.deepStrictEqual(persistedEvents([event], 'zero_retention'), []);

const snapshot = persistedSnapshot({
  runId: 'run-1', messages: [{ role: 'assistant', content: 'private output' }],
  memory: { working: [{ snippet: 'private memory' }], longterm: [] },
  trace: [{ message: 'private trace' }],
  cost: { spentUsd: 0.12 },
}, 'metadata_only');
assert.deepStrictEqual(snapshot.messages, []);
assert.deepStrictEqual(snapshot.memory, { working: [], longterm: [] });
assert.strictEqual(snapshot.cost.spentUsd, 0.12);
assert.strictEqual(snapshot.trace[0].message, REDACTED);

const zero = persistedSnapshot({
  runId: 'run-2', messages: [{ content: 'private output' }],
  context: { usedTokens: 10, windowTokens: 100, items: [{ title: 'task' }] },
  trace: [{ detail: 'private trace' }], cost: { spentUsd: 0.2 },
}, 'zero_retention');
assert.deepStrictEqual(zero.messages, []);
assert.deepStrictEqual(zero.trace, []);
assert.deepStrictEqual(zero.context.items, []);
assert.strictEqual(zero.cost.spentUsd, 0.2);

const semantic = new SemanticCacheIndex();
semantic.store({ taskText: 'tenant private answer', tenantId: 'org-a', result: { text: 'private' } });
assert.strictEqual(semantic.lookup({ taskText: 'tenant private answer', tenantId: 'org-b' }).hit, false);
assert.strictEqual(semantic.lookup({ taskText: 'tenant private answer', tenantId: 'org-a' }).hit, true);

console.log('✓ privacy persistence and tenant cache boundaries');
