'use strict';

const { ModelRouter } = require('../interfaces');
const { DecisionType, DecisionStatus } = require('../core/types');
const { Decision, DecisionEngine } = require('../decisions/decision-engine');
const { SwitchingCostCalculator, ModelStickinessManager } = require('../decisions/switching-cost');
const { generateId, now } = require('../state/runtime-state');
// Session 2 intelligence overlay (additive): task classification, empirical
// performance, expected utility, budget/latency/reliability awareness,
// explanations. Legacy weighted scoring stays the ordering base so behavior
// without observations is unchanged; observations adjust it.
const { classifyTask } = require('../intelligence/task-classifier');
const routerIntel = require('../intelligence/router-intelligence');
const routingObjective = require('../decisions/routing-objective');
const { VERSIONS } = require('../intelligence/versions');

class InMemoryModelRouter extends ModelRouter {
  constructor(modelRegistry, switchingCostCalculator, stickinessManager, eventBus = null, options = {}) {
    super();
    this.modelRegistry = modelRegistry;
    this.switchingCostCalculator = switchingCostCalculator || new SwitchingCostCalculator();
    this.stickinessManager = stickinessManager || new ModelStickinessManager();
    this.eventBus = eventBus;
    this.decisionEngine = new DecisionEngine();
    this.config = {
      qualityWeight: options.qualityWeight || 0.4,
      costWeight: options.costWeight || 0.2,
      latencyWeight: options.latencyWeight || 0.15,
      reliabilityWeight: options.reliabilityWeight || 0.15,
      contextFitWeight: options.contextFitWeight || 0.1,
      ...options
    };
    // Optional Session 2 learning store (IntelligenceStore). Attached by
    // server wiring; absent in unit tests (routing then uses priors only).
    this.intelligence = options.intelligence || null;
  }

  attachIntelligence(store) {
    this.intelligence = store || null;
    return this;
  }

  weightsFor(runtimeState) {
    const w = (runtimeState && runtimeState.policy && runtimeState.policy.routerWeights) || null;
    if (!w) return this.config;
    const num = (v, fb) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fb);
    return {
      qualityWeight: num(w.qualityWeight, this.config.qualityWeight),
      costWeight: num(w.costWeight, this.config.costWeight),
      latencyWeight: num(w.latencyWeight, this.config.latencyWeight),
      reliabilityWeight: num(w.reliabilityWeight, this.config.reliabilityWeight),
      contextFitWeight: num(w.contextFitWeight, this.config.contextFitWeight),
    };
  }

  // Canonical eligibility pipeline (single pass, no re-entry):
  //   availability -> provider mapping -> pricing validity
  //   -> capability/context constraints -> quality/latency/reliability
  //   -> budget -> scoring -> selection.
  // Once a model is excluded at any stage it never re-enters a later stage:
  // every subsequent filter operates on the surviving pool only.
  runEligibility(list, runtimeState, runPolicy) {
    const log = [];
    const stage = (name, pool, excluded) => {
      log.push({ stage: name, survivors: pool.map((m) => m.id), excluded: excluded.map((m) => ({ id: m.id, reason: m._excl || name })) });
      return pool;
    };
    let pool = list.slice();
    // 1. availability: registry-marked unavailable models can never succeed.
    {
      const survivors = [];
      const excluded = [];
      for (const m of pool) {
        if (m.status === 'unavailable') { m._excl = 'marked unavailable'; excluded.push(m); }
        else survivors.push(m);
      }
      pool = stage('availability', survivors, excluded);
    }
    if (pool.length === 0) {
      const err = Object.assign(
        new Error(`No available models: all ${list.length} candidate(s) are marked unavailable`),
        { code: 'no_models' },
      );
      err.eligibility = log;
      throw err;
    }
    // 2. provider mapping: a routable model needs a known provider route.
    //Honest default: unknown provider stays eligible (flagged) unless the
    // policy explicitly requires a known provider.
    {
      const survivors = [];
      const excluded = [];
      const requireProvider = runPolicy.requireKnownProvider === true;
      for (const m of pool) {
        if ((!m.provider || String(m.provider).trim() === '') && requireProvider) {
          m._excl = 'unknown provider (policy requires known provider)'; excluded.push(m);
        } else survivors.push(m);
      }
      pool = stage('provider', survivors, excluded);
    }
    // 3. pricing validity: unknown commercial pricing is not optimizer input.
    const cachedForRouting = Math.max(0, Number(runtimeState.context.cacheablePrefixTokens) || 0);
    const hasOptimizerPricing = (model) => {
      const knownRate = (value) => value !== null && value !== undefined && value !== ''
        && Number.isFinite(Number(value)) && Number(value) >= 0;
      return knownRate(model.inputPer1k) && knownRate(model.outputPer1k)
        && (cachedForRouting <= 0 || knownRate(model.cachedPer1k));
    };
    const allowUnknownPricing = runPolicy.allowUnknownPricing === true;
    {
      const survivors = [];
      const excluded = [];
      for (const m of pool) {
        if (!allowUnknownPricing && !hasOptimizerPricing(m)) { m._excl = 'incomplete pricing'; excluded.push(m); }
        else survivors.push(m);
      }
      pool = stage('pricing', survivors, excluded);
    }
    if (pool.length === 0) {
      const err = Object.assign(new Error('No available models have complete pricing for optimization'), {
        code: 'insufficient_pricing',
      });
      err.eligibility = log;
      throw err;
    }
    // 4. capability/context constraints.
    const needTokens = runtimeState.context.currentTokens || 0;
    {
      const survivors = [];
      const excluded = [];
      const requiredCaps = Array.isArray(runPolicy.requiredCapabilities) ? runPolicy.requiredCapabilities : [];
      for (const m of pool) {
        const window = m.contextWindow || 0;
        if (window > 0 && needTokens > 0 && needTokens > window) {
          m._excl = `context window too small (need ~${needTokens}, window ${window})`; excluded.push(m); continue;
        }
        const missing = requiredCaps.filter((c) => !(Array.isArray(m.capabilities) && m.capabilities.includes(c)));
        if (missing.length) { m._excl = `missing capabilities: ${missing.join(', ')}`; excluded.push(m); continue; }
        survivors.push(m);
      }
      // Context overflow never strands the run when NOTHING fits: fall back to
      // the pre-context pool so the orchestrator's larger-context failover can
      // still report honestly (historical behavior preserved).
      const contextExcludedAll = survivors.length === 0 && excluded.length > 0
        && excluded.every((m) => String(m._excl || '').startsWith('context window'));
      if (contextExcludedAll) {
        pool = stage('capability_context', pool, []);
      } else {
        pool = stage('capability_context', survivors, excluded);
      }
    }
    // 5. quality/latency/reliability constraints — eligibility gates on the
    // surviving pool only (never reconstructed from a broader pool).
    const qualityFloor = Number(runPolicy.qualityFloor);
    if (Number.isFinite(qualityFloor) && qualityFloor > 0) {
      const survivors = [];
      const excluded = [];
      for (const m of pool) {
        if (Number.isFinite(Number(m.quality)) && Number(m.quality) >= qualityFloor) survivors.push(m);
        else { m._excl = `quality ${m.quality} below floor ${qualityFloor}`; excluded.push(m); }
      }
      if (!survivors.length) {
        const err = Object.assign(new Error(`No available models satisfy quality floor ${qualityFloor}`), { code: 'quality_constraint' });
        err.eligibility = log;
        throw err;
      }
      pool = stage('quality', survivors, excluded);
    } else {
      pool = stage('quality', pool, []);
    }
    const latencyTargetMs = Number(runPolicy.latencyTargetMs);
    if (Number.isFinite(latencyTargetMs) && latencyTargetMs > 0) {
      const survivors = [];
      const excluded = [];
      for (const m of pool) {
        if (Number.isFinite(Number(m.avgLatencyMs)) && Number(m.avgLatencyMs) <= latencyTargetMs) survivors.push(m);
        else { m._excl = `latency ${m.avgLatencyMs}ms above target ${latencyTargetMs}ms`; excluded.push(m); }
      }
      if (!survivors.length) {
        const err = Object.assign(new Error(`No available models satisfy latency target ${latencyTargetMs}ms`), { code: 'latency_constraint' });
        err.eligibility = log;
        throw err;
      }
      pool = stage('latency', survivors, excluded);
    } else {
      pool = stage('latency', pool, []);
    }
    const minRel = Number(runPolicy.minReliability);
    if (Number.isFinite(minRel) && minRel > 0) {
      const preferredId = typeof runPolicy.preferredModel === 'string' ? runPolicy.preferredModel : null;
      const survivors = [];
      const excluded = [];
      for (const m of pool) {
        if (Number(m.reliability) >= minRel || m.id === preferredId) survivors.push(m);
        else { m._excl = `reliability ${m.reliability} below floor ${minRel}`; excluded.push(m); }
      }
      if (survivors.length) pool = stage('reliability', survivors, excluded);
      else pool = stage('reliability', pool, []);
    } else {
      pool = stage('reliability', pool, []);
    }
    // 6. budget: hard budget excludes; soft budget stays eligible with a
    // penalty applied at scoring/objective time.
    {
      const remaining = runtimeState.budget && typeof runtimeState.budget.getRemainingBudget === 'function'
        ? runtimeState.budget.getRemainingBudget() : null;
      const hasRemaining = remaining !== null && remaining !== undefined && remaining !== '' && Number.isFinite(Number(remaining));
      const rem = hasRemaining ? Number(remaining) : null;
      const hard = runPolicy.hardBudget === true || runPolicy.budgetEnforcement === 'hard' || (rem !== null && rem <= 0.01);
      const survivors = [];
      const excluded = [];
      const inputTokens = Math.max(0, Number(runtimeState.context.currentTokens) || 0);
      const cachedTokens = Math.max(0, Math.min(inputTokens, Number(runtimeState.context.cacheablePrefixTokens) || 0));
      for (const m of pool) {
        const est = routingObjective.estimateProviderCostUsd(m, { inputTokens, outputTokens: 1000, cachedTokens });
        if (rem !== null && est !== null && est > rem && hard) {
          m._excl = `expected $${est} exceeds remaining $${rem}`; excluded.push(m); continue;
        }
        survivors.push(m);
      }
      if (!survivors.length && pool.length) {
        const err = Object.assign(new Error('No available models fit the remaining budget'), { code: 'budget_constraint' });
        err.eligibility = log;
        throw err;
      }
      pool = stage('budget', survivors.length ? survivors : pool, excluded);
    }
    for (const m of pool) delete m._excl;
    return { pool, log };
  }

  // Real expected total cost for one model definition (pinned/retained paths
  // must never report $0). Null only when pricing itself is unknown.
  realExpectedCostFor(model, runtimeState, extraSwitchUsd = 0) {
    try {
      const inputTokens = Math.max(0, Number(runtimeState.context.currentTokens) || 0);
      const cachedTokens = Math.max(0, Math.min(inputTokens, Number(runtimeState.context.cacheablePrefixTokens) || 0));
      const provider = routingObjective.estimateProviderCostUsd(model, { inputTokens, outputTokens: 1000, cachedTokens });
      if (provider === null) return null;
      const maxRetries = Math.max(0, Math.min(5, Number(runtimeState.policy?.maxRetries ?? this.config.maxRetries ?? 2)));
      const retry = routingObjective.estimateRetryCostUsd(provider, model.reliability, maxRetries) ?? 0;
      const tool = routingObjective.estimateToolContinuationCostUsd((runtimeState && runtimeState.policy) || {}).cost;
      const total = provider + retry + Math.max(0, Number(extraSwitchUsd) || 0) + tool;
      return Number.isFinite(total) ? Math.round(Math.max(0, total) * 1e6) / 1e6 : null;
    } catch {
      return null;
    }
  }

  async route(task, runtimeState, candidates, policy) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (list.length === 0) {
      throw Object.assign(new Error('No available models: registry is empty or all models are blocked/unavailable'), { code: 'no_models' });
    }
    const runPolicy = (runtimeState && runtimeState.policy) || {};
    // Explicit user constraint: preferred model wins when available and
    // compatible (still honesty-checked for health below). It is resolved
    // after pricing eligibility so an unpriced preference cannot bypass the
    // production optimizer's unknown-pricing guard.
    const preferredId = typeof runPolicy.preferredModel === 'string' && runPolicy.preferredModel
      ? runPolicy.preferredModel : null;
    let preferred = null;
    const { pool: scoredPool, log: eligibilityLog } = this.runEligibility(list, runtimeState, runPolicy);
    const excludedByStage = {};
    for (const s of eligibilityLog) excludedByStage[s.stage] = (s.excluded || []).length;
    preferred = preferredId
      ? scoredPool.find((m) => m.id === preferredId && m.status !== 'unavailable') || null
      : null;
    const preferredExcluded = preferredId && !preferred
      ? (eligibilityLog.flatMap((s) => s.excluded || []).find((e) => e.id === preferredId) || null)
      : null;

    const evaluation = await this.evaluateCandidates(task, runtimeState, scoredPool);
    evaluation.excludedCandidates = {
      availability: excludedByStage.availability || 0,
      provider: excludedByStage.provider || 0,
      unpriced: (excludedByStage.pricing || 0),
      context: (eligibilityLog.find((s) => s.stage === 'capability_context') || { excluded: [] }).excluded.length,
      quality: excludedByStage.quality || 0,
      latency: excludedByStage.latency || 0,
      reliability: excludedByStage.reliability || 0,
      budget: excludedByStage.budget || 0,
    };
    evaluation.eligibility = eligibilityLog;
    if (!evaluation.candidates.length) {
      throw Object.assign(new Error('No routable models after scoring'), { code: 'no_models' });
    }
    // Objective layer (separate from scoring): expected total task cost per
    // candidate. Selection minimizes the objective; the weighted score stays
    // as the explainable ranking signal and tie-break.
    try {
      const switchCosts = {};
      for (const c of evaluation.candidates) {
        if (c.modelId === runtimeState.model.currentModel) { switchCosts[c.modelId] = 0; continue; }
        try {
          const sc = this.switchingCostCalculator.calculate(
            runtimeState.context, runtimeState.model,
            runtimeState.model.currentModel, c.modelId,
            { toProvider: c.provider, toModelLatency: c.avgLatencyMs },
          );
          switchCosts[c.modelId] = Number.isFinite(sc.total) ? Math.max(0, sc.total) : 0;
        } catch { switchCosts[c.modelId] = 0; }
      }
      evaluation.candidates = routingObjective.attachObjectives(evaluation.candidates, {
        switchCosts, policy: runPolicy,
      });
      evaluation.objective = {
        formula: routingObjective.OBJECTIVE_FORMULA,
        unit: 'USD per expected success (lower wins)',
      };
    } catch { /* objective is advisory; score ordering preserved */ }

    const currentModel = runtimeState.model.currentModel;
    const eligibilityFactors = () => {
      const out = [];
      for (const s of eligibilityLog) {
        for (const e of (s.excluded || [])) {
          out.push({ key: `eligibility:${s.stage}`, label: `Excluded at ${s.stage}: ${e.id}`, status: 'warn', detail: e.reason || s.stage });
        }
      }
      return out.slice(0, 12);
    };
    const objectiveFactors = (c) => {
      if (!c || !c.objective) return [];
      const o = c.objective;
      const fmtUsd = (v) => (v === null || v === undefined ? 'unknown' : `$${Number(v).toFixed(6)}`);
      return [
        { key: 'objective', label: 'Expected total task cost', status: o.expectedTotalCostUsd === null ? 'warn' : 'pass', detail: fmtUsd(o.expectedTotalCostUsd) },
        { key: 'objective_success', label: 'Predicted success for objective', status: 'pass', detail: `${o.successUsed === null ? 'unknown' : `${(o.successUsed * 100).toFixed(0)}%`} (${o.successBasis})` },
        ...(o.costPerSuccessUsd !== null ? [{ key: 'objective_per_success', label: 'Expected cost per success', status: 'pass', detail: fmtUsd(o.costPerSuccessUsd) }] : []),
      ];
    };
    // Preferred-model override: explicit user choice bypasses optimization,
    // but it must still report the REAL expected cost (never $0).
    if (preferred && (!currentModel || preferred.id !== currentModel)) {
      const pinned = evaluation.candidates.find((c) => c.modelId === preferred.id) || { modelId: preferred.id };
      const pinnedCost = this.realExpectedCostFor(preferred, runtimeState, 0);
      const decision = this.decisionEngine.createDecision(
        DecisionType.MODEL_SELECTION,
        `SELECT ${preferred.id}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: pinned,
          score: pinned.score || 0,
          factors: [
            { key: 'user_preference', label: 'Preferred model chosen by user', status: 'pass', detail: preferred.id },
            { key: 'optimization', label: 'Cost optimization bypassed by user preference', status: 'warn', detail: 'selectionReason=user_preference' },
            { key: 'expected_cost', label: 'Real expected cost (bypass still priced)', status: pinnedCost === null ? 'warn' : 'pass', detail: pinnedCost === null ? 'pricing unknown' : `$${pinnedCost.toFixed(6)}` },
          ],
          reason: 'User pinned a preferred model for this run',
          expectedCost: pinnedCost,
          expectedLatency: preferred.avgLatencyMs,
          expectedQuality: preferred.quality,
          switchingCost: 0,
          confidence: 1,
        }
      );
      decision.selectionReason = 'user_preference';
      decision.optimizationBypassed = true;
      if (pinned.objective) {
        for (const f of objectiveFactors(pinned)) decision.factors.push(f);
      }
      return this._finalizeRouting(task, runtimeState, evaluation, preferred.id, decision);
    }
    // Objective winner (lowest expected cost per success); falls back to the
    // score leader when objectives are unknown/tied.
    const scoreLeader = evaluation.candidates[0];
    const objectiveWinner = routingObjective.selectByObjective(evaluation.candidates) || scoreLeader;
    const preferredHold = !!(preferred && currentModel === preferred.id);
    // Challenger selection (deterministic):
    // - preferred hold -> the pinned model;
    // - objective winner differs from incumbent -> it challenges (switch path);
    // - incumbent wins on cost but the score leader differs -> the score
    //   leader is recorded as the challenger and retention is decided on
    //   expected-cost grounds (no hysteresis needed when nothing cheaper
    //   proposes a switch).
    let bestCandidate;
    let costRetention = false;
    if (preferredHold) {
      bestCandidate = evaluation.candidates.find((c) => c.modelId === preferred.id) || evaluation.candidates[0];
    } else if (currentModel && objectiveWinner && objectiveWinner.modelId !== currentModel) {
      bestCandidate = objectiveWinner;
    } else if (currentModel && scoreLeader && scoreLeader.modelId !== currentModel
        && objectiveWinner && objectiveWinner.modelId === currentModel) {
      bestCandidate = scoreLeader;
      costRetention = true;
    } else {
      bestCandidate = objectiveWinner || evaluation.candidates[0];
    }

    const incumbentDefSafe = () => scoredPool.find((m) => m.id === currentModel)
      || list.find((m) => m.id === currentModel) || { id: currentModel };

    // Cost-based retention: the challenger leads on score, but the incumbent
    // wins on expected total task cost — no switch is proposed, so hysteresis
    // never engages. Recorded as retention with both sides of the comparison.
    if (costRetention) {
      const toChallenger = this.switchingCostCalculator.calculate(
        runtimeState.context, runtimeState.model, currentModel, bestCandidate.modelId,
        { toProvider: bestCandidate.provider, toModelLatency: bestCandidate.avgLatencyMs },
      );
      const incumbentCand = evaluation.candidates.find((c) => c.modelId === currentModel) || null;
      const incObj = incumbentCand && incumbentCand.objective ? incumbentCand.objective.objectiveValue : null;
      const chalObj = bestCandidate.objective ? bestCandidate.objective.objectiveValue : null;
      const decision = this.decisionEngine.createDecision(
        DecisionType.MODEL_RETENTION,
        `KEEP ${currentModel}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: incumbentCand || { modelId: currentModel },
          score: evaluation.currentScore,
          factors: [
            { key: 'score_challenger', label: `${bestCandidate.modelId} leads on score`, status: 'warn', detail: `${bestCandidate.score.toFixed(2)} vs ${Number(evaluation.currentScore).toFixed(2)}` },
            { key: 'objective', label: 'Incumbent wins on expected total cost', status: 'pass', detail: `objective ${incObj === null ? 'unknown' : `$${incObj}`} vs challenger ${chalObj === null ? 'unknown' : `$${chalObj}`}` },
            { key: 'switch_cost', label: 'Switching cost avoided', status: 'pass', detail: `$${toChallenger.total.toFixed(4)}` },
            ...(incumbentCand && incumbentCand.objective ? objectiveFactors(incumbentCand) : []),
          ],
          reason: `Incumbent ${currentModel} has the lowest expected total task cost; score-leading challenger ${bestCandidate.modelId} is more expensive per expected success`,
          expectedCost: incumbentCand && incumbentCand.objective && incumbentCand.objective.expectedTotalCostUsd !== null
            ? incumbentCand.objective.expectedTotalCostUsd : this.realExpectedCostFor(incumbentDefSafe(), runtimeState, 0),
          expectedLatency: runtimeState.model.modelLatency,
          expectedQuality: evaluation.currentScore,
          switchingCost: toChallenger.total,
          confidence: 0.85,
        }
      );
      decision.selectionReason = 'optimized';
      decision.optimizationBypassed = false;
      return this._finalizeRouting(task, runtimeState, evaluation, currentModel, decision);
    }

    // No incumbent, or incumbent already best: direct selection.

    // No incumbent, or incumbent already best: direct selection.
    if (!currentModel || bestCandidate.modelId === currentModel) {
      const winnerCost = bestCandidate.objective && bestCandidate.objective.expectedTotalCostUsd !== null
        ? bestCandidate.objective.expectedTotalCostUsd : bestCandidate.estimatedCost;
      const decision = this.decisionEngine.createDecision(
        DecisionType.MODEL_SELECTION,
        `SELECT ${bestCandidate.modelId}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: bestCandidate,
          score: bestCandidate.score,
          factors: [
            { key: 'quality', label: 'Quality score', status: 'pass', detail: bestCandidate.score.toFixed(2) },
            { key: 'cost', label: 'Cost efficiency', status: 'pass', detail: `$${bestCandidate.estimatedCost?.toFixed(4) || 'N/A'}` },
            { key: 'latency', label: 'Latency', status: 'pass', detail: `${bestCandidate.avgLatencyMs}ms` },
            { key: 'objective', label: 'Why this candidate won', status: 'pass', detail: bestCandidate.objective ? `lowest objective (${bestCandidate.objective.objectiveValue === null ? 'unknown cost' : `$${bestCandidate.objective.objectiveValue}`})` : 'highest score' },
            ...(preferredExcluded ? [{ key: 'pinned_ineligible', label: `Pinned model ${preferredId} ineligible`, status: 'fail', detail: preferredExcluded.reason || 'excluded' }] : []),
            ...eligibilityFactors().slice(0, 4),
            ...objectiveFactors(bestCandidate),
          ],
          reason: bestCandidate.objective && bestCandidate.objective.objectiveValue !== null
            ? `Lowest expected cost per success ($${bestCandidate.objective.objectiveValue} via ${bestCandidate.objective.successBasis})`
            : 'Best overall score for task requirements',
          expectedCost: winnerCost,
          expectedLatency: bestCandidate.avgLatencyMs,
          expectedQuality: bestCandidate.score,
          switchingCost: 0,
          confidence: 0.85
        }
      );
      decision.selectionReason = 'optimized';
      decision.optimizationBypassed = false;
      return this._finalizeRouting(task, runtimeState, evaluation, bestCandidate.modelId, decision);
    }

    // Incumbent exists and a challenger leads. A degraded/unavailable (or
    // unscored) incumbent is never sticky: switch without hysteresis.
    const incumbentDef = scoredPool.find((m) => m.id === currentModel)
      || list.find((m) => m.id === currentModel) || null;
    const incumbentUnhealthy = !incumbentDef || (incumbentDef.status && incumbentDef.status !== 'healthy');
    // User pinned switching off: keep a healthy incumbent, always.
    if (runPolicy.allowSwitching === false && !incumbentUnhealthy) {
      const incumbentCand = evaluation.candidates.find((c) => c.modelId === currentModel) || null;
      const keepCost = incumbentCand && incumbentCand.objective && incumbentCand.objective.expectedTotalCostUsd !== null
        ? incumbentCand.objective.expectedTotalCostUsd
        : this.realExpectedCostFor(incumbentDef || { id: currentModel }, runtimeState, 0);
      const keep = this.decisionEngine.createDecision(
        DecisionType.MODEL_RETENTION,
        `KEEP ${currentModel}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: incumbentCand || { modelId: currentModel },
          score: evaluation.currentScore,
          factors: [
            { key: 'user_preference', label: 'Model switching disabled for this run', status: 'pass', detail: 'user setting' },
            { key: 'expected_cost', label: 'Real expected cost of retained model', status: keepCost === null ? 'warn' : 'pass', detail: keepCost === null ? 'pricing unknown' : `$${Number(keepCost).toFixed(6)}` },
          ],
          reason: 'Model switching disabled by user — incumbent retained',
          expectedCost: keepCost,
          expectedLatency: runtimeState.model.modelLatency,
          expectedQuality: evaluation.currentScore,
          switchingCost: 0,
          confidence: 1,
        }
      );
      keep.selectionReason = 'user_preference';
      keep.optimizationBypassed = true;
      return this._finalizeRouting(task, runtimeState, evaluation, currentModel, keep);
    }
    const switchingCost = this.switchingCostCalculator.calculate(
      runtimeState.context,
      runtimeState.model,
      currentModel,
      bestCandidate.modelId,
      { toProvider: bestCandidate.provider, toModelLatency: bestCandidate.avgLatencyMs }
    );

    let decision;
    let selectedModel;
    let allowed;
    let switchReason;
    let netBenefit = 0;

    if (incumbentUnhealthy) {
      allowed = true;
      switchReason = `Incumbent ${currentModel} is ${incumbentDef ? incumbentDef.status : 'not a scored candidate'}; failing over without hysteresis`;
    } else {
      netBenefit = this.switchingCostCalculator.calculateNetBenefit(
        bestCandidate.score - evaluation.currentScore,
        (runtimeState.model.getPricing(currentModel)?.outputPer1k || 0) - (bestCandidate.outputPer1k || 0),
        (runtimeState.model.modelLatency || 0) - bestCandidate.avgLatencyMs,
        switchingCost.total
      );

      // Same-unit comparison: the dollar switching cost is converted to
      // router-score units with the same scale calculateNetBenefit uses
      // (0.2 x total/0.01), so hysteresis compares scores to scores.
      const switchScoreUnits = 0.2 * (switchingCost.total / 0.01);
      const switchEval = this.stickinessManager.canSwitch(
        runtimeState.runId,
        currentModel,
        bestCandidate.modelId,
        netBenefit,
        switchScoreUnits
      );
      allowed = switchEval.allowed;
      switchReason = switchEval.reason;
      if (!allowed) {
        const incumbentCand = evaluation.candidates.find((c) => c.modelId === currentModel) || null;
        const retainCost = incumbentCand && incumbentCand.objective && incumbentCand.objective.expectedTotalCostUsd !== null
          ? incumbentCand.objective.expectedTotalCostUsd
          : (incumbentDef ? this.realExpectedCostFor(incumbentDef, runtimeState, 0) : null);
        decision = this.decisionEngine.createDecision(
          DecisionType.MODEL_RETENTION,
          `KEEP ${currentModel}`,
          `run:${runtimeState.runId}`,
          {
            candidates: evaluation.candidates,
            selectedCandidate: incumbentCand || { modelId: currentModel },
            score: evaluation.currentScore,
            factors: [
              { key: 'stickiness', label: 'Model stickiness', status: 'pass', detail: switchEval.reason },
              { key: 'switch_cost', label: 'Switching cost too high', status: 'warn', detail: `$${switchingCost.total.toFixed(4)}` },
              { key: 'net_benefit', label: 'Net benefit insufficient', status: 'fail', detail: `${netBenefit.toFixed(4)} < ${switchEval.requiredBenefit?.toFixed(4) || 'N/A'}` },
              { key: 'expected_cost', label: 'Real expected cost of retained model', status: retainCost === null ? 'warn' : 'pass', detail: retainCost === null ? 'pricing unknown' : `$${Number(retainCost).toFixed(6)}` },
              ...(bestCandidate.objective ? objectiveFactors(bestCandidate) : []),
            ],
            reason: switchEval.reason,
            expectedCost: retainCost,
            expectedLatency: runtimeState.model.modelLatency,
            expectedQuality: evaluation.currentScore,
            switchingCost: switchingCost.total,
            confidence: 0.9
          }
        );
        decision.selectionReason = 'stickiness';
        decision.optimizationBypassed = false;
        selectedModel = currentModel;
        return this._finalizeRouting(task, runtimeState, evaluation, selectedModel, decision);
      }
    }

    decision = this.decisionEngine.createDecision(
      DecisionType.MODEL_SWITCH,
      `SWITCH TO ${bestCandidate.modelId}`,
      `run:${runtimeState.runId}`,
      {
        candidates: evaluation.candidates,
        selectedCandidate: bestCandidate,
        score: bestCandidate.score,
        factors: [
          { key: 'quality_gain', label: 'Quality improvement', status: 'pass', detail: `+${(bestCandidate.score - evaluation.currentScore).toFixed(2)}` },
          { key: 'switch_cost', label: 'Switching cost', status: 'warn', detail: `$${switchingCost.total.toFixed(4)}` },
          ...(incumbentUnhealthy
            ? [{ key: 'incumbent', label: switchReason, status: 'fail', detail: currentModel }]
            : [{ key: 'net_benefit', label: 'Net benefit after switching cost', status: 'pass', detail: `${netBenefit.toFixed(4)}` }]),
          { key: 'expected_cost', label: 'Expected total cost after switch', status: (bestCandidate.objective && bestCandidate.objective.expectedTotalCostUsd !== null) ? 'pass' : 'warn', detail: (bestCandidate.objective && bestCandidate.objective.expectedTotalCostUsd !== null) ? `$${bestCandidate.objective.expectedTotalCostUsd}` : 'pricing unknown' },
          ...(bestCandidate.objective ? objectiveFactors(bestCandidate) : []),
        ],
        reason: incumbentUnhealthy ? switchReason : `Net benefit ${netBenefit.toFixed(4)} exceeds threshold`,
        expectedCost: (bestCandidate.objective && bestCandidate.objective.expectedTotalCostUsd !== null)
          ? bestCandidate.objective.expectedTotalCostUsd : switchingCost.total,
        expectedLatency: bestCandidate.avgLatencyMs,
        expectedQuality: bestCandidate.score,
        switchingCost: switchingCost.total,
        confidence: 0.8
      }
    );
    decision.selectionReason = decision.selectionReason || 'optimized';
    decision.optimizationBypassed = false;
    selectedModel = bestCandidate.modelId;
    return this._finalizeRouting(task, runtimeState, evaluation, selectedModel, decision);
  }

  // Enrichment applied to every routing outcome (additive): explanation,
  // counterfactuals, reproducibility metadata, routing-history record.
  // Never throws; never changes the selected model.
  _finalizeRouting(task, runtimeState, evaluation, selectedModel, decision) {
    try {
      const ranked = evaluation.candidates || [];
      const selected = ranked.find((c) => c.modelId === selectedModel) || { modelId: selectedModel, reasons: [] };
      const cf = routerIntel.counterfactuals(selected, ranked, { limit: 2 });
      const expl = routerIntel.explainSelection(selected, ranked);
      evaluation.counterfactuals = cf;
      evaluation.explanation = expl.summary;
      evaluation.tradeoff = expl.tradeoff || null;
      decision.metadata = {
        ...(decision.metadata || {}),
        inputsHash: evaluation.inputsHash || null,
        policyVersion: evaluation.policyVersion || VERSIONS.routingPolicy,
        taskProfile: evaluation.taskProfile || null,
        counterfactuals: cf,
        explanation: expl.summary,
        objectiveFormula: (evaluation.objective && evaluation.objective.formula) || routingObjective.OBJECTIVE_FORMULA,
        selectionReason: decision.selectionReason || null,
        optimizationBypassed: decision.optimizationBypassed === true,
        eligibility: (evaluation.eligibility || []).map((s) => ({ stage: s.stage, survivors: s.survivors, excluded: s.excluded })),
      };
      if (!Array.isArray(decision.factors)) decision.factors = [];
      for (const r of (selected.reasons || []).slice(0, 8)) {
        decision.factors.push({
          key: `intel:${r.factor}`,
          label: String(r.humanExplanation || r.factor).slice(0, 200),
          status: r.direction === 'against' ? 'fail' : r.direction === 'for' ? 'pass' : 'warn',
          detail: `contribution ${r.contribution}`,
        });
      }
      if (this.intelligence && this.intelligence.routingHistory) {
        this.intelligence.routingHistory.record({
          runId: runtimeState.runId,
          taskCategory: (evaluation.taskProfile && evaluation.taskProfile.category) || selected.taskCategory || 'general',
          selectedModel,
          candidates: ranked.map((c) => ({
            modelId: c.modelId, score: c.score,
            predictedSuccess: c.predictedSuccess ?? null,
            expectedCostUsd: c.expectedCostUsd ?? c.estimatedCost ?? null,
          })),
          reasons: (selected.reasons || []).slice(0, 8),
          policyVersion: evaluation.policyVersion || VERSIONS.routingPolicy,
          inputsHash: evaluation.inputsHash || null,
          predictedSuccess: selected.predictedSuccess ?? null,
          expectedCostUsd: selected.expectedCostUsd ?? selected.estimatedCost ?? null,
        });
      }
    } catch { /* enrichment never breaks routing */ }
    return { selectedModel, decision, evaluation };
  }

  async evaluateCandidates(task, runtimeState, candidateModels) {    const currentModel = runtimeState.model.currentModel;
    let currentScore = 0;
    
    const candidates = [];
    
    for (const model of candidateModels) {
      const score = await this.scoreModel(model, task, runtimeState);
      const estimatedCost = this.estimateModelCost(model, runtimeState);
      const reliability = Number(model.reliability);
      const maxRetries = Math.max(0, Math.min(5, Number(runtimeState.policy?.maxRetries ?? this.config.maxRetries ?? 2)));
      const retryMultiplier = Number.isFinite(reliability) && reliability >= 0 && reliability <= 1
        ? Array.from({ length: maxRetries + 1 }, (_, attempt) => Math.pow(1 - reliability, attempt)).reduce((sum, probability) => sum + probability, 0)
        : null;
      const retryCostUsd = estimatedCost !== null && retryMultiplier !== null
        ? Math.max(0, estimatedCost * (retryMultiplier - 1)) : null;
      const switchingCostUsd = Number.isFinite(Number(score.switchCost)) ? Math.max(0, Number(score.switchCost)) : null;
      const expectedTotalCostUsd = estimatedCost === null || retryCostUsd === null || switchingCostUsd === null
        ? null : estimatedCost + retryCostUsd + switchingCostUsd;
      const finite = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
      const nullable = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

      candidates.push({
        modelId: model.id,
        name: model.name,
        provider: model.provider,
        score: finite(score.total),
        quality: finite(score.quality, 0.5),
        cost: finite(score.cost, 0.5),
        latency: finite(score.latency, 0.5),
        reliability: finite(score.reliability, 0.5),
        contextFit: finite(score.contextFit, 0),
        switchCost: finite(score.switchCost),
        avgLatencyMs: model.avgLatencyMs ?? null,
        outputPer1k: model.outputPer1k ?? null,
        estimatedCost: nullable(estimatedCost),
        // Intelligence overlay (nullable; null renders as "unknown"):
        predictedSuccess: nullable(score.predictedSuccess),
        taskFitScore: nullable(score.taskFitScore),
        toolCapabilityScore: nullable(score.toolCapabilityScore),
        // Expected total execution cost, not just nominal one-call price:
        // provider estimate + expected bounded retry cost + measurable
        // switching/context-resend cost. Null means the optimizer lacks a
        // reliable commercial estimate; it is never coerced to zero.
        expectedCostUsd: nullable(expectedTotalCostUsd),
        expectedCostBreakdown: {
          provider: nullable(estimatedCost), retry: nullable(retryCostUsd), switching: nullable(switchingCostUsd),
        },
        expectedLatencyMs: nullable(score.expectedLatencyMs !== null && score.expectedLatencyMs !== undefined ? score.expectedLatencyMs : model.avgLatencyMs),
        taskCategory: score.taskCategory || 'general',
        predictionConfidence: score.predictionConfidence || 'none',
        predictionSamples: Number.isFinite(Number(score.predictionSamples)) ? Number(score.predictionSamples) : 0,
        reasons: Array.isArray(score.reasons) ? score.reasons : [],
        ...(score.excluded ? { excluded: score.excluded, exclusionReason: score.exclusionReason || null } : {}),
      });
      
      if (model.id === currentModel) {
        currentScore = score.total;
      }
    }
    
    // Deterministic ordering: score desc, then modelId asc (reproducible §39).
    candidates.sort((a, b) => b.score - a.score || String(a.modelId).localeCompare(String(b.modelId)));

    // Reproducibility inputs (§39): same task/context/models/policy/data/
    // budget must reproduce the decision. Secrets never included.
    let taskProfile = null;
    let inputsHash = null;
    try {
      const taskText = (task && (task.objective || task.text)) || '';
      taskProfile = classifyTask(taskText || 'general task');
      const perf = this.intelligence && this.intelligence.performance ? this.intelligence.performance : null;
      inputsHash = routerIntel.hashRoutingInputs({
        taskText,
        taskCategory: taskProfile.category,
        models: candidateModels,
        perfDigest: perf ? String((perf.records && perf.records.size) || 0) : '',
        remainingBudget: runtimeState.budget && typeof runtimeState.budget.getRemainingBudget === 'function'
          ? runtimeState.budget.getRemainingBudget() : null,
        policyVersion: VERSIONS.routingPolicy,
        needTokens: (runtimeState.context && runtimeState.context.currentTokens) || 0,
      });
    } catch { /* advisory */ }

    return { candidates, currentScore, taskProfile, inputsHash, policyVersion: VERSIONS.routingPolicy };
  }

  async scoreModel(model, task, runtimeState) {
    const weights = this.weightsFor(runtimeState);
    // Explicit fallback semantics: UNKNOWN (null/undefined/'') never poses
    // as a measured value. Unknown quality/reliability score neutral (0.5),
    // unknown price scores neutral (never "free"), unknown latency neutral.
    // Every component is finite and clamped to [0, 1]; the total to [0, 1].
    const known = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const clamp01 = (v, fallback) => {
      if (!known(v)) return fallback;
      return Math.max(0, Math.min(1, Number(v)));
    };
    const needTokens = runtimeState.context.currentTokens || 0;
    const window = model.contextWindow || 0;
    if (window > 0 && needTokens > 0 && needTokens > window) {
      // Context-incompatible: eliminated by route(); scored 0, never NaN.
      return { total: 0, quality: 0, cost: 0, latency: 0, reliability: 0, contextFit: 0, switchCost: 0, excluded: 'context_window' };
    }

    const contextUtilization = runtimeState.context.getUtilization();

    let switchCost = 0;
    let switchCostBreakdown = null;
    if (model.id !== runtimeState.model.currentModel) {
      try {
        const c = this.switchingCostCalculator.calculate(
          runtimeState.context,
          runtimeState.model,
          runtimeState.model.currentModel,
          model.id,
          { toProvider: model.provider, toModelLatency: model.avgLatencyMs }
        );
        switchCost = Number.isFinite(c.total) ? Math.max(0, c.total) : 0;
        switchCostBreakdown = c;
      } catch {
        switchCost = 0;
      }
    }

    const quality = clamp01(model.quality, 0.5);
    const cachedForScore = Number(runtimeState.context.cacheablePrefixTokens) || 0;
    const costKnown = known(model.inputPer1k) && known(model.outputPer1k)
      && (cachedForScore <= 0 || known(model.cachedPer1k));
    const costScore = costKnown && Number(model.outputPer1k) >= 0
      ? Math.max(0, 1 - (Number(model.outputPer1k) / 0.01)) : 0.5;
    const latencyScore = known(model.avgLatencyMs) && Number(model.avgLatencyMs) >= 0
      ? Math.max(0, 1 - (Number(model.avgLatencyMs) / 5000)) : 0.5;
    const reliability = clamp01(model.reliability, 0.5);
    const contextFit = Number.isFinite(contextUtilization) ? Math.max(0, 1 - contextUtilization) : 0.5;

    const raw = (
      quality * weights.qualityWeight +
      costScore * weights.costWeight +
      latencyScore * weights.latencyWeight +
      reliability * weights.reliabilityWeight +
      contextFit * weights.contextFitWeight
    ) * (1 - Math.min(0.3, switchCost * 10));

    const legacyTotal = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

    // ---- Session 2 overlay: task-specific empirical intelligence ----
    // Without observations every adjustment is exactly 0 (priors only), so
    // legacy ordering is preserved. With observations (n>=3) the task-fit
    // delta, tool capability and budget pressure move the total.
    const overlay = this._intelligenceOverlay(model, task, runtimeState, {
      quality, costScore, latencyScore, reliability, contextFit, switchCost,
    });
    const total = overlay.excluded
      ? 0
      : Math.max(0, Math.min(1, legacyTotal + overlay.adjustment));

    return {
      total,
      quality,
      cost: costScore,
      latency: latencyScore,
      reliability,
      contextFit,
      switchCost,
      switchCostBreakdown,
      // Intelligence overlay (nullable = unknown stays unknown):
      predictedSuccess: overlay.predictedSuccess,
      taskFitScore: overlay.taskFitScore,
      toolCapabilityScore: overlay.toolCapabilityScore,
      expectedCostUsd: overlay.expectedCostUsd,
      expectedLatencyMs: overlay.expectedLatencyMs,
      taskCategory: overlay.taskCategory,
      predictionConfidence: overlay.predictionConfidence,
      predictionSamples: overlay.predictionSamples,
      reasons: overlay.reasons,
      ...(overlay.excluded ? { excluded: overlay.excluded } : {}),
      ...(overlay.exclusionReason ? { exclusionReason: overlay.exclusionReason } : {}),
    };
  }

  // Pure adjustment computer. Never throws; returns zero-adjustment overlay
  // when intelligence is absent or evidence is thin.
  _intelligenceOverlay(model, task, runtimeState, legacy = {}) {
    const none = {
      adjustment: 0, predictedSuccess: null, taskFitScore: null,
      toolCapabilityScore: null, expectedCostUsd: null, expectedLatencyMs: null,
      taskCategory: 'general', predictionConfidence: 'none', predictionSamples: 0,
      reasons: [], excluded: null, exclusionReason: null,
    };
    try {
      const taskText = (task && (task.objective || task.text)) || '';
      const profile = classifyTask(taskText || 'general task');
      none.taskCategory = profile.category;
      const store = this.intelligence && this.intelligence.performance ? this.intelligence.performance : null;
      const needTokens = (runtimeState.context && runtimeState.context.currentTokens) || 0;
      const cachedTokens = (runtimeState.context && runtimeState.context.cacheablePrefixTokens) || 0;
      const remaining = runtimeState.budget && typeof runtimeState.budget.getRemainingBudget === 'function'
        ? runtimeState.budget.getRemainingBudget() : null;
      const scored = routerIntel.scoreCandidate(model, {
        taskProfile: profile,
        performanceStore: store,
        needTokens,
        cachedTokens,
        remainingBudget: remaining,
        policy: (runtimeState && runtimeState.policy) || {},
        weights: {
          quality: 0.4, cost: 0.2, latency: 0.15, reliability: 0.15, contextFit: 0.1,
        },
      });
      let adjustment = 0;
      // Task-specific empirical delta: only with real observations (n>=3).
      // Smoothed prediction minus prior, scaled so a 9/10 vs 2/10 history
      // swings ~±0.07 — enough to flip close races, never to dwarf priors.
      const meta = scored.predictedSuccessMeta || {};
      if (store && (meta.attempts || 0) >= 3 && scored.taskFitScore !== null) {
        adjustment += (scored.taskFitScore - 0.7) * 0.4;
      }
      // Real context fit: the legacy component is window-blind (identical for
      // all candidates), so per-model window pressure is applied here — but
      // ONLY under genuine pressure (need > 60% of window). Without pressure
      // every candidate fits and the adjustment is exactly 0, preserving
      // legacy ordering bit-for-bit.
      try {
        const window = Number(model.contextWindow) || 0;
        if (window > 0 && needTokens > window * 0.6) {
          const wf = routerIntel.contextFitScore(model, needTokens);
          if (wf.score !== null && !wf.excluded) {
            adjustment += (wf.score - 0.7) * 0.2;
          }
        }
      } catch { /* advisory */ }
      // Tool capability matters only when the task needs tools.
      if (profile.requiresTools && scored.toolCapabilityScore !== null) {
        adjustment += (scored.toolCapabilityScore - 0.5) * 0.1;
      }
      // Observed latency (p50, n>=3) replaces static scoring cautiously.
      const staticKnown = model.avgLatencyMs !== null && model.avgLatencyMs !== undefined && model.avgLatencyMs !== '' && Number.isFinite(Number(model.avgLatencyMs));
      if (store && scored.expectedLatencyMs !== null && !staticKnown) {
        adjustment += (0.5 - Math.min(1, scored.expectedLatencyMs / 8000)) * 0.05;
      }
      const reasons = Array.isArray(scored.reasons) ? scored.reasons : [];
      if (scored.excluded === 'budget') {
        return {
          adjustment: 0, predictedSuccess: scored.predictedSuccess,
          taskFitScore: scored.taskFitScore, toolCapabilityScore: scored.toolCapabilityScore,
          expectedCostUsd: scored.expectedCostUsd, expectedLatencyMs: scored.expectedLatencyMs,
          taskCategory: profile.category, predictionConfidence: meta.confidence || 'none',
          predictionSamples: meta.attempts || 0, reasons,
          excluded: 'budget', exclusionReason: scored.exclusionReason,
        };
      }
      return {
        adjustment: Math.max(-0.3, Math.min(0.3, Math.round(adjustment * 1000) / 1000)),
        predictedSuccess: scored.predictedSuccess,
        taskFitScore: scored.taskFitScore,
        toolCapabilityScore: scored.toolCapabilityScore,
        expectedCostUsd: scored.expectedCostUsd,
        expectedLatencyMs: scored.expectedLatencyMs,
        taskCategory: profile.category,
        predictionConfidence: meta.confidence || 'none',
        predictionSamples: meta.attempts || 0,
        reasons,
        excluded: null, exclusionReason: null,
      };
    } catch {
      return none;
    }
  }

  estimateModelCost(model, runtimeState) {
    const inputTokens = Math.max(0, Number(runtimeState.context.currentTokens) || 0);
    const cachedTokens = Math.max(0, Math.min(inputTokens, Number(runtimeState.context.cacheablePrefixTokens) || 0));
    const outputTokens = 1000;

    const rate = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
    const inputRate = rate(model.inputPer1k);
    const outputRate = rate(model.outputPer1k);
    const cachedRate = rate(model.cachedPer1k);
    // Unknown pricing is not a zero-cost candidate. It may remain routable
    // when capability/quality constraints leave no priced alternative, but
    // the optimizer must not rank it using invented commercial numbers.
    if (inputRate === null || outputRate === null || (cachedTokens > 0 && cachedRate === null)) return null;
    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const inputCost = (uncachedInput / 1000) * inputRate;
    const cachedCost = (cachedTokens / 1000) * (cachedRate ?? 0);
    const outputCost = (outputTokens / 1000) * outputRate;

    const total = inputCost + cachedCost + outputCost;
    return Number.isFinite(total) ? Math.max(0, total) : 0;
  }

  on(event, handler) {}
}

module.exports = {
  InMemoryModelRouter
};
