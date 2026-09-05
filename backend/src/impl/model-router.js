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
    // Context incompatibility eliminates a candidate: a model whose window
    // cannot hold the current context is never selected (the orchestrator's
    // pre-call guard + larger-context failover handle the overflow honestly).
    const needTokens = runtimeState.context.currentTokens || 0;
    const compatible = list.filter((m) => {
      const window = m.contextWindow || 0;
      return !(window > 0 && needTokens > 0 && needTokens > window);
    });
    const pool = compatible.length > 0 ? compatible : list;
    const eliminated = list.length - pool.length;
    // Availability eliminates a candidate whenever it is known: a model the
    // registry marks unavailable (explicit state, or a prior request-time
    // model_unavailable failure recorded by the orchestrator) is never
    // selected. Unlike context overflow this never falls back to the excluded
    // set — selecting a known-inaccessible model cannot succeed.
    const availablePool = pool.filter((m) => m.status !== 'unavailable');
    const excludedUnavailable = pool.length - availablePool.length;
    if (availablePool.length === 0) {
      throw Object.assign(new Error(`No available models: all ${pool.length} candidate(s) are marked unavailable`), { code: 'no_models' });
    }
    const cachedForRouting = Math.max(0, Number(runtimeState.context.cacheablePrefixTokens) || 0);
    const hasOptimizerPricing = (model) => {
      const knownRate = (value) => value !== null && value !== undefined && value !== ''
        && Number.isFinite(Number(value)) && Number(value) >= 0;
      return knownRate(model.inputPer1k) && knownRate(model.outputPer1k)
        && (cachedForRouting <= 0 || knownRate(model.cachedPer1k));
    };
    const unpriced = availablePool.filter((m) => !hasOptimizerPricing(m));
    const allowUnknownPricing = runPolicy.allowUnknownPricing === true;
    let scoredPool = allowUnknownPricing
      ? availablePool
      : availablePool.filter(hasOptimizerPricing);
    if (scoredPool.length === 0) {
      throw Object.assign(new Error('No available models have complete pricing for optimization'), {
        code: 'insufficient_pricing',
      });
    }
    preferred = preferredId
      ? scoredPool.find((m) => m.id === preferredId && m.status !== 'unavailable') || null
      : null;
    const excludedPricing = allowUnknownPricing ? 0 : unpriced.length;
    // Hard quality/latency constraints are eligibility gates, not score
    // nudges. Unknown evidence cannot prove a candidate safe for an explicit
    // floor/target, so it is rejected rather than silently treated as good.
    const qualityFloor = Number(runPolicy.qualityFloor);
    if (Number.isFinite(qualityFloor) && qualityFloor > 0) {
      const passing = availablePool.filter((m) => Number.isFinite(Number(m.quality)) && Number(m.quality) >= qualityFloor);
      if (!passing.length) {
        throw Object.assign(new Error(`No available models satisfy quality floor ${qualityFloor}`), { code: 'quality_constraint' });
      }
      scoredPool = passing;
    }
    const latencyTargetMs = Number(runPolicy.latencyTargetMs);
    if (Number.isFinite(latencyTargetMs) && latencyTargetMs > 0) {
      const passing = scoredPool.filter((m) => Number.isFinite(Number(m.avgLatencyMs)) && Number(m.avgLatencyMs) <= latencyTargetMs);
      if (!passing.length) {
        throw Object.assign(new Error(`No available models satisfy latency target ${latencyTargetMs}ms`), { code: 'latency_constraint' });
      }
      scoredPool = passing;
    }
    // Reliability floor from preset/policy (never empties the pool alone).
    const minRel = Number(runPolicy.minReliability);
    if (Number.isFinite(minRel) && minRel > 0) {
      const passing = scoredPool.filter((m) => Number(m.reliability) >= minRel || m.id === preferred?.id);
      if (passing.length) scoredPool = passing;
    }

    const evaluation = await this.evaluateCandidates(task, runtimeState, scoredPool);
    evaluation.excludedCandidates = {
      context: eliminated,
      unavailable: excludedUnavailable,
      unpriced: excludedPricing,
    };
    if (!evaluation.candidates.length) {
      throw Object.assign(new Error('No routable models after scoring'), { code: 'no_models' });
    }

    const currentModel = runtimeState.model.currentModel;
    // Preferred-model override: explicit user choice, recorded honestly.
    if (preferred && (!currentModel || preferred.id !== currentModel)) {
      const decision = this.decisionEngine.createDecision(
        DecisionType.MODEL_SELECTION,
        `SELECT ${preferred.id}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: evaluation.candidates.find((c) => c.modelId === preferred.id) || { modelId: preferred.id },
          score: (evaluation.candidates.find((c) => c.modelId === preferred.id) || {}).score || 0,
          factors: [
            { key: 'user_preference', label: 'Preferred model chosen by user', status: 'pass', detail: preferred.id },
          ],
          reason: 'User pinned a preferred model for this run',
          expectedCost: 0,
          expectedLatency: preferred.avgLatencyMs,
          expectedQuality: preferred.quality,
          switchingCost: 0,
          confidence: 1,
        }
      );
      return this._finalizeRouting(task, runtimeState, evaluation, preferred.id, decision);
    }
    const bestCandidate = preferred && currentModel === preferred.id
      ? evaluation.candidates.find((c) => c.modelId === preferred.id) || evaluation.candidates[0]
      : evaluation.candidates[0];

    // No incumbent, or incumbent already best: direct selection.
    if (!currentModel || bestCandidate.modelId === currentModel) {
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
            ...(eliminated ? [{ key: 'context', label: `${eliminated} candidate(s) excluded: context window too small`, status: 'warn', detail: `need ~${needTokens} tokens` }] : []),
            ...(excludedUnavailable ? [{ key: 'availability', label: `${excludedUnavailable} candidate(s) excluded: marked unavailable`, status: 'warn', detail: 'known-inaccessible models are never selected' }] : []),
            ...(excludedPricing ? [{ key: 'pricing', label: `${excludedPricing} candidate(s) excluded: pricing incomplete`, status: 'warn', detail: 'unknown commercial pricing is not optimizer input' }] : []),
          ],
          reason: 'Best overall score for task requirements',
          expectedCost: bestCandidate.estimatedCost,
          expectedLatency: bestCandidate.avgLatencyMs,
          expectedQuality: bestCandidate.score,
          switchingCost: 0,
          confidence: 0.85
        }
      );
      return this._finalizeRouting(task, runtimeState, evaluation, bestCandidate.modelId, decision);
    }

    // Incumbent exists and a challenger leads. A degraded/unavailable (or
    // unscored) incumbent is never sticky: switch without hysteresis.
    const incumbentDef = availablePool.find((m) => m.id === currentModel) || null;
    const incumbentUnhealthy = !incumbentDef || (incumbentDef.status && incumbentDef.status !== 'healthy');
    // User pinned switching off: keep a healthy incumbent, always.
    if (runPolicy.allowSwitching === false && !incumbentUnhealthy) {
      const keep = this.decisionEngine.createDecision(
        DecisionType.MODEL_RETENTION,
        `KEEP ${currentModel}`,
        `run:${runtimeState.runId}`,
        {
          candidates: evaluation.candidates,
          selectedCandidate: { modelId: currentModel },
          score: evaluation.currentScore,
          factors: [
            { key: 'user_preference', label: 'Model switching disabled for this run', status: 'pass', detail: 'user setting' },
          ],
          reason: 'Model switching disabled by user — incumbent retained',
          expectedCost: 0,
          expectedLatency: runtimeState.model.modelLatency,
          expectedQuality: evaluation.currentScore,
          switchingCost: 0,
          confidence: 1,
        }
      );
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
        decision = this.decisionEngine.createDecision(
          DecisionType.MODEL_RETENTION,
          `KEEP ${currentModel}`,
          `run:${runtimeState.runId}`,
          {
            candidates: evaluation.candidates,
            selectedCandidate: { modelId: currentModel },
            score: evaluation.currentScore,
            factors: [
              { key: 'stickiness', label: 'Model stickiness', status: 'pass', detail: switchEval.reason },
              { key: 'switch_cost', label: 'Switching cost too high', status: 'warn', detail: `$${switchingCost.total.toFixed(4)}` },
              { key: 'net_benefit', label: 'Net benefit insufficient', status: 'fail', detail: `${netBenefit.toFixed(4)} < ${switchEval.requiredBenefit?.toFixed(4) || 'N/A'}` }
            ],
            reason: switchEval.reason,
            expectedCost: 0,
            expectedLatency: runtimeState.model.modelLatency,
            expectedQuality: evaluation.currentScore,
            switchingCost: switchingCost.total,
            confidence: 0.9
          }
        );
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
        ],
        reason: incumbentUnhealthy ? switchReason : `Net benefit ${netBenefit.toFixed(4)} exceeds threshold`,
        expectedCost: switchingCost.total,
        expectedLatency: bestCandidate.avgLatencyMs,
        expectedQuality: bestCandidate.score,
        switchingCost: switchingCost.total,
        confidence: 0.8
      }
    );
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
