'use strict';

const { DecisionType, DecisionStatus } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class DecisionFactor {
  constructor(key, label, status, detail = '') {
    this.key = key;
    this.label = label;
    this.status = status;
    this.detail = detail;
  }
}

class DecisionAlternative {
  constructor(id, deltaCost, deltaLatency, score, note = '') {
    this.id = id;
    this.deltaCost = deltaCost;
    this.deltaLatency = deltaLatency;
    this.score = score;
    this.note = note;
  }
}

class Decision {
  constructor(type, decision, currentStateRef, options = {}) {
    this.decisionId = generateId('decision');
    this.timestamp = now();
    this.decisionType = type;
    this.currentStateRef = currentStateRef;
    this.decision = decision;
    this.candidatesConsidered = options.candidates || [];
    this.selectedCandidate = options.selectedCandidate || null;
    this.score = options.score || 0;
    this.constraints = options.constraints || {};
    this.factors = options.factors || [];
    this.reason = options.reason || '';
    this.expectedCost = options.expectedCost || 0;
    this.expectedLatency = options.expectedLatency || 0;
    this.expectedQuality = options.expectedQuality || 0;
    this.switchingCost = options.switchingCost || 0;
    this.confidence = options.confidence || 0.5;
    this.metadata = options.metadata || {};
    this.status = DecisionStatus.PENDING;
    this.executedAt = null;
    this.result = null;
  }

  addFactor(key, label, status, detail = '') {
    this.factors.push(new DecisionFactor(key, label, status, detail));
  }

  addAlternative(id, deltaCost, deltaLatency, score, note = '') {
    this.candidatesConsidered.push(new DecisionAlternative(id, deltaCost, deltaLatency, score, note));
  }

  markExecuted(result = null) {
    this.status = DecisionStatus.EXECUTED;
    this.executedAt = now();
    this.result = result;
  }

  markRejected(reason) {
    this.status = DecisionStatus.REJECTED;
    this.executedAt = now();
    this.result = { rejected: true, reason };
  }

  markFailed(error) {
    this.status = DecisionStatus.FAILED;
    this.executedAt = now();
    this.result = { failed: true, error: String(error) };
  }

  getNetBenefit() {
    const qualityGain = this.expectedQuality;
    const costSaving = -this.expectedCost;
    const latencyGain = -this.expectedLatency / 1000;
    return qualityGain + costSaving + latencyGain - this.switchingCost;
  }

  toJSON() {
    return {
      decisionId: this.decisionId,
      timestamp: this.timestamp,
      decisionType: this.decisionType,
      currentStateRef: this.currentStateRef,
      decision: this.decision,
      candidatesConsidered: this.candidatesConsidered,
      selectedCandidate: this.selectedCandidate,
      score: this.score,
      constraints: this.constraints,
      factors: this.factors,
      reason: this.reason,
      expectedCost: this.expectedCost,
      expectedLatency: this.expectedLatency,
      expectedQuality: this.expectedQuality,
      switchingCost: this.switchingCost,
      confidence: this.confidence,
      metadata: this.metadata,
      status: this.status,
      executedAt: this.executedAt,
      result: this.result
    };
  }
}

class DecisionEngine {
  constructor(options = {}) {
    this.decisionHistory = [];
    this.maxHistory = options.maxHistory || 100;
  }

  createDecision(type, decision, stateRef, options = {}) {
    const decisionObj = new Decision(type, decision, stateRef, options);
    this.decisionHistory.push(decisionObj);
    if (this.decisionHistory.length > this.maxHistory) {
      this.decisionHistory.shift();
    }
    return decisionObj;
  }

  recordDecision(decision) {
    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > this.maxHistory) {
      this.decisionHistory.shift();
    }
  }

  getRecentDecisions(limit = 10) {
    return this.decisionHistory.slice(-limit);
  }

  getDecisionsByType(type, limit = 10) {
    return this.decisionHistory
      .filter(d => d.decisionType === type)
      .slice(-limit);
  }

  getLastDecision(type) {
    const decisions = this.getDecisionsByType(type, 1);
    return decisions[0] || null;
  }

  clearHistory() {
    this.decisionHistory = [];
  }
}

module.exports = {
  Decision,
  DecisionFactor,
  DecisionAlternative,
  DecisionEngine
};