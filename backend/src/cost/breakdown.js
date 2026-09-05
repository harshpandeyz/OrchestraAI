'use strict';

// Session 1 — normalized cost accounting (one semantic, backward compatible).
//
// Legacy estimator shape (category map + total) is preserved for existing
// consumers, but every model call ALSO produces a normalized breakdown:
//
//   CostBreakdown {
//     inputTokens, cachedInputTokens, outputTokens, reasoningTokens,
//     toolCosts, totalUsd, currency, provider, model
//   }
//
// Rule: total request cost is NEVER classified as OUTPUT_TOKENS. Input,
// cached input, output, reasoning, and tool costs are tracked as distinct
// categories; the total is their sum.

const { CostCategory } = require('../core/types');

function round6(n) {
  return Math.round(Number(n || 0) * 1e6) / 1e6;
}

// Build a normalized breakdown from token counts + per-1k pricing + tool cost.
function normalizeModelCost({ inputTokens = 0, cachedTokens = 0, outputTokens = 0, reasoningTokens = 0, toolCosts = 0, pricing = {}, provider = null, model = null } = {}) {
  const inputPer1k = Number(pricing.inputPer1k) || 0;
  const cachedPer1k = pricing.cachedPer1k ?? inputPer1k;
  const outputPer1k = Number(pricing.outputPer1k) || 0;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const inputCost = (uncached / 1000) * inputPer1k;
  const cachedCost = (cachedTokens / 1000) * (Number(cachedPer1k) || 0);
  const outputCost = (outputTokens / 1000) * outputPer1k;
  // Reasoning tokens (when reported) price at output rates; unknown -> 0.
  const reasoningCost = (reasoningTokens / 1000) * outputPer1k;
  const tools = Number(toolCosts) || 0;
  const totalUsd = inputCost + cachedCost + outputCost + reasoningCost + tools;
  return {
    // inputTokens counts UNCACHED tokens only (total - cached) so categories
    // never double-count: input(800) + cached(200) = total(1000).
    inputTokens: { tokens: uncached, costUsd: round6(inputCost) },
    cachedInputTokens: { tokens: cachedTokens, costUsd: round6(cachedCost) },
    outputTokens: { tokens: outputTokens, costUsd: round6(outputCost) },
    reasoningTokens: { tokens: reasoningTokens, costUsd: round6(reasoningCost) },
    toolCosts: { costUsd: round6(tools) },
    totalUsd: round6(totalUsd),
    currency: 'USD',
    provider,
    model,
  };
}

// Merge a normalized breakdown into the legacy category map (for snapshots
// that still render per-category bars). Total is kept OUT of OUTPUT_TOKENS.
function toLegacyCategories(normalized) {
  return {
    [CostCategory.INPUT_TOKENS]: normalized.inputTokens.costUsd,
    [CostCategory.CACHED_INPUT_TOKENS]: normalized.cachedInputTokens.costUsd,
    [CostCategory.OUTPUT_TOKENS]: normalized.outputTokens.costUsd,
    ...(normalized.reasoningTokens.tokens > 0 ? { reasoning_tokens: normalized.reasoningTokens.costUsd } : {}),
    ...(normalized.toolCosts.costUsd > 0 ? { [CostCategory.TOOL_EXECUTION]: normalized.toolCosts.costUsd } : {}),
    total: normalized.totalUsd,
  };
}

module.exports = { normalizeModelCost, toLegacyCategories, round6 };
