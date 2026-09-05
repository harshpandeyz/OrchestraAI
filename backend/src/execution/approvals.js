'use strict';

// Session 3 — Approval system (first-class) + policy-aware risk classification.
//
// Approval is scoped to a SPECIFIC action (tool + params hash + run + proposed
// change), never "approve the agent". Approvals cannot be escalated or
// replayed: each approval binds runId + actionType + resource fingerprint,
// expires, and is single-use.

const crypto = require('crypto');
const { RiskLevel, compareRisk } = require('./tool-system');
const { ApprovalMode } = require('./execution-policy');

const ApprovalStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

// Canonical params fingerprint: stable key-order, actionType + params only.
// proposedAction is audit metadata (stored on the record) — NOT part of the
// binding. Binding includes runId (checked separately) + actionType + params
// so request/peek/consume agree even when callers omit proposedAction.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fingerprintAction(actionType, params, extra = '') {
  const h = crypto.createHash('sha256');
  // Back-compat: when a caller passes an explicit non-empty extra
  // (legacy proposedAction binding), honor it so old stored approvals keep
  // verifying. New code passes ''/undefined and binds params only.
  const hasExtra = extra !== undefined && extra !== null && String(extra) !== '' && String(extra) !== '{}';
  if (hasExtra) {
    h.update(JSON.stringify({ actionType, params: params || {}, extra: String(extra) }));
  } else {
    h.update(`${String(actionType)}|${stableStringify(params || {})}`);
  }
  return h.digest('hex').slice(0, 16);
}

function fingerprintParams(actionType, params) {
  const h = crypto.createHash('sha256');
  h.update(`${String(actionType)}|${stableStringify(params || {})}`);
  return h.digest('hex').slice(0, 16);
}

// Policy-aware risk classification. Not simplistic string matching: the tool
// definition's declared risk is the floor, and parameter analysis can only
// raise it (params can make a MEDIUM tool HIGH, never lower a HIGH tool).
function classifyRisk(definition, params = {}) {
  const base = (definition && definition.riskLevel) || RiskLevel.LOW;
  const name = (definition && definition.name) || '';
  let risk = base;
  const reasons = [`base:${base}`];
  const raise = (to, why) => {
    if (compareRisk(to, risk) > 0) { risk = to; reasons.push(why); }
  };

  const p = params || {};
  if (name === 'apply_patch') {
    const edits = Array.isArray(p.edits) ? p.edits : [];
    const totalChars = edits.reduce((n, e) => n + String((e && e.newText) || '').length, 0);
    if (edits.length > 10 || totalChars > 20000) raise(RiskLevel.HIGH, 'large-patch');
    if (/migrate|schema|auth|credential|secret|deploy/i.test(JSON.stringify(p).slice(0, 2000))) {
      raise(RiskLevel.HIGH, 'sensitive-area');
    }
  }
  if (name === 'git_commit' || name === 'git_add') {
    if (p.allowUnrelated) raise(RiskLevel.HIGH, 'unrelated-changes-included');
  }
  if (name === 'git_create_branch') raise(RiskLevel.MEDIUM, 'branch-mutation');
  if (name === 'git_push') raise(RiskLevel.HIGH, 'remote-mutation');
  if (name === 'install_package') raise(RiskLevel.HIGH, 'supply-chain');
  if (name === 'fetch_url' || name === 'web_search') raise(RiskLevel.MEDIUM, 'egress');
  if (name === 'run_tests' || name === 'build_project') {
    // stays LOW unless params smuggle a non-allowlisted command
    if (typeof p.command === 'string' && p.command && !/^(npm (test|run (test|build|lint))|pytest|cargo test|go test|node )/.test(p.command)) {
      raise(RiskLevel.CRITICAL, 'non-allowlisted-command');
    }
  }
  if (name === 'deploy_preview') raise(RiskLevel.CRITICAL, 'deploy');
  return { risk, reasons };
}

function approvalModeForAutonomy(autonomyMode) {
  switch (autonomyMode) {
    case 'read_only': return ApprovalMode.APPROVE_ALL;
    case 'assisted': return ApprovalMode.APPROVE_WRITES;
    case 'autonomous': return ApprovalMode.APPROVE_DANGEROUS;
    case 'restricted_autonomous': return ApprovalMode.APPROVE_DANGEROUS;
    default: return ApprovalMode.APPROVE_WRITES;
  }
}

let approvalSeq = 0;

class ApprovalStore {
  constructor(options = {}) {
    this.approvals = new Map(); // id -> record
    this.defaultTtlMs = options.defaultTtlMs || 10 * 60 * 1000;
    this.maxPending = options.maxPending || 50;
  }

  request({ runId, actionType, title, description, riskLevel, params, proposedAction, affectedResources, estimatedChanges, estimatedCost, expiresInMs }) {
    if (!runId || !actionType) throw new Error('runId and actionType are required');
    const pending = [...this.approvals.values()].filter((a) => a.runId === runId && a.status === ApprovalStatus.PENDING);
    if (pending.length >= this.maxPending) throw new Error('too many pending approvals for run');
    const id = `appr-${Date.now().toString(36)}-${(approvalSeq++).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const nowMs = Date.now();
    // Binding is runId + actionType + params fingerprint (spec). The
    // proposedAction is stored for audit but never affects the fingerprint.
    const fp = fingerprintParams(actionType, params);
    const record = {
      id,
      runId,
      actionType,
      title: String(title || actionType).slice(0, 200),
      description: String(description || '').slice(0, 2000),
      riskLevel: riskLevel || RiskLevel.MEDIUM,
      requestedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + (Number.isFinite(expiresInMs) ? expiresInMs : this.defaultTtlMs)).toISOString(),
      affectedResources: Array.isArray(affectedResources) ? affectedResources.slice(0, 20) : [],
      proposedAction: proposedAction || null,
      paramsFingerprint: fp,
      estimatedCost: estimatedCost ?? null,
      estimatedChanges: estimatedChanges ?? null,
      status: ApprovalStatus.PENDING,
      decidedAt: null,
      decidedBy: null,
      consumed: false, // single-use: consumed on first successful gate check
    };
    this.approvals.set(id, record);
    return { ...record };
  }

  get(id) {
    const r = this.approvals.get(id);
    return r ? { ...r } : null;
  }

  listForRun(runId, includeDecided = true) {
    return [...this.approvals.values()]
      .filter((a) => a.runId === runId && (includeDecided || a.status === ApprovalStatus.PENDING))
      .map((a) => ({ ...a }));
  }

  pendingForRun(runId) {
    this._sweepExpired();
    return this.listForRun(runId, false);
  }

  _sweepExpired() {
    const t = Date.now();
    for (const r of this.approvals.values()) {
      try {
        if ((r.status === ApprovalStatus.PENDING || r.status === ApprovalStatus.APPROVED) && new Date(r.expiresAt).getTime() <= t) {
          r.status = ApprovalStatus.EXPIRED;
          r.decidedAt = r.decidedAt || new Date(t).toISOString();
        }
      } catch { /* ignore malformed dates */ }
    }
  }

  _settle(id, status, decidedBy) {
    this._sweepExpired();
    const r = this.approvals.get(id);
    if (!r) return { ok: false, error: 'approval not found' };
    if (r.status !== ApprovalStatus.PENDING) return { ok: false, error: `approval is ${r.status}` };
    r.status = status;
    r.decidedAt = new Date().toISOString();
    r.decidedBy = decidedBy || 'user';
    return { ok: true, approval: { ...r } };
  }

  approve(id, decidedBy) { return this._settle(id, ApprovalStatus.APPROVED, decidedBy); }
  deny(id, decidedBy) { return this._settle(id, ApprovalStatus.DENIED, decidedBy); }
  cancel(id, decidedBy) { return this._settle(id, ApprovalStatus.CANCELLED, decidedBy); }

  // Gate check before executing a gated action. Verifies scope binding:
  // same run, same action type, same params fingerprint, still APPROVED,
  // unexpired, unconsumed. Expiry is checked BEFORE any success path so an
  // expired approval is never consumable, and consumption is single-use.
  checkAndConsume({ runId, actionType, params, proposedAction, approvalId }) {
    this._sweepExpired();
    const r = this.approvals.get(approvalId);
    if (!r) return { ok: false, error: 'approval not found' };
    if (r.runId !== runId) return { ok: false, error: 'approval belongs to a different run' };
    if (r.actionType !== actionType) return { ok: false, error: 'approval is for a different action' };
    // Expiry wins over state: an APPROVED approval past expiresAt is unusable.
    // Sweep only flips PENDING; check APPROVED explicitly here.
    try {
      if (r.expiresAt && Date.now() >= new Date(r.expiresAt).getTime()) {
        if (r.status !== ApprovalStatus.EXPIRED) {
          r.status = ApprovalStatus.EXPIRED;
          r.decidedAt = r.decidedAt || new Date().toISOString();
        }
        return { ok: false, error: 'approval expired' };
      }
    } catch { /* malformed date -> treat as unexpired, fingerprint still gates */ }
    if (r.status !== ApprovalStatus.APPROVED) return { ok: false, error: `approval is ${r.status}` };
    if (r.consumed) return { ok: false, error: 'approval already consumed (replay rejected)' };
    const fp = fingerprintParams(actionType, params);
    // Back-compat: approvals minted by older code bound proposedAction into
    // the fingerprint. Accept either binding so upgrades do not invalidate
    // in-flight approvals, but never widen scope (run/action still exact).
    const legacyFp = (() => {
      try {
        if (proposedAction !== undefined) return fingerprintAction(actionType, params, JSON.stringify(proposedAction || {}));
        if (r.proposedAction) return fingerprintAction(actionType, params, JSON.stringify(r.proposedAction || {}));
      } catch {}
      return null;
    })();
    if (fp !== r.paramsFingerprint && legacyFp !== r.paramsFingerprint) {
      return { ok: false, error: 'approval does not match this action (fingerprint mismatch)' };
    }
    r.consumed = true;
    return { ok: true, approval: { ...r } };
  }

  // Non-consuming pre-check (for dry-run UX: "is there an approval?").
  peek({ runId, actionType, params, proposedAction }) {
    this._sweepExpired();
    const fp = fingerprintParams(actionType, params);
    const legacyFp = (() => {
      try {
        if (proposedAction !== undefined) return fingerprintAction(actionType, params, JSON.stringify(proposedAction || {}));
      } catch {}
      return null;
    })();
    const match = [...this.approvals.values()].find(
      (r) => {
        if (r.runId !== runId || r.actionType !== actionType) return false;
        if (r.status !== ApprovalStatus.APPROVED || r.consumed) return false;
        // Expired approvals are never peekable.
        try {
          if (r.expiresAt && Date.now() >= new Date(r.expiresAt).getTime()) return false;
        } catch {}
        if (r.paramsFingerprint === fp) return true;
        if (legacyFp && r.paramsFingerprint === legacyFp) return true;
        // Legacy record whose fingerprint bound proposedAction: match when the
        // caller omits proposedAction by comparing against the stored one.
        if (!proposedAction && r.proposedAction) {
          try {
            const stored = fingerprintAction(actionType, params, JSON.stringify(r.proposedAction || {}));
            if (stored === r.paramsFingerprint) return true;
          } catch {}
        }
        return false;
      }
    );
    return match ? { ...match } : null;
  }

  clearRun(runId) {
    for (const [id, r] of this.approvals.entries()) {
      if (r.runId === runId) this.approvals.delete(id);
    }
  }
}

module.exports = {
  ApprovalStatus,
  ApprovalStore,
  classifyRisk,
  approvalModeForAutonomy,
  fingerprintAction,
  fingerprintParams,
  stableStringify,
};
