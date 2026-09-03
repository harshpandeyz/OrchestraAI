import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import type { StreamEnvelope } from '../types';

// SSE subscription with reconnect + stale detection. The server sends NAMED
// events (`event: model.selected`), which never fire EventSource.onmessage —
// so we register an explicit listener per known type plus an onmessage
// fallback for unnamed payloads. Missed events are replayed by the server via
// ?since=<lastSeq>; the reducer dedupes by seq.

const KNOWN_EVENTS = [
  'task.created', 'task.started', 'task.updated', 'planning',
  'context.built', 'context.added', 'context.removed', 'context.compressed', 'context.limit_warning',
  'model.discovered', 'model.updated', 'model.price_changed', 'model.health_changed', 'model.unavailable',
  'model.selected', 'model.switch_requested', 'model.switched', 'model.retained', 'model.switch_rejected',
  'cache.hit', 'cache.miss', 'cache.invalidated',
  'memory.read', 'memory.written', 'memory.write', 'memory.evicted',
  'tool.selected', 'tool.started', 'tool.completed', 'tool.finished', 'tool.failed',
  'execution.started', 'execution.step_started', 'execution.step_completed', 'execution.failed',
  'execution.retry', 'execution.paused', 'execution.resumed', 'execution.completed',
  'routing.evaluated', 'cost.updated', 'budget.warning', 'budget.exceeded',
  'optimization.triggered', 'optimization.completed',
  'run.completed', 'run.failed', 'run.cancelled',
  'price.updated', 'change.recorded', 'response.delta', 'response.done',
];

export function useEventStream(runId: string | null) {
  const { state, dispatch } = useRuntime();
  const retryRef = useRef(0);
  const lastSeq = state.server.conn.lastSeq;

  useEffect(() => {
    if (!runId) return;
    let es: EventSource | null = null;
    let closed = false;
    let staleTimer: any = null;

    const apply = (data: string) => {
      try {
        const env = JSON.parse(data) as StreamEnvelope;
        dispatch({ type: 'event/apply', env });
      } catch { /* ignore malformed */ }
    };

    const connect = () => {
      dispatch({ type: 'conn/set', conn: { status: retryRef.current > 0 ? 'reconnecting' : 'connected' } });
      // Capture since-seq at (re)connect time for server-side replay.
      es = new EventSource(api.streamUrl(runId, lastSeqRef.current || undefined));
      es.onopen = () => { retryRef.current = 0; dispatch({ type: 'conn/set', conn: { status: 'connected' } }); };
      for (const name of KNOWN_EVENTS) {
        es.addEventListener(name, (ev) => apply((ev as MessageEvent).data));
      }
      es.onmessage = (ev) => apply((ev as MessageEvent).data);
      es.onerror = () => {
        dispatch({ type: 'conn/set', conn: { status: 'reconnecting' } });
        try { es?.close(); } catch { /* ignore */ }
        if (!closed) {
          retryRef.current += 1;
          const backoff = Math.min(10000, 1000 * 2 ** Math.min(4, retryRef.current));
          setTimeout(() => { if (!closed) connect(); }, backoff);
        }
      };
    };
    lastSeqRef.current = lastSeq || 0;
    connect();

    // Stale watchdog: no updates for 30s => STALE (data kept, marked clearly).
    staleTimer = setInterval(() => {
      const lu = lastUpdateRef.current;
      if (lu && Date.now() - new Date(lu).getTime() > 30000) {
        dispatch({ type: 'conn/set', conn: { status: 'reconnecting' } });
      }
    }, 5000);

    return () => { closed = true; clearInterval(staleTimer); try { es?.close(); } catch { /* ignore */ } dispatch({ type: 'conn/set', conn: { status: 'disconnected' } }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  lastUpdateRef.current = state.server.conn.lastUpdate;
  return { lastSeq };
}
const lastUpdateRef: { current: string | null } = { current: null };
const lastSeqRef: { current: number } = { current: 0 };

export function freshnessLabel(status: string, lastUpdate: string | null): 'LIVE' | 'STALE' | 'DISCONNECTED' | 'UNKNOWN' {
  if (status === 'connected') {
    if (!lastUpdate) return 'LIVE';
    const age = Date.now() - new Date(lastUpdate).getTime();
    return age > 30000 ? 'STALE' : 'LIVE';
  }
  if (status === 'reconnecting') return 'STALE';
  if (status === 'disconnected') return 'DISCONNECTED';
  return 'UNKNOWN';
}
