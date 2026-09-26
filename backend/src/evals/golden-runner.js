'use strict';

// OrchestraAI — Evals v2 golden runner (deterministic, zero-dependency).
//
// Scores recorded attempts against GOLDEN_TASKS with pure rule predicates.
// No network, no provider calls, no LLM judge. Cost/latency on each attempt
// are caller-supplied measurements (real numbers); when the caller has none,
// it must pass explicit DEMO measurements labelled provenance:'DEMO' — the
// runner never invents them.
//
// An attempt: { taskId, output?, toolCalls?, evidence?, cost?, latencyMs?,
//               modelId?, llmJudge? }
//   - output: string produced for the task
//   - toolCalls: ordered array of tool names invoked
//   - evidence: string cited from context / fetched pages
//   - cost / latencyMs: measured numbers (or DEMO-labelled)
//   - llmJudge: optional { score, note } — recorded verbatim as secondary
//     signal, never overrides the deterministic pass/fail.
//
// scoreAttempt(task, attempt) -> { pass, reason, secondary }
// runGoldenSuite(attemptsByTask, opts) -> leaderboard + regression inputs
// diffGoldenRuns(before, after) -> per-category delta table

const { GOLDEN_TASKS } = require('./golden-tasks');

function taskById(id) {
  return GOLDEN_TASKS.find((t) => t.id === id) || null;
}

function scoreExpect(expect, attempt) {
  const a = attempt || {};
  switch (expect.kind) {
    case 'exact': {
      const out = String(a.output ?? '').trim();
      const pass = out === String(expect.value);
      return { pass, reason: pass ? 'exact match' : `expected exact ${JSON.stringify(expect.value)}, got ${JSON.stringify(out.slice(0, 120))}` };
    }
    case 'contains': {
      const out = String(a.output ?? '');
      const pass = out.toLowerCase().includes(String(expect.value).toLowerCase());
      return { pass, reason: pass ? `contains ${JSON.stringify(expect.value)}` : `missing ${JSON.stringify(expect.value)}` };
    }
    case 'sequence': {
      const got = Array.isArray(a.toolCalls) ? a.toolCalls : [];
      const want = expect.value || [];
      const pass = got.length === want.length && got.every((v, i) => v === want[i]);
      return { pass, reason: pass ? `sequence ${want.join('>')}` : `expected [${want.join(',')}], got [${got.join(',')}]` };
    }
    case 'retrieves': {
      const hay = `${a.evidence ?? ''}\n${a.output ?? ''}`;
      const pass = hay.includes(String(expect.value));
      return { pass, reason: pass ? `retrieved ${JSON.stringify(expect.value)}` : `evidence missing ${JSON.stringify(expect.value)}` };
    }
    case 'bounded': {
      const costOk = expect.maxCost === undefined || (Number.isFinite(a.cost) && a.cost <= expect.maxCost);
      const latOk = expect.maxLatencyMs === undefined || (Number.isFinite(a.latencyMs) && a.latencyMs <= expect.maxLatencyMs);
      const outOk = String(a.output ?? '').trim().length > 0;
      const pass = costOk && latOk && outOk;
      const bits = [];
      if (!costOk) bits.push(`cost ${a.cost} > ${expect.maxCost}`);
      if (!latOk) bits.push(`latency ${a.latencyMs}ms > ${expect.maxLatencyMs}ms`);
      if (!outOk) bits.push('empty output');
      return { pass, reason: pass ? `within bounds (cost ${a.cost}, ${a.latencyMs}ms)` : bits.join('; ') };
    }
    default:
      return { pass: false, reason: `unknown expect kind ${expect.kind}` };
  }
}

function scoreAttempt(task, attempt) {
  if (!task) return { pass: false, reason: 'unknown task', secondary: null };
  const r = scoreExpect(task.expect, attempt);
  const secondary = attempt && attempt.llmJudge ? { ...attempt.llmJudge, role: 'secondary-only' } : null;
  return { pass: r.pass, reason: r.reason, secondary };
}

// attemptsByTask: { [taskId]: attempt } — one attempt per task per model run.
// opts: { modelId, provenance: 'DEMO'|'OBSERVED'|'VERIFIED' }
function runGoldenSuite(attemptsByTask, opts = {}) {
  const modelId = opts.modelId || 'unknown';
  const provenance = opts.provenance || 'DEMO';
  const rows = [];
  let passCount = 0;
  let costSum = 0;
  let costN = 0;
  let latSum = 0;
  let latN = 0;
  for (const task of GOLDEN_TASKS) {
    const attempt = (attemptsByTask || {})[task.id] || null;
    if (!attempt) {
      rows.push({ taskId: task.id, category: task.category, pass: false, reason: 'no attempt recorded', cost: null, latencyMs: null, modelId, provenance });
      continue;
    }
    const s = scoreAttempt(task, attempt);
    if (s.pass) passCount += 1;
    if (Number.isFinite(attempt.cost)) { costSum += attempt.cost; costN += 1; }
    if (Number.isFinite(attempt.latencyMs)) { latSum += attempt.latencyMs; latN += 1; }
    rows.push({
      taskId: task.id, category: task.category, pass: s.pass, reason: s.reason,
      secondary: s.secondary, cost: Number.isFinite(attempt.cost) ? attempt.cost : null,
      latencyMs: Number.isFinite(attempt.latencyMs) ? attempt.latencyMs : null,
      modelId, provenance,
    });
  }
  const byCategory = {};
  for (const r of rows) {
    const c = byCategory[r.category] || (byCategory[r.category] = { category: r.category, total: 0, passed: 0, costs: [], latencies: [] });
    c.total += 1;
    if (r.pass) c.passed += 1;
    if (Number.isFinite(r.cost)) c.costs.push(r.cost);
    if (Number.isFinite(r.latencyMs)) c.latencies.push(r.latencyMs);
  }
  const categories = Object.values(byCategory).map((c) => ({
    category: c.category,
    total: c.total,
    passed: c.passed,
    successRate: c.total ? Math.round((c.passed / c.total) * 1000) / 1000 : null,
    avgCost: c.costs.length ? Math.round((c.costs.reduce((a, b) => a + b, 0) / c.costs.length) * 1e6) / 1e6 : null,
    avgLatencyMs: c.latencies.length ? Math.round(c.latencies.reduce((a, b) => a + b, 0) / c.latencies.length) : null,
  }));
  return {
    modelId,
    provenance,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    passed: passCount,
    successRate: rows.length ? Math.round((passCount / rows.length) * 1000) / 1000 : null,
    avgCost: costN ? Math.round((costSum / costN) * 1e6) / 1e6 : null,
    avgLatencyMs: latN ? Math.round(latSum / latN) : null,
    categories,
    rows,
  };
}

// Deterministic DEMO attempts for smoke/regression baselines: derived purely
// from task expect + a caller seed, explicitly labelled DEMO. Used by
// qa/evals-golden-check.js and tests so the suite is runnable with zero keys.
function demoAttempts(seed = 'baseline') {
  const out = {};
  for (const t of GOLDEN_TASKS) {
    const e = t.expect;
    if (e.kind === 'exact') out[t.id] = { output: String(e.value), cost: 0.001, latencyMs: 400, modelId: `demo-${seed}` };
    else if (e.kind === 'contains') out[t.id] = { output: `answer: ${e.value} (demo)`, cost: 0.001, latencyMs: 400, modelId: `demo-${seed}` };
    else if (e.kind === 'sequence') out[t.id] = { toolCalls: [...e.value], output: e.value.join(','), cost: 0.002, latencyMs: 900, modelId: `demo-${seed}` };
    else if (e.kind === 'retrieves') out[t.id] = { output: `citing ${e.value}`, evidence: String(e.value), cost: 0.002, latencyMs: 900, modelId: `demo-${seed}` };
    else if (e.kind === 'bounded') out[t.id] = { output: 'ok', cost: 0.0005, latencyMs: 300, modelId: `demo-${seed}` };
  }
  return out;
}

// Regression diff: compare two runGoldenSuite() results task-by-task.
function diffGoldenRuns(before, after) {
  const bBy = new Map((before.rows || []).map((r) => [r.taskId, r]));
  const aBy = new Map((after.rows || []).map((r) => [r.taskId, r]));
  const ids = new Set([...bBy.keys(), ...aBy.keys()]);
  const changed = [];
  for (const id of ids) {
    const b = bBy.get(id);
    const a = aBy.get(id);
    const bp = b ? !!b.pass : null;
    const ap = a ? !!a.pass : null;
    if (bp !== ap) changed.push({ taskId: id, category: (a || b).category, before: bp, after: ap, direction: bp === true && ap === false ? 'regression' : bp === false && ap === true ? 'fix' : 'changed' });
  }
  const bCat = new Map((before.categories || []).map((c) => [c.category, c.successRate]));
  const aCat = new Map((after.categories || []).map((c) => [c.category, c.successRate]));
  const cats = new Set([...bCat.keys(), ...aCat.keys()]);
  const byCategory = [...cats].map((category) => {
    const b = bCat.get(category);
    const a = aCat.get(category);
    const delta = (a ?? 0) - (b ?? 0);
    return { category, before: b ?? null, after: a ?? null, delta: Math.round(delta * 1000) / 1000 };
  });
  return {
    beforeModel: before.modelId || null,
    afterModel: after.modelId || null,
    beforeRate: before.successRate ?? null,
    afterRate: after.successRate ?? null,
    delta: Math.round(((after.successRate ?? 0) - (before.successRate ?? 0)) * 1000) / 1000,
    changed,
    regressions: changed.filter((c) => c.direction === 'regression'),
    fixes: changed.filter((c) => c.direction === 'fix'),
    byCategory,
  };
}

module.exports = { taskById, scoreExpect, scoreAttempt, runGoldenSuite, demoAttempts, diffGoldenRuns };
