'use strict';

// Layered semantic cache (§21–§22).
//
// Layers:
//   L1 run      — exact prompt hash within the run (current prompt cache).
//   L2 workspace— shared exact entries namespaced by workspace (opt-in).
//   L3 semantic — near-duplicate task reuse with similarity + freshness +
//                 context-fingerprint + tool-dependency checks.
//   L4 provider — provider-reported cached-token metadata (informational).
//
// Reuse is conservative: a semantic hit must clear similarity, freshness,
// fingerprint-stability and tool-dependency gates or it is a miss with a
// reason. Stale codebases never serve old answers as fresh.

const crypto = require('crypto');
const { VERSIONS } = require('./versions');
const { lexicalOverlap, fingerprintContext } = require('./context-engine');

function hashTask(taskText) {
  return crypto.createHash('sha256').update(String(taskText || '')).digest('hex');
}

class SemanticCacheIndex {
  constructor(options = {}) {
    this.max = options.max || 200;
    // entries: { key, taskText, taskHash, fingerprint, modelId, tools, result,
    //            tenantId, projectId, createdAt, workspaceRev, similarity computed at lookup }
    this.entries = [];
    this.similarityThreshold = Number.isFinite(options.similarityThreshold) ? options.similarityThreshold : 0.82;
    this.maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 1000 * 60 * 60 * 24;
  }

  store(entry) {
    const e = {
      key: entry.key || `sem-${hashTask(entry.taskText).slice(0, 12)}`,
      taskText: String(entry.taskText || '').slice(0, 4000),
      taskHash: hashTask(entry.taskText),
      fingerprint: entry.fingerprint || null,
      modelId: entry.modelId || null,
      tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 20) : [],
      result: entry.result !== undefined ? entry.result : null,
      createdAt: entry.createdAt || entry.cachedAt || new Date().toISOString(),
      workspaceRev: entry.workspaceRev || null,
      tenantId: entry.tenantId || null,
      projectId: entry.projectId || null,
      runId: entry.runId || null,
      // Reuse-gate provenance (additive; absent on legacy entries):
      pureAnswer: entry.pureAnswer === true,
      compatibleModels: Array.isArray(entry.compatibleModels) ? entry.compatibleModels.slice(0, 20) : null,
      maxAgeMs: Number.isFinite(Number(entry.maxAgeMs)) && Number(entry.maxAgeMs) > 0 ? Number(entry.maxAgeMs) : null,
    };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return e;
  }

  lookup(query = {}) {
    const taskText = String(query.taskText || '');
    const nowMs = query.nowMs || Date.now();
    const tenantId = query.tenantId || null;
    const projectId = query.projectId || null;
    let best = null;
    let bestSim = 0;
    for (const e of this.entries) {
      // Authenticated tenant lookups never consume legacy/unscoped entries or
      // another tenant's semantic answer. Unscoped unit/demo lookups retain
      // the historical workspace behavior.
      if (tenantId && e.tenantId !== tenantId) continue;
      if (projectId && e.projectId !== projectId) continue;
      const sim = e.taskHash === hashTask(taskText) ? 1 : lexicalOverlap(taskText, e.taskText);
      if (sim > bestSim) { bestSim = sim; best = e; }
    }
    if (!best) return { hit: false, reason: 'empty index' };
    const similarity = Math.round(bestSim * 1000) / 1000;
    if (similarity < this.similarityThreshold) {
      return { hit: false, reason: `similarity ${similarity} < threshold ${this.similarityThreshold}`, similarity };
    }
    const ageMs = nowMs - (Date.parse(best.createdAt) || nowMs);
    const entryMaxAge = Number.isFinite(Number(best.maxAgeMs)) && Number(best.maxAgeMs) > 0 ? Number(best.maxAgeMs) : this.maxAgeMs;
    if (ageMs > entryMaxAge) {
      return { hit: false, reason: `stale (age ${Math.round(ageMs / 60000)}m > max ${Math.round(entryMaxAge / 60000)}m)`, similarity, freshness: 0 };
    }
    // Context drift: same words but different selected context -> risky reuse.
    if (query.fingerprint && best.fingerprint && query.fingerprint !== best.fingerprint) {
      return {
        hit: false, reason: 'context fingerprint changed since cached entry (codebase/context drift)',
        similarity, freshness: Math.round(Math.max(0, 1 - ageMs / entryMaxAge) * 1000) / 1000,
      };
    }
    // Workspace revision change invalidates tool-dependent answers.
    if (query.workspaceRev && best.workspaceRev && query.workspaceRev !== best.workspaceRev && best.tools.length) {
      return { hit: false, reason: 'workspace changed since cached entry; tool-dependent result may be stale', similarity };
    }
    // Tool dependency change invalidates.
    if (Array.isArray(query.tools)) {
      const a = new Set(query.tools);
      const b = new Set(best.tools);
      const same = a.size === b.size && [...a].every((t) => b.has(t));
      if (!same) {
        return { hit: false, reason: 'tool dependencies differ from cached entry', similarity };
      }
    }
    return {
      hit: true,
      similarity,
      freshness: Math.round(Math.max(0, 1 - ageMs / entryMaxAge) * 1000) / 1000,
      sourceTask: best.taskText.slice(0, 200),
      modelUsed: best.modelId,
      runId: best.runId || null,
      toolDependencies: best.tools,
      contextFingerprint: best.fingerprint,
      createdAt: best.createdAt,
      result: best.result,
      pureAnswer: best.pureAnswer === true,
      compatibleModels: best.compatibleModels || null,
      cacheVersion: VERSIONS.semanticCache,
    };
  }

  invalidateByWorkspace(workspaceRev) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.workspaceRev !== workspaceRev);
    return { invalidated: before - this.entries.length };
  }

  clear() { this.entries = []; }

  clearScope({ tenantId = null, projectId = null } = {}) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => {
      if (tenantId && entry.tenantId !== tenantId) return true;
      if (projectId && entry.projectId !== projectId) return true;
      return false;
    });
    return before - this.entries.length;
  }

  dump() { return this.entries.slice(-this.max); }

  load(items) {
    if (!Array.isArray(items)) return 0;
    this.entries = items.filter((e) => e && e.taskText).slice(-this.max);
    return this.entries.length;
  }
}

module.exports = { SemanticCacheIndex, hashTask, fingerprintContext };
