# FRONTEND.md — OrchestraAI Console (Session 4)

## Architecture
- `frontend/` — Vite + React 18 + TypeScript. No chart/map libs; all visualizations are div/SVG bars (offline-safe, no fake telemetry).
- `backend/` — zero-dependency Node HTTP stub implementing the Session 1–3 contracts (`ARCHITECTURE.md`, `CONTRACTS.md`) so the console runs live end-to-end. Replace with the real runtime in Session 5 without touching components (only `src/api/client.ts` base URL).
- Types in `src/types.ts` mirror `CONTRACTS.md` verbatim and are the only schema.

## Component structure
- `App.tsx` — boot (loads runs/models/tools/memory/evals, selects active run, loads snapshot), top bar (brand, shell LIVE/DEMO mode badge from snapshot `meta.mode` with `/api/health` fallback, connection pill, ⌘K, theme toggle, inspector toggle, New Run), three-panel shell, view router, toasts, drawer scrim. Narrow screens (≤980px) start with both drawers closed so center stays primary; ≤560px hides the shell mode badge (mode stays visible per-run in the header) and compacts topbar actions so nothing clips.
- `components/LeftPanel.tsx` — New Run button, WORKSPACE (run search from 2+ runs, active-run card with live status/spend, run rows with status dot + rel-time + spend + model tag) / RUNTIME (models, tools, memory, evals with live counts) / SYSTEM (providers → settings `#settings-providers` anchor, settings) + shortcut hints. `settingsAnchor` in store state distinguishes the two SYSTEM entries.
- `components/Center.tsx` — `RunHeader` (title, status pill, LIVE/DEMO pill, model pill, budget bar with spent/budget, elapsed timer, Stop/Retry), `MessageList` (dependency-free safe markdown: code blocks, tables, lists, quotes; pinned auto-scroll so history reading never jumps; streaming cursor; copy buttons; 150-message render cap), `Composer` (multiline, Enter-to-send, explicit READY/RUNNING/STOPPING/ERROR/COMPLETED state, `/` focuses).
- `components/Inspector.tsx` — 14 runtime sections with quick-nav: Current model (hero), Why this model? (score + factors + alternatives + decision), Model switches (old→new flow + rejected), Context (utilization + threshold + segments + growth chart), Cache (HIT/MISS/INVALIDATED feed), Memory (expandable), Tools (ACTIVE/AVAILABLE/RECENT), Cost (breakdown bars + budget), Latency (samples + series), Model routing (factor bars), Run history (backend `series` only), Execution trace (filterable, expandable), Runtime decisions, What changed? Charts (`SvgLine` with hover tooltip + min/latest/max, thresholds) render backend telemetry only, with no-data states.
- `pages/pages.tsx` — Models (sort: quality/cost/latency/context/reliability + healthy filter, cards), Tools (enabled filter, BLOCKED/RUNNING states), Memory (scope filter, importance sort, cards), Evaluations (pass/fail table, empty by design), Settings (appearance, composer defaults, shortcuts; secrets never rendered).
- `components/CommandPalette.tsx` — Ctrl/⌘+K search across runs, models, tools, memories plus actions (New run, Focus composer, Toggle inspector, Open *, Switch theme). Arrow/Enter/Esc keyboard flow. All hooks above the closed-state early return (regression-tested).

## State management
- `state/store.tsx` — `RuntimeProvider` with `useReducer`. **Server state** (runs, snapshot, models, tools, memory, conn, sending) and **UI state** (view, settingsAnchor, drawers, expanded sections, selection, queries, palette) are separate slices. Progressive disclosure by default: model/why/switch/context/cache/tools/cost/latency/trace open; memory/routing/history/decisions/changes collapsed. `applyEventToSnapshot` is a pure function (unit-tested) mapping every SSE type to snapshot updates; reducer dedupes by `seq`.
- `hooks/useEventStream.ts` — `EventSource` on `/api/runs/:id/events?since=<lastSeq>`, exponential-backoff reconnect, `: ping` keepalive tolerance. `freshnessLabel` → LIVE (<30s) / STALE / DISCONNECTED / UNKNOWN; stale banner shows last-update timestamp and data is never presented as current.

## Runtime event handling
Snapshot first (`GET state` → `lastSeq`), then SSE stream with `since` replay (backend keeps a 500-event per-run buffer). `response.delta` appends to a streaming assistant message; `response.done` finalizes it. Tool start/finish flips per-tool `lastStatus` and appends mono tool rows. Model/routing/context/cache/cost/memory events update only their slice.

## API layer
`src/api/client.ts` — the only module that calls `fetch`: `getRuns/getRun/getState/sendMessage/cancelRun/retryRun/getModels/getTools/getMemory/getEvaluations/streamUrl`. Cancel/retry/pause-equivalent controls call backend endpoints only.

## Three-panel design
CSS grid `240px 1fr 360px`; center max-width 860px; inspector is a dense card stack with collapsible sections. Narrow screens (<980px): left/right become slide-over drawers, center stays primary. Desktop layout untouched.

## Performance strategy
Normalized snapshot, single reducer pass per event, `useMemo` on trace/timeline, SSE deltas mutate only the streaming message, trace/changes capped (200/100), sparkline slices last 24 samples, no full-page refreshes, no per-event full-tree rerender beyond context propagation.

## Responsive / accessibility
Breakpoints at 1200px and 980px; keyboard: Enter-to-send, ⌘K palette, Esc closes, all sections are `<button>`-toggled with `aria-expanded`, feed is `role=log aria-live=polite`, focus-visible rings, semantic colors with text labels (not color-only), `prefers-reduced-motion` disables animation.

## Testing
`npm test` (vitest, jsdom): `runtime.test.ts` (delta streaming, backend alias handling `fromModel`/`toModel`/`toolName`, model-decision capture, message cap, seq dedupe, freshness labels, failure states), `inspector.test.tsx` (inspector sections render from backend data, markdown code/table rendering, switch banner, API surface, composer labels), `palette.test.tsx` (Ctrl+K toggle regression: no hooks after early return), `center.test.tsx`, `settings.test.tsx`. 51 tests, all passing. `npm run build` (tsc + vite) passes. Browser-verified via headless Chrome (Playwright CDP, zero console errors, no document h-overflow at 390/768/1440): sidebar New Run, send→complete, inspector hero + why-model, palette search + ArrowUp/Down + Esc, models/tools/memory/evals/settings pages, providers anchor, light + dark themes.

## OrchestraAI product layer
- Brand: OrchestraAI everywhere (console, title, favicon, health `service: orchestraai`, `OPENROUTER_APP_NAME=orchestraai`). Identity is orchestration green (primary) + calm sky (secondary) on warm neutrals — no generic AI-purple. Theme key `orchestra-theme` (migrates `aar-theme`); **light-first** friendly design system, warm dark theme one toggle away (`?theme=dark|light` deep-link supported).
- Run header carries a **journey strip** (Task → Context → Model → Execute → Done) derived only from real snapshot state (`journeySteps` in `Center.tsx`, unit-tested). Terminal runs show a **FINAL** pill (topbar + inspector) instead of STALE — completed history is final, not ageing; only a real stream error still shows DISCONNECTED.
- Terminal-run honesty: composer disables on completed/cancelled/failed with a contextual hint (send would 409); cancelled copy points to New Run (retry/cancel-resume are backend-rejected); failed copy points to Retry.
- Settings gained a **Providers & runtime** card backed by real `GET /api/health` + `GET /api/config`: LIVE/DEMO, provider id, credential presence (never values), discovery state, run guardrails — with honest loading/error states.

## What Session 5 must expose for complete integration
1. Real `GET /api/runs/:id/state` snapshots in the exact `RuntimeSnapshot` shape (especially `routing.decision.factors`, `context.items[].status`, `cache.recent`).
2. Live SSE at `/api/runs/:id/events` with `seq`, `since` replay, and `price.updated` / `memory.write` / `model.switched` events.
3. `POST cancel/retry` (and pause/resume if added — frontend will bind, never invents).
4. `GET /api/evaluations` real metrics (page already renders any array it returns).
5. Auth for any dangerous actions; frontend must never receive provider secrets — keep redaction server-side (`memory.snippet` must stay safe to render).
