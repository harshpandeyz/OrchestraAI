'use strict';

// OrchestraAI — OTLP observability exporter (Session 12, optional, off by default).
//
// Zero-dependency OTLP/HTTP exporter alongside telemetry-collector.js. It
// converts TelemetryEvents to OpenTelemetry spans using the GenAI semantic
// conventions (see OBSERVABILITY.md for the event→span mapping) and ships
// them to a configured OTLP/HTTP endpoint. No SDK, no new dependency: plain
// Node http/https POST of OTLP/JSON.
//
// Enable with:
//   OTLP_ENABLED=1 OTLP_ENDPOINT=https://collector.example:4318/v1/traces
//   (optional) OTLP_HEADERS="k1=v1,k2=v2"  OTLP_TIMEOUT_MS=5000
//
// Off by default: when disabled, every method is a documented no-op and the
// runtime behaves exactly as before (telemetry-collector.js is untouched).

const http = require('http');
const https = require('https');

function isEnabled(env = process.env) {
  return String(env.OTLP_ENABLED || '').toLowerCase() === '1' && !!env.OTLP_ENDPOINT;
}

function endpointOf(env = process.env) {
  return String(env.OTLP_ENDPOINT || '');
}

function headersOf(env = process.env) {
  const out = { 'content-type': 'application/json' };
  for (const pair of String(env.OTLP_HEADERS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

// TelemetryEvent -> OTel span (GenAI conventions). Pure function, no I/O.
// Timestamps: OTel wants nanoseconds since epoch; event timestamps are ISO.
function toSpan(event) {
  const e = event && typeof event.toJSON === 'function' ? event.toJSON() : (event || {});
  const startNs = isoToNs(e.timestamp) || String(Date.now() * 1e6);
  const attrs = [
    strAttr('orchestra.run_id', e.runId),
    strAttr('orchestra.event_id', e.eventId),
    strAttr('orchestra.event_type', e.type),
  ];
  if (e.model) attrs.push(strAttr('gen_ai.request.model', e.model));
  if (e.provider) attrs.push(strAttr('gen_ai.provider.name', e.provider));
  if (e.tool) attrs.push(strAttr('orchestra.tool.name', e.tool));
  if (e.decision) attrs.push(strAttr('orchestra.routing.decision', e.decision));
  if (e.decisionReason) attrs.push(strAttr('orchestra.routing.reason', String(e.decisionReason).slice(0, 500)));
  if (e.tokens) {
    if (Number.isFinite(e.tokens.input)) attrs.push(intAttr('gen_ai.usage.input_tokens', e.tokens.input));
    if (Number.isFinite(e.tokens.output)) attrs.push(intAttr('gen_ai.usage.output_tokens', e.tokens.output));
    if (Number.isFinite(e.tokens.cached)) attrs.push(intAttr('gen_ai.usage.cached_tokens', e.tokens.cached));
  }
  if (e.latency && Number.isFinite(e.latency.total)) attrs.push(intAttr('orchestra.latency_ms', Math.round(e.latency.total)));
  if (e.cost && Number.isFinite(e.cost.total)) attrs.push(doubleAttr('orchestra.cost_usd', e.cost.total));
  if (e.stepId) attrs.push(strAttr('orchestra.step_id', e.stepId));
  attrs.push(strAttr('orchestra.status', e.status || 'success'));
  if (e.error) attrs.push(strAttr('orchestra.error', String(e.error).slice(0, 500)));
  const spanId = spanIdFor(e.eventId || `${e.runId}-${e.type}-${e.timestamp}`);
  return {
    traceId: traceIdFor(e.runId || 'norun'),
    spanId,
    parentSpanId: e.stepId ? spanIdFor(`step-${e.stepId}`) : undefined,
    name: spanName(e),
    kind: 1, // INTERNAL
    startTimeUnixNano: startNs,
    endTimeUnixNano: String(BigInt(startNs) + BigInt(Math.max(0, Math.round((e.latency && e.latency.total) || 0)) * 1e6)),
    attributes: attrs.filter(Boolean),
    status: e.status === 'success' ? {} : { code: 2, message: String(e.error || e.status || 'error').slice(0, 200) },
  };
}

function spanName(e) {
  if (e.tool) return `tool.${e.tool}`;
  if (e.model) return `gen_ai.${e.type || 'call'}`;
  if (e.decision) return 'orchestra.routing';
  return `orchestra.${e.type || 'event'}`;
}

function strAttr(key, value) {
  if (value === null || value === undefined) return null;
  return { key, value: { stringValue: String(value).slice(0, 1000) } };
}
function intAttr(key, value) {
  return { key, value: { intValue: String(Math.round(Number(value))) } };
}
function doubleAttr(key, value) {
  return { key, value: { doubleValue: Number(value) } };
}

function isoToNs(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return String(BigInt(ms) * 1000000n);
}

function hexHash(s, len) {
  const h = require('crypto').createHash('sha256').update(String(s)).digest('hex');
  return h.slice(0, len);
}
function traceIdFor(runId) { return hexHash(`trace:${runId}`, 32); }
function spanIdFor(id) { return hexHash(`span:${id}`, 16); }

function toOtlp(spans) {
  return { resourceSpans: [{ resource: { attributes: [strAttr('service.name', 'orchestraai')] }, scopeSpans: [{ scope: { name: 'orchestraai-telemetry' }, spans }] }] };
}

function postJson(endpoint, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(endpoint); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const timer = setTimeout(() => reject(Object.assign(new Error('OTLP export timed out'), { code: 'timeout' })), timeoutMs);
    const req = lib.request(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': data.length },
    }, (res) => {
      res.resume();
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(data);
  });
}

class OtlpExporter {
  constructor(env = process.env) {
    this.env = env;
  }
  get enabled() { return isEnabled(this.env); }
  async export(events) {
    if (!this.enabled) return { exported: 0, skipped: 'disabled' };
    const spans = (Array.isArray(events) ? events : [events]).map(toSpan);
    if (!spans.length) return { exported: 0, skipped: 'empty' };
    const timeoutMs = Math.min(Number(this.env.OTLP_TIMEOUT_MS) || 5000, 15000);
    const r = await postJson(endpointOf(this.env), headersOf(this.env), toOtlp(spans), timeoutMs);
    if (r.status >= 200 && r.status < 300) return { exported: spans.length };
    throw Object.assign(new Error(`OTLP endpoint rejected export (status ${r.status})`), { code: 'export_failed' });
  }
}

module.exports = { OtlpExporter, toSpan, toOtlp, isEnabled, endpointOf, headersOf, spanName };
