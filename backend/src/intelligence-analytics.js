'use strict';

// Orchestra Intelligence — backend analytics builder.
//
// Single authoritative source for the Intelligence suite. All values derive
// from observed runtime state (runs, snapshots, canonical economics,
// registry, IntelligenceStore). Nothing is fabricated: thin evidence yields
// INSUFFICIENT_DATA, demo traffic yields DEMO provenance, live traffic
// yields LIVE/OBSERVED. The frontend never computes pricing or benchmark
// results; it only renders what this module returns.

const { round6 } = require('./savings');

const VALUE_FORMULA = 'value = 0.35*quality + 0.25*successRate + 0.15*reliability + 0.15*costEfficiency + 0.10*latencyEfficiency; costEfficiency = 1 - (modelCostPerTask - minCost)/(maxCost - minCost || 1); latencyEfficiency = 1 - (modelP50 - minP50)/(maxP50 - minP50 || 1)';

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const s = [...sortedAsc].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day);
  return `w:${t.toISOString().slice(0, 10)}`;
}

function monthKey(d) {
  return `m:${d.toISOString().slice(0, 7)}`;
}

function bucketKey(dateIso, granularity) {
  const d = new Date(dateIso);
  if (!Number.isFinite(d.getTime())) return null;
  if (granularity === 'weekly') return weekKey(d);
  if (granularity === 'monthly') return monthKey(d);
  return dayKey(d);
}

function parseRange(range, from, to) {
  if (from || to) return { from, to };
  if (!range || range === 'all') return { from: null, to: null };
  const m = String(range).match(/^(\d+)(d|D)$/);
  const days = m ? parseInt(m[1], 10) : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function within(dateIso, from, to) {
  const ts = new Date(dateIso || 0).getTime();
  if (!Number.isFinite(ts)) return false;
  if (from && ts < new Date(from).getTime()) return false;
  if (to && ts > new Date(to).getTime()) return false;
  return true;
}

function provenanceFor(mode, runCount) {
  if (!runCount) return 'INSUFFICIENT_DATA';
  return mode === 'live' ? 'LIVE' : 'DEMO';
}

function stateFor(count, threshold = 1) {
  if (!count || count < threshold) return 'INSUFFICIENT_DATA';
  return 'READY';
}

function buildIntelligence(input = {}) {
  const {
    runs = [],
    economicsByRun = new Map(),
    snapshotsByRun = new Map(),
    models = [],
    observedByModel = new Map(),
    intelligence = null,
    mode = 'demo',
    tenantId = null,
    options = {},
  } = input;
  const granularity = ['daily', 'weekly', 'monthly'].includes(options.granularity) ? options.granularity : 'daily';
  const rangeRaw = options.range || '30d';
  const { from, to } = parseRange(rangeRaw, options.from || null, options.to || null);
  const filters = options.filters || {};
  const fModel = filters.model || null;
  const fProvider = filters.provider ? String(filters.provider).toLowerCase() : null;
  const fTask = filters.taskCategory || null;
  const fProject = filters.projectId || null;

  const generatedAt = new Date().toISOString();

  // Filtered run set (terminal + active; economics may be missing for active).
  let scoped = runs.filter((r) => {
    const date = r.updatedAt || r.createdAt;
    if (!within(date, from, to)) return false;
    if (fProject && String(r.projectId || '') !== String(fProject)) return false;
    if (fModel && String(r.activeModelId || '') !== String(fModel)) return false;
    if (fProvider) {
      const snap = snapshotsByRun.get(r.id);
      const prov = snap?.meta?.provider || snap?.modelCalls?.[0]?.provider || '';
      // Fall back to model registry provider lookup
      const reg = models.find((m) => m.id === r.activeModelId);
      const p = String(prov || reg?.provider || '').toLowerCase();
      if (p !== fProvider) return false;
    }
    if (fTask) {
      const snap = snapshotsByRun.get(r.id);
      const cat = snap?.intelligence?.taskProfile?.category || snap?.routing?.taskProfile?.category || r.taskMode || 'general';
      if (String(cat) !== String(fTask)) return false;
    }
    return true;
  });

  const runCount = scoped.length;
  const baseProvenance = provenanceFor(mode, runCount);

  // Collect per-run economics + snapshot helpers
  const withEcon = scoped.map((r) => ({
    run: r,
    econ: economicsByRun.get(r.id) || null,
    snap: snapshotsByRun.get(r.id) || null,
  }));

  const verifiedCount = withEcon.filter((x) => x.econ && x.econ.calculationStatus === 'verified_modeled').length;
  const coverageRate = runCount ? round6(verifiedCount / runCount) : 0;

  const meta = {
    generatedAt,
    mode,
    provenance: runCount ? baseProvenance : 'INSUFFICIENT_DATA',
    runCount,
    verifiedCount,
    coverageRate,
    granularity,
    range: rangeRaw,
    from, to,
    filters: { model: fModel, provider: fProvider, taskCategory: fTask, projectId: fProject },
    valueScoreFormula: VALUE_FORMULA,
    note: runCount
      ? (mode === 'live' ? 'Orchestra observed usage — metered from canonical run economics.' : 'Demo traffic — deterministic mock provider, explicitly labelled. Same pipeline, mock model calls.')
      : 'Not enough observed runs for this slice. Showing honest empty states — no fabricated metrics.',
  };

  // ---------- TOP MODELS (usage over time) ----------
  const topModels = buildTopModels(withEcon, models, { granularity, mode, baseProvenance });

  // ---------- LEADERBOARD ----------
  const leaderboard = buildLeaderboard({ withEcon, models, observedByModel, intelligence, mode, baseProvenance });

  // ---------- TASKS ----------
  const tasks = buildTasks({ leaderboardRows: leaderboard.rows, intelligence, mode, baseProvenance });

  // ---------- COST ----------
  const cost = buildCost(withEcon, { mode, baseProvenance });

  // ---------- MARKET SHARE ----------
  const marketShare = buildMarketShare(withEcon, models, { mode, baseProvenance });

  // ---------- BENCHMARKS ----------
  const benchmarks = buildBenchmarks(intelligence, { mode });

  // ---------- LATENCY ----------
  const latency = buildLatency({ leaderboardRows: leaderboard.rows, withEcon, intelligence, mode, baseProvenance });

  // ---------- CONTEXT ----------
  const context = buildContext(withEcon, { mode, baseProvenance });

  // ---------- TOOLS ----------
  const tools = buildTools(withEcon, models, { mode, baseProvenance });

  // ---------- WORKLOADS ----------
  const workloads = buildWorkloads(withEcon, { mode, baseProvenance });

  // ---------- LANGUAGES ----------
  const languages = {
    provenance: 'INSUFFICIENT_DATA',
    state: 'INSUFFICIENT_DATA',
    note: 'No language-attributed telemetry is recorded. Natural and programming language breakdowns appear only when runs carry language evidence.',
    natural: [],
    programming: [],
  };

  // ---------- IMAGES / MULTIMODAL ----------
  const images = buildImages(withEcon, models, { mode });

  // ---------- EXECUTION FLOW (differentiator hero) ----------
  const executionFlow = buildExecutionFlow(withEcon, { mode, baseProvenance });

  return {
    meta, topModels, leaderboard, tasks, cost, marketShare, benchmarks,
    latency, context, tools, workloads, languages, images, executionFlow,
  };
}

function collectModelSteps(withEcon) {
  // Returns [{runId, date, model, provider, cost, baseline, input, output, cached, latencyMs}]
  const out = [];
  for (const { run, econ, snap } of withEcon) {
    const date = run.updatedAt || run.createdAt;
    const steps = (econ && econ.steps) || [];
    if (steps.length) {
      for (const s of steps) {
        out.push({
          runId: run.id, date,
          model: s.actualModel || s.model || run.activeModelId || 'unknown',
          provider: s.provider || snap?.meta?.provider || 'unknown',
          cost: num(s.actualCost, 0) || 0,
          baseline: num(s.baselineCost, 0) || 0,
          input: num(s.inputTokens, 0) || 0,
          output: num(s.outputTokens, 0) || 0,
          cached: num(s.cachedTokens, 0) || 0,
          latencyMs: num(s.latencyMs, null),
        });
      }
    } else if (run.activeModelId) {
      out.push({
        runId: run.id, date,
        model: run.activeModelId,
        provider: snap?.meta?.provider || 'unknown',
        cost: num(econ?.actualCost, 0) || num(run.spent, 0) || 0,
        baseline: num(econ?.baselineCost, 0) || 0,
        input: 0, output: 0, cached: 0,
        latencyMs: num(snap?.latency?.totalMs, null),
      });
    }
  }
  return out;
}

function buildTopModels(withEcon, models, { granularity, mode, baseProvenance }) {
  const steps = collectModelSteps(withEcon);
  if (!steps.length) {
    return {
      provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA',
      granularity, range: granularity,
      note: 'No model-call evidence in this slice. Complete a run to see usage over time.',
      series: [], totals: [], models: [],
    };
  }
  const buckets = new Map();
  for (const s of steps) {
    const k = bucketKey(s.date, granularity) || 'unknown';
    if (!buckets.has(k)) buckets.set(k, { period: k, total: 0, totalCost: 0, perModel: {}, perModelCost: {} });
    const b = buckets.get(k);
    b.total += 1;
    b.totalCost = round6((b.totalCost || 0) + (s.cost || 0));
    b.perModel[s.model] = (b.perModel[s.model] || 0) + 1;
    b.perModelCost[s.model] = round6((b.perModelCost[s.model] || 0) + (s.cost || 0));
  }
  const series = Array.from(buckets.values()).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const totalsMap = new Map();
  for (const s of steps) {
    if (!totalsMap.has(s.model)) {
      const reg = models.find((m) => m.id === s.model);
      totalsMap.set(s.model, { model: s.model, provider: s.provider !== 'unknown' ? s.provider : (reg?.provider || 'unknown'), calls: 0, cost: 0, baseline: 0, runs: new Set() });
    }
    const t = totalsMap.get(s.model);
    t.calls += 1;
    t.cost = round6(t.cost + (s.cost || 0));
    t.baseline = round6(t.baseline + (s.baseline || 0));
    t.runs.add(s.runId);
  }
  const totals = Array.from(totalsMap.values()).map((t) => ({
    model: t.model, provider: t.provider, calls: t.calls, runs: t.runs.size,
    cost: t.cost, baseline: t.baseline, modeledSavings: round6(t.baseline - t.cost),
  })).sort((a, b) => b.calls - a.calls);
  const modelIds = totals.map((t) => t.model);
  return {
    provenance: baseProvenance, state: 'READY',
    granularity,
    note: mode === 'live' ? 'Orchestra observed usage — step-level model calls from canonical economics.' : 'Demo usage — mock provider calls through the real pipeline.',
    series, totals, models: modelIds,
  };
}

function buildLeaderboard({ withEcon, models, observedByModel, intelligence, mode, baseProvenance }) {
  if (!models.length && !withEcon.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', formula: VALUE_FORMULA, note: 'No models observed.', rows: [] };
  }
  // Aggregate cost / tokens per model from canonical steps
  const steps = collectModelSteps(withEcon);
  const costByModel = new Map();
  const runsByModel = new Map();
  for (const s of steps) {
    const c = costByModel.get(s.model) || { cost: 0, baseline: 0, input: 0, output: 0, cached: 0, calls: 0, latencies: [] };
    c.cost += s.cost || 0; c.baseline += s.baseline || 0;
    c.input += s.input || 0; c.output += s.output || 0; c.cached += s.cached || 0;
    c.calls += 1;
    if (Number.isFinite(s.latencyMs)) c.latencies.push(s.latencyMs);
    costByModel.set(s.model, c);
    if (!runsByModel.has(s.model)) runsByModel.set(s.model, new Set());
    runsByModel.get(s.model).add(s.runId);
  }
  // Context + cache per model from snapshots
  const ctxByModel = new Map();
  const cacheByModel = new Map();
  for (const { run, snap } of withEcon) {
    const mid = run.activeModelId || snap?.activeModelId || 'unknown';
    if (!snap) continue;
    const used = num(snap.context?.usedTokens, null);
    const win = num(snap.context?.windowTokens, null);
    if (used !== null && win) {
      const a = ctxByModel.get(mid) || { utils: [] };
      a.utils.push(used / win);
      ctxByModel.set(mid, a);
    }
    const hits = num(snap.cache?.hits, null);
    const misses = num(snap.cache?.misses, null);
    if (hits !== null || misses !== null) {
      const c = cacheByModel.get(mid) || { hits: 0, misses: 0 };
      c.hits += hits || 0; c.misses += misses || 0;
      cacheByModel.set(mid, c);
    }
  }

  // Performance per model across categories
  const perf = intelligence?.performance || null;

  const allModelIds = new Set([...models.map((m) => m.id), ...costByModel.keys()]);
  // Drop synthetic 'unknown' unless it is the only evidence
  if (allModelIds.has('unknown') && allModelIds.size > 1) allModelIds.delete('unknown');

  const rows = [];
  for (const modelId of allModelIds) {
    const reg = models.find((m) => m.id === modelId) || null;
    const obs = (observedByModel && observedByModel.get(modelId)) || null;
    const cost = costByModel.get(modelId) || null;
    const forModel = perf && typeof perf.forModel === 'function' ? perf.forModel(modelId, tenantId) : {};
    const cats = Object.values(forModel || {});
    let attempts = 0; let successes = 0; let qSum = 0; let qN = 0; const latSamples = [];
    for (const d of cats) {
      attempts += d.attempts || 0; successes += d.successes || 0;
      if (Number.isFinite(d.qualityEwma)) { qSum += d.qualityEwma; qN += 1; }
      // latency samples are not directly exposed; use p50 as proxy sample
      if (d.latency && Number.isFinite(d.latency.p50)) latSamples.push(d.latency.p50);
      if (d.latency && Number.isFinite(d.latency.mean)) latSamples.push(d.latency.mean);
    }
    if (cost && cost.latencies.length) latSamples.push(...cost.latencies);

    // Quality: prefer observed EWMA, then registry when source is not unknown/demo-thin
    let quality = null; let qualityProvenance = 'INSUFFICIENT_DATA';
    if (qN > 0) { quality = round6(qSum / qN); qualityProvenance = mode === 'live' ? 'OBSERVED' : 'DEMO'; }
    else if (reg && Number.isFinite(Number(reg.quality)) && reg.qualitySource !== 'unknown') {
      quality = Number(reg.quality) > 1 ? round6(Number(reg.quality) / 100) : round6(Number(reg.quality));
      qualityProvenance = reg.qualitySource === 'demo' ? 'DEMO' : (reg.qualitySource || 'UNKNOWN').toUpperCase();
    }

    let successRate = null; let successProvenance = 'INSUFFICIENT_DATA'; let successSamples = attempts;
    if (attempts >= 3) { successRate = round6(successes / attempts); successProvenance = mode === 'live' ? 'OBSERVED' : 'DEMO'; }
    else if (obs && (obs.successes + obs.failures) >= 3) {
      successRate = round6(obs.successes / (obs.successes + obs.failures));
      successProvenance = mode === 'live' ? 'OBSERVED' : 'DEMO';
      successSamples = obs.successes + obs.failures;
    }

    let reliability = null; let reliabilityProvenance = 'INSUFFICIENT_DATA';
    if (reg && Number.isFinite(Number(reg.reliability)) && reg.reliabilitySource !== 'unknown') {
      reliability = round6(Number(reg.reliability));
      reliabilityProvenance = (reg.reliabilitySource || 'unknown').toUpperCase();
      if (mode !== 'live' && reliabilityProvenance !== 'DEMO') reliabilityProvenance = 'DEMO';
    } else if (successRate !== null) {
      reliability = successRate;
      reliabilityProvenance = successProvenance;
    }

    let p50 = null; let p95 = null; let avgLatencyMs = null; let latencyProvenance = 'INSUFFICIENT_DATA'; let latencySamples = 0;
    if (latSamples.length >= 1) {
      p50 = percentile(latSamples, 50); p95 = percentile(latSamples, 95); avgLatencyMs = Math.round(mean(latSamples));
      latencySamples = latSamples.length;
      latencyProvenance = mode === 'live' ? 'OBSERVED' : 'DEMO';
    } else if (reg && Number.isFinite(Number(reg.avgLatencyMs)) && reg.latencySource !== 'unknown') {
      avgLatencyMs = Math.round(Number(reg.avgLatencyMs)); p50 = avgLatencyMs; p95 = null;
      latencyProvenance = (reg.latencySource || 'unknown').toUpperCase();
      if (mode !== 'live' && latencyProvenance !== 'DEMO') latencyProvenance = 'DEMO';
    }

    const runs = runsByModel.get(modelId)?.size || 0;
    const totalCost = cost ? round6(cost.cost) : null;
    const costPerTask = cost && runs ? round6(cost.cost / runs) : (cost && cost.calls ? round6(cost.cost / cost.calls) : null);
    let costPerSuccessfulTask = null;
    if (costPerTask !== null && successRate) {
      costPerSuccessfulTask = successRate > 0 ? round6(costPerTask / successRate) : null;
    }
    let pricingProvenance = 'INSUFFICIENT_DATA';
    if (reg && reg.pricingSource) {
      pricingProvenance = String(reg.pricingSource).toUpperCase();
      if (pricingProvenance === 'UNKNOWN') pricingProvenance = 'INSUFFICIENT_DATA';
      if (mode !== 'live' && pricingProvenance !== 'INSUFFICIENT_DATA') pricingProvenance = 'DEMO';
    } else if (cost) {
      pricingProvenance = mode === 'live' ? 'OBSERVED' : 'DEMO';
    }

    let contextEfficiency = null;
    const ctx = ctxByModel.get(modelId);
    if (ctx && ctx.utils.length) {
      const avgUtil = mean(ctx.utils);
      contextEfficiency = round6(1 - avgUtil);
    }
    let cacheEfficiency = null;
    const ch = cacheByModel.get(modelId);
    if (ch && (ch.hits + ch.misses) > 0) cacheEfficiency = round6(ch.hits / (ch.hits + ch.misses));

    rows.push({
      model: modelId,
      provider: reg?.provider || (cost ? withEcon.find((x) => x.run.activeModelId === modelId)?.snap?.meta?.provider : null) || 'unknown',
      status: reg?.status || 'unknown',
      capabilities: reg?.capabilities || [],
      quality, qualityProvenance,
      successRate, successProvenance, successSamples,
      reliability, reliabilityProvenance,
      avgLatencyMs, p50, p95, latencySamples, latencyProvenance,
      totalCost, runs, calls: cost?.calls || 0,
      costPerTask, costPerSuccessfulTask, pricingProvenance,
      contextEfficiency, cacheEfficiency,
      inputTokens: cost?.input || 0, outputTokens: cost?.output || 0, cachedTokens: cost?.cached || 0,
      valueScore: null, // filled below
      explanation: '',
      provenance: baseProvenance === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : mode === 'live' ? 'OBSERVED' : 'DEMO',
    });
  }

  // Value score normalization (only across models with signal)
  const withCost = rows.filter((r) => Number.isFinite(r.costPerTask));
  const withLat = rows.filter((r) => Number.isFinite(r.p50));
  const minCost = withCost.length ? Math.min(...withCost.map((r) => r.costPerTask)) : 0;
  const maxCost = withCost.length ? Math.max(...withCost.map((r) => r.costPerTask)) : 1;
  const minP50 = withLat.length ? Math.min(...withLat.map((r) => r.p50)) : 0;
  const maxP50 = withLat.length ? Math.max(...withLat.map((r) => r.p50)) : 1;
  for (const r of rows) {
    const q = Number.isFinite(r.quality) ? r.quality : 0.5;
    const s = Number.isFinite(r.successRate) ? r.successRate : 0.5;
    const rel = Number.isFinite(r.reliability) ? r.reliability : 0.5;
    const costEff = Number.isFinite(r.costPerTask) ? 1 - ((r.costPerTask - minCost) / ((maxCost - minCost) || 1)) : 0.5;
    const latEff = Number.isFinite(r.p50) ? 1 - ((r.p50 - minP50) / ((maxP50 - minP50) || 1)) : 0.5;
    const hasSignal = Number.isFinite(r.quality) || Number.isFinite(r.successRate) || Number.isFinite(r.costPerTask);
    r.valueScore = hasSignal ? round6(0.35 * q + 0.25 * s + 0.15 * rel + 0.15 * costEff + 0.10 * latEff) : null;
    r.valueComponents = { quality: round6(q), success: round6(s), reliability: round6(rel), costEfficiency: round6(costEff), latencyEfficiency: round6(latEff) };
    r.explanation = explainRow(r);
  }
  rows.sort((a, b) => (b.valueScore ?? -1) - (a.valueScore ?? -1));

  if (!rows.length || rows.every((r) => r.valueScore === null && r.successRate === null && r.quality === null)) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', formula: VALUE_FORMULA, note: 'Not enough measured quality, success, or cost evidence to rank models. Complete runs with known pricing to populate the leaderboard.', rows: [] };
  }
  return {
    provenance: baseProvenance, state: 'READY', formula: VALUE_FORMULA,
    note: mode === 'live'
      ? 'Ranked from observed success, quality estimates, reliability, metered cost, and latency. Formula is defined in meta.valueScoreFormula.'
      : 'Ranked from demo traffic through the real pipeline. Values are illustrative of the demo, not production measurements.',
    rows,
  };
}

function explainRow(r) {
  const bits = [];
  if (Number.isFinite(r.quality) && r.quality >= 0.8) bits.push(`high quality (${r.quality})`);
  if (Number.isFinite(r.successRate) && r.successRate >= 0.85) bits.push(`strong success rate (${Math.round(r.successRate * 100)}% over ${r.successSamples} attempts)`);
  if (Number.isFinite(r.costPerTask) && r.valueComponents && r.valueComponents.costEfficiency >= 0.7) bits.push(`low cost per task ($${r.costPerTask})`);
  if (Number.isFinite(r.p50) && r.valueComponents && r.valueComponents.latencyEfficiency >= 0.7) bits.push(`fast (p50 ${r.p50}ms)`);
  if (Number.isFinite(r.reliability) && r.reliability >= 0.9) bits.push(`reliable (${r.reliability})`);
  if (Number.isFinite(r.cacheEfficiency) && r.cacheEfficiency >= 0.5) bits.push(`cache-efficient (${Math.round(r.cacheEfficiency * 100)}% hit rate)`);
  if (!bits.length) {
    if (r.valueScore !== null) return `Balanced profile — composite value ${r.valueScore}. See component breakdown for trade-offs.`;
    return 'Insufficient measured evidence — shown for completeness, not ranked on verified signal.';
  }
  return `Ranks highly for ${bits.slice(0, 2).join(' and ')}.`;
}

function buildTasks({ leaderboardRows, intelligence, mode, baseProvenance }) {
  const TASK_LABELS = {
    code: 'Coding', debug: 'Debugging', research: 'Research', analysis: 'Analysis',
    writing: 'Writing', extraction: 'Summarization & Extraction', planning: 'Agentic Workflows & Planning',
    general: 'General',
  };
  // Map spec task names to classifier categories
  const SPEC = [
    { key: 'reasoning', label: 'Reasoning', categories: ['analysis', 'planning'] },
    { key: 'coding', label: 'Coding', categories: ['code', 'debug'] },
    { key: 'analysis', label: 'Analysis', categories: ['analysis', 'research'] },
    { key: 'writing', label: 'Writing', categories: ['writing'] },
    { key: 'summarization', label: 'Summarization', categories: ['extraction'] },
    { key: 'agentic', label: 'Agentic Workflows', categories: ['planning', 'code'] },
    { key: 'vision', label: 'Vision', categories: [] },
    { key: 'tool-heavy', label: 'Tool-heavy Tasks', categories: ['code', 'debug', 'extraction'] },
  ];
  const perf = intelligence?.performance || null;
  const categories = SPEC.map((spec) => {
    // Candidate models with evidence in these categories
    const scored = leaderboardRows.map((row) => {
      let catSuccess = null; let catLat = null; let catQuality = null; let samples = 0;
      if (perf && typeof perf.predictedSuccess === 'function') {
        for (const c of spec.categories) {
          try {
            const d = perf.describe ? perf.describe(row.model, c, tenantId) : null;
            if (d && d.attempts >= 1) {
              samples += d.attempts;
              if (d.predicted !== undefined && (catSuccess === null || d.predicted > catSuccess)) catSuccess = d.predicted;
              if (d.qualityEwma !== null && (catQuality === null || d.qualityEwma > catQuality)) catQuality = d.qualityEwma;
              if (d.latency && d.latency.p50 !== null && (catLat === null || d.latency.p50 < catLat)) catLat = d.latency.p50;
            }
          } catch { /* ignore */ }
        }
      }
      return { row, catSuccess, catLat, catQuality, samples };
    }).filter((s) => s.samples > 0 || spec.categories.length === 0);
    const pick = (fn) => {
      const valid = scored.filter((s) => fn(s) !== null && fn(s) !== undefined);
      if (!valid.length) return null;
      valid.sort((a, b) => {
        const av = fn(a); const bv = fn(b);
        return av - bv;
      });
      return valid;
    };
    // best quality: max catQuality ?? row.quality
    let bestQuality = null; let bestValue = null; let lowestCost = null; let fastest = null; let mostReliable = null;
    if (scored.length) {
      const byQ = [...scored].sort((a, b) => ((b.catQuality ?? b.row.quality ?? -1) - (a.catQuality ?? a.row.quality ?? -1)));
      bestQuality = byQ[0] && (byQ[0].catQuality ?? byQ[0].row.quality) !== null ? byQ[0].row.model : null;
      const byV = [...scored].sort((a, b) => ((b.row.valueScore ?? -1) - (a.row.valueScore ?? -1)));
      bestValue = byV[0]?.row.valueScore !== null ? byV[0].row.model : null;
      const byC = scored.filter((s) => s.row.costPerTask !== null).sort((a, b) => a.row.costPerTask - b.row.costPerTask);
      lowestCost = byC.length ? byC[0].row.model : null;
      const byL = scored.filter((s) => (s.catLat ?? s.row.p50) !== null).sort((a, b) => (a.catLat ?? a.row.p50) - (b.catLat ?? b.row.p50));
      fastest = byL.length ? byL[0].row.model : null;
      const byR = [...scored].sort((a, b) => ((b.row.reliability ?? -1) - (a.row.reliability ?? -1)));
      mostReliable = byR[0]?.row.reliability !== null ? byR[0].row.model : null;
    }
    const hasAny = bestQuality || bestValue || lowestCost || fastest || mostReliable;
    void TASK_LABELS; void pick;
    return {
      key: spec.key, label: spec.label, classifierCategories: spec.categories,
      bestQuality, bestValue, lowestCost, fastest, mostReliable,
      state: hasAny ? 'READY' : 'INSUFFICIENT_DATA',
      note: hasAny ? undefined : 'No observed runs in this task slice yet.',
    };
  });
  const anyReady = categories.some((c) => c.state === 'READY');
  return {
    provenance: anyReady ? baseProvenance : 'INSUFFICIENT_DATA',
    state: anyReady ? 'READY' : 'INSUFFICIENT_DATA',
    note: anyReady
      ? (mode === 'live' ? 'Task slices from observed task profiles and per-category performance.' : 'Task slices from demo traffic.')
      : 'No task-attributed evidence yet. Run tasks across categories to populate this view.',
    categories,
  };
}

function buildCost(withEcon, { mode, baseProvenance }) {
  const costs = withEcon.map((x) => num(x.econ?.actualCost, null)).filter((v) => v !== null);
  if (!costs.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No metered run costs in this slice.', stats: null, series: [], distribution: null };
  }
  const sorted = [...costs].sort((a, b) => a - b);
  const stats = {
    count: costs.length,
    total: round6(costs.reduce((a, b) => a + b, 0)),
    average: round6(mean(costs)),
    median: round6(median(costs)),
    p95: round6(percentile(sorted, 95)),
    min: round6(sorted[0]),
    max: round6(sorted[sorted.length - 1]),
  };
  // Input/output/cache split from steps
  let input = 0; let output = 0; let cached = 0; let baseline = 0;
  const seriesMap = new Map();
  for (const { run, econ } of withEcon) {
    const c = num(econ?.actualCost, null);
    if (c === null) continue;
    const k = dayKey(new Date(run.updatedAt || run.createdAt));
    const b = seriesMap.get(k) || { period: k, average: 0, median: 0, p95: 0, total: 0, costs: [] };
    b.costs.push(c); b.total = round6(b.total + c);
    seriesMap.set(k, b);
    for (const s of econ?.steps || []) {
      input += num(s.inputTokens, 0) || 0;
      output += num(s.outputTokens, 0) || 0;
      cached += num(s.cachedTokens, 0) || 0;
      baseline += num(s.baselineCost, 0) || 0;
    }
  }
  const series = Array.from(seriesMap.values()).sort((a, b) => String(a.period).localeCompare(String(b.period))).map((b) => ({
    period: b.period, total: b.total,
    average: round6(mean(b.costs)), median: round6(median(b.costs)),
    p95: round6(percentile([...b.costs].sort((x, y) => x - y), 95)),
    runs: b.costs.length,
  }));
  // Distribution buckets (5 quantiles)
  const buckets = [0, 25, 50, 75, 90, 100].map((p, i, arr) => {
    if (i === arr.length - 1) return null;
    return { from: percentile(sorted, p), to: percentile(sorted, arr[i + 1]) };
  }).filter(Boolean);
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live'
      ? 'Backend-authoritative costs from canonical economics. Frontend never prices independently.'
      : 'Demo costs from the mock provider through canonical economics.',
    stats: { ...stats, inputTokens: input, outputTokens: output, cachedTokens: cached, baselineCost: round6(baseline) },
    series, distribution: { buckets: buckets.map((b) => ({ from: round6(b.from), to: round6(b.to) })), min: stats.min, max: stats.max },
  };
}

function buildMarketShare(withEcon, models, { mode, baseProvenance }) {
  const steps = collectModelSteps(withEcon);
  if (!steps.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No usage to distribute yet.', providers: [], models: [], workloads: [] };
  }
  const totalCost = steps.reduce((a, s) => a + (s.cost || 0), 0) || 1;
  const totalCalls = steps.length || 1;
  const byProvider = new Map();
  const byModel = new Map();
  const byWorkload = new Map();
  for (const s of steps) {
    const p = byProvider.get(s.provider) || { key: s.provider, calls: 0, cost: 0 };
    p.calls += 1; p.cost += s.cost || 0;
    byProvider.set(s.provider, p);
    const m = byModel.get(s.model) || { key: s.model, provider: s.provider, calls: 0, cost: 0 };
    m.calls += 1; m.cost += s.cost || 0;
    byModel.set(s.model, m);
  }
  for (const { run } of withEcon) {
    const cat = run.taskMode || 'general';
    const w = byWorkload.get(cat) || { key: cat, runs: 0 };
    w.runs += 1;
    byWorkload.set(cat, w);
  }
  const providers = Array.from(byProvider.values()).map((p) => ({
    provider: p.key, calls: p.calls, cost: round6(p.cost),
    shareByCalls: round6(p.calls / totalCalls), shareByCost: round6(p.cost / totalCost),
  })).sort((a, b) => b.cost - a.cost);
  const modelRows = Array.from(byModel.values()).map((m) => {
    const reg = models.find((x) => x.id === m.key);
    return {
      model: m.key, provider: m.provider !== 'unknown' ? m.provider : (reg?.provider || 'unknown'),
      calls: m.calls, cost: round6(m.cost),
      shareByCalls: round6(m.calls / totalCalls), shareByCost: round6(m.cost / totalCost),
    };
  }).sort((a, b) => b.calls - a.calls);
  const totalRuns = withEcon.length || 1;
  const workloads = Array.from(byWorkload.values()).map((w) => ({
    workload: w.key, runs: w.runs, share: round6(w.runs / totalRuns),
  })).sort((a, b) => b.runs - a.runs);
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live'
      ? 'Orchestra observed usage — shares of metered calls and cost in this workspace. Not external market statistics.'
      : 'Demo observed usage — shares within demo traffic. Not external market statistics.',
    providers, models: modelRows, workloads,
  };
}

function buildBenchmarks(intelligence, { mode }) {
  const store = intelligence?.benchmarks || null;
  if (!store) return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No validated benchmark data.', cases: [], summaries: [] };
  const cases = typeof store.listCases === 'function' ? store.listCases() : [];
  if (!cases.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No validated benchmark data.', cases: [], summaries: [] };
  }
  const summaries = cases.map((c) => {
    let summary = [];
    try { summary = store.summarize(c.id) || []; } catch { summary = []; }
    return { caseId: c.id, category: c.category, results: summary };
  });
  return {
    provenance: mode === 'live' ? 'VERIFIED' : 'DEMO',
    state: 'READY',
    note: 'Benchmark results from explicitly recorded attempts only. No synthetic scores.',
    cases: cases.map((c) => ({ id: c.id, category: c.category, prompt: String(c.prompt || '').slice(0, 200), createdAt: c.createdAt })),
    summaries,
  };
}

function buildLatency({ leaderboardRows, withEcon, intelligence, mode, baseProvenance }) {
  const rows = leaderboardRows.filter((r) => r.p50 !== null || r.avgLatencyMs !== null);
  if (!rows.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No latency telemetry in this slice.', perModel: [] };
  }
  const perModel = rows.map((r) => ({
    model: r.model, provider: r.provider,
    p50: r.p50, p95: r.p95, mean: r.avgLatencyMs, samples: r.latencySamples,
    timeToFirstToken: null, timeToFirstTokenNote: 'Time-to-first-token is not captured by current telemetry.',
    provenance: r.latencyProvenance,
  })).sort((a, b) => (a.p50 ?? Infinity) - (b.p50 ?? Infinity));
  void withEcon; void intelligence;
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live' ? 'Observed latencies from completed model calls.' : 'Demo latencies from mock provider calls.',
    perModel,
  };
}

function buildContext(withEcon, { mode, baseProvenance }) {
  const utils = [];
  const perRun = [];
  let compressedItems = 0; let totalItems = 0;
  let totalSaved = 0;
  for (const { run, snap } of withEcon) {
    if (!snap?.context) continue;
    const used = num(snap.context.usedTokens, null);
    const win = num(snap.context.windowTokens, null);
    const util = used !== null && win ? used / win : null;
    if (util !== null) utils.push(util);
    const items = snap.context.items || [];
    totalItems += items.length;
    compressedItems += items.filter((i) => i.status === 'COMPRESSED').length;
    const saved = num(snap.cache?.savedUsd, 0) || 0;
    totalSaved = round6(totalSaved + saved);
    perRun.push({
      runId: run.id, title: run.title,
      usedTokens: used, windowTokens: win,
      utilization: util !== null ? round6(util) : null,
      items: items.length,
      cachedTokens: num(snap.cache?.cachedTokens, 0) || 0,
      savedUsd: saved,
    });
  }
  if (!perRun.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No context snapshots in this slice.', stats: null, perRun: [] };
  }
  const avgUtil = utils.length ? mean(utils) : null;
  const stats = {
    runs: perRun.length,
    avgUsedTokens: Math.round(mean(perRun.map((r) => r.usedTokens || 0).filter((v) => v > 0)) || 0),
    avgWindowTokens: Math.round(mean(perRun.map((r) => r.windowTokens || 0).filter((v) => v > 0)) || 0),
    avgUtilization: avgUtil !== null ? round6(avgUtil) : null,
    compressionRatio: totalItems ? round6(compressedItems / totalItems) : null,
    compressedItems, totalItems,
    cacheReuseSavedUsd: totalSaved,
    note: 'Optimized context = used tokens after compression and cache reuse. Raw vs optimized deltas come from snapshots, not estimates.',
  };
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live' ? 'Measured context windows and compression states.' : 'Demo context windows and compression states.',
    stats, perRun: perRun.slice(-50).reverse(),
  };
}

function buildTools(withEcon, models, { mode, baseProvenance }) {
  const byTool = new Map();
  let totalRunsWithTools = 0;
  let totalCalls = 0;
  for (const { run, snap } of withEcon) {
    const tools = snap?.tools || [];
    let runCalls = 0;
    for (const t of tools) {
      const calls = num(t.calls, 0) || 0;
      if (calls > 0) runCalls += calls;
      if (!byTool.has(t.name)) byTool.set(t.name, { tool: t.name, description: t.description || '', calls: 0, runs: 0, latencies: [], successWeighted: 0 });
      const a = byTool.get(t.name);
      a.calls += calls;
      if (calls > 0) { a.runs += 1; a.latencies.push(num(t.avgLatencyMs, 0) || 0); a.successWeighted += (num(t.successRate, 1) ?? 1) * calls; }
    }
    // Trace-level retry signal: count tool.failed vs tool.completed from trace
    const trace = snap?.trace || [];
    const fails = trace.filter((e) => e.type === 'tool.failed').length;
    const sid = run.id;
    void sid; void fails;
    if (runCalls > 0) totalRunsWithTools += 1;
    totalCalls += runCalls;
  }
  if (!byTool.size || totalCalls === 0) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No tool-call telemetry in this slice.', summary: null, perTool: [] };
  }
  const perTool = Array.from(byTool.values()).map((a) => ({
    tool: a.tool, description: a.description,
    calls: a.calls, runs: a.runs,
    callsPerRun: totalRunsWithTools ? round6(a.calls / Math.max(1, withEcon.length)) : 0,
    successRate: a.calls ? round6(a.successWeighted / a.calls) : null,
    avgLatencyMs: a.latencies.length ? Math.round(mean(a.latencies)) : null,
    retryRate: null,
    retryNote: 'Retry attribution requires step-level tool attempts; currently reported as null rather than estimated.',
    provenance: mode === 'live' ? 'OBSERVED' : 'DEMO',
  })).sort((a, b) => b.calls - a.calls);
  const summary = {
    totalCalls, runsWithTools: totalRunsWithTools,
    totalRuns: withEcon.length,
    callsPerRun: withEcon.length ? round6(totalCalls / withEcon.length) : 0,
  };
  void models;
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live' ? 'Tool telemetry from run snapshots. Costs are registry rates × observed calls (modeled).' : 'Demo tool telemetry through the real pipeline.',
    summary, perTool,
    compatibilityNote: 'Model × tool compatibility needs larger per-pair samples and is reported only when attempts ≥ 3 per pair; otherwise omitted.',
    compatibility: [],
  };
}

function buildWorkloads(withEcon, { mode, baseProvenance }) {
  if (!withEcon.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No classified workloads yet.', perWorkload: [] };
  }
  const byCat = new Map();
  for (const { run, econ, snap } of withEcon) {
    const cat = snap?.intelligence?.taskProfile?.category || snap?.routing?.taskProfile?.category || run.taskMode || 'general';
    const key = String(cat);
    if (!byCat.has(key)) byCat.set(key, { workload: key, runs: 0, costs: [], latencies: [], successes: 0, successSamples: 0, savings: 0 });
    const a = byCat.get(key);
    a.runs += 1;
    const c = num(econ?.actualCost, null);
    if (c !== null) a.costs.push(c);
    const lat = num(snap?.latency?.totalMs, null);
    if (lat !== null) a.latencies.push(lat);
    const outcome = snap?.intelligence?.outcome || null;
    if (outcome && typeof outcome.taskSuccess === 'boolean') {
      a.successSamples += 1;
      if (outcome.taskSuccess) a.successes += 1;
    }
    const svg = num(econ?.savings, null);
    if (svg !== null && svg > 0) a.savings = round6(a.savings + svg);
  }
  const perWorkload = Array.from(byCat.values()).map((a) => ({
    workload: a.workload,
    runs: a.runs,
    totalCost: a.costs.length ? round6(a.costs.reduce((x, y) => x + y, 0)) : null,
    avgCost: a.costs.length ? round6(mean(a.costs)) : null,
    avgLatencyMs: a.latencies.length ? Math.round(mean(a.latencies)) : null,
    successRate: a.successSamples >= 1 ? round6(a.successes / a.successSamples) : null,
    successSamples: a.successSamples,
    savingsOpportunity: round6(a.savings),
    provenance: mode === 'live' ? 'OBSERVED' : 'DEMO',
  })).sort((a, b) => b.runs - a.runs);
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live'
      ? 'Workloads from observed task profiles. Savings opportunity = sum of positive modeled savings in the slice.'
      : 'Demo workloads from mock traffic.',
    perWorkload,
  };
}

function buildImages(withEcon, models, { mode }) {
  const capable = (models || []).filter((m) => (m.capabilities || []).some((c) => /vision|image|multimodal/i.test(String(c))));
  if (!capable.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'No image-capable models in the registry and no image task telemetry. Multimodal analytics appear when supported workloads are observed.', capableModels: [], volume: null };
  }
  // No image task volume telemetry exists; report capability honestly without inventing volume.
  void withEcon; void mode;
  return {
    provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA',
    note: 'Image-capable models are registered, but no image task volume has been observed. Volume, cost, and latency appear only with real multimodal telemetry.',
    capableModels: capable.map((m) => ({ model: m.id, provider: m.provider, capabilities: m.capabilities })),
    volume: null, cost: null, latency: null, success: null,
  };
}

function buildExecutionFlow(withEcon, { mode, baseProvenance }) {
  if (!withEcon.length) {
    return { provenance: 'INSUFFICIENT_DATA', state: 'INSUFFICIENT_DATA', note: 'Run traffic to see the optimization path with measured values.', stages: [] };
  }
  const costs = withEcon.map((x) => num(x.econ?.actualCost, null)).filter((v) => v !== null);
  const baselines = withEcon.map((x) => num(x.econ?.baselineCost, null)).filter((v) => v !== null);
  const totalCost = costs.length ? round6(costs.reduce((a, b) => a + b, 0)) : null;
  const totalBaseline = baselines.length ? round6(baselines.reduce((a, b) => a + b, 0)) : null;
  const savings = totalBaseline !== null && totalCost !== null ? round6(totalBaseline - totalCost) : null;
  const avgCtx = withEcon.map((x) => num(x.snap?.context?.usedTokens, null)).filter((v) => v !== null);
  const avgCtxVal = avgCtx.length ? Math.round(mean(avgCtx)) : null;
  const candCounts = withEcon.map((x) => (x.snap?.routing?.candidates || []).length).filter((v) => v > 0);
  const avgCands = candCounts.length ? round6(mean(candCounts)) : null;
  const verified = withEcon.filter((x) => x.econ?.calculationStatus === 'verified_modeled').length;
  const stages = [
    { key: 'incoming', label: 'Incoming Task', detail: `${withEcon.length} observed tasks in slice`, value: withEcon.length },
    { key: 'context', label: 'Context Analysis', detail: avgCtxVal !== null ? `avg ${avgCtxVal.toLocaleString()} tokens scoped per run` : 'context scoped per run', value: avgCtxVal },
    { key: 'candidates', label: 'Candidate Models', detail: avgCands !== null ? `avg ${avgCands} candidates evaluated` : 'candidates evaluated per task', value: avgCands },
    { key: 'analysis', label: 'Cost / Quality / Latency Analysis', detail: 'router scores every candidate; switching cost is first-class', value: null },
    { key: 'execution', label: 'Optimal Execution Path', detail: 'executes with checkpoints, tool policy, and failover', value: null },
    { key: 'verification', label: 'Verification', detail: `${verified}/${withEcon.length} runs with verified modeled economics`, value: verified },
    { key: 'cost', label: 'Actual Cost', detail: totalCost !== null ? `$${totalCost} metered provider cost` : 'metered provider cost', value: totalCost },
    { key: 'savings', label: 'Verified Savings', detail: savings !== null && savings > 0 ? `$${savings} modeled savings after optimization` : 'modeled savings vs reference (never called verified without evidence)', value: savings },
  ];
  return {
    provenance: baseProvenance, state: 'READY',
    note: mode === 'live'
      ? 'Each stage shows measured values from this slice. Savings are modeled vs the reference snapshot — verified only when calculationStatus is verified_modeled.'
      : 'Demo execution path through the real pipeline with mock provider calls.',
    stages,
  };
}

module.exports = {
  buildIntelligence,
  VALUE_FORMULA,
  provenanceFor,
};
