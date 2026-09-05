'use strict';

// SSE/event service — the HTTP layer's single entry point for live run
// streams. Owns framing (headers, comment prelude, named frames), replay via
// ?since=, gap frames when the cursor predates the retained window, and live
// subscription lifecycle. Route handlers authenticate/authorize; this module
// never makes auth decisions.

function defaultSseLine(envelope) {
  if (envelope && typeof envelope.toSSE === 'function') return envelope.toSSE();
  return `event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

// Serves GET /api/runs/:id/events. Returns { served: true } when the
// response was fully handled (replay and/or live stream), or
// { served: false, code: 'not_found' } when the run has no events anywhere
// (caller maps to 404). Never throws for expected states.
function serveRunEvents({ eventBus, store, sseLine = defaultSseLine }, req, res, { runId, since = 0, live = false, corsHeaders = {}, securityHeaders = {} }) {
  const logs = eventBus.eventLogs;
  if (!logs.has(runId)) {
    // Persisted-only runs may not have reloaded logs in this process.
    const onDisk = store.loadEvents(runId);
    if (!onDisk.length) return { served: false, code: 'not_found' };
    logs.set(runId, onDisk);
  }
  res.writeHead(200, {
    ...securityHeaders,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...corsHeaders,
    ...(corsHeaders['Access-Control-Allow-Origin'] ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  });
  res.write(`: connected run=${runId}\n\n`);
  const n = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  const replay = typeof eventBus.getEventsSinceWithGap === 'function'
    ? eventBus.getEventsSinceWithGap(runId, n)
    : { events: eventBus.getEventsSince(runId, n), gap: false };
  const list = replay.events || [];
  if (replay.gap) {
    res.write(`event: gap\ndata: ${JSON.stringify({ runId, since: n, oldestSeq: replay.oldestSeq, message: 'event window truncated; resync via GET state' })}\n\n`);
  }
  for (const msg of list) {
    res.write(sseLine(msg));
  }
  if (live) eventBus.subscribe(runId, res);
  else res.end();
  return { served: true, replayed: list.length, gap: !!replay.gap };
}

module.exports = { serveRunEvents, defaultSseLine };
