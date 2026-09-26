# OrchestraAI — Observability Export (OTLP)

Optional, off-by-default OpenTelemetry export alongside
`backend/src/telemetry/telemetry-collector.js`. When disabled (the default),
the runtime behaves exactly as before — the collector is untouched and no
traffic leaves the process.

Enable with:

```bash
OTLP_ENABLED=1 \
OTLP_ENDPOINT=https://collector.example:4318/v1/traces \
OTLP_HEADERS="authorization=Bearer …,org=default" \
OTLP_TIMEOUT_MS=5000 \
node backend/server.js
```

Zero new dependencies: the exporter (`backend/src/telemetry/otlp-exporter.js`)
POSTs OTLP/JSON over plain Node `http`/`https`. No SDK.

---

## Event → span mapping (GenAI semantic conventions)

Each `TelemetryEvent` becomes one OTel `INTERNAL` span:

| TelemetryEvent field | Span field |
|---|---|
| `runId` | `traceId` = `sha256("trace:"+runId)[0:32]` (all spans of a run share a trace) |
| `eventId` | `spanId` = `sha256("span:"+eventId)[0:16]` |
| `stepId` | `parentSpanId` = span id of `step-<stepId>` (when present) |
| `type` + `tool`/`model`/`decision` | `name`: `tool.<name>` for tool events, `gen_ai.<type>` for model events, `orchestra.routing` for decisions, else `orchestra.<type>` |
| `timestamp` (ISO) | `startTimeUnixNano`; `endTime = start + latency.total` |
| `model` | `gen_ai.request.model` |
| `provider` | `gen_ai.provider.name` |
| `tokens.input/output/cached` | `gen_ai.usage.input_tokens` / `output_tokens` / `cached_tokens` |
| `latency.total` (ms) | `orchestra.latency_ms` (int) |
| `cost.total` (USD) | `orchestra.cost_usd` (double) |
| `tool` | `orchestra.tool.name` |
| `decision` / `decisionReason` | `orchestra.routing.decision` / `orchestra.routing.reason` |
| `stepId` | `orchestra.step_id` |
| `status` | `orchestra.status`; non-`success` sets OTel `status.code = ERROR` with `orchestra.error` |
| — | `resource.attributes["service.name"] = "orchestraai"`, `scope.name = "orchestraai-telemetry"` |

Secrets never export: `TelemetryEvent` payloads pass through the existing
secret-redaction layer before collection, and the exporter only reads the
fields above (never raw provider keys, session tokens, or request bodies).

## Failure semantics

- Exporter disabled → `export()` returns `{ skipped: 'disabled' }`, no I/O.
- Empty batch → `{ skipped: 'empty' }`.
- Non-2xx collector response → throws `{ code: 'export_failed' }` (logged, never crashes the run).
- Timeout (default 5s, max 15s) → throws `{ code: 'timeout' }`.

## What is NOT exported

Run inputs/outputs beyond the bounded snapshot fields above, provider
credentials, session cookies, workspace file contents, and evaluation raw
evidence. The exporter is a telemetry bridge, not a data pipeline.
