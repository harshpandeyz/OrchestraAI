'use strict';

const { aggregate, periodFor } = require('./billing');
const { round6 } = require('./savings');

function withinRange(run, from, to) {
  const ts = new Date(run.updatedAt || run.createdAt || 0).getTime();
  if (!Number.isFinite(ts)) return false;
  if (from && ts < new Date(from).getTime()) return false;
  if (to && ts > new Date(to).getTime()) return false;
  return true;
}

function buildAnalytics(runs, economicsByRun, options = {}) {
  const rows = [];
  const modelBreakdown = new Map();
  const providerBreakdown = new Map();
  const tokenComposition = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
  const trend = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  const statusCounts = {
    verified: 0,
    insufficient: 0,
    incomplete: 0,
    noSavings: 0,
    costIncrease: 0,
  };

  for (const run of (runs || []).filter((r) => withinRange(r, options.from, options.to))) {
    const economics = economicsByRun && economicsByRun.get(run.id);
    if (!economics) continue;
    const line = { runId: run.id, title: run.title || 'Untitled task', date: run.updatedAt || run.createdAt, savings: economics };
    rows.push(line);
    if (economics.status === 'incomplete_run') statusCounts.incomplete++;
    else if (economics.status === 'insufficient_pricing_data') statusCounts.insufficient++;
    else if (economics.status === 'cost_increase') statusCounts.costIncrease++;
    else if (economics.status === 'no_savings' || economics.economicOutcome === 'unchanged') statusCounts.noSavings++;
    else if (economics.calculationStatus === 'verified_modeled') statusCounts.verified++;
    const period = periodFor(line.date);
    const t = trend.get(period) || { period, baseline: 0, optimized: 0, savings: 0, negativeImpact: 0, runs: 0 };
    if (Number.isFinite(Number(economics.baselineCost))) t.baseline += Number(economics.baselineCost);
    if (Number.isFinite(Number(economics.actualCost))) t.optimized += Number(economics.actualCost);
    if (Number.isFinite(Number(economics.savings))) {
      t.savings += Math.max(0, Number(economics.savings));
      t.negativeImpact += Math.min(0, Number(economics.savings));
    }
    t.runs++;
    trend.set(period, t);
    for (const step of economics.steps || []) {
      const model = step.actualModel || 'unknown';
      const provider = step.provider || 'unknown';
      const modelRow = modelBreakdown.get(model) || { model, provider, cost: 0, baseline: 0, runs: 0 };
      modelRow.cost += Number(step.actualCost) || 0;
      modelRow.baseline += Number(step.baselineCost) || 0;
      modelRow.runs++;
      modelBreakdown.set(model, modelRow);
      const providerRow = providerBreakdown.get(provider) || { provider, cost: 0, baseline: 0, runs: 0 };
      providerRow.cost += Number(step.actualCost) || 0;
      providerRow.baseline += Number(step.baselineCost) || 0;
      providerRow.runs++;
      providerBreakdown.set(provider, providerRow);
      if (Number.isFinite(Number(step.inputTokens))) tokenComposition.inputTokens += Number(step.inputTokens);
      if (Number.isFinite(Number(step.outputTokens))) tokenComposition.outputTokens += Number(step.outputTokens);
      if (Number.isFinite(Number(step.cachedTokens))) tokenComposition.cachedTokens += Number(step.cachedTokens);
      if (Number.isFinite(Number(step.reasoningTokens))) tokenComposition.reasoningTokens += Number(step.reasoningTokens);
    }
    const snapshot = run.snapshot || {};
    // Snapshot cache counters are durable run totals. Recent event samples are
    // only a compatibility fallback and must never be treated as totals.
    if (Number.isFinite(Number(snapshot.cache?.hits)) || Number.isFinite(Number(snapshot.cache?.misses))) {
      cacheHits += Number(snapshot.cache?.hits) || 0;
      cacheMisses += Number(snapshot.cache?.misses) || 0;
    } else {
      const recent = snapshot.cache?.recent || [];
      cacheHits += recent.filter((event) => event.type === 'cache.hit').length;
      cacheMisses += recent.filter((event) => event.type === 'cache.miss').length;
    }
  }

  const summary = aggregate(rows, { period: options.period });
  const normalize = (row) => ({
    ...row,
    cost: round6(row.cost),
    baseline: round6(row.baseline),
    modeledSavings: round6(row.baseline - row.cost),
  });
  const spendTrend = Array.from(trend.values()).sort((a, b) => a.period.localeCompare(b.period)).map((t) => ({
    ...t,
    baseline: round6(t.baseline), optimized: round6(t.optimized), savings: round6(t.savings), negativeImpact: round6(t.negativeImpact),
  }));
  return {
    summary,
    spendTrend,
    savingsTrend: spendTrend.map((t) => ({ period: t.period, savings: t.savings, rate: t.baseline > 0 ? round6(t.savings / t.baseline) : 0 })),
    modelBreakdown: Array.from(modelBreakdown.values()).map(normalize).sort((a, b) => b.cost - a.cost),
    providerBreakdown: Array.from(providerBreakdown.values()).map(normalize).sort((a, b) => b.cost - a.cost),
    tokenComposition,
    cacheImpact: { hits: cacheHits, misses: cacheMisses, hitRate: cacheHits + cacheMisses > 0 ? round6(cacheHits / (cacheHits + cacheMisses)) : 0 },
    recentRuns: rows.slice(-20).reverse().map((r) => ({
      runId: r.runId,
      title: r.title,
      date: r.date,
      status: r.savings.status,
      calculationStatus: r.savings.calculationStatus || null,
      economicOutcome: r.savings.economicOutcome || null,
      baselineCost: r.savings.baselineCost,
      optimizedProviderCost: r.savings.actualCost,
      platformFee: r.savings.platformFee,
      customerNetSavings: r.savings.customerNetSavings,
    })),
    dataQuality: {
      totalRuns: rows.length,
      verifiedCount: statusCounts.verified,
      insufficientCount: statusCounts.insufficient,
      incompleteCount: statusCounts.incomplete,
      noSavingsCount: statusCounts.noSavings,
      costIncreaseCount: statusCounts.costIncrease,
      coverageRate: rows.length ? round6(statusCounts.verified / rows.length) : 0,
      label: statusCounts.verified === rows.length && rows.length > 0 ? 'verified_modeled' : 'mixed_or_insufficient',
    },
  };
}

module.exports = { buildAnalytics, withinRange };
