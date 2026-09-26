'use strict';

const assert = require('assert');
const { TelemetryEvent } = require('../src/telemetry/telemetry-collector');
const { OtlpExporter, toSpan, toOtlp, isEnabled, spanName } = require('../src/telemetry/otlp-exporter');

// Off by default: no endpoint, no export.
{
  assert.strictEqual(isEnabled({}), false);
  assert.strictEqual(isEnabled({ OTLP_ENABLED: '1' }), false, 'endpoint required');
  const ex = new OtlpExporter({});
  assert.strictEqual(ex.enabled, false);
  (async () => {
    const r = await ex.export([]);
    assert.strictEqual(r.skipped, 'disabled');
  })().catch((e) => { console.error(e); process.exit(1); });
}

// Event -> span mapping (GenAI conventions).
{
  const ev = new TelemetryEvent('run-1', 'model.completed', { text: 'hi' }, {
    model: 'demo-model', provider: 'mock', tokens: { input: 100, output: 50, cached: 10 },
    latency: { total: 1200, model: 1100 }, cost: { total: 0.002, breakdown: {} },
  });
  const span = toSpan(ev);
  assert.strictEqual(span.traceId.length, 32);
  assert.strictEqual(span.spanId.length, 16);
  const keys = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
  assert.strictEqual(keys['gen_ai.request.model'].stringValue, 'demo-model');
  assert.strictEqual(keys['gen_ai.provider.name'].stringValue, 'mock');
  assert.strictEqual(keys['gen_ai.usage.input_tokens'].intValue, '100');
  assert.strictEqual(keys['orchestra.cost_usd'].doubleValue, 0.002);
  assert.strictEqual(spanName(ev.toJSON()), 'gen_ai.model.completed');

  const toolEv = new TelemetryEvent('run-1', 'tool.completed', {}, { tool: 'browser_snapshot', latency: { total: 300 }, cost: { total: 0.001 } });
  assert.strictEqual(spanName(toolEv.toJSON()), 'tool.browser_snapshot');

  const payload = toOtlp([span]);
  assert.strictEqual(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);
  assert.strictEqual(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'orchestraai');
}

// Failure status maps to OTel error status.
{
  const ev = new TelemetryEvent('run-2', 'tool.failed', {}, { tool: 'run_tests', status: 'failure', error: 'boom' });
  const span = toSpan(ev);
  assert.strictEqual(span.status.code, 2);
}

console.log('--- OTLP exporter tests: passed ---');
