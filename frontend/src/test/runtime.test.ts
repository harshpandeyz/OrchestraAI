import { describe, expect, it } from 'vitest';
import { applyEventToSnapshot, reducer, initial } from '../state/store';
import { freshnessLabel } from '../hooks/useEventStream';
import type { RuntimeSnapshot } from '../types';

function snap(): RuntimeSnapshot {
  return {
    runId: 'run-1', lastSeq: 3, updatedAt: new Date().toISOString(), status: 'running', activeModelId: 'nemotron-x',
    context: { usedTokens: 42300, windowTokens: 128000, segments: [{ key: 'a', label: 'A', tokensPct: 100 }], items: [] },
    cache: { hitRate: 0.74, cachedTokens: 1, uncachedTokens: 1, savedUsd: 0.01, state: 'WARM', recent: [] },
    memory: { working: [], longterm: [] },
    tools: [{ name: 'run_tests', description: 't', status: 'enabled', calls: 1, avgLatencyMs: 100, successRate: 1 }],
    cost: { spentUsd: 0.03, budgetUsd: 0.1, projectedUsd: 0.07, breakdown: [] },
    latency: { currentStepMs: 1, avgStepMs: 1, modelMs: 1, toolMs: 1, totalMs: 1, samples: [1] },
    routing: { currentId: 'nemotron-x', candidates: [], decision: null },
    trace: [], decisions: [], changes: [], messages: [],
  };
}
const env = (seq: number, type: string, payload: any = {}) => ({ seq, runId: 'run-1', type, ts: new Date().toISOString(), payload });

describe('streaming events', () => {
  it('streams response deltas incrementally without refresh', () => {
    let s = snap();
    s = applyEventToSnapshot(s, env(4, 'response.delta', { delta: 'Fixing ' }));
    s = applyEventToSnapshot(s, env(5, 'response.delta', { delta: 'auth…' }));
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].content).toBe('Fixing auth…');
    s = applyEventToSnapshot(s, env(6, 'response.done', { full: 'Fixing auth… done' }));
    expect(s.messages[0].content).toBe('Fixing auth… done');
  });
  it('records model switch + retained decisions + context/cost/cache/tool updates', () => {
    let s = snap();
    s = applyEventToSnapshot(s, env(4, 'model.selected', { modelId: 'helium-b' }));
    expect(s.activeModelId).toBe('helium-b');
    s = applyEventToSnapshot(s, env(5, 'context.compressed', { reclaimedTokens: 8400 }));
    expect(s.context.usedTokens).toBe(33900);
    s = applyEventToSnapshot(s, env(6, 'tool.started', { tool: 'run_tests' }));
    expect(s.tools[0].lastStatus).toBe('running');
    s = applyEventToSnapshot(s, env(7, 'tool.finished', { tool: 'run_tests', status: 'failed', durationMs: 2800 }));
    expect(s.tools[0].calls).toBe(2);
    s = applyEventToSnapshot(s, env(8, 'cache.hit', { savedUsd: 0.005 }));
    expect(s.cache.savedUsd).toBeCloseTo(0.015);
    s = applyEventToSnapshot(s, env(9, 'cost.updated', { spentUsd: 0.05 }));
    expect(s.cost.spentUsd).toBe(0.05);
    s = applyEventToSnapshot(s, env(10, 'model.retained', { reason: 'Switch cost too high' }));
    expect(s.decisions.length).toBe(1);
    expect(s.trace.length).toBeGreaterThan(5);
  });
  it('reducer drops out-of-order/duplicate events and tracks connection/stale', () => {
    const s0 = { ...initial, server: { ...initial.server, snapshot: snap(), conn: { status: 'connected' as const, lastSeq: 3, lastUpdate: new Date().toISOString() } } };
    const dup = reducer(s0, { type: 'event/apply', env: env(3, 'response.delta', { delta: 'x' }) });
    expect(dup.server.snapshot!.messages.length).toBe(0);
    const ok = reducer(s0, { type: 'event/apply', env: env(4, 'response.delta', { delta: 'hi' }) });
    expect(ok.server.conn.lastSeq).toBe(4);
  });
  it('freshness labels live/stale/disconnected correctly', () => {
    expect(freshnessLabel('connected', new Date().toISOString())).toBe('LIVE');
    expect(freshnessLabel('connected', new Date(Date.now() - 60000).toISOString())).toBe('STALE');
    expect(freshnessLabel('reconnecting', new Date().toISOString())).toBe('STALE');
    expect(freshnessLabel('disconnected', new Date().toISOString())).toBe('DISCONNECTED');
  });
  it('handles real backend aliases (fromModel/toModel, toolName) without crashing', () => {
    let s = snap();
    s = applyEventToSnapshot(s, env(4, 'model.switched', { fromModel: 'a', toModel: 'b', fromId: 'a', toId: 'b', reason: 'budget optimization', switchingCost: 0.009 }));
    expect(s.activeModelId).toBe('b');
    expect(s.decisions.some(d => /SWITCH a → b/.test(d.decision))).toBe(true);
    s = applyEventToSnapshot(s, env(5, 'model.selected', { modelId: 'b', reason: 'best score', factors: [{ key: 'q', label: 'Quality', status: 'pass' }] }));
    expect(s.routing.decision).not.toBeNull();
    expect(s.routing.decision!.factors.length).toBe(1);
    s = applyEventToSnapshot(s, env(6, 'tool.failed', { toolName: 'run_tests', error: 'boom', code: 'failure', durationMs: 1200 }));
    expect(s.tools[0].lastStatus).toBe('failed');
    expect(s.latency.samples).toContain(1200);
    s = applyEventToSnapshot(s, env(7, 'response.done', { full: 'done', latencyMs: 900 }));
    expect(s.latency.modelMs).toBe(900);
    s = applyEventToSnapshot(s, env(8, 'model.switch_requested', { fromModel: 'b', toModel: 'c' }));
    expect(s.trace.length).toBeGreaterThan(0);
    s = applyEventToSnapshot(s, env(9, 'execution.completed', {}));
    expect(s.trace.length).toBeGreaterThan(0);
  });
  it('caps message history so large runs stay responsive', () => {
    let s = snap();
    for (let i = 0; i < 400; i++) {
      s = applyEventToSnapshot(s, env(4 + i, 'tool.started', { tool: 'run_tests', detail: `call ${i}` }));
    }
    expect(s.messages.length).toBeLessThanOrEqual(300);
  });
  it('run failure and cancel surface error states, not blank screens', () => {
    let s = snap();
    s = applyEventToSnapshot(s, env(4, 'run.failed', { reason: 'model unavailable' }));
    expect(s.status).toBe('failed');
    s = applyEventToSnapshot(s, env(5, 'run.cancelled', {}));
    expect(s.status).toBe('cancelled');
  });
});
