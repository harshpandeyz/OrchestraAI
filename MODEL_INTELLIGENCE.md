# MODEL_INTELLIGENCE.md — Session 2 surface consumed by the console

- `GET /api/models` returns the registry. Frontend MUST NOT hard-code a catalog; render only this.
- Routing: backend owns scoring (`quality, cost, latency, reliability, contextFit, switchCost`).
  Snapshot `routing.candidates[]` + `routing.decision` (Decision object with `factors[]`, `alternatives[]`) is the ONLY source for the "Why this model?" panel and routing bars.
- Health/pricing stream via `price.updated` events and `cost.updated` events. Frontend never computes prices.
- Model switch appears as `model.switched` (or `model.retained`) events with `payload: { fromId, toId, reason, factors }`.
