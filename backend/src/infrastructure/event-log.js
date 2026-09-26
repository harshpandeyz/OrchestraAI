'use strict';

// Durable event retrieval for multi-instance SSE.
//
// Instance A may emit events that instance B must serve to a reconnecting
// client. This module merges the in-memory EventBus buffer with the durable
// per-run event log (FileStore today, Postgres when configured) so replay
// via ?since= (or Last-Event-ID) works regardless of which instance the
// client reconnects to.
//
// Contract compatibility (CONTRACTS.md):
//   - query param ?since=<seq> keeps working unchanged
//   - Last-Event-ID header (or `lastEventId` field) is accepted as an
//     equivalent cursor when ?since= is absent
//   - gap frames keep the existing shape { runId, since, oldestSeq, message }
//   - envelope shape { seq, runId, type, ts, payload } is unchanged

function parseCursor({ since, lastEventId }) {
  const fromSince = Number(since);
  if (Number.isFinite(fromSince) && fromSince > 0) return Math.floor(fromSince);
  const fromHeader = Number(lastEventId);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.floor(fromHeader);
  return 0;
}

function parseLastEventIdHeader(req) {
  try {
    const raw = req && req.headers ? (req.headers['last-event-id'] || req.headers['Last-Event-ID']) : '';
    const n = Number(String(raw || '').trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function dedupeBySeq(events) {
  const seen = new Set();
  const out = [];
  const sorted = (Array.isArray(events) ? events : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const e of sorted) {
    if (!e || !Number.isFinite(e.seq) || seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  return out;
}

// Merges durable (disk/db) events with the live bus buffer. The bus wins on
// seq collisions (same seq => same logical event). Returns
// { events, gap, oldestSeq, latestSeq } matching getEventsSinceWithGap.
async function readDurableSince({ eventBus, store, runId, since = 0 }) {
  const n = Number(since) || 0;
  let durable = [];
  try {
    if (store && typeof store.loadEvents === 'function') {
      const loaded = store.loadEvents(runId);
      durable = typeof loaded.then === 'function' ? await loaded : loaded;
    }
  } catch {
    durable = [];
  }
  let live = [];
  let gapInfo = null;
  try {
    if (eventBus && typeof eventBus.getEventsSinceWithGap === 'function') {
      gapInfo = eventBus.getEventsSinceWithGap(runId, 0);
      live = (gapInfo && gapInfo.events) || [];
    } else if (eventBus && typeof eventBus.getEventsSince === 'function') {
      live = eventBus.getEventsSince(runId, 0) || [];
    }
  } catch {
    live = [];
  }
  const merged = dedupeBySeq([...(Array.isArray(durable) ? durable : []), ...(Array.isArray(live) ? live : [])]);
  if (!merged.length) return { events: [], gap: false, oldestSeq: 0, latestSeq: 0 };
  const oldestSeq = merged[0].seq;
  const latestSeq = merged[merged.length - 1].seq;
  // Gap iff the cursor predates the retained window and the window is non-empty.
  const gap = n > 0 && n < oldestSeq - 1;
  return { events: merged.filter((e) => e.seq > n), gap, oldestSeq, latestSeq };
}

module.exports = { parseCursor, parseLastEventIdHeader, dedupeBySeq, readDurableSince };
