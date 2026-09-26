'use strict';

// OrchestraAI — Evals v2 golden task suite (data only).
//
// 24 fixed tasks across 5 categories. Each task carries a deterministic,
// rule-based success predicate (no LLM judge as the primary signal): the
// runner scores a recorded attempt's evidence against `expect` using pure
// functions in golden-runner.js. An optional, clearly-labelled LLM-judge
// signal may be attached by callers as secondary evidence — it is never the
// only signal and never overrides the deterministic verdict.
//
// Categories:
//   coding                  — exact-output / patch-shape checks
//   reasoning               — multi-step selection / ordering checks
//   tool-use                — allowlisted tool-call sequence checks
//   long-context            — retrieval-from-context checks
//   cheap-simple            — trivial tasks that must stay cheap/fast
//
// Every `expect` is one of:
//   { kind: 'exact', value }            — output must equal value
//   { kind: 'contains', value }         — output must contain substring
//   { kind: 'sequence', value: [...] }  — tool-call name sequence must equal
//   { kind: 'retrieves', value }        — cited evidence must contain value
//   { kind: 'bounded', maxCost, maxLatencyMs } — cost/latency ceiling
//
// Tasks are stable data: ids never reused, prompts frozen. Add new tasks by
// appending with a new id; never edit an existing task's expect in place
// (create a v2 id instead) so before/after regression diffs stay meaningful.

const GOLDEN_TASKS = [
  // ---- coding (6) ----
  { id: 'code-01-reverse-string', category: 'coding', prompt: 'Return the reverse of "orchestra".', expect: { kind: 'exact', value: 'artsehcro' } },
  { id: 'code-02-sum-array', category: 'coding', prompt: 'Sum [3, 1, 4, 1, 5]. Return the number only.', expect: { kind: 'exact', value: '14' } },
  { id: 'code-03-patch-shape', category: 'coding', prompt: 'Produce an exact-match edit replacing "foo" with "bar" on line 1.', expect: { kind: 'contains', value: 'bar' } },
  { id: 'code-04-json-keys', category: 'coding', prompt: 'Return JSON {"a":1,"b":2} with keys sorted.', expect: { kind: 'contains', value: '"a":1' } },
  { id: 'code-05-fizzbuzz-3', category: 'coding', prompt: 'FizzBuzz for 3 (divisible by 3 only).', expect: { kind: 'exact', value: 'Fizz' } },
  { id: 'code-06-semver-next', category: 'coding', prompt: 'Next patch after 0.4.0?', expect: { kind: 'exact', value: '0.4.1' } },
  // ---- reasoning / multi-step (5) ----
  { id: 'reason-01-cheapest-healthy', category: 'reasoning', prompt: 'Pick the cheapest healthy model from [A:$0.03 healthy, B:$0.01 degraded, C:$0.02 healthy].', expect: { kind: 'exact', value: 'C' } },
  { id: 'reason-02-cache-tradeoff', category: 'reasoning', prompt: 'Model X costs $0.01 with cold cache, model Y costs $0.02 with warm cache saving $0.015. Which is cheaper all-in?', expect: { kind: 'exact', value: 'Y' } },
  { id: 'reason-03-order-plans', category: 'reasoning', prompt: 'Order steps [test, plan, execute] into a valid pipeline.', expect: { kind: 'sequence', value: ['plan', 'execute', 'test'] } },
  { id: 'reason-04-fallback', category: 'reasoning', prompt: 'Primary model is down. Name the correct fallback action.', expect: { kind: 'contains', value: 'fallback' } },
  { id: 'reason-05-budget-stop', category: 'reasoning', prompt: 'Budget is 99% spent. What should the runner do?', expect: { kind: 'contains', value: 'stop' } },
  // ---- tool-use (5) ----
  { id: 'tool-01-read-then-test', category: 'tool-use', prompt: 'Read a file then run its tests.', expect: { kind: 'sequence', value: ['read_file', 'run_tests'] } },
  { id: 'tool-02-search-then-patch', category: 'tool-use', prompt: 'Search code then apply a patch.', expect: { kind: 'sequence', value: ['search_code', 'apply_patch'] } },
  { id: 'tool-03-status-diff-log', category: 'tool-use', prompt: 'Inspect git status, diff, and log in order.', expect: { kind: 'sequence', value: ['git_status', 'git_diff', 'git_log'] } },
  { id: 'tool-04-env-then-build', category: 'tool-use', prompt: 'Inspect the environment then build the project.', expect: { kind: 'sequence', value: ['env_inspect', 'build_project'] } },
  { id: 'tool-05-fetch-citation', category: 'tool-use', prompt: 'Fetch a URL and cite its title.', expect: { kind: 'retrieves', value: 'title' } },
  // ---- long-context (4) ----
  { id: 'ctx-01-needle', category: 'long-context', prompt: 'The needle "magpie-42" is buried in the context. Quote it.', expect: { kind: 'retrieves', value: 'magpie-42' } },
  { id: 'ctx-02-two-hop', category: 'long-context', prompt: 'Doc A says the key is in Doc B; Doc B says the key is "ember-7". Quote the key.', expect: { kind: 'retrieves', value: 'ember-7' } },
  { id: 'ctx-03-compress-keep', category: 'long-context', prompt: 'After compression, which run id must be retained? (run r-keep-1)', expect: { kind: 'retrieves', value: 'r-keep-1' } },
  { id: 'ctx-04-window-math', category: 'long-context', prompt: '2000 of 8000 tokens used. What utilization?', expect: { kind: 'contains', value: '25' } },
  // ---- cheap-simple (4) ----
  { id: 'cheap-01-ping', category: 'cheap-simple', prompt: 'Reply "pong".', expect: { kind: 'exact', value: 'pong' } },
  { id: 'cheap-02-echo', category: 'cheap-simple', prompt: 'Echo "hello".', expect: { kind: 'exact', value: 'hello' } },
  { id: 'cheap-03-yes', category: 'cheap-simple', prompt: 'Answer yes or no: is 2+2=4?', expect: { kind: 'contains', value: 'yes' } },
  { id: 'cheap-04-cheap-ceiling', category: 'cheap-simple', prompt: 'Reply "ok" using the cheapest path.', expect: { kind: 'bounded', maxCost: 0.005, maxLatencyMs: 5000 } },
];

const CATEGORIES = ['coding', 'reasoning', 'tool-use', 'long-context', 'cheap-simple'];

module.exports = { GOLDEN_TASKS, CATEGORIES };
