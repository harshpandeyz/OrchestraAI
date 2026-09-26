'use strict';

const assert = require('assert');
const { GOLDEN_TASKS, CATEGORIES } = require('../src/evals/golden-tasks');
const { scoreAttempt, runGoldenSuite, demoAttempts, diffGoldenRuns, taskById } = require('../src/evals/golden-runner');

// Suite shape: 24 fixed tasks across 5 categories.
{
  assert.strictEqual(GOLDEN_TASKS.length, 24, 'golden suite must hold 24 tasks');
  assert.deepStrictEqual([...CATEGORIES].sort(), ['cheap-simple', 'coding', 'long-context', 'reasoning', 'tool-use']);
  const cats = new Set(GOLDEN_TASKS.map((t) => t.category));
  for (const c of CATEGORIES) assert.ok(cats.has(c), `missing category ${c}`);
  const ids = new Set(GOLDEN_TASKS.map((t) => t.id));
  assert.strictEqual(ids.size, 24, 'task ids must be unique');
}

// Deterministic scoring per expect kind.
{
  assert.strictEqual(scoreAttempt(taskById('code-01-reverse-string'), { output: 'artsehcro' }).pass, true);
  assert.strictEqual(scoreAttempt(taskById('code-01-reverse-string'), { output: 'wrong' }).pass, false);
  assert.strictEqual(scoreAttempt(taskById('reason-03-order-plans'), { toolCalls: ['plan', 'execute', 'test'] }).pass, true);
  assert.strictEqual(scoreAttempt(taskById('reason-03-order-plans'), { toolCalls: ['plan', 'test'] }).pass, false);
  assert.strictEqual(scoreAttempt(taskById('ctx-01-needle'), { output: 'x', evidence: 'magpie-42 here' }).pass, true);
  assert.strictEqual(scoreAttempt(taskById('cheap-04-cheap-ceiling'), { output: 'ok', cost: 0.0005, latencyMs: 300 }).pass, true);
  assert.strictEqual(scoreAttempt(taskById('cheap-04-cheap-ceiling'), { output: 'ok', cost: 5, latencyMs: 300 }).pass, false);
  // LLM judge is secondary-only and never flips the verdict.
  const withJudge = scoreAttempt(taskById('code-01-reverse-string'), { output: 'wrong', llmJudge: { score: 0.99, note: 'looks good' } });
  assert.strictEqual(withJudge.pass, false);
  assert.strictEqual(withJudge.secondary.role, 'secondary-only');
  // Unknown task fails closed.
  assert.strictEqual(scoreAttempt(null, { output: 'x' }).pass, false);
}

// Full suite run is deterministic and honest about provenance.
{
  const r1 = runGoldenSuite(demoAttempts('baseline'), { modelId: 'demo-baseline', provenance: 'DEMO' });
  const r2 = runGoldenSuite(demoAttempts('baseline'), { modelId: 'demo-baseline', provenance: 'DEMO' });
  assert.deepStrictEqual(r1, { ...r2, generatedAt: r1.generatedAt });
  assert.strictEqual(r1.total, 24);
  assert.strictEqual(r1.passed, 24);
  assert.strictEqual(r1.successRate, 1);
  assert.strictEqual(r1.provenance, 'DEMO');
  assert.strictEqual(r1.categories.length, 5);
  // Missing attempts fail honestly (never invented).
  const partial = { ...demoAttempts('baseline') };
  delete partial['code-01-reverse-string'];
  const r3 = runGoldenSuite(partial, { modelId: 'demo-partial', provenance: 'DEMO' });
  assert.strictEqual(r3.passed, 23);
  assert.ok(r3.rows.find((r) => r.taskId === 'code-01-reverse-string' && r.pass === false));
}

// Regression diff detects before/after movement by category.
{
  const before = runGoldenSuite(demoAttempts('v1'), { modelId: 'router-v1', provenance: 'DEMO' });
  const attempts = demoAttempts('v2');
  attempts['code-01-reverse-string'] = { output: 'wrong', cost: 0.001, latencyMs: 400 };
  const after = runGoldenSuite(attempts, { modelId: 'router-v2', provenance: 'DEMO' });
  const d = diffGoldenRuns(before, after);
  assert.strictEqual(d.regressions.length, 1);
  assert.strictEqual(d.regressions[0].taskId, 'code-01-reverse-string');
  assert.strictEqual(d.regressions[0].direction, 'regression');
  assert.ok(d.byCategory.find((c) => c.category === 'coding' && c.delta < 0));
}

console.log('--- Evals golden tests: passed ---');
