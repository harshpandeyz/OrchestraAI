'use strict';

const { EventType } = require('../core/types');

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

class EventBus {
  constructor(options = {}) {
    this.maxReplayBuffer = options.maxReplayBuffer || 500;
    this.eventLogs = new Map();
    this.subscribers = new Map();
    this.globalSeq = 0;
  }

  getNextSeq() {
    return ++this.globalSeq;
  }

  emit(runId, type, payload) {
    const seq = this.getNextSeq();
    const envelope = new EventEnvelope(runId, type, payload, seq);

    if (!this.eventLogs.has(runId)) {
      this.eventLogs.set(runId, []);
    }
    const log = this.eventLogs.get(runId);
    log.push(envelope);
    if (log.length > this.maxReplayBuffer) {
      log.shift();
    }

    const subscribers = this.subscribers.get(runId) || new Set();
    const sseLine = envelope.toSSE();
    for (const res of subscribers) {
      try {
        res.write(sseLine);
      } catch (e) {
        subscribers.delete(res);
      }
    }

    return envelope;
  }

  subscribe(runId, response) {
    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }
    this.subscribers.get(runId).add(response);

    response.write(`: connected run=${runId}\n\n`);

    const pingInterval = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch (e) {
        clearInterval(pingInterval);
        this.unsubscribe(runId, response);
      }
    }, 15000);

    response.on('close', () => {
      clearInterval(pingInterval);
      this.unsubscribe(runId, response);
    });

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

  getReplayBuffer(runId, since = 0) {
    const log = this.eventLogs.get(runId) || [];
    return log.filter(e => e.seq > since);
  }

  getEventsSince(runId, since) {
    return this.getReplayBuffer(runId, since);
  }

  getFullState(runId) {
    const log = this.eventLogs.get(runId) || [];
    return {
      events: log,
      lastSeq: this.globalSeq
    };
  }

  clearRun(runId) {
    this.eventLogs.delete(runId);
    const subscribers = this.subscribers.get(runId);
    if (subscribers) {
      for (const res of subscribers) {
        try {
          res.end();
        } catch (e) {}
      }
      this.subscribers.delete(runId);
    }
  }
}

const eventBus = new EventBus();

module.exports = {
  EventBus,
  EventEnvelope,
  eventBus
};