'use strict';

const { ModelRouter } = require('../interfaces');
const { DecisionType, DecisionStatus } = require('../core/types');
const { Decision, DecisionEngine } = require('../decisions/decision-engine');
const { SwitchingCostCalculator, ModelStickinessManager } = require('../decisions/switching-cost');
const { generateId, now } = require('../state/runtime-state');

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
  }

  async route(task, runtimeState, candidates, policy) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (list.length === 0) {
      throw Object.assign(new Error('No available models: registry is empty or all models are blocked/unavailable'), { code: 'no_models' });
    }
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

    const evaluation = await this.evaluateCandidates(task, runtimeState, pool);
    if (!evaluation.candidates.length) {
      throw Object.assign(new Error('No routable models after scoring'), { code: 'no_models' });
    }

    const currentModel = runtimeState.model.currentModel;
    const bestCandidate = evaluation.candidates[0];

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
          ],
          reason: 'Best overall score for task requirements',
          expectedCost: bestCandidate.estimatedCost || 0,
          expectedLatency: bestCandidate.avgLatencyMs,
          expectedQuality: bestCandidate.score,
          switchingCost: 0,
          confidence: 0.85
        }
      );
      return { selectedModel: bestCandidate.modelId, decision, evaluation };
    }

    // Incumbent exists and a challenger leads. A degraded/unavailable (or
    // unscored) incumbent is never sticky: switch without hysteresis.
    const incumbentDef = pool.find((m) => m.id === currentModel) || null;
    const incumbentUnhealthy = !incumbentDef || (incumbentDef.status && incumbentDef.status !== 'healthy');
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
        return { selectedModel, decision, evaluation };
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
    return { selectedModel, decision, evaluation };
  }

  async evaluateCandidates(task, runtimeState, candidateModels) {
    const currentModel = runtimeState.model.currentModel;
    let currentScore = 0;
    
    const candidates = [];
    
    for (const model of candidateModels) {
      const score = await this.scoreModel(model, task, runtimeState);
      const estimatedCost = this.estimateModelCost(model, runtimeState);
      const finite = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

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
        avgLatencyMs: finite(model.avgLatencyMs),
        outputPer1k: finite(model.outputPer1k),
        estimatedCost: finite(estimatedCost),
      });
      
      if (model.id === currentModel) {
        currentScore = score.total;
      }
    }
    
    candidates.sort((a, b) => b.score - a.score);
    
    return { candidates, currentScore };
  }

  async scoreModel(model, task, runtimeState) {
    // Explicit fallback semantics: missing telemetry never explodes scoring.
    // Every component is finite and clamped to [0, 1]; the total to [0, 1].
    const clamp01 = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
    };
    const needTokens = runtimeState.context.currentTokens || 0;
    const window = model.contextWindow || 0;
    if (window > 0 && needTokens > 0 && needTokens > window) {
      // Context-incompatible: eliminated by route(); scored 0, never NaN.
      return { total: 0, quality: 0, cost: 0, latency: 0, reliability: 0, contextFit: 0, switchCost: 0, excluded: 'context_window' };
    }

    const contextUtilization = runtimeState.context.getUtilization();
    const contextFit = Number.isFinite(contextUtilization) ? Math.max(0, 1 - contextUtilization) : 0.5;

    let switchCost = 0;
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
      } catch {
        switchCost = 0;
      }
    }

    const quality = clamp01(model.quality, 0.5);
    const outPer1k = Number(model.outputPer1k);
    const costScore = Number.isFinite(outPer1k) && outPer1k >= 0 ? Math.max(0, 1 - (outPer1k / 0.01)) : 0.5;
    const latMs = Number(model.avgLatencyMs);
    const latencyScore = Number.isFinite(latMs) && latMs >= 0 ? Math.max(0, 1 - (latMs / 5000)) : 0.5;
    const reliability = clamp01(model.reliability, 0.5);

    const raw = (
      quality * this.config.qualityWeight +
      costScore * this.config.costWeight +
      latencyScore * this.config.latencyWeight +
      reliability * this.config.reliabilityWeight +
      contextFit * this.config.contextFitWeight
    ) * (1 - Math.min(0.3, switchCost * 10));

    const total = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

    return {
      total,
      quality,
      cost: costScore,
      latency: latencyScore,
      reliability,
      contextFit,
      switchCost
    };
  }

  estimateModelCost(model, runtimeState) {
    const inputTokens = Math.max(0, Number(runtimeState.context.currentTokens) || 0);
    const cachedTokens = Math.max(0, Math.min(inputTokens, Number(runtimeState.context.cacheablePrefixTokens) || 0));
    const outputTokens = 1000;

    const finiteRate = (v, fb) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fb);
    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const inputCost = (uncachedInput / 1000) * finiteRate(model.inputPer1k, 0.001);
    const cachedCost = (cachedTokens / 1000) * finiteRate(model.cachedPer1k, 0.0002);
    const outputCost = (outputTokens / 1000) * finiteRate(model.outputPer1k, 0.003);

    const total = inputCost + cachedCost + outputCost;
    return Number.isFinite(total) ? Math.max(0, total) : 0;
  }

  on(event, handler) {}
}

module.exports = {
  InMemoryModelRouter
};