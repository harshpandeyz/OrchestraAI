# CONTEXT_MEMORY_CACHE.md — Session 3 surface consumed by the console

- Context snapshot: `context.usedTokens/windowTokens`, `segments[]` (percent composition), `items[]` with `status: KEEP|COMPRESSED|ARCHIVED|REMOVED`, each `{ id, kind, title, source, tokens, relevance }`.
- Compression appears as `context.compressed` events `{ reclaimedTokens, items }`; frontend only visualizes.
- Cache snapshot: `cache.*` + `recent[]` (`cache.hit|miss|invalidated`). Never invent hit rates.
- Memory: `GET /api/memory` + snapshot `memory.{working,longterm}`; writes/evictions arrive as `memory.write|memory.evicted` events. Respect `status`; never render secrets (backend redacts; `snippet` is safe to show).
