import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { RuntimeProvider, clampWidth, persistPanels, useRuntime } from './state/store';
import type { View } from './state/store';
import { freshnessLabel, useEventStream } from './hooks/useEventStream';
import { LeftPanel } from './components/LeftPanel';
import { Composer, MessageList, RunHeader } from './components/Center';
import { RuntimeInspector } from './components/Inspector';
import { CommandPalette } from './components/CommandPalette';
import { NewRunDialog } from './components/NewRunDialog';
import { Onboarding } from './components/Onboarding';
import { Skeleton } from './components/ui';
import { Tip, shortcutLabel } from './components/Tooltip';
import {
  IconChevronLeft, IconChevronRight, IconMoon, IconPanelLeft, IconPanelRight,
  IconPlus, IconSearch, IconSun, IconX,
} from './components/icons';
import { EvalsPage, MemoryPage, ModelsPage, SettingsPage, ToolsPage } from './pages/pages';
import { OverviewPage, SavingsPage } from './pages/command-center';
import { BillingPage, OperationsPage, ProjectsPage } from './pages/account';
import { AuthPage, LandingPage } from './pages/public';

const LEFT_MIN = 180, LEFT_MAX = 380, RIGHT_MIN = 300, RIGHT_MAX = 520;

function ModeBadge() {
  const { state } = useRuntime();
  const [mode, setMode] = React.useState<string | null>(state.server.snapshot?.meta?.mode || null);
  const [provider, setProvider] = React.useState<string | null>(state.server.snapshot?.meta?.provider || null);
  React.useEffect(() => {
    setMode(state.server.snapshot?.meta?.mode || null);
    setProvider(state.server.snapshot?.meta?.provider || null);
  }, [state.server.snapshot?.meta?.mode, state.server.snapshot?.meta?.provider]);
  React.useEffect(() => {
    let cancelled = false;
    api.health().then(h => {
      if (cancelled || mode) return;
      setMode(h.mode || null);
      setProvider(h.provider || null);
    }).catch(() => { /* unknown stays unknown */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!mode) return <span className="pill neutral sm modebadge" title="Runtime mode unknown — backend not reached yet">UNKNOWN</span>;
  const live = mode === 'live';
  return (
    <span className={`pill sm modebadge ${live ? 'ok' : 'neutral'}`}
      title={live ? `LIVE — real provider calls${provider ? ` via ${provider}` : ''}` : 'DEMO — labelled mock provider, no real model calls'}
      aria-label={`Runtime mode ${live ? 'live' : 'demo'}`}>
      <span className="status-dot healthy" aria-hidden="true" style={live ? undefined : { background: 'var(--faint)' }} />{live ? 'LIVE' : 'DEMO'}
    </span>
  );
}

function useNewRun() {
  const { dispatch } = useRuntime();
  return useCallback(() => {
    dispatch({ type: 'ui/set', patch: { newRunOpen: true } });
  }, [dispatch]);
}

function TopBar() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  const terminalStatus = snap ? String(snap.status) : null;
  const terminal = !!terminalStatus && ['completed', 'failed', 'cancelled'].includes(terminalStatus);
  const fresh = freshnessLabel(state.server.conn.status, state.server.conn.lastUpdate);
  const pill = terminal && fresh !== 'DISCONNECTED' ? 'FINAL' : fresh;
  // The FINAL pill covers three distinct terminal states — its copy must say
  // which one, or a failed run reads as "complete" next to the LIVE mode badge.
  const terminalCopy = terminalStatus === 'failed'
    ? { label: 'Run failed, showing final state', title: 'Run failed — this is the final state, not a live stream' }
    : terminalStatus === 'cancelled'
      ? { label: 'Run cancelled, showing final state', title: 'Run cancelled — this is the final state, not a live stream' }
      : { label: 'Run complete, showing final state', title: 'Run is complete — this is the final state, not a live stream' };
  const newRun = useNewRun();
  const toggleTheme = () => {
    const next = state.ui.theme === 'dark' ? 'light' : 'dark';
    dispatch({ type: 'ui/set', patch: { theme: next } });
    try { localStorage.setItem('orchestra-theme', next); } catch { /* ignore */ }
  };
  return (
    <header className="topbar">
      <Tip label={state.ui.leftOpen ? 'Collapse sidebar' : 'Open sidebar'}>
        <button className="icon-btn icon-only" aria-label={state.ui.leftOpen ? 'Collapse navigation sidebar' : 'Open navigation sidebar'} aria-pressed={state.ui.leftOpen}
          onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: !state.ui.leftOpen } })}><IconPanelLeft size={17} /></button>
      </Tip>
      <div className="brand" aria-label="OrchestraAI home">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="26" height="26" role="img">
            <rect width="32" height="32" rx="9" fill="#0C7A5C" />
            <rect x="8" y="13" width="3.4" height="9" rx="1.7" fill="#fff" />
            <rect x="14.3" y="8" width="3.4" height="16" rx="1.7" fill="#fff" />
            <rect x="20.6" y="11" width="3.4" height="11" rx="1.7" fill="#BDE6D2" />
          </svg>
        </span>
        <span className="brand-name">OrchestraAI</span>
        <span className="brand-tag">agent runtime</span>
        <ModeBadge />
      </div>
      <button className={`conn ${pill.toLowerCase()}`} role="status" aria-label={pill === 'FINAL' ? terminalCopy.label : `Connection ${pill}${state.server.conn.lastUpdate ? `, last update ${new Date(state.server.conn.lastUpdate).toLocaleTimeString()}` : ''}`}
        title={pill === 'FINAL' ? terminalCopy.title : state.server.conn.lastUpdate ? `Last update ${new Date(state.server.conn.lastUpdate).toLocaleString()}` : 'No updates yet'}
        onClick={() => dispatch({ type: 'ui/set', patch: { view: 'run' } })}>
        <span className="dot" aria-hidden="true" />{pill}{pill !== 'FINAL' && pill !== 'LIVE' && state.server.conn.lastUpdate ? ` · ${new Date(state.server.conn.lastUpdate).toLocaleTimeString()}` : ''}
      </button>
      <span className="spacer" />
      <Tip label="Search runs, models, tools" shortcut={shortcutLabel('mod+k')}>
        <button className="icon-btn icon-only" onClick={() => dispatch({ type: 'ui/set', patch: { paletteOpen: true } })} aria-label={`Open command palette (${shortcutLabel('mod+k')})`}><IconSearch size={17} /></button>
      </Tip>
      <Tip label={state.ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        <button className="icon-btn icon-only topbar-theme" aria-label="Toggle theme"
          onClick={toggleTheme}>
          {state.ui.theme === 'dark' ? <IconMoon size={17} /> : <IconSun size={17} />}
        </button>
      </Tip>
      <Tip label={state.ui.rightOpen ? 'Collapse runtime inspector' : 'Open runtime inspector'}>
        <button className="icon-btn icon-only" aria-label={state.ui.rightOpen ? 'Collapse runtime inspector' : 'Open runtime inspector'} aria-pressed={state.ui.rightOpen}
          onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } })}><IconPanelRight size={17} /></button>
      </Tip>
      <Tip label="Start a new run" shortcut={shortcutLabel('mod+n')}>
        <button className="icon-btn primary top-newrun" onClick={newRun} aria-label={`New run (${shortcutLabel('mod+n')})`}><IconPlus size={16} /><span className="hide-sm">New Run</span><span className="show-sm">New</span></button>
      </Tip>
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
          <button aria-label="Dismiss notification" onClick={() => dispatch({ type: 'toast/dismiss', id: t.id })}><IconX size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/** Draggable divider between workspace and a side panel. Keyboard accessible. */
function ResizeHandle({
  side, onResize,
}: {
  side: 'left' | 'right';
  onResize: (deltaX: number) => void;
}) {
  const { state } = useRuntime();
  const dragging = useRef(false);
  const label = side === 'left' ? 'Resize navigation panel' : 'Resize runtime inspector';
  const width = side === 'left' ? state.ui.leftWidth : state.ui.rightWidth;
  const min = side === 'left' ? LEFT_MIN : RIGHT_MIN;
  const max = side === 'left' ? LEFT_MAX : RIGHT_MAX;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(side === 'left' ? -step : step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onResize(side === 'left' ? step : -step); }
    else if (e.key === 'Home') { e.preventDefault(); onResize((side === 'left' ? LEFT_MIN : RIGHT_MIN) - width); }
    else if (e.key === 'End') { e.preventDefault(); onResize((side === 'left' ? LEFT_MAX : RIGHT_MAX) - width); }
  };

  return (
    <div
      className={`resize-handle resize-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}. Current width ${width} pixels. Use left and right arrows to resize.`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={e => {
        e.preventDefault();
        dragging.current = true;
        const startX = e.clientX;
        let last = 0;
        const move = (ev: MouseEvent) => {
          if (!dragging.current) return;
          const dx = ev.clientX - startX;
          onResize(dx - last);
          last = dx;
        };
        const up = () => {
          dragging.current = false;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      onTouchStart={e => {
        const t = e.touches[0];
        if (!t) return;
        const startX = t.clientX;
        let last = 0;
        const move = (ev: TouchEvent) => {
          const cur = ev.touches[0]?.clientX;
          if (cur === undefined) return;
          const dx = cur - startX;
          onResize(dx - last);
          last = dx;
        };
        const end = () => {
          window.removeEventListener('touchmove', move);
          window.removeEventListener('touchend', end);
        };
        window.addEventListener('touchmove', move, { passive: true });
        window.addEventListener('touchend', end);
      }}
    />
  );
}

function useViewportWidth(): number {
  const [vw, setVw] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1440);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vw;
}

function Boot() {
  const { state, dispatch } = useRuntime();
  const activeId = state.server.activeRunId;

  useEffect(() => {
    document.documentElement.dataset.theme = state.ui.theme;
    try { localStorage.setItem('orchestra-theme', state.ui.theme); } catch { /* ignore */ }
  }, [state.ui.theme]);

  // Persist workspace geometry (widths + collapsed state). Transient run state
  // is never persisted as configuration.
  useEffect(() => {
    persistPanels(state.ui);
  }, [state.ui.leftOpen, state.ui.rightOpen, state.ui.leftWidth, state.ui.rightWidth]);

  // Narrow screens: drawers start closed so the center workspace is primary.
  // ?theme=dark|light and ?view=… deep-links override once.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 980) {
      dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } });
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('theme');
      if (t === 'dark' || t === 'light') dispatch({ type: 'ui/set', patch: { theme: t } });
      const v = (params.get('view') || '').toLowerCase();
      if (v === 'overview' || v === 'savings' || v === 'models' || v === 'tools' || v === 'memory' || v === 'evals' || v === 'settings' || v === 'run') {
        dispatch({ type: 'ui/set', patch: { view: v as View } });
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts: the only shortcuts worth knowing. Revealed via tooltips
  // and the palette — never as permanent layout content.
  // ⌘/Ctrl+K palette · / focus composer · ⌘/Ctrl+N new run · Esc close/stop.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        dispatch({ type: 'ui/set', patch: { newRunOpen: true } });
      } else if (e.key === 'Escape') {
        if (state.ui.paletteOpen) return; // palette handles its own Esc
        if (typeof window !== 'undefined' && window.innerWidth <= 980 && (state.ui.leftOpen || state.ui.rightOpen)) {
          dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } });
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dispatch, state.ui.paletteOpen, state.ui.leftOpen, state.ui.rightOpen]);

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
  const snapTerminal = !!snap && ['completed', 'failed', 'cancelled'].includes(String(snap.status));
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 980;
  const drawerOpen = (state.ui.leftOpen || state.ui.rightOpen) && narrow;
  const isRunView = state.ui.view === 'run';

  const resizeLeft = useCallback((dx: number) => {
    dispatch({ type: 'ui/set', patch: { leftWidth: clampWidth(state.ui.leftWidth + dx, LEFT_MIN, LEFT_MAX) } });
  }, [dispatch, state.ui.leftWidth]);
  const resizeRight = useCallback((dx: number) => {
    // Right handle sits left of the panel: dragging left widens.
    dispatch({ type: 'ui/set', patch: { rightWidth: clampWidth(state.ui.rightWidth - dx, RIGHT_MIN, RIGHT_MAX) } });
  }, [dispatch, state.ui.rightWidth]);

  // Tracks are built to match exactly the children actually rendered
  // (hidden panels are display:none and leave grid flow; each visible panel
  // is followed by its overlay handle track). A static 5-track template
  // would drop <main> into a 0px track whenever a panel is closed.
  const vw = useViewportWidth();
  const effLeft = vw <= 1024 ? Math.min(state.ui.leftWidth, 206) : vw <= 1200 ? Math.min(state.ui.leftWidth, 220) : vw <= 1280 ? Math.min(state.ui.leftWidth, 232) : state.ui.leftWidth;
  const effRight = vw <= 1024 ? Math.min(state.ui.rightWidth, 308) : vw <= 1200 ? Math.min(state.ui.rightWidth, 328) : vw <= 1280 ? Math.min(state.ui.rightWidth, 348) : state.ui.rightWidth;
  const rightShown = isRunView && !!snap && state.ui.rightOpen;
  const shellStyle: React.CSSProperties = narrow ? {} : {
    gridTemplateColumns: [
      ...(state.ui.leftOpen ? [`${effLeft}px`, '0px'] : []),
      'minmax(0,1fr)',
      ...(rightShown ? ['0px', `${effRight}px`] : []),
    ].join(' '),
  };

  return (
    <div className="app">
      <TopBar />
      <div className="shell" style={shellStyle}>
        <LeftPanel />
        {!narrow && state.ui.leftOpen && <ResizeHandle side="left" onResize={resizeLeft} />}
        <main className="center" aria-label="Workspace">
          {state.ui.view !== 'run' ? (
            state.ui.view === 'overview' ? <OverviewPage /> : state.ui.view === 'savings' ? <SavingsPage /> : state.ui.view === 'models' ? <ModelsPage /> : state.ui.view === 'memory' ? <MemoryPage />
              : state.ui.view === 'tools' ? <ToolsPage /> : state.ui.view === 'evals' ? <EvalsPage /> : state.ui.view === 'billing' ? <BillingPage /> : state.ui.view === 'projects' ? <ProjectsPage />
                : state.ui.view === 'sessions' || state.ui.view === 'prompts' || state.ui.view === 'cache' || state.ui.view === 'alerts' ? <OperationsPage kind={state.ui.view} /> : <SettingsPage />
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
              {fresh !== 'LIVE' && !snapTerminal && (
                <div className={`banner ${fresh === 'STALE' ? 'warn' : 'err'}`} role="alert">
                  <span>{fresh === 'STALE' ? 'STALE DATA — live connection lost. ' : 'DISCONNECTED — '}Last update: {snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : 'never'}. State below is marked stale, not current.</span>
                </div>
              )}
              {fresh === 'DISCONNECTED' && snapTerminal && (
                <div className="banner err" role="alert">
                  <span>DISCONNECTED — showing the final saved state. It is complete, not live.</span>
                </div>
              )}
              {failedBanner(snap.status)}
              <FirstRunBanner />
              <RunHeader />
              <MessageList messages={snap.messages} />
              <Composer />
            </>
          )}
        </main>
        {!narrow && isRunView && snap && state.ui.rightOpen && <ResizeHandle side="right" onResize={resizeRight} />}
        {isRunView && snap && <RuntimeInspector />}
        {drawerOpen && (
          <button className="scrim" aria-label="Close panels"
            onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } })} />
        )}
      </div>
      {/* Collapsed-panel affordances: one clear control each, never trapped. */}
      {!narrow && !state.ui.leftOpen && (
        <Tip label="Open sidebar">
          <button className="rail-fab rail-left" aria-label="Open navigation sidebar" onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: true } })}>
            <IconChevronRight size={15} />
          </button>
        </Tip>
      )}
      {!narrow && isRunView && snap && !state.ui.rightOpen && (
        <Tip label="Open runtime inspector" side="left">
          <button className="rail-fab rail-right" aria-label="Open runtime inspector" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: true } })}>
            <IconChevronLeft size={15} />
          </button>
        </Tip>
      )}
      <CommandPalette />
      <NewRunDialog />
      <Onboarding />
      <Toasts />
    </div>
  );
}

function FirstRunBanner() {
  const { state, dispatch } = useRuntime();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('orchestra-demo-banner-v1') === '1'; } catch { return true; }
  });
  const [checked, setChecked] = useState<{ demo: boolean; anyConnected: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getProviders()
      .then(({ mode, providers }) => {
        if (!cancelled) setChecked({ demo: mode !== 'live', anyConnected: (providers || []).some((p) => p.connected) });
      })
      .catch(() => { if (!cancelled) setChecked({ demo: false, anyConnected: true }); });
    return () => { cancelled = true; };
  }, []);
  if (dismissed || !checked || !checked.demo || checked.anyConnected) return null;
  if (state.ui.view !== 'run') return null;
  const hide = () => {
    try { localStorage.setItem('orchestra-demo-banner-v1', '1'); } catch { /* ignore */ }
    setDismissed(true);
  };
  return (
    <div className="banner info" role="status">
      <span><b>OrchestraAI is ready.</b> Connect a provider to enable LIVE mode, or keep exploring in Demo mode.</span>
      <span className="banner-actions">
        <button className="icon-btn sm primary" onClick={() => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: 'providers' } })}>
          Connect provider
        </button>
        <button className="icon-btn sm" onClick={hide}>Demo mode</button>
      </span>
    </div>
  );
}

function failedBanner(status: string): React.ReactNode {
  if (status === 'failed') {
    return <div className="banner err" role="alert"><span><b>Run failed.</b> Review the execution trace and inspector, then Retry when ready.</span></div>;
  }
  if (status === 'cancelled') {
    return <div className="banner warn" role="status"><span>Run cancelled. State is preserved — press <b>New Run</b> above to start another task.</span></div>;
  }
  return null;
}

export default function App() {
  const pathname = typeof window === 'undefined' ? '/console' : window.location.pathname;
  if (pathname === '/' || pathname === '/welcome') return <LandingPage />;
  if (pathname === '/auth' || pathname === '/login' || pathname === '/signup') return <AuthPage />;
  return <RuntimeProvider><Boot /></RuntimeProvider>;
}
