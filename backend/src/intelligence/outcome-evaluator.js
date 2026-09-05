'use strict';

// Genuine outcome evaluation (§9–§11, §31–§33).
//
// Separates three things the old evaluator conflated:
//   completion (run reached COMPLETED) vs success (task actually achieved).
//
// Sources of evidence, in trust order:
//   1. structured success criteria + tool observations (tests, diffs)
//   2. explicit user feedback (one signal among many, never sole truth)
//   3. automated heuristics (assistant output present, no tool failures)
//   4. model self-report ("I succeeded") — recorded but NEVER sufficient alone.
//
// Every score is nullable when its evidence is absent. Evaluator version is
// always attached (§38).

const { VERSIONS } = require('./versions');

const EVALUATOR_VERSION = VERSIONS.evaluator;

let seq = 0;
function genId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function clamp01(v) {
  if (!Number.isFinite(Number(v))) return null;
  return Math.max(0, Math.min(1, Number(v)));
}

// ---------- Success criteria (§10) ----------

const CRITERION_TYPES = Object.freeze(['test', 'file_change', 'text_requirement', 'numeric_threshold', 'tool_result', 'manual_confirmation']);
const CRITERION_STATUS = Object.freeze(['pending', 'passed', 'failed', 'unknown']);

function createCriterion(input = {}) {
  return {
    id: input.id || genId('crit'),
    description: String(input.description || '').slice(0, 500),
    type: CRITERION_TYPES.includes(input.type) ? input.type : 'text_requirement',
    verificationMethod: String(input.verificationMethod || '').slice(0, 300),
    required: input.required !== false,
    status: CRITERION_STATUS.includes(input.status) ? input.status : 'pending',
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 20) : [],
  };
}

// Evaluate one criterion against collected evidence. Pure + deterministic.
// evidenceByType: { test: [...], tool_result: [...], file_change: [...], ... }
function evaluateCriterion(criterion, evidenceByType = {}) {
  const c = { ...criterion };
  const pool = evidenceByType[c.type] || evidenceByType.all || [];
  const texts = pool.map((e) => `${e.claim || ''} ${e.contentReference || ''}`.toLowerCase()).join('\n');
  if (c.type === 'test') {
    if (/0 failed|all .*pass|pass.*0 fail/.test(texts) && /pass/.test(texts)) c.status = 'passed';
    else if (/fail/.test(texts)) c.status = 'failed';
    else c.status = 'unknown';
  } else if (c.type === 'tool_result') {
    if (pool.some((e) => e.toolSuccess === true)) c.status = 'passed';
    else if (pool.some((e) => e.toolSuccess === false)) c.status = 'failed';
    else c.status = 'unknown';
  } else if (c.type === 'manual_confirmation') {
    const fb = (evidenceByType.user_feedback || [])[0];
    if (fb && fb.userSignal === 'positive') c.status = 'passed';
    else if (fb && fb.userSignal === 'negative') c.status = 'failed';
    else c.status = 'unknown';
  } else {
    c.status = 'unknown';
  }
  return c;
}

// ---------- Evidence ledger (§11) ----------

const EVIDENCE_TYPES = Object.freeze(['file', 'test', 'tool_result', 'provider_response', 'web_source', 'diff', 'metric', 'user_confirmation']);

function createEvidence(input = {}) {
  return {
    id: input.id || genId('ev'),
    type: EVIDENCE_TYPES.includes(input.type) ? input.type : 'metric',
    source: String(input.source || 'runtime').slice(0, 200),
    // Stable reference (suite id, file path, tool call id) — never a raw dump.
    location: String(input.location || '').slice(0, 500),
    contentReference: String(input.contentReference || input.claim || '').slice(0, 1000),
    claim: String(input.claim || '').slice(0, 500),
    confidence: clamp01(input.confidence) === null ? 0.5 : clamp01(input.confidence),
    timestamp: input.timestamp || nowIso(),
    // Optional structured flags used by criterion evaluation:
    toolSuccess: typeof input.toolSuccess === 'boolean' ? input.toolSuccess : undefined,
    userSignal: typeof input.userSignal === 'string' ? input.userSignal : undefined,
  };
}

// ---------- Outcome evaluation ----------

// signals: {
//   completed: bool, hasAssistantMessage: bool, toolFailures: number,
//   withinBudget: bool,
//   criteria: SuccessCriterion[], evidence: EvidenceItem[],
//   toolObservations: [{toolName, success}], testSummary: {passed, failed}|null,
//   userFeedback: { signal: 'positive'|'negative'|'success'|'failure'|rating,
//                  confidence }|null,
//   modelSelfReport: 'success'|'failure'|null,
//   cost, latencyMs, steps
// }
function evaluateOutcome(input = {}) {
  const s = input.signals || input;
  const runId = input.runId || s.runId || null;
  const evidence = Array.isArray(s.evidence) ? s.evidence.map((e) => ({ ...e })) : [];
  const criteria = Array.isArray(s.criteria) ? s.criteria.map((c) => ({ ...c })) : [];

  const byType = {};
  for (const e of evidence) {
    const t = e.type || 'metric';
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }
  if (s.userFeedback) {
    byType.user_feedback = [{ userSignal: normalizeUserSignal(s.userFeedback), confidence: s.userFeedback.confidence ?? 0.4 }];
  }

  // Test-derived correctness (tool/test evidence only — never self-report).
  let correctnessScore = null;
  let testEvidence = null;
  if (s.testSummary && Number.isFinite(Number(s.testSummary.passed)) && Number.isFinite(Number(s.testSummary.failed))) {
    const p = Number(s.testSummary.passed);
    const f = Number(s.testSummary.failed);
    correctnessScore = (p + f) > 0 ? Math.round((p / (p + f)) * 1000) / 1000 : null;
    testEvidence = { passed: p, failed: f };
  } else if ((s.toolFailures || 0) > 0 || (byType.tool_result || []).some((e) => e.toolSuccess === false)) {
    correctnessScore = 0.4; // tool failures observed, no passing evidence
  } else if (s.hasAssistantMessage && (byType.tool_result || []).some((e) => e.toolSuccess === true)) {
    correctnessScore = 0.75; // tools succeeded, no test counts
  }

  // Completeness from criteria (required criteria only).
  let completenessScore = null;
  const evaluated = criteria.map((c) => evaluateCriterion(c, byType));
  const required = evaluated.filter((c) => c.required);
  if (required.length) {
    const passed = required.filter((c) => c.status === 'passed').length;
    const failed = required.filter((c) => c.status === 'failed').length;
    const unknown = required.length - passed - failed;
    completenessScore = Math.round(((passed + unknown * 0.4) / required.length) * 1000) / 1000;
  }

  // Safety: violations observed -> low; nothing observed -> null (unknown).
  let safetyScore = null;
  const safetyHits = evidence.filter((e) => /secret|credential|production|destructive|exfiltrat/i.test(`${e.claim} ${e.contentReference}`));
  if (safetyHits.length) safetyScore = 0.2;
  else if (evidence.length || s.hasAssistantMessage) safetyScore = 0.9;

  // User signal: stored, low weight, never sole determinant.
  let userSignal = null;
  if (s.userFeedback) {
    userSignal = {
      signal: normalizeUserSignal(s.userFeedback),
      confidence: clamp01(s.userFeedback.confidence) === null ? 0.4 : clamp01(s.userFeedback.confidence),
    };
  }

  // Overall: weighted blend of AVAILABLE components only. Missing -> excluded
  // from the blend (unknown stays unknown, §3). Model self-report can only
  // nudge an already-evidenced score, never create one.
  const parts = [];
  if (correctnessScore !== null) parts.push([correctnessScore, 0.4]);
  if (completenessScore !== null) parts.push([completenessScore, 0.35]);
  if (safetyScore !== null) parts.push([safetyScore, 0.15]);
  // Operational health stays a small component (completion != success).
  const operational = (s.completed ? 0.6 : 0) + (s.hasAssistantMessage ? 0.2 : 0) +
    (!(s.toolFailures > 0) ? 0.1 : 0) + (s.withinBudget !== false ? 0.1 : 0);
  parts.push([clamp01(operational), 0.1]);
  let overall = null;
  if (parts.length) {
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    overall = Math.round((parts.reduce((a, [v, w]) => a + v * w, 0) / wsum) * 1000) / 1000;
  }
  if (s.modelSelfReport === 'success' && overall !== null && parts.length <= 2) {
    overall = Math.round(Math.min(overall, 0.65) * 1000) / 1000; // capped: self-report is weak evidence
  }

  // taskSuccess: explicit tri-state. User feedback is ONE evidence signal
  // weighted by confidence — never absolute truth over objective evidence.
  // - Objective failure (failing tests / failed required criteria) wins over
  //   positive feedback: "user liked it" cannot overturn failing tests.
  // - Objective success (passing tests / passed required criteria) wins over
  //   low-confidence negative feedback: a 0.4-confidence thumbs-down does not
  //   erase 10 passing tests. High-confidence negative (>=0.7) against
  //   objective success is a genuine conflict -> null (needs review), not
  //   automatic failure.
  // - With no decisive objective evidence, negative feedback (conf >= 0.3)
  //   can decide failure, but positive feedback alone NEVER proves success
  //   (stays null/unknown — weak evidence + thumbs-up is not verification).
  let taskSuccess = null;
  const requiredFailed = evaluated.some((c) => c.required && c.status === 'failed');
  const requiredPassed = required.length > 0 && required.every((c) => !c.required || c.status === 'passed');
  let objective = null;
  if (requiredFailed || (testEvidence && testEvidence.failed > 0 && (s.strictTests !== false))) {
    objective = false;
  } else if (requiredPassed || (testEvidence && testEvidence.failed === 0 && testEvidence.passed > 0)) {
    objective = true;
  }
  const fbConf = userSignal ? userSignal.confidence : 0;
  const fbNeg = !!(userSignal && userSignal.signal === 'negative');
  const fbPos = !!(userSignal && userSignal.signal === 'positive');
  if (objective === false) {
    if (fbPos && fbConf >= 0.8) taskSuccess = null; // conflict: user loves it but tests fail
    else taskSuccess = false;
  } else if (objective === true) {
    if (fbNeg && fbConf >= 0.7) taskSuccess = null; // conflict: tests pass but user strongly disagrees
    else taskSuccess = true;
  } else if (fbNeg && fbConf >= 0.3) {
    taskSuccess = false;
  } else if (s.completed === false) {
    taskSuccess = false;
  } else {
    taskSuccess = null;
  }

  const reasons = [];
  if (s.completed) reasons.push({ factor: 'completion', detail: 'run reached COMPLETED' });
  else if (s.completed === false) reasons.push({ factor: 'completion', detail: 'run did not complete' });
  if (testEvidence) reasons.push({ factor: 'tests', detail: `${testEvidence.passed} passed, ${testEvidence.failed} failed` });
  if (evaluated.length) reasons.push({ factor: 'criteria', detail: `${evaluated.filter((c) => c.status === 'passed').length}/${evaluated.length} criteria passed` });
  if (userSignal) reasons.push({ factor: 'user_feedback', detail: `user signal ${userSignal.signal} (confidence ${userSignal.confidence})` });
  if (s.modelSelfReport) reasons.push({ factor: 'self_report', detail: `model claimed ${s.modelSelfReport} (weak evidence, capped)` });

  // Confidence: driven by evidence breadth, not by the score value.
  const evidenceBreadth = (testEvidence ? 1 : 0) + (evaluated.length ? 1 : 0) +
    ((byType.tool_result || []).length ? 1 : 0) + (userSignal ? 1 : 0);
  const confidence = evidenceBreadth >= 3 ? 0.85 : evidenceBreadth === 2 ? 0.65 : evidenceBreadth === 1 ? 0.45 : 0.25;

  return {
    id: input.id || genId('oeval'),
    runId,
    modelId: input.modelId || s.modelId || null,
    taskCategory: input.taskCategory || s.taskCategory || 'general',
    taskSuccess, // true | false | null (unknown)
    correctnessScore,
    completenessScore,
    evidenceScore: evidence.length ? Math.min(1, evidence.length / 5) : null,
    safetyScore,
    regressionScore: null, // set by benchmark comparisons, not single runs
    userSignal,
    overallScore: overall,
    confidence,
    criteria: evaluated,
    evidence,
    reasons,
    cost: Number.isFinite(Number(s.cost)) ? Number(s.cost) : null,
    latencyMs: Number.isFinite(Number(s.latencyMs)) ? Math.max(0, Math.round(Number(s.latencyMs))) : null,
    steps: Number.isFinite(Number(s.steps)) ? Number(s.steps) : null,
    evaluatorVersion: EVALUATOR_VERSION,
    timestamp: nowIso(),
  };
}

function normalizeUserSignal(fb) {
  if (!fb) return 'unknown';
  const raw = String(fb.signal || fb.value || fb.rating || '').toLowerCase();
  if (['positive', 'success', 'up', 'good', 'thumbs_up', 'thumbs-up', 'pass'].includes(raw)) return 'positive';
  if (['negative', 'failure', 'down', 'bad', 'thumbs_down', 'thumbs-down', 'fail'].includes(raw)) return 'negative';
  const n = Number(fb.rating);
  if (Number.isFinite(n)) return n >= 3.5 ? 'positive' : 'negative';
  return 'unknown';
}

// Map an OutcomeEvaluation to a learning-safe performance update (§33).
// Returns null when there is no trustworthy evidence (unknown stays unknown).
function outcomeToLearningUpdate(outcome) {
  if (!outcome) return null;
  if (outcome.taskSuccess === true) {
    return { success: true, qualityScore: outcome.overallScore, trusted: true };
  }
  if (outcome.taskSuccess === false) {
    return { success: false, qualityScore: outcome.overallScore, trusted: true };
  }
  // Unknown success with decent operational evidence -> latency-only update.
  if (outcome.overallScore !== null && outcome.confidence >= 0.45) {
    return { success: null, qualityScore: null, trusted: false, latencyOnly: true };
  }
  return null;
}

module.exports = {
  EVALUATOR_VERSION,
  CRITERION_TYPES,
  EVIDENCE_TYPES,
  createCriterion,
  evaluateCriterion,
  createEvidence,
  evaluateOutcome,
  normalizeUserSignal,
  outcomeToLearningUpdate,
};
