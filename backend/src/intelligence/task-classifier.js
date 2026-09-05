'use strict';

// Deterministic, explainable task classification (§6).
//
// Rule-based only: no LLM calls, no network, no randomness. Given the same
// task text the classifier always returns the same TaskProfile, and every
// decision carries its triggering signals so the UI can show "why debug".
//
// Categories: general | code | debug | research | analysis | writing |
// extraction | planning

const { VERSIONS } = require('./versions');

const CATEGORIES = Object.freeze([
  'general', 'code', 'debug', 'research', 'analysis', 'writing', 'extraction', 'planning',
]);

const COMPLEXITIES = Object.freeze(['trivial', 'simple', 'medium', 'complex']);
const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

// Each rule: category, test on lowercase text, weight, human-readable signal.
const RULES = [
  // debug — error/failure language + fix intent + code references
  { category: 'debug', weight: 3, signal: 'error/exception language', test: (t) => /(error|exception|traceback|stack ?trace|failed|failing|failure|bug|crash|broken|regression|stack ?overflow)\b/.test(t) },
  { category: 'debug', weight: 2, signal: 'asks to identify/fix failure', test: (t) => /\b(fix|debug|diagnose|repro(duce)?|root ?cause|why (does|is|doesn|isn)|not working|doesn'?t work)\b/.test(t) },
  { category: 'debug', weight: 1, signal: 'code/file references', test: (t) => /[\w\-./]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|rb|php|css|html)|line \d+|assertion|test.+fail|fail.+test/.test(t) },
  // code — build/implement intent
  { category: 'code', weight: 3, signal: 'implement/build intent', test: (t) => /\b(implement|build|create (a |an )?(function|component|class|module|api|endpoint|script)|write (code|a function|a script)|refactor)\b/.test(t) },
  { category: 'code', weight: 2, signal: 'code artifact mention', test: (t) => /\b(function|class|module|api|endpoint|component|pull request|commit|branch|deploy)\b/.test(t) },
  { category: 'code', weight: 1, signal: 'file/path references', test: (t) => /[\w\-./]+\.(ts|tsx|js|jsx|py|go|rs)|src\/|lib\/|test\.|spec\./.test(t) },
  // research — fresh/external information
  { category: 'research', weight: 3, signal: 'research/investigate language', test: (t) => /\b(research|investigate|survey|compare .*(approach|framework|library|tool)|what (is|are) the (latest|best|current)|literature)\b/.test(t) },
  { category: 'research', weight: 2, signal: 'external source request', test: (t) => /\b(search (the )?web|find (docs|documentation|examples)|cite|sources?|according to)\b/.test(t) },
  { category: 'research', weight: 1, signal: 'freshness language', test: (t) => /\b(latest|recent|current|as of 202\d|up[- ]to[- ]date|new (release|version))\b/.test(t) },
  // analysis — data/reasoning over provided material
  { category: 'analysis', weight: 3, signal: 'analysis request', test: (t) => /\b(analy[sz]e|analysis|evaluate|assess|review (this|the)|summarise|summarize|explain (this|the|why))\b/.test(t) },
  { category: 'analysis', weight: 1, signal: 'data/evidence mention', test: (t) => /\b(data|metrics?|results?|logs?|report|dataset|telemetry)\b/.test(t) },
  // writing — prose generation
  { category: 'writing', weight: 3, signal: 'writing/generation intent', test: (t) => /\b(write|draft|compose|blog|essay|email|readme|document(ation)?|announcement|release notes)\b/.test(t) },
  // extraction — structured pull-out
  { category: 'extraction', weight: 3, signal: 'extraction intent', test: (t) => /\b(extract|parse|list (all|the)|pull out|as json|structured|table of|key[- ]value)\b/.test(t) },
  // planning — multi-step breakdown
  { category: 'planning', weight: 3, signal: 'planning language', test: (t) => /\b(plan|roadmap|steps|break down|breakdown|milestones?|task list|strategy|design (the )?(plan|approach))\b/.test(t) },
];

// Strong tool signal: a verb acting on a toolable object ("run the tests",
// "read auth/service.ts"). A bare keyword ("Test task") is not enough —
// otherwise every mention of the word "test" would claim tool requirements.
const TOOL_STRONG = /\b(run|execute|invoke|call|apply|search|read|open|inspect|test|check|build|deploy|use|using)\b[^.\n]{0,40}\b(tests?|suite|spec|file|code|tool|search|docs?|service|endpoint|repo|database|server)\b/i;

const LONG_CONTEXT_HINTS = [
  /whole (repo|codebase|project)/i,
  /all files/i,
  /large|huge|entire/i,
  /compare .* files?/i,
  /migrat/i,
];

const REASONING_HINTS = [
  /why|prove|trade-?off|compare|decide|design|architect|algorithm|complexity|proof/i,
  /step[- ]by[- ]step|think through/i,
];

const FRESH_INFO_HINTS = [
  /latest|recent|current|as of|today|news|release|version \d|docs|documentation/i,
  /search the web|up[- ]to[- ]date/i,
];

function classifyTask(input = {}) {
  const raw = typeof input === 'string' ? input : (input.text || input.objective || '');
  const text = String(raw || '');
  const t = text.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);

  const scores = {};
  const signalsByCategory = {};
  for (const c of CATEGORIES) { scores[c] = 0; signalsByCategory[c] = []; }
  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.test(t); } catch { hit = false; }
    if (hit) {
      scores[rule.category] += rule.weight;
      signalsByCategory[rule.category].push(rule.signal);
    }
  }

  let category = 'general';
  let best = 0;
  for (const c of CATEGORIES) {
    if (c === 'general') continue;
    if (scores[c] > best) { best = scores[c]; category = c; }
  }
  // Deterministic tie-break: fixed category priority order.
  const priority = ['debug', 'code', 'extraction', 'planning', 'research', 'analysis', 'writing'];
  for (const c of priority) {
    if (c !== category && scores[c] === best && best > 0) {
      // keep existing winner unless the priority category strictly outranks
      // by appearing earlier in priority order AND winner is later.
      if (priority.indexOf(c) < priority.indexOf(category)) category = c;
    }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  // Confidence: share of the winning score, floored when no signal fired.
  // No signal -> general with low confidence (honest "unknown-ish").
  const confidence = best <= 0
    ? 0.35
    : Math.round(Math.min(0.95, 0.5 + (best / Math.max(total, 1)) * 0.45) * 100) / 100;

  const signals = best <= 0 ? ['no strong category signals; defaulted to general'] : signalsByCategory[category].slice();

  const requiresTools = TOOL_STRONG.test(text) ||
    category === 'debug' || category === 'code' || category === 'extraction';
  const requiresLongContext = LONG_CONTEXT_HINTS.some((re) => re.test(text)) ||
    category === 'planning' || words.length > 400;
  const requiresReasoning = REASONING_HINTS.some((re) => re.test(text)) ||
    category === 'debug' || category === 'planning' || category === 'analysis';
  const requiresFreshInformation = FRESH_INFO_HINTS.some((re) => re.test(text)) ||
    category === 'research';

  // Complexity: deterministic from length + multi-intent signals.
  const distinctHitCategories = CATEGORIES.filter((c) => c !== 'general' && scores[c] > 0).length;
  let complexity = 'simple';
  const lengthScore = words.length > 200 ? 2 : words.length > 60 ? 1 : 0;
  const breadth = distinctHitCategories >= 3 ? 2 : distinctHitCategories === 2 ? 1 : 0;
  const sum = lengthScore + breadth + (category === 'debug' || category === 'planning' ? 1 : 0);
  if (sum >= 4) complexity = 'complex';
  else if (sum >= 2) complexity = 'medium';
  else if (words.length <= 8 && distinctHitCategories <= 1) complexity = 'trivial';

  const riskLevel = /\b(delete|drop|production|prod|deploy|migrat|schema|payment|billing|auth|secret|password|rm -rf|force push)\b/.test(t)
    ? 'high'
    : (requiresTools || complexity === 'complex' ? 'medium' : 'low');

  const expectedOutputType = category === 'extraction' ? 'structured'
    : category === 'code' || category === 'debug' ? 'code'
    : category === 'writing' ? 'prose'
    : category === 'planning' ? 'plan'
    : category === 'research' || category === 'analysis' ? 'report'
    : 'text';

  const estimatedSteps = complexity === 'trivial' ? 1
    : complexity === 'simple' ? 2
    : complexity === 'medium' ? 4 : 7;

  return {
    category,
    complexity,
    requiresTools,
    requiresLongContext,
    requiresReasoning,
    requiresFreshInformation,
    expectedOutputType,
    riskLevel,
    estimatedSteps,
    confidence,
    signals,
    scores: { ...scores },
    classifierVersion: VERSIONS.taskClassifier,
  };
}

module.exports = { classifyTask, CATEGORIES, COMPLEXITIES, RISK_LEVELS };
