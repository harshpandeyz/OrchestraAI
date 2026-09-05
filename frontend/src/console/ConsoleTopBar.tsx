// Console top bar, v4: authenticated console essentials — restrained, typography-first.
import React from 'react';
import { useRuntime } from '../state/store';
import { freshnessLabel } from '../hooks/useEventStream';
import { effectiveStatus } from '../lib/semantics';
import { Tip, shortcutLabel } from '../components/Tooltip';
import { IconMoon, IconPanelLeft, IconPanelRight, IconPlus, IconSearch, IconSun } from '../components/icons';

export function ConsoleTopBar() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  const mode = state.server.snapshot?.meta?.mode || null;
  const runRec = state.server.runs.find((r) => r.id === state.server.activeRunId);
  const effStatus = snap ? effectiveStatus(snap.status, runRec?.status) : null;
  const terminal = !!effStatus && ['completed', 'failed', 'cancelled'].includes(effStatus);
  const fresh = freshnessLabel(state.server.conn.status, state.server.conn.lastUpdate);
  const live = fresh === 'LIVE' && !terminal;
  const statusText = terminal
    ? effStatus === 'failed' ? 'Failed' : effStatus === 'cancelled' ? 'Stopped' : 'Complete'
    : fresh === 'LIVE' ? 'Live' : fresh === 'STALE' ? 'Stale' : fresh === 'DISCONNECTED' ? 'Offline' : 'Idle';
  const dotCls = terminal ? '' : fresh === 'LIVE' ? 'live' : fresh === 'STALE' ? 'warn' : fresh === 'DISCONNECTED' ? 'bad' : '';

  return (
    <header className="o2-topbar" role="banner">
      <div className="o2-brand" aria-label="OrchestraAI home">
        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
          <svg viewBox="0 0 32 32" width="24" height="24" role="img" aria-label="OrchestraAI logo">
            <rect width="32" height="32" rx="9" fill="#0B7A55" />
            <rect x="8" y="13" width="3.4" height="9" rx="1.7" fill="#fff" />
            <rect x="14.3" y="8" width="3.4" height="16" rx="1.7" fill="#fff" />
            <rect x="20.6" y="11" width="3.4" height="11" rx="1.7" fill="#8FE3B8" />
          </svg>
        </span>
        <span className="o2-brand-name">OrchestraAI</span>
        {mode && <span className="o2-mode">{mode === 'live' ? 'LIVE' : 'DEMO'}</span>}
      </div>
      <Tip label="Collapse sidebar">
        <button
          className="o2-iconbtn"
          aria-label="Open sidebar"
          onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: !state.ui.leftOpen } })}
        >
          <IconPanelLeft size={17} />
        </button>
      </Tip>
      <span className="o2-spacer" />
      <span className={`o2-connection ${dotCls}`} role="status" aria-label={`Runtime connection ${statusText}`}>
        <span className="o2-dot" aria-hidden="true" />
        {statusText}
      </span>
      <Tip label="Search runs, models, tools" shortcut={shortcutLabel('mod+k')}>
        <button
          className="o2-cmdk"
          onClick={() => dispatch({ type: 'ui/set', patch: { paletteOpen: true } })}
          aria-label={`Open command palette (${shortcutLabel('mod+k')})`}
        >
          <IconSearch size={15} />
          <span>Search</span>
          <kbd>{shortcutLabel('mod+k')}</kbd>
        </button>
      </Tip>
      <Tip label={state.ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        <button
          className="o2-iconbtn theme"
          aria-label="Toggle theme"
          onClick={() => {
            const next = state.ui.theme === 'dark' ? 'light' : 'dark';
            dispatch({ type: 'ui/set', patch: { theme: next } });
            try { localStorage.setItem('orchestra-theme', next); } catch { /* ignore */ }
          }}
        >
          {state.ui.theme === 'dark' ? <IconMoon size={16} /> : <IconSun size={16} />}
        </button>
      </Tip>
      <Tip label={state.ui.rightOpen ? 'Collapse live intelligence' : 'Open live intelligence'}>
        <button
          className="o2-iconbtn"
          aria-label={state.ui.rightOpen ? 'Collapse live intelligence panel' : 'Open live intelligence panel'}
          aria-pressed={state.ui.rightOpen}
          onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } })}
        >
          <IconPanelRight size={16} />
        </button>
      </Tip>
      <Tip label="Start a new run" shortcut={shortcutLabel('mod+n')}>
        <button className="o2-newrun" onClick={() => dispatch({ type: 'ui/set', patch: { newRunOpen: true } })} aria-label={`New run (${shortcutLabel('mod+n')})`}>
          <IconPlus size={15} /><span className="o2-newrun-label">New Run</span>
        </button>
      </Tip>
      <button className="o2-avatar" aria-label="Account and settings" title="Account and settings" onClick={() => dispatch({ type: 'ui/set', patch: { view: 'settings' } })}>
        OA
      </button>
    </header>
  );
}
