'use strict';

// Intelligence facade (§43): task -> profile -> memory/context -> prompt plan
// -> candidates -> performance -> router -> decision+reasons -> execution ->
// outcome -> evaluator -> learning store -> future routing.

const { VERSIONS } = require('./versions');
const { classifyTask } = require('./task-classifier');
const { buildCapabilityProfile, compareProfiles } = require('./capability-profile');
const { ModelPerformanceStore, RoutingHistoryStore } = require('./performance-store');
const { evaluateOutcome, createCriterion, createEvidence, outcomeToLearningUpdate, EVALUATOR_VERSION } = require('./outcome-evaluator');
const contextEngine = require('./context-engine');
const memoryIntel = require('./memory-intelligence');
const { SemanticCacheIndex } = require('./semantic-cache');
const routerIntel = require('./router-intelligence');
const { BenchmarkStore } = require('./benchmarks');
const { IntelligenceStore } = require('./intelligence-store');

module.exports = {
  VERSIONS,
  EVALUATOR_VERSION,
  classifyTask,
  buildCapabilityProfile,
  compareProfiles,
  ModelPerformanceStore,
  RoutingHistoryStore,
  evaluateOutcome,
  createCriterion,
  createEvidence,
  outcomeToLearningUpdate,
  contextEngine,
  memoryIntel,
  SemanticCacheIndex,
  routerIntel,
  BenchmarkStore,
  IntelligenceStore,
};
