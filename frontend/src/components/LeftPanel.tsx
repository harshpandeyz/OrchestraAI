import React, { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { relTime, statusPill, usd } from './ui';

const RUNTIME_NAV = [
  { view: 'models' as const, label: 'Models', ico: '◈', hint: 'Browse model catalog' },
  { view: 'tools' as const, label: 'Tools', ico: '✚', hint: 'Tool registry' },
  { view: 'memory' as const, label: 'Memory', ico: '◉', hint: 'Working + long-term memory' },
  { view: 'evals' as const, label: 'Evaluations', ico: '★', hint: 'Runtime quality' },
];
const SYSTEM_NAV = [
  { view: 'settings' as const, anchor: 'providers', label: 'Providers', ico: '◍', hint: 'Provider configuration and runtime mode' },
  { view: 'settings' as const, anchor: null as string | null, label: 'Settings', ico: '⚙', hint: 'Console settings' },
];

export function LeftPanel() {
  const { state, dispatch } = useRuntime();
  const { runs, activeRunId } = state.server;
  const q = state.ui.runQuery.toLowerCase();
  const filtered = useMemo(
    () => runs.filter(r => !q || (r.title + r.id + r.taskMode + r.status).toLowerCase().includes(q)).slice(0, 60),
    [runs, q],
  );
  const active = runs.find(r => r.id === activeRunId);
  const [creating, setCreating] = useState(false);
  const go = (view: typeof state.ui.view, anchor: string | null = null) => {
    dispatch({ type: 'ui/set', patch: { view, settingsAnchor: anchor, leftOpen: window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };
  const newRun = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { run } = await api.createRun('New agent run', state.ui.taskMode);
      const { runs: fresh } = await api.getRuns();
      dispatch({ type: 'runs/set', runs: fresh });
      dispatch({ type: 'runs/active', id: run.id });
      dispatch({ type: 'ui/set', patch: { view: 'run', leftOpen: window.innerWidth > 980 ? state.ui.leftOpen : false } });
    } catch {
      dispatch({ type: 'toast/push', toast: { kind: 'err', title: 'Could not create run', body: 'Backend unavailable — is it running on :8787?' } });
    } finally {
      setCreating(false);
    }
  };
  const pickRun = (id: string) => {
    dispatch({ type: 'runs/active', id });
    dispatch({ type: 'ui/set', patch: { view: 'run', leftOpen: window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };

  return (
    <nav className={`left ${state.ui.leftOpen ? 'open' : ''}`} aria-label="Primary">
      <button className="newrun-btn" onClick={newRun} disabled={creating} aria-label="Create a new run">
        <span aria-hidden="true">+</span> {creating ? 'Creating…' : 'New Run'}
      </button>
      <div className="nav-sec">Workspace <span className="n">{runs.length}</span></div>
      {runs.length > 1 && (
        <input className="nav-search" placeholder="Filter runs…" aria-label="Filter runs" value={state.ui.runQuery}
          onChange={e => dispatch({ type: 'ui/set', patch: { runQuery: e.target.value } })} />
      )}
      {active && state.ui.view === 'run' && (
        <div className="active-run-card" aria-label="Active run">
          <div className="lbl">Active run</div>
          <div className="ttl" title={active.title}>{active.title}</div>
          <div className="meta">
            <span className={`pill ${statusPill(active.status)}`} style={{ fontSize: 10 }}>{String(active.status).toUpperCase()}</span>
            <span>{usd(active.spent)} / {usd(active.budget)}</span>
          </div>
        </div>
      )}
      <div className="run-list" role="listbox" aria-label="Runs">
        {filtered.length === 0 && (
          <div className="empty" role="status"><b>No runs yet</b><span>Press New Run above to start your first task.</span></div>
        )}
        {filtered.map(r => {
          const isActive = r.id === activeRunId;
          const modelShort = r.activeModelId ? r.activeModelId.split('/').pop() : null;
          return (
            <button key={r.id} role="option" aria-selected={isActive} aria-current={isActive ? 'true' : undefined}
              className={`run-item ${isActive ? 'active' : ''}`} onClick={() => pickRun(r.id)} title={`${r.title} · ${r.status} · ${r.taskMode}`}>
              <span className="r1">
                <span className={`status-dot ${statusPill(r.status) === 'ok' ? 'healthy' : statusPill(r.status) === 'err' ? 'down' : statusPill(r.status) === 'warn' ? 'degraded' : 'idle'}`} aria-hidden="true" />
                <span className="t">{r.title}</span>
              </span>
              <span className="s">
                <span>{relTime(r.updatedAt)}</span>
                <span>· {usd(r.spent)}</span>
                {modelShort && <span className="modeltag" title={r.activeModelId || ''}>{modelShort}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="nav-sec">Runtime</div>
      {RUNTIME_NAV.map(i => {
        const count = i.view === 'models' ? state.server.models.length : i.view === 'tools' ? state.server.tools.length : i.view === 'memory' ? state.server.memItems.length : state.server.evals.length;
        return (
          <button key={i.label} className={`nav-item ${state.ui.view === i.view ? 'active' : ''}`}
            aria-current={state.ui.view === i.view ? 'page' : undefined} title={i.hint} onClick={() => go(i.view)}>
            <span className="ico" aria-hidden="true">{i.ico}</span>{i.label}
            <span className="count">{count}</span>
          </button>
        );
      })}

      <div className="nav-sec">System</div>
      {SYSTEM_NAV.map(i => {
        const isActive = state.ui.view === i.view && (state.ui.settingsAnchor || null) === i.anchor;
        return (
          <button key={i.label} className={`nav-item ${isActive ? 'active' : ''}`}
            aria-current={isActive ? 'page' : undefined} title={i.hint} onClick={() => go(i.view, i.anchor)}>
            <span className="ico" aria-hidden="true">{i.ico}</span>{i.label}
          </button>
        );
      })}
      <React.Fragment>
        <div className="nav-sec">Shortcuts</div>
        <div className="nav-hints">
          <span><kbd>⌘K</kbd> search</span>
          <span><kbd>/</kbd> composer</span>
          <span><kbd>Enter</kbd> send</span>
        </div>
      </React.Fragment>
    </nav>
  );
}
