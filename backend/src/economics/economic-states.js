'use strict';

// Canonical economic states (Agent 2).
//
// Six quantities that must never be conflated:
//   estimated         — pre-call forecast (cost estimator / router objective)
//   observed          — provider-reported usage x captured pricing (post-call)
//   modeled_baseline  — reference-model repricing of observed usage
//   modeled_savings   — baseline minus observed (model output, not money moved)
//   verified_savings  — modeled savings on a completed run with full pricing
//   invoice_reconciled— provider invoice truth (outside this runtime; stored,
//                       never computed here)
//
// The canonical model-call record (canonical-record.js) remains the single
// source of truth for per-call costs. This module only labels values so
// callers cannot mistake one state for another, and derives cache monetary
// value from an explicit pricing snapshot (never a hardcoded rate).

const { round6 } = require('../cost/breakdown');

const ECONOMIC_KINDS = Object.freeze([
  'estimated',
  'observed',
  'modeled_baseline',
  'modeled_savings',
  'verified_savings',
  'invoice_reconciled',
]);

function label(kind, amountUsd, basis = null) {
  if (!ECONOMIC_KINDS.includes(kind)) throw new Error(`unknown economic kind: ${kind}`);
  const amount = amountUsd === null || amountUsd === undefined || amountUsd === ''
    ? null : Number(amountUsd);
  return {
    kind,
    amountUsd: amount === null || !Number.isFinite(amount) ? null : round6(amount),
    basis: basis || null,
  };
}

// Cache monetary value from an explicit pricing snapshot. Pricing must carry
// inputPer1k/cachedPer1k; without it the value is 0 labelled 'unpriced' —
// never a hardcoded dollars-per-token constant.
function cacheValueUsd({ reusedTokens = 0, pricing = null } = {}) {
  const tokens = Math.max(0, Math.floor(Number(reusedTokens) || 0));
  const inputPer1k = pricing ? Number(pricing.inputPer1k) : NaN;
  const cachedPer1k = pricing ? Number(pricing.cachedPer1k) : NaN;
  if (!Number.isFinite(inputPer1k) || inputPer1k < 0) {
    return { valueUsd: 0, reusedTokens: tokens, basis: 'unpriced (no input pricing)' };
  }
  const cached = Number.isFinite(cachedPer1k) && cachedPer1k >= 0 ? cachedPer1k : inputPer1k;
  const value = Math.max(0, (((inputPer1k - cached) * tokens) / 1000));
  return { valueUsd: round6(value), reusedTokens: tokens, basis: 'pricing snapshot (input minus cached rate)' };
}

// Keep the six states side by side for a run ledger. Each slot holds a
// label() envelope or null. No slot is ever derived from another implicitly.
function summarizeRunEconomics(slots = {}) {
  const out = {};
  for (const kind of ECONOMIC_KINDS) {
    const v = slots[kind] === undefined ? null : slots[kind];
    out[kind] = v === null ? null : (v && v.kind ? v : label(kind, v.amountUsd ?? v, v.basis ?? null));
  }
  return out;
}

module.exports = { ECONOMIC_KINDS, label, cacheValueUsd, summarizeRunEconomics };
