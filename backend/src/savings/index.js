'use strict';

const {
  SavingsEngine,
  getReferenceModel,
  getPricingForModel,
  extractStepsFromRun,
  calculateStepBaselineCost,
  calculateStepActualCost,
  determineSavingsStatus,
  validatePricing,
  round6,
  SavingsStatus,
  addBillingFields,
  DEFAULT_PLATFORM_FEE_PCT,
} = require('./savings-engine');

module.exports = {
  SavingsEngine,
  getReferenceModel,
  getPricingForModel,
  extractStepsFromRun,
  calculateStepBaselineCost,
  calculateStepActualCost,
  determineSavingsStatus,
  validatePricing,
  round6,
  SavingsStatus,
  addBillingFields,
  DEFAULT_PLATFORM_FEE_PCT,
};
