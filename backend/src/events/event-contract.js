'use strict';

// SSE / event contract — the single source of truth for wire event names.
//
// Shape: every SSE frame is a named event whose data is an envelope
//   { seq, runId, type, ts, payload }
// with `seq` strictly increasing per process (hence per run), `type` the
// wire name below, and `payload` JSON-serializable (unserializable payloads
// degrade to { _unserializable: true }, never a dropped frame).
//
// Delivery guarantees (implemented by EventBus, consumed by the console):
//   - replay:   GET .../events?since=<lastSeq> replays missed frames
//   - gap:      when `since` predates the retained window the server emits a
//               transport-level `gap` frame; the client must resync via
//               GET .../state (snapshot replacement), not by guessing
//   - dedupe:   the client ignores frames with seq <= last applied seq
//   - unknown:  unknown types must be traced, never crash the client
//   - aliases:  `tool.finished` (= tool.completed) and `memory.write`
//               (= memory.written) are legacy aliases the backend may still
//               emit and the frontend must still accept
//
// Adding a backend event: add it to core/types EventType (it appears here
// automatically) AND make sure the frontend handles it —
// backend/test/event-contract.test.js fails if the console's KNOWN_EVENTS
// does not cover this contract, so a backend addition cannot silently
// disappear from the UI.

const { EventType } = require('../core/types');

// Legacy aliases still on the wire (accepted, never newly preferred).
const WIRE_ALIASES = Object.freeze(['tool.finished', 'memory.write']);

// Transport-level frames (not domain events).
const TRANSPORT_EVENTS = Object.freeze(['gap']);

const WIRE_EVENTS = Object.freeze([...Object.values(EventType), ...WIRE_ALIASES]);

const ENVELOPE_FIELDS = Object.freeze(['seq', 'runId', 'type', 'ts', 'payload']);

function isKnownWireEvent(type) {
  return WIRE_EVENTS.includes(type) || TRANSPORT_EVENTS.includes(type);
}

function assertEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'envelope missing' };
  for (const f of ENVELOPE_FIELDS) {
    if (env[f] === undefined) return { ok: false, error: `envelope missing ${f}` };
  }
  if (!Number.isFinite(env.seq)) return { ok: false, error: 'envelope seq must be a number' };
  if (!isKnownWireEvent(env.type)) return { ok: false, error: `unknown event type: ${env.type}`, unknown: true };
  return { ok: true };
}

module.exports = {
  WIRE_EVENTS,
  WIRE_ALIASES,
  TRANSPORT_EVENTS,
  ENVELOPE_FIELDS,
  isKnownWireEvent,
  assertEnvelope,
};
