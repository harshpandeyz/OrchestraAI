'use strict';
// DEMO fixtures only — NOT on the production execution path.
//
// These files are the preserved Session 2/3/4 exploratory implementations and the
// scripted `simulate.js` sequence. They are kept for reference and isolated
// demo tests. The live runtime (backend/server.js + backend/src/**) MUST NOT
// require anything from this directory.
//
// Canonical production modules:
//   provider access  -> backend/src/providers/provider-adapter.js
//   model discovery  -> backend/src/providers/model-discovery.js
//   model registry   -> backend/src/impl/model-registry.js
//   model routing    -> backend/src/impl/model-router.js
//   context/memory/cache/tools -> backend/src/impl/*
//   execution        -> backend/src/core/orchestrator.js
//
// NOTE: backend/demo/provider_adapter.js is known-broken (syntax errors) and is
// retained untouched as an archive artifact. Do not import it.

module.exports = {};
