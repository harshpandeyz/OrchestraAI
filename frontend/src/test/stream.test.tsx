import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { useEventStream } from '../hooks/useEventStream';
import { api } from '../api/client';
import type { RuntimeSnapshot } from '../types';

// Controllable EventSource double: captures listeners per instance.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  handlers = new Map<string, Array<(ev: { data: string }) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void) {
    const list = this.handlers.get(name) || [];
    list.push(fn);
    this.handlers.set(name, list);
  }
  fire(name: string, env: object) {
    for (const fn of this.handlers.get(name) || []) fn({ data: JSON.stringify(env) });
  }
  fireMessage(env: object) {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  close() {
    this.closed = true;
  }
}

function snap(): RuntimeSnapshot {
  return {
    runId: 'run-1', lastSeq: 3, updatedAt: new Date().toISOString(), status: 'running', activeModelId: 'm',
    context: { usedTokens: 100, windowTokens: 128000, segments: [], items: [] },
    cache: { hitRate: 0, cachedTokens: 0, uncachedTokens: 0, savedUsd: 0, state: 'COLD', recent: [] },
    memory: { working: [], longterm: [] },
    tools: [],
    cost: { spentUsd: 0, budgetUsd: 1, projectedUsd: 0, breakdown: [] },
    latency: { currentStepMs: 0, avgStepMs: 0, modelMs: 0, toolMs: 0, totalMs: 0, samples: [] },
    routing: { currentId: 'm', candidates: [], decision: null },
    trace: [], decisions: [], changes: [], messages: [],
  };
}
const env = (seq: number, type: string, payload: object = {}) => ({ seq, runId: 'run-1', type, ts: new Date().toISOString(), payload });
const wrapper = ({ children }: { children: React.ReactNode }) => <RuntimeProvider>{children}</RuntimeProvider>;

describe('useEventStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects with the reconnect cursor and replays from it', () => {
    const { result } = renderHook(() => {
      const rt = useRuntime();
      useEventStream('run-1');
      return rt;
    }, { wrapper });
    // First connect has no cursor yet (snapshot not loaded).
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toBe('/api/runs/run-1/events');
    act(() => {
      result.current.dispatch({ type: 'snap/set', snap: snap() });
    });
    // A missed frame replays through the named listener and advances the cursor.
    act(() => {
      MockEventSource.instances[0].fire('task.updated', env(4, 'task.updated', { userText: 'hi' }));
    });
    expect(result.current.state.server.conn.lastSeq).toBe(4);
    expect(result.current.state.server.snapshot!.trace.length).toBe(1);
    // Reconnect replays from the synced cursor.
    act(() => {
      MockEventSource.instances[0].fail();
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances[1].url).toBe('/api/runs/run-1/events?since=4');
  });

  it('coalesces adjacent deltas and flushes lifecycle events first', () => {
    const { result } = renderHook(() => {
      const rt = useRuntime();
      useEventStream('run-1');
      return rt;
    }, { wrapper });
    act(() => {
      result.current.dispatch({ type: 'snap/set', snap: snap() });
    });
    const es = MockEventSource.instances[0];
    act(() => {
      es.fire('response.delta', env(4, 'response.delta', { delta: 'Fixing ' }));
      es.fire('response.delta', env(5, 'response.delta', { delta: 'auth' }));
    });
    // Still buffered: no dispatch yet.
    expect(result.current.state.server.snapshot!.messages.length).toBe(0);
    act(() => {
      vi.advanceTimersByTime(20);
    });
    const msgs = result.current.state.server.snapshot!.messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Fixing auth');
    // A lifecycle event flushes a pending delta before applying itself.
    act(() => {
      es.fire('response.delta', env(6, 'response.delta', { delta: 'more ' }));
      es.fire('response.done', env(7, 'response.done', { full: 'more done' }));
    });
    expect(result.current.state.server.snapshot!.messages[0].content).toBe('more done');
  });

  it('gap frame triggers snapshot resync', async () => {
    const fresh = { ...snap(), lastSeq: 40 };
    const getState = vi.spyOn(api, 'getState').mockResolvedValue({ state: fresh });
    const { result } = renderHook(() => {
      const rt = useRuntime();
      useEventStream('run-1');
      return rt;
    }, { wrapper });
    act(() => {
      result.current.dispatch({ type: 'snap/set', snap: snap() });
    });
    await act(async () => {
      MockEventSource.instances[0].fire('gap', env(0, 'gap', {}));
      await Promise.resolve();
    });
    expect(getState).toHaveBeenCalledWith('run-1');
    expect(result.current.state.server.snapshot!.lastSeq).toBe(40);
    expect(result.current.state.server.conn.lastSeq).toBe(40);
  });

  it('unknown events arrive via onmessage fallback without crashing', () => {
    const { result } = renderHook(() => {
      const rt = useRuntime();
      useEventStream('run-1');
      return rt;
    }, { wrapper });
    act(() => {
      result.current.dispatch({ type: 'snap/set', snap: snap() });
    });
    act(() => {
      MockEventSource.instances[0].fireMessage(env(4, 'future.event', { x: 1 }));
    });
    expect(result.current.state.server.conn.lastSeq).toBe(4);
    expect(result.current.state.server.snapshot!.trace.length).toBe(1);
  });

  it('errors reconnect with backoff and an updated cursor', () => {
    const { result } = renderHook(() => {
      const rt = useRuntime();
      useEventStream('run-1');
      return rt;
    }, { wrapper });
    act(() => {
      result.current.dispatch({ type: 'snap/set', snap: snap() });
    });
    act(() => {
      MockEventSource.instances[0].fire('task.updated', env(4, 'task.updated', {}));
      MockEventSource.instances[0].fail();
    });
    expect(result.current.state.server.conn.status).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances.length).toBe(2);
    // Reconnect replays from the latest applied seq.
    expect(MockEventSource.instances[1].url).toBe('/api/runs/run-1/events?since=4');
  });
});
