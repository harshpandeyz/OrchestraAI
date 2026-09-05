'use strict';

// Intelligence data versioning (§38).
//
// Every learned artifact records the policy that produced it so runs can be
// reproduced and compared across versions. Bump a version only when its
// algorithm's semantics change (not on every edit).

const VERSIONS = Object.freeze({
  routingPolicy: 'routing-policy-v2',
  taskClassifier: 'task-classifier-v1',
  performanceEstimator: 'performance-estimator-v1',
  evaluator: 'outcome-evaluator-v2',
  evidenceLedger: 'evidence-ledger-v1',
  memorySchema: 'memory-schema-v2',
  compression: 'compression-v2',
  contextScoring: 'context-scoring-v2',
  memoryRetrieval: 'memory-retrieval-v2',
  semanticCache: 'semantic-cache-v1',
});

module.exports = { VERSIONS };
