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
  'model.call_completed',
  'cache.hit', 'cache.miss', 'cache.invalidated',
  'memory.read', 'memory.written', 'memory.write', 'memory.evicted',
  'tool.selected', 'tool.started', 'tool.completed', 'tool.finished', 'tool.failed',
  'tool.approval_required', 'tool.approved', 'tool.denied', 'tool.timed_out',
  'approval.requested', 'approval.decided',
  'plan.created', 'plan.updated',
  'changeset.created', 'changeset.approval_required', 'changeset.applied', 'changeset.rolled_back',
  'verification.started', 'verification.passed', 'verification.failed',
  'episode.started', 'episode.completed',
  'execution.started', 'execution.step_started', 'execution.step_completed', 'execution.failed',
  'execution.retry', 'execution.paused', 'execution.resumed', 'execution.completed',
  'execution.recovery_started', 'execution.recovered', 'execution.recovery_blocked',
  'routing.evaluated', 'cost.updated', 'budget.warning', 'budget.exceeded',
  'optimization.triggered', 'optimization.completed',
  'run.completed', 'run.failed', 'run.cancelled',
  'price.updated', 'change.recorded', 'response.delta', 'response.done',
];

export function useEventStream(runId: string | null) {
  const { state, dispatch } = useRuntime();
  const retryRef = useRef(0);
  const lastUpdateRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const lastSeq = state.server.conn.lastSeq;
  // Sync the reconnect cursor inside effects only — writing refs during render
  // is a side effect and breaks under concurrent rendering. The cursor always
  // holds the latest applied seq so a dropped stream replays from the right
  // point (the reducer dedupes by seq regardless).
  useEffect(() => { lastSeqRef.current = lastSeq || 0; }, [lastSeq]);
  useEffect(() => { lastUpdateRef.current = state.server.conn.lastUpdate; }, [state.server.conn.lastUpdate]);

  useEffect(() => {
    if (!runId) return;
    let es: EventSource | null = null;
    let closed = false;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    let bufferedDelta = '';
    let bufferedDeltaEnv: StreamEnvelope | null = null;
    let resyncing = false;

    const flushDelta = () => {
      if (!bufferedDeltaEnv) return;
      const env = bufferedDeltaEnv;
      bufferedDeltaEnv = null;
      const delta = bufferedDelta;
      bufferedDelta = '';
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = null;
      dispatch({ type: 'event/apply', env: { ...env, payload: { ...env.payload, delta } } });
    };

    const apply = (data: string) => {
      try {
        const env = JSON.parse(data) as StreamEnvelope;
        // Provider token streams can emit dozens of events per second. Coalesce
        // only adjacent text deltas; lifecycle, usage, and error events remain
        // ordered and are flushed before they are applied.
        if (env.type === 'response.delta') {
          bufferedDelta += String(env.payload?.delta || '');
          bufferedDeltaEnv = env;
          if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 16);
          return;
        }
        flushDelta();
        dispatch({ type: 'event/apply', env });
      } catch { /* ignore malformed */ }
    };

    const resyncSnapshot = async () => {
      if (closed || resyncing) return;
      resyncing = true;
      dispatch({ type: 'conn/set', conn: { status: 'reconnecting' } });
      try {
        const result = await api.getState(runId);
        if (!closed && result.state) {
          lastSeqRef.current = result.state.lastSeq || 0;
          dispatch({ type: 'snap/set', snap: result.state });
        }
      } catch {
        // The normal reconnect path will retry if the snapshot endpoint is
        // temporarily unavailable.
      } finally {
        resyncing = false;
      }
    };

    const connect = () => {
      dispatch({ type: 'conn/set', conn: { status: retryRef.current > 0 ? 'reconnecting' : 'connected' } });
      // Capture since-seq at (re)connect time for server-side replay.
      // Session cookies must accompany cross-origin Vite-dev SSE as well as
      // same-origin production SSE; the backend authenticates the stream.
      es = new EventSource(api.streamUrl(runId, lastSeqRef.current || undefined), { withCredentials: true });
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
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!closed) connect(); }, backoff);
        }
      };
      es.addEventListener('gap', () => { void resyncSnapshot(); });
    };
    connect();

    // Stale watchdog: no updates for 30s => STALE (data kept, marked clearly).
    staleTimer = setInterval(() => {
      const lu = lastUpdateRef.current;
      if (lu && Date.now() - new Date(lu).getTime() > 30000) {
        dispatch({ type: 'conn/set', conn: { status: 'reconnecting' } });
      }
    }, 5000);

    return () => {
      closed = true;
      if (staleTimer) clearInterval(staleTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = null;
      bufferedDelta = '';
      bufferedDeltaEnv = null;
      try { es?.close(); } catch { /* ignore */ }
      dispatch({ type: 'conn/set', conn: { status: 'disconnected' } });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { lastSeq };
}

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
