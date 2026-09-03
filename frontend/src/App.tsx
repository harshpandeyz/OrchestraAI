import React, { useCallback, useEffect } from 'react';
import { api } from './api/client';
import { RuntimeProvider, useRuntime } from './state/store';
import { freshnessLabel, useEventStream } from './hooks/useEventStream';
import { LeftPanel } from './components/LeftPanel';
import { Composer, MessageList, RunHeader } from './components/Center';
import { RuntimeInspector } from './components/Inspector';
import { CommandPalette } from './components/CommandPalette';
import { Skeleton } from './components/ui';
import { EvalsPage, MemoryPage, ModelsPage, SettingsPage, ToolsPage } from './pages/pages';

function TopBar() {
  const { state, dispatch } = useRuntime();
  const fresh = freshnessLabel(state.server.conn.status, state.server.conn.lastUpdate);
  const newRun = async () => {
    try {
      const { run } = await api.createRun('New agent run', state.ui.taskMode);
      const { runs } = await api.getRuns();
      dispatch({ type: 'runs/set', runs });
      dispatch({ type: 'runs/active', id: run.id });
      dispatch({ type: 'ui/set', patch: { view: 'run' } });
    } catch {
      dispatch({ type: 'toast/push', toast: { kind: 'err', title: 'Could not create run', body: 'Backend unavailable — is it running on :8787?' } });
    }
  };
  return (
    <header className="topbar">
      <button className="icon-btn" aria-label="Toggle navigation" aria-pressed={state.ui.leftOpen}
        onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: !state.ui.leftOpen } })}>☰</button>
      <div className="brand">Adaptive Agent <span>Runtime Console</span></div>
      <button className={`conn ${fresh.toLowerCase()}`} role="status" aria-label={`Connection ${fresh}${state.server.conn.lastUpdate ? `, last update ${new Date(state.server.conn.lastUpdate).toLocaleTimeString()}` : ''}`}
        title={state.server.conn.lastUpdate ? `Last update ${new Date(state.server.conn.lastUpdate).toLocaleString()}` : 'No updates yet'}
        onClick={() => dispatch({ type: 'ui/set', patch: { view: 'run' } })}>
        <span className="dot" aria-hidden="true" />{fresh}{fresh !== 'LIVE' && state.server.conn.lastUpdate ? ` · ${new Date(state.server.conn.lastUpdate).toLocaleTimeString()}` : ''}
      </button>
      <span className="spacer" />
      <button className="icon-btn" onClick={() => dispatch({ type: 'ui/set', patch: { paletteOpen: true } })} aria-label="Open command palette (Control or Command K)">⌘K <span className="hide-sm">Search</span></button>
      <button className="icon-btn" aria-label="Toggle theme" title="Toggle theme"
        onClick={() => { const next = state.ui.theme === 'dark' ? 'light' : 'dark'; dispatch({ type: 'ui/set', patch: { theme: next } }); try { localStorage.setItem('aar-theme', next); } catch { /* ignore */ } }}>
        {state.ui.theme === 'dark' ? '☾' : '☀'}
      </button>
      <button className="icon-btn" aria-label="Toggle inspector" aria-pressed={state.ui.rightOpen}
        onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } })}>Inspector</button>
      <button className="icon-btn primary" onClick={newRun}>+ <span className="hide-sm">New Run</span><span className="show-sm">New</span></button>
    </header>
  );
}

function Toasts() {
  const { state, dispatch } = useRuntime();
  useEffect(() => {
    if (!state.ui.toasts.length) return;
    const t = setTimeout(() => dispatch({ type: 'toast/dismiss', id: state.ui.toasts[0].id }), 6000);
    return () => clearTimeout(t);
  }, [state.ui.toasts, dispatch]);
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {state.ui.toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span><b>{t.title}</b>{t.body ? <span className="tbody"> — {t.body}</span> : null}</span>
          <button aria-label="Dismiss notification" onClick={() => dispatch({ type: 'toast/dismiss', id: t.id })}>✕</button>
        </div>
      ))}
    </div>
  );
}

function Boot() {
  const { state, dispatch } = useRuntime();
  const activeId = state.server.activeRunId;

  useEffect(() => {
    document.documentElement.dataset.theme = state.ui.theme;
    try { localStorage.setItem('aar-theme', state.ui.theme); } catch { /* ignore */ }
  }, [state.ui.theme]);

  // Narrow screens: drawers start closed so the center workspace is primary.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 980) {
      dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [{ runs }, { models }, { tools }, { items }, evals] = await Promise.all([
        api.getRuns(), api.getModels(), api.getTools(), api.getMemory(), api.getEvaluations(),
      ]);
      dispatch({ type: 'runs/set', runs });
      dispatch({ type: 'models/set', models });
      dispatch({ type: 'tools/set', tools });
      dispatch({ type: 'mem/set', items });
      dispatch({ type: 'evals/set', evals: evals.evaluations || [], note: evals.note || '' });
      if (!activeId && runs.length) dispatch({ type: 'runs/active', id: runs[0].id });
    } catch {
      dispatch({ type: 'conn/set', conn: { status: 'disconnected' } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    api.getState(activeId).then(({ state: snap }) => { if (!cancelled) dispatch({ type: 'snap/set', snap }); })
      .catch(() => dispatch({ type: 'conn/set', conn: { status: 'disconnected' } }));
    return () => { cancelled = true; };
  }, [activeId, dispatch]);

  useEventStream(activeId);
  const snap = state.server.snapshot;
  const fresh = freshnessLabel(state.server.conn.status, state.server.conn.lastUpdate);
  const drawerOpen = (state.ui.leftOpen || state.ui.rightOpen) && typeof window !== 'undefined' && window.innerWidth <= 980;

  return (
    <div className="app">
      <TopBar />
      <div className="shell">
        <LeftPanel />
        <main className="center" aria-label="Workspace">
          {state.ui.view !== 'run' ? (
            state.ui.view === 'models' ? <ModelsPage /> : state.ui.view === 'memory' ? <MemoryPage />
              : state.ui.view === 'tools' ? <ToolsPage /> : state.ui.view === 'evals' ? <EvalsPage /> : <SettingsPage />
          ) : !snap ? (
            state.server.conn.status === 'disconnected' ? (
              <div className="banner err" role="alert">
                <span><b>Backend unavailable</b> — start it with `npm start` (port 8787) and reload. No fake runtime is shown.</span>
                <button className="icon-btn sm" onClick={() => loadAll()}>Retry</button>
              </div>
            ) : (
              <div className="page" aria-label="Loading runtime state"><Skeleton lines={8} /></div>
            )
          ) : (
            <>
              {fresh !== 'LIVE' && (
                <div className={`banner ${fresh === 'STALE' ? 'warn' : 'err'}`} role="alert">
                  <span>{fresh === 'STALE' ? 'STALE DATA — live connection lost. ' : 'DISCONNECTED — '}Last update: {snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : 'never'}. State below is marked stale, not current.</span>
                </div>
              )}
              {failedBanner(snap.status)}
              <RunHeader />
              <MessageList messages={snap.messages} />
              <Composer />
            </>
          )}
        </main>
        {state.ui.view === 'run' && snap && <RuntimeInspector />}
        {drawerOpen && (
          <button className="scrim" aria-label="Close panels"
            onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } })} />
        )}
      </div>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function failedBanner(status: string): React.ReactNode {
  if (status === 'failed') {
    return <div className="banner err" role="alert"><span><b>Run failed.</b> Review the execution trace and inspector, then Retry when ready.</span></div>;
  }
  if (status === 'cancelled') {
    return <div className="banner warn" role="status"><span>Run cancelled. State is preserved — send a new message or Retry to continue.</span></div>;
  }
  return null;
}

export default function App() {
  return <RuntimeProvider><Boot /></RuntimeProvider>;
}
