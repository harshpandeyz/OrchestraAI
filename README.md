# OrchestraAI — Adaptive Agent Runtime

Three-panel **OrchestraAI console**: runs on the left, agent workspace in the
center, runtime intelligence on the right.

The backend is now a real end-to-end runtime (Session 5): user task → context →
model routing → real provider call (OpenRouter/OpenAI/Anthropic) or explicit
DEMO mock → tool execution → memory/cache/telemetry → SSE → reevaluate →
complete. See `ARCHITECTURE.md` / `CONTRACTS.md` / `.env.example`.

## Run it
```bash
cp .env.example .env   # fill in OPENROUTER_API_KEY for LIVE mode; without keys the server runs in labelled DEMO mode

# terminal 1 — runtime API + SSE
npm start          # :8787 (RUNTIME_MODE=live iff provider credentials exist, else demo)

# terminal 2 — console
cd frontend && npm install && npm run dev   # :5173 (proxies /api → :8787)
```
Production: `cd frontend && npm run build` → `frontend/dist`, which the runtime serves itself on :8787 (one port: console + API). Docker: `docker build -t orchestraai .` (Dockerfile provided; requires a running Docker daemon).

## Test it
```bash
npm test                 # backend unit tests (40)
npm run test:integration # full API→completion integration suite (32: A–U + 10 scenarios)
cd frontend && npm test  # console tests (8)
```

## Modes
- `LIVE`: real provider calls. The active model always comes from Model Intelligence (registry + router); catalog aliases resolve to provider-native IDs; unknown provider IDs fail honestly with configuration guidance — never fake success.
- `DEMO`: deterministic mock provider, explicitly labelled in `/api/health`, every snapshot (`meta.mode`), and the UI badge. Same agent loop, same real tools — only the model call is mocked. Used for tests and offline development.

## Event naming (canonical)
Dotted lowercase (`model.switched`, `memory.written`, `tool.completed`, `tool.failed`, `cost.updated`, `price.updated`). The frontend additionally accepts legacy aliases `tool.finished` and `memory.write` (Session 4 names); the backend only emits canonical names.

## Docs
- `ARCHITECTURE.md` / `CONTRACTS.md` / `MODEL_INTELLIGENCE.md` / `CONTEXT_MEMORY_CACHE.md` — backend contracts consumed (Sessions 1–3 surface).
- `FRONTEND.md` — console architecture, state, events, testing, and Session 5 integration list.
