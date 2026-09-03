'use strict';

// Minimal evaluation backend (Session A).
//
// Stores REAL run outcomes only — never invented scores. Each record derives
// deterministically from a finished run's own evidence (terminal status,
// assistant output presence, tool failure count, budget compliance) using the
// documented rule-based rubric below. Evaluator metadata always identifies the
// rubric version so consumers can tell rule-based scores from human/LLM judges.
//
// Rubric `runtime-evidence-v1` (score in [0, 1]):
//   +0.60  run completed (vs failed/cancelled/interrupted)
//   +0.15  at least one non-empty assistant message
//   +0.15  zero failed tool calls (or no tools used)
//   +0.10  spend stayed within budget
// passed = completed && score >= 0.70

const { generateId, now } = require('./state/runtime-state');

const EVALUATOR = { name: 'runtime-evidence-v1', kind: 'rule-based' };

function scoreEvidence(evidence = {}) {
  let score = 0;
  if (evidence.completed) score += 0.6;
  if (evidence.hasAssistantMessage) score += 0.15;
  if (!evidence.toolFailures) score += 0.15;
  if (evidence.withinBudget) score += 0.1;
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

function buildEvaluation(input = {}) {
  const score = scoreEvidence(input);
  const completed = !!input.completed;
  return {
    id: input.id || generateId('eval'),
    runId: input.runId || null,
    model: input.model || null,
    provider: input.provider || null,
    category: input.category || 'general',
    score,
    passed: completed && score >= 0.7,
    status: input.status || (completed ? 'completed' : 'not-completed'),
    cost: typeof input.cost === 'number' && Number.isFinite(input.cost) ? input.cost : 0,
    latencyMs: typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : 0,
    steps: typeof input.steps === 'number' && Number.isFinite(input.steps) ? input.steps : 0,
    toolCalls: typeof input.toolCalls === 'number' ? input.toolCalls : 0,
    toolFailures: typeof input.toolFailures === 'number' ? input.toolFailures : 0,
    timestamp: input.timestamp || now(),
    evaluator: { ...EVALUATOR },
  };
}

class EvaluationStore {
  constructor(options = {}) {
    this.max = options.max || 200;
    this.evals = [];
  }

  record(input) {
    const entry = buildEvaluation(input);
    this.evals.push(entry);
    if (this.evals.length > this.max) this.evals.splice(0, this.evals.length - this.max);
    return entry;
  }

  list({ runId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(this.max, Number(limit) || 50));
    const filtered = runId ? this.evals.filter((e) => e.runId === runId) : this.evals;
    return filtered.slice(-n).reverse();
  }

  loadAll(items) {
    if (!Array.isArray(items)) return 0;
    const valid = items.filter((e) => e && typeof e.id === 'string' && typeof e.runId === 'string');
    this.evals = valid.slice(-this.max);
    return this.evals.length;
  }

  dump() {
    return this.evals.slice();
  }
}

module.exports = { EvaluationStore, buildEvaluation, scoreEvidence, EVALUATOR };
