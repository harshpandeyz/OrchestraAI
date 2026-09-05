'use strict';

// SSE / event contract tests: the backend event vocabulary and the frontend
// console cannot drift apart silently.
//
//   - contract covers every EventType (+ documented aliases)
//   - frontend KNOWN_EVENTS covers the contract (parsed from the .ts source)
//   - frontend reducer has no duplicate switch-case labels
//   - EventBus honors replay / gap / dedupe-by-seq / bounded buffers /
//     subscriber cleanup / envelope shape
//
// Run: node backend/test/event-contract.test.js (no network)

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { EventType } = require('../src/core/types');
const { WIRE_EVENTS, WIRE_ALIASES, TRANSPORT_EVENTS, isKnownWireEvent, assertEnvelope } = require('../src/events/event-contract');
const { EventBus, EventEnvelope } = require('../src/events/event-bus');
const { serveRunEvents } = require('../src/services/sse-service');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', rel), 'utf8');
}

async function main() {
  await test('contract covers every backend EventType plus documented aliases', () => {
    for (const v of Object.values(EventType)) {
      assert.ok(WIRE_EVENTS.includes(v), `contract missing ${v}`);
    }
    for (const a of WIRE_ALIASES) {
      assert.ok(WIRE_EVENTS.includes(a), `contract missing alias ${a}`);
    }
    assert.ok(!WIRE_EVENTS.includes('gap'), 'transport frames are not domain events');
    assert.ok(isKnownWireEvent('gap'), 'but gap is a known wire frame');
    assert.ok(!isKnownWireEvent('definitely.bogus'), 'unknown rejected');
  });

  await test('envelope validation accepts good frames, flags unknown without crashing', () => {
    const good = { seq: 1, runId: 'r', type: 'tool.completed', ts: new Date().toISOString(), payload: {} };
    assert.strictEqual(assertEnvelope(good).ok, true);
    assert.strictEqual(assertEnvelope(null).ok, false);
    assert.strictEqual(assertEnvelope({ ...good, seq: undefined }).ok, false);
    const unknown = assertEnvelope({ ...good, type: 'future.event' });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.unknown, true, 'unknown flagged distinctly (client must trace, not crash)');
  });

  await test('frontend KNOWN_EVENTS covers the whole contract', () => {
    const src = readFrontend('hooks/useEventStream.ts');
    const m = src.match(/const KNOWN_EVENTS = \[([\s\S]*?)\];/);
    assert.ok(m, 'KNOWN_EVENTS array found');
    const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(names.length > 40, `expected a full list, got ${names.length}`);
    const missing = WIRE_EVENTS.filter((w) => !names.includes(w));
    assert.deepStrictEqual(missing, [], `frontend must handle backend events: missing ${missing.join(', ')}`);
  });

  await test('frontend reducer has no duplicate case labels', () => {
    const src = readFrontend('state/store.tsx');
    const labels = [...src.matchAll(/case '([^']+)':/g)].map((x) => x[1]);
    const seen = new Set();
    const dupes = labels.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));
    assert.deepStrictEqual(dupes, [], `duplicate reducer cases: ${dupes.join(', ')}`);
  });

  await test('bus replays since cursor and flags gaps honestly', () => {
    const bus = new EventBus({ maxReplayBuffer: 5 });
    for (let i = 0; i < 5; i++) bus.emit('run-a', 'tool.started', { i });
    const full = bus.getEventsSinceWithGap('run-a', 0);
    assert.strictEqual(full.gap, false, 'full replay has no gap');
    assert.strictEqual(full.events.length, 5);
    // Overflow the buffer: oldest frames fall off.
    for (let i = 0; i < 5; i++) bus.emit('run-a', 'tool.started', { i: i + 5 });
    const partial = bus.getEventsSinceWithGap('run-a', full.events[0].seq);
    assert.strictEqual(partial.gap, true, 'predated cursor reports a gap');
    assert.ok(partial.events.length > 0 && partial.events.length <= 5, 'replays what is retained');
    const fresh = bus.getEventsSinceWithGap('run-a', partial.latestSeq);
    assert.strictEqual(fresh.gap, false, 'current cursor has no gap');
    assert.strictEqual(fresh.events.length, 0);
    const empty = bus.getEventsSinceWithGap('run-unknown', 0);
    assert.deepStrictEqual(empty.events, []);
    assert.strictEqual(empty.gap, false, 'unknown run is empty, not a gap');
  });

  await test('bus sequence is monotonic and envelopes are well-formed SSE', () => {
    const bus = new EventBus();
    const e1 = bus.emit('run-b', 'task.created', { title: 't' });
    const e2 = bus.emit('run-b', 'response.delta', { delta: 'hi' });
    assert.ok(e2.seq > e1.seq, 'seq increases');
    const sse = e2.toSSE();
    assert.ok(sse.startsWith('event: response.delta\n'), 'named SSE event');
    assert.ok(sse.includes('"seq":'), 'envelope carries seq');
    const parsed = JSON.parse(sse.split('\n')[1].replace(/^data: /, ''));
    assert.strictEqual(assertEnvelope(parsed).ok, true);
    assert.ok(e2 instanceof EventEnvelope);
  });

  await test('bus drops dead subscribers and bounds buffers', () => {
    const bus = new EventBus({ maxReplayBuffer: 10, maxRuns: 2, maxSubscribersPerRun: 2 });
    const dead = { write: () => { throw new Error('gone'); }, on: () => {}, end: () => {} };
    bus.subscribe('run-c', dead);
    bus.emit('run-c', 'task.created', {});
    assert.strictEqual(bus.subscriberCount('run-c'), 0, 'throwing subscriber reaped');
    for (let i = 0; i < 30; i++) bus.emit('run-c', 'tool.started', { i });
    assert.ok(bus.getReplayBuffer('run-c').length <= 10, 'replay buffer bounded');
    bus.emit('run-1', 'task.created', {});
    bus.emit('run-2', 'task.created', {});
    bus.emit('run-3', 'task.created', {});
    assert.ok(bus.eventLogs.size <= 3, 'runs map stays small');
    bus.clearRun('run-c');
    assert.strictEqual(bus.getReplayBuffer('run-c').length, 0, 'clearRun releases state');
  });

  await test('unserializable payloads degrade instead of dropping frames', () => {
    const bus = new EventBus();
    const circular = {};
    circular.self = circular;
    const env = bus.emit('run-d', 'tool.completed', circular);
    assert.deepStrictEqual(env.payload, { _unserializable: true });
    assert.ok(env.seq > 0, 'frame still sequenced');
  });

  await test('sse service replays, flags gaps, and 404s unknown runs', () => {
    const bus = new EventBus({ maxReplayBuffer: 3 });
    const fakeStore = { loadEvents: () => [] };
    const writes = [];
    const res = {
      writeHead: () => {}, write: (s) => writes.push(s), end: () => { res.ended = true; }, ended: false,
    };
    const missing = serveRunEvents({ eventBus: bus, store: fakeStore }, {}, res, { runId: 'run-x', since: 0, live: false });
    assert.strictEqual(missing.served, false, 'unknown run not served');
    for (let i = 0; i < 3; i++) bus.emit('run-y', 'tool.started', { i });
    const before = writes.length;
    const ok = serveRunEvents({ eventBus: bus, store: fakeStore }, {}, res, { runId: 'run-y', since: 0, live: false });
    assert.strictEqual(ok.served, true);
    assert.strictEqual(ok.replayed, 3);
    assert.ok(writes.slice(before).some((w) => w.startsWith('event: tool.started')), 'named frames replayed');
    assert.ok(res.ended, 'non-live response ends');
    // Truncate the window, then request an old cursor: gap frame first.
    for (let i = 0; i < 3; i++) bus.emit('run-y', 'tool.started', { i: i + 3 });
    const gapWrites = [];
    const res2 = { writeHead: () => {}, write: (s) => gapWrites.push(s), end: () => {}, on: () => {} };
    const gap = serveRunEvents({ eventBus: bus, store: fakeStore }, {}, res2, { runId: 'run-y', since: 1, live: true });
    assert.strictEqual(gap.gap, true);
    assert.ok(gapWrites.some((w) => w.startsWith('event: gap')), 'gap frame precedes replay');
    assert.strictEqual(bus.subscriberCount('run-y'), 1, 'live run subscribed');
    bus.clearRun('run-y');
  });
}

main().then(() => {
  console.log(`\n--- Event-contract results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
