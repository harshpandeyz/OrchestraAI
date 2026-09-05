'use strict';

// Billing is intentionally a thin consumer of SavingsEngine output. It owns
// periods, invoice state and presentation; it never recalculates savings.

const { round6 } = require('./savings');

function periodFor(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fromSavings(savings, options = {}) {
  const result = savings || {};
  const known = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const fee = known(result.platformFee);
  const actual = known(result.actualCost);
  const finalCost = Number.isFinite(Number(result.customerFinalCost))
    ? Number(result.customerFinalCost) : (actual !== null && fee !== null ? actual + fee : null);
  const calculationStatus = ['verified_modeled', 'insufficient_data', 'incomplete'].includes(result.calculationStatus)
    ? result.calculationStatus
    : result.status === 'incomplete_run' ? 'incomplete'
      : result.status === 'insufficient_pricing_data' ? 'insufficient_data' : 'verified_modeled';
  const modeledSavings = known(result.savings);
  const economicOutcome = result.economicOutcome || (calculationStatus === 'verified_modeled' && modeledSavings !== null
    ? modeledSavings > 0 ? 'saved' : modeledSavings < 0 ? 'cost_increase' : 'unchanged'
    : null);
  return {
    period: options.period || periodFor(options.date),
    currency: result.currency || 'USD',
    status: result.status || 'insufficient_pricing_data',
    calculationStatus,
    economicOutcome,
    economicsStatus: result.economicsStatus || 'not_eligible',
    invoiceStatus: result.invoiceStatus || 'not_invoice_reconciled',
    baselineCost: known(result.baselineCost),
    optimizedProviderCost: actual,
    eligibleSavings: known(result.eligibleSavings),
    modeledSavings,
    platformFeePct: Number(result.platformFeePct) || 0,
    platformFee: fee,
    customerFinalCost: finalCost === null ? null : round6(finalCost),
    customerNetSavings: Number.isFinite(Number(result.customerNetSavings))
      ? Number(result.customerNetSavings)
      : (Number.isFinite(Number(result.baselineCost)) && finalCost !== null ? round6(Number(result.baselineCost) - finalCost) : null),
    source: 'SavingsEngine',
    reconciliation: 'modeled_only',
  };
}

function aggregate(entries, options = {}) {
  const rows = (entries || []).map((entry) => fromSavings(entry.savings || entry, {
    period: entry.period || options.period,
    date: entry.date,
  }));
  const sum = (key) => {
    const values = rows.map((row) => Number(row[key])).filter((value) => Number.isFinite(value));
    return values.length ? round6(values.reduce((n, value) => n + value, 0)) : null;
  };
  const count = (status) => rows.filter((row) => row.calculationStatus === status).length;
  const verifiedCount = count('verified_modeled');
  const positiveModeledSavings = round6(rows.reduce((n, row) => n + Math.max(0, Number(row.modeledSavings) || 0), 0));
  const negativeModeledImpact = round6(rows.reduce((n, row) => n + Math.min(0, Number(row.modeledSavings) || 0), 0));
  return {
    period: options.period || periodFor(options.date),
    currency: 'USD',
    runCount: rows.length,
    baselineCost: sum('baselineCost'),
    optimizedProviderCost: sum('optimizedProviderCost'),
    eligibleSavings: sum('eligibleSavings'),
    platformFee: sum('platformFee'),
    customerFinalCost: sum('customerFinalCost'),
    customerNetSavings: sum('customerNetSavings'),
    savingsRate: sum('baselineCost') > 0 && sum('eligibleSavings') !== null
      ? round6(sum('eligibleSavings') / sum('baselineCost')) : null,
    dataQuality: {
      verifiedCount,
      insufficientCount: count('insufficient_pricing_data'),
      incompleteCount: count('incomplete_run'),
      noSavingsCount: rows.filter((row) => row.economicOutcome === 'unchanged').length,
      costIncreaseCount: rows.filter((row) => row.economicOutcome === 'cost_increase').length,
      coverageRate: rows.length ? round6(verifiedCount / rows.length) : 0,
    },
    positiveModeledSavings,
    negativeModeledImpact,
    invoiceStatus: 'not_invoice_reconciled',
    source: 'SavingsEngine',
    lineItems: rows,
  };
}

module.exports = { periodFor, fromSavings, aggregate };
