'use strict';

// Benchmark / evaluation dataset support (§34).
//
// Small architecture for a future evaluation platform: versioned cases with
// explicit success criteria + expected capabilities, and per-attempt history
// (model, case, outcome, cost, latency). No seeded fake benchmark data —
// cases are created explicitly via API or tests.

const { VERSIONS } = require('./versions');

function nowIso() {
  return new Date().toISOString();
}

class BenchmarkStore {
  constructor(options = {}) {
    this.max = options.max || 100;
    this.maxAttempts = options.maxAttempts || 500;
    this.cases = new Map();
    this.attempts = [];
  }

  createCase(input = {}) {
    if (!input.id || typeof input.id !== 'string') throw Object.assign(new Error('benchmark case requires id'), { code: 'bad_request' });
    const c = {
      id: String(input.id).slice(0, 128),
      category: String(input.category || 'general').slice(0, 64),
      prompt: String(input.prompt || '').slice(0, 8000),
      context: input.context !== undefined ? input.context : null,
      successCriteria: Array.isArray(input.successCriteria) ? input.successCriteria.slice(0, 20) : [],
      expectedCapabilities: Array.isArray(input.expectedCapabilities) ? input.expectedCapabilities.slice(0, 20) : [],
      createdAt: nowIso(),
      evaluatorVersion: VERSIONS.evaluator,
    };
    this.cases.set(c.id, c);
    if (this.cases.size > this.max) {
      const first = this.cases.keys().next().value;
      this.cases.delete(first);
    }
    return c;
  }

  getCase(id) {
    return this.cases.get(id) || null;
  }

  listCases() {
    return Array.from(this.cases.values());
  }

  deleteCase(id) {
    return this.cases.delete(id);
  }

  recordAttempt(input = {}) {
    const a = {
      id: input.id || `att-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      caseId: input.caseId || null,
      modelId: input.modelId || null,
      runId: input.runId || null,
      outcome: input.outcome !== undefined ? input.outcome : null,
      passed: typeof input.passed === 'boolean' ? input.passed : null,
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
      cost: Number.isFinite(Number(input.cost)) ? Number(input.cost) : null,
      latencyMs: Number.isFinite(Number(input.latencyMs)) ? Number(input.latencyMs) : null,
      timestamp: nowIso(),
    };
    this.attempts.push(a);
    if (this.attempts.length > this.maxAttempts) this.attempts.splice(0, this.attempts.length - this.maxAttempts);
    return a;
  }

  attemptsFor(caseId, modelId = null) {
    return this.attempts.filter((a) => a.caseId === caseId && (!modelId || a.modelId === modelId));
  }

  // Per-model summary for a case: pass rate + avg cost/latency + samples.
  summarize(caseId) {
    const list = this.attemptsFor(caseId);
    const byModel = new Map();
    for (const a of list) {
      if (!a.modelId) continue;
      if (!byModel.has(a.modelId)) byModel.set(a.modelId, []);
      byModel.get(a.modelId).push(a);
    }
    return Array.from(byModel.entries()).map(([modelId, rows]) => {
      const scored = rows.filter((r) => typeof r.passed === 'boolean');
      const costs = rows.map((r) => r.cost).filter(Number.isFinite);
      const lats = rows.map((r) => r.latencyMs).filter(Number.isFinite);
      return {
        modelId,
        attempts: rows.length,
        passRate: scored.length ? Math.round((scored.filter((r) => r.passed).length / scored.length) * 1000) / 1000 : null,
        avgCost: costs.length ? Math.round((costs.reduce((x, y) => x + y, 0) / costs.length) * 1e6) / 1e6 : null,
        avgLatencyMs: lats.length ? Math.round(lats.reduce((x, y) => x + y, 0) / lats.length) : null,
      };
    });
  }

  dump() {
    return { cases: Array.from(this.cases.values()), attempts: this.attempts.slice(-this.maxAttempts) };
  }

  load(data) {
    if (!data || typeof data !== 'object') return 0;
    this.cases.clear();
    for (const c of data.cases || []) {
      if (c && c.id) this.cases.set(c.id, c);
    }
    this.attempts = Array.isArray(data.attempts) ? data.attempts.filter(Boolean).slice(-this.maxAttempts) : [];
    return this.cases.size;
  }
}

module.exports = { BenchmarkStore };
