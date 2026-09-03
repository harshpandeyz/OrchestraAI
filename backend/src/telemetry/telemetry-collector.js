'use strict';

const { EventType, CostCategory } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class TelemetryEvent {
  constructor(runId, type, payload, options = {}) {
    this.eventId = generateId('telemetry');
    this.runId = runId;
    this.type = type;
    this.timestamp = now();
    this.payload = payload;
    this.stepId = options.stepId || null;
    this.model = options.model || null;
    this.provider = options.provider || null;
    this.tokens = options.tokens || { input: 0, output: 0, cached: 0 };
    this.cacheInfo = options.cacheInfo || { hit: false, cachedTokens: 0 };
    this.tool = options.tool || null;
    this.latency = options.latency || { total: 0, model: 0, tool: 0 };
    this.cost = options.cost || { total: 0, breakdown: {} };
    this.decision = options.decision || null;
    this.decisionReason = options.decisionReason || null;
    this.status = options.status || 'success';
    this.error = options.error || null;
  }

  toJSON() {
    return {
      eventId: this.eventId,
      runId: this.runId,
      type: this.type,
      timestamp: this.timestamp,
      stepId: this.stepId,
      model: this.model,
      provider: this.provider,
      tokens: this.tokens,
      cacheInfo: this.cacheInfo,
      tool: this.tool,
      latency: this.latency,
      cost: this.cost,
      decision: this.decision,
      decisionReason: this.decisionReason,
      status: this.status,
      error: this.error,
      payload: this.payload
    };
  }
}

class TelemetryCollector {
  constructor(options = {}) {
    this.events = new Map();
    this.metrics = new Map();
    this.maxEventsPerRun = options.maxEventsPerRun || 1000;
    this.maxMetricsPerRun = options.maxMetricsPerRun || 500;
  }

  recordEvent(runId, event) {
    if (!this.events.has(runId)) {
      this.events.set(runId, []);
    }
    
    const runEvents = this.events.get(runId);
    runEvents.push(event);
    
    if (runEvents.length > this.maxEventsPerRun) {
      runEvents.shift();
    }
    
    return event;
  }

  recordMetric(runId, metricName, value, tags = {}) {
    if (!this.metrics.has(runId)) {
      this.metrics.set(runId, []);
    }
    
    const runMetrics = this.metrics.get(runId);
    runMetrics.push({
      metricName,
      value,
      tags,
      timestamp: now()
    });
    
    if (runMetrics.length > this.maxMetricsPerRun) {
      runMetrics.shift();
    }
  }

  recordDecision(runId, decision) {
    return this.recordEvent(runId, new TelemetryEvent(runId, EventType.ROUTING_EVALUATED, {
      decision: decision.toJSON()
    }, {
      decision: decision.decision,
      decisionReason: decision.reason
    }));
  }

  recordModelEvent(runId, type, model, provider, tokens, latency, cost, payload = {}) {
    return this.recordEvent(runId, new TelemetryEvent(runId, type, payload, {
      model,
      provider,
      tokens,
      latency: { total: latency, model: latency },
      cost: { total: cost, breakdown: { model: cost } }
    }));
  }

  recordToolEvent(runId, type, tool, latency, cost, payload = {}, status = 'success', error = null) {
    return this.recordEvent(runId, new TelemetryEvent(runId, type, payload, {
      tool,
      latency: { total: latency, tool: latency },
      cost: { total: cost, breakdown: { tool: cost } },
      status,
      error
    }));
  }

  recordContextEvent(runId, type, payload = {}) {
    return this.recordEvent(runId, new TelemetryEvent(runId, type, payload));
  }

  recordCacheEvent(runId, type, hit, cachedTokens, payload = {}) {
    return this.recordEvent(runId, new TelemetryEvent(runId, type, payload, {
      cacheInfo: { hit, cachedTokens }
    }));
  }

  recordBudgetEvent(runId, type, spent, budget, payload = {}) {
    return this.recordEvent(runId, new TelemetryEvent(runId, type, payload, {
      cost: { total: spent, breakdown: { current: spent, budget } }
    }));
  }

  getRunTelemetry(runId) {
    return {
      events: this.events.get(runId) || [],
      metrics: this.metrics.get(runId) || []
    };
  }

  getAggregatedMetrics(timeRange = null) {
    const allMetrics = [];
    for (const [runId, metrics] of this.metrics.entries()) {
      for (const metric of metrics) {
        if (!timeRange || metric.timestamp >= timeRange.start && metric.timestamp <= timeRange.end) {
          allMetrics.push({ ...metric, runId });
        }
      }
    }
    return allMetrics;
  }

  getRunSummary(runId) {
    const events = this.events.get(runId) || [];
    const metrics = this.metrics.get(runId) || [];
    
    const modelEvents = events.filter(e => e.model);
    const toolEvents = events.filter(e => e.tool);
    const decisionEvents = events.filter(e => e.decision);
    const errorEvents = events.filter(e => e.status === 'failed' || e.status === 'error');
    
    const totalCost = events.reduce((sum, e) => sum + (e.cost?.total || 0), 0);
    const totalLatency = events.reduce((sum, e) => sum + (e.latency?.total || 0), 0);
    const totalTokens = events.reduce((sum, e) => sum + (e.tokens?.input || 0) + (e.tokens?.output || 0), 0);
    
    return {
      runId,
      eventCount: events.length,
      metricCount: metrics.length,
      modelCalls: modelEvents.length,
      toolCalls: toolEvents.length,
      decisions: decisionEvents.length,
      errors: errorEvents.length,
      totalCost,
      totalLatency,
      totalTokens,
      firstEvent: events[0]?.timestamp,
      lastEvent: events[events.length - 1]?.timestamp
    };
  }

  flush() {
    this.events.clear();
    this.metrics.clear();
  }

  clearRun(runId) {
    this.events.delete(runId);
    this.metrics.delete(runId);
  }
}

module.exports = {
  TelemetryEvent,
  TelemetryCollector
};