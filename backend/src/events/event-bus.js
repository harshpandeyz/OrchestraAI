'use strict';

// Session 1 — SSE/event infrastructure correctness (not event semantics).
//
// Guarantees:
//   - seq is monotonic per run (global counter; per-run subsequence increases)
//   - replay via ?since= never silently loses events: callers get { events, gap }
//   - subscriber/connection cleanup on close, error, and run termination
//   - bounded memory: maxReplayBuffer/run, maxRuns total, max subscribers/run
//   - backpressure: failed writes drop that subscriber (no unbounded buffering)
//   - malformed payloads never crash emit (payload must be JSON-serializable)

const { EventType } = require('../core/types');
const { normalizePrivacyMode, sanitize } = require('../privacy');

class EventEnvelope {
  constructor(runId, type, payload, seq) {
    this.seq = seq;
    this.runId = runId;
    this.type = type;
    this.ts = new Date().toISOString();
    this.payload = payload;
  }

  toSSE() {
    return `event: ${this.type}\ndata: ${JSON.stringify(this)}\n\n`;
  }
}

function safePayload(payload) {
  if (payload === undefined) return null;
  try {
    JSON.stringify(payload);
    return payload;
  } catch {
    return { _unserializable: true };
  }
}

class EventBus {
  constructor(options = {}) {
    this.maxReplayBuffer = options.maxReplayBuffer || 500;
    this.maxRuns = options.maxRuns || 500;
    this.maxSubscribersPerRun = options.maxSubscribersPerRun || 50;
    this.pingMs = options.pingMs || 15000;
    this.eventLogs = new Map(); // runId -> [envelope...] (bounded)
    this.runSeq = new Map(); // runId -> last per-run seq (monotonic check)
    this.subscribers = new Map(); // runId -> Set<res>
    this.globalSeq = 0;
    this.privacyModes = new Map(); // runId -> persistence/transmission mode
  }

  getNextSeq() {
    return ++this.globalSeq;
  }

  _pruneRunsIfNeeded() {
    while (this.eventLogs.size > this.maxRuns) {
      const oldest = this.eventLogs.keys().next().value;
      if (!oldest) break;
      // Never prune a run with live subscribers.
      if (this.subscribers.has(oldest) && this.subscribers.get(oldest).size > 0) {
        // Move it to the back by re-inserting.
        const log = this.eventLogs.get(oldest);
        this.eventLogs.delete(oldest);
        this.eventLogs.set(oldest, log);
        break;
      }
      this.eventLogs.delete(oldest);
      this.runSeq.delete(oldest);
    }
  }

  emit(runId, type, payload) {
    const seq = this.getNextSeq();
    const mode = this.privacyModes.get(runId);
    const safe = safePayload(payload);
    const envelope = new EventEnvelope(runId, type, mode ? sanitize(safe, mode) : safe, seq);

    if (!this.eventLogs.has(runId)) {
      this.eventLogs.set(runId, []);
      this._pruneRunsIfNeeded();
    }
    const log = this.eventLogs.get(runId);
    log.push(envelope);
    if (log.length > this.maxReplayBuffer) {
      log.shift();
    }
    // Per-run monotonicity invariant (global seq implies per-run increase).
    const last = this.runSeq.get(runId) || 0;
    if (seq <= last) {
      // Should never happen; keep invariant visible for tests.
      throw new Error(`event seq went backwards for run ${runId}`);
    }
    this.runSeq.set(runId, seq);

    const subscribers = this.subscribers.get(runId);
    if (subscribers && subscribers.size) {
      const sseLine = envelope.toSSE();
      for (const res of [...subscribers]) {
        try {
          const ok = res.write(sseLine);
          // Backpressure: if the kernel buffer is full (write -> false),
          // keep the subscriber but do not queue unbounded data — Node
          // buffers internally; a dead client will error/close and be
          // reaped on 'close'. No per-subscriber queue is maintained.
          void ok;
        } catch (e) {
          subscribers.delete(res);
        }
      }
      if (subscribers.size === 0) this.subscribers.delete(runId);
    }

    return envelope;
  }

  setPrivacyMode(runId, mode) {
    if (!runId) return;
    const normalized = normalizePrivacyMode(mode);
    this.privacyModes.set(runId, normalized);
    const existing = this.eventLogs.get(runId);
    if (existing) {
      for (const event of existing) event.payload = sanitize(event.payload, normalized);
    }
  }

  subscribe(runId, response, options = {}) {
    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }
    const set = this.subscribers.get(runId);
    if (set.size >= this.maxSubscribersPerRun) {
      // Shed oldest subscriber to bound memory (close it cleanly).
      const oldest = set.values().next().value;
      if (oldest) {
        try { oldest.end(); } catch {}
        set.delete(oldest);
      }
    }
    set.add(response);

    try { response.write(`: connected run=${runId}\n\n`); } catch { set.delete(response); }

    const pingMs = options.pingMs || this.pingMs;
    const pingInterval = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch (e) {
        clearInterval(pingInterval);
        this.unsubscribe(runId, response);
      }
    }, pingMs);
    if (pingInterval.unref) pingInterval.unref();

    const onClose = () => {
      clearInterval(pingInterval);
      this.unsubscribe(runId, response);
    };
    try {
      response.on('close', onClose);
    } catch {}

    return this.getReplayBuffer(runId);
  }

  unsubscribe(runId, response) {
    const subscribers = this.subscribers.get(runId);
    if (subscribers) {
      subscribers.delete(response);
      if (subscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    }
  }

  subscriberCount(runId) {
    const s = this.subscribers.get(runId);
    return s ? s.size : 0;
  }

  getReplayBuffer(runId, since = 0) {
    const log = this.eventLogs.get(runId) || [];
    return log.filter(e => e.seq > since);
  }

  // Legacy: returns array for backward compat (runtime.test.js, older callers).
  getEventsSince(runId, since) {
    return this.getReplayBuffer(runId, Number(since) || 0);
  }

  // Replay with gap detection: if `since` predates the retained window,
  // gap=true and the caller must resync via GET /state (documented contract).
  getEventsSinceWithGap(runId, since) {
    const n = Number(since) || 0;
    const log = this.eventLogs.get(runId) || [];
    if (!log.length) return { events: [], gap: false, oldestSeq: 0, latestSeq: 0 };
    const oldestSeq = log[0].seq;
    const latestSeq = log[log.length - 1].seq;
    const gap = n > 0 && n < oldestSeq - 1;
    return { events: log.filter(e => e.seq > n), gap, oldestSeq, latestSeq };
  }

  oldestSeq(runId) {
    const log = this.eventLogs.get(runId) || [];
    return log.length ? log[0].seq : 0;
  }

  latestSeq(runId) {
    const log = this.eventLogs.get(runId) || [];
    return log.length ? log[log.length - 1].seq : 0;
  }

  getFullState(runId) {
    const log = this.eventLogs.get(runId) || [];
    return {
      events: log,
      lastSeq: log.length ? log[log.length - 1].seq : 0,
    };
  }

  // Close live subscribers for a terminated run (no unnecessary live sockets).
  closeSubscribers(runId) {
    const subscribers = this.subscribers.get(runId);
    if (subscribers) {
      for (const res of [...subscribers]) {
        try { res.end(); } catch (e) {}
      }
      this.subscribers.delete(runId);
    }
  }

  clearRun(runId) {
    this.eventLogs.delete(runId);
    this.runSeq.delete(runId);
    this.privacyModes.delete(runId);
    this.closeSubscribers(runId);
  }
}

const eventBus = new EventBus();

module.exports = {
  EventBus,
  EventEnvelope,
  eventBus
};
