import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { RuntimeProvider, clampWidth, persistPanels, useRuntime } from './state/store';
import type { View } from './state/store';
import { freshnessLabel, useEventStream } from './hooks/useEventStream';
import { effectiveStatus } from './lib/semantics';
import { ConsoleSidebar } from './console/ConsoleSidebar';
import { ConsoleTopBar } from './console/ConsoleTopBar';
import { LiveIntelligence } from './console/LiveIntelligence';
import { Composer, MessageList, RunHeader } from './components/Center';
import { CommandPalette } from './components/CommandPalette';
import { NewRunDialog } from './components/NewRunDialog';
import { Onboarding } from './components/Onboarding';
import { Skeleton } from './components/ui';
import { IconChevronLeft, IconChevronRight, IconX } from './components/icons';
import { EvalsPage, MemoryPage, ModelsPage, SettingsPage, ToolsPage } from './pages/pages';
import { OverviewPage, SavingsPage } from './pages/command-center';
import { BillingPage, OperationsPage, ProjectsPage } from './pages/account';
import { AuthPage, LandingPage } from './pages/public';
import { PricingPage } from './pages/pricing';
import { IntelligencePage } from './analytics/Intelligence';
import './console/styles/console.css';
import './analytics/intelligence.css';

const LEFT_MIN = 180, LEFT_MAX = 380, RIGHT_MIN = 300, RIGHT_MAX = 520;

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

function Breadcrumbs({ view }: { view: View }) {
  const parts: { label: string; href?: string }[] = [];
  if (view === 'run') {
    parts.push({ label: 'Run' });
  } else if (view === 'overview') {
    parts.push({ label: 'Overview' });
  } else if (view === 'savings') {
    parts.push({ label: 'Savings' });
  } else if (view === 'models') {
    parts.push({ label: 'Models' });
  } else if (view === 'tools') {
    parts.push({ label: 'Tools' });
  } else if (view === 'memory') {
    parts.push({ label: 'Memory' });
  } else if (view === 'evals') {
    parts.push({ label: 'Evaluations' });
  } else if (view === 'cache') {
    parts.push({ label: 'Cache' });
  } else if (view === 'alerts') {
    parts.push({ label: 'Alerts' });
  } else if (view === 'projects') {
    parts.push({ label: 'Projects' });
  } else if (view === 'billing') {
    parts.push({ label: 'Billing' });
  } else if (view === 'settings') {
    parts.push({ label: 'Settings' });
  } else if (view === 'intelligence') {
    parts.push({ label: 'Intelligence' });
  } else if (view === 'conversations') {
    parts.push({ label: 'Conversations' });
  } else if (view === 'traces') {
    parts.push({ label: 'Traces' });
  } else if (view === 'api') {
    parts.push({ label: 'API' });
  } else if (view === 'prompts') {
    parts.push({ label: 'Prompts' });
  }
  return (
    <nav className="o2-breadcrumbs" aria-label="Page breadcrumbs">
      {parts.map((p, i) => (
        <span key={i} style={{ marginRight: 8 }}>
          {i > 0 ? ' / ' : ''}
          <a href={p.href || '#'} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{p.label}</a>
        </span>
      ))}
    </nav>
  );
}

function PageHeader({ title, eyebrow, view }: { title: string; eyebrow?: string; view: View }) {
  return (
    <header className="o2-page-header" aria-label="Page header">
      <div className="o2-page-header-inner">
        <Breadcrumbs view={view} />
        <h2>{title}</h2>
        {eyebrow && <span className="o2-eyebrow">{eyebrow}</span>}
      </div>
    </header>
  );
}

function failedBanner(status: string, runStatus?: string): React.ReactNode {
  const eff = effectiveStatus(status, runStatus);
  if (eff === 'failed') {
    if (status !== 'failed') {
      return <div className="o2-banner warn" role="alert"><span><b>Run failed.</b> The saved record is terminal but live state is incomplete (interrupted) — review the trace, then start a new run or Retry.</span></div>;
    }
    return <div className="o2-banner err" role="alert"><span><b>Run failed.</b> Review the execution trace and Live Intelligence, then Retry when ready.</span></div>;
  }
  if (eff === 'cancelled') {
    return <div className="o2-banner warn" role="status"><span>Run cancelled. State is preserved — press <b>New Run</b> above to start another task.</span></div>;
  }
  return null;
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
    <div className="o2-banner info" role="status">
      <span><b>OrchestraAI is ready.</b> Connect a provider to enable LIVE mode, or keep exploring in Demo mode.</span>
      <span className="banner-actions">
        <button className="o2-btn primary" onClick={() => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: 'providers' } })}>
          Connect provider
        </button>
        <button className="o2-btn" onClick={hide}>Demo mode</button>
      </span>
    </div>
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

function ResizeHandle({
  side, onResize,
}: {
  side: 'left' | 'right';
  onResize: (deltaX: number) => void;
}) {
  const { state } = useRuntime();
  const dragging = useRef(false);
  const label = side === 'left' ? 'Resize navigation panel' : 'Resize live intelligence panel';
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

function Boot() {
  const { state, dispatch } = useRuntime();
  const activeId = state.server.activeRunId;

  useEffect(() => {
    document.documentElement.dataset.theme = state.ui.theme;
    try { localStorage.setItem('orchestra-theme', state.ui.theme); } catch { /* ignore */ }
  }, [state.ui.theme]);

  useEffect(() => {
    persistPanels(state.ui);
  }, [state.ui.leftOpen, state.ui.rightOpen, state.ui.leftWidth, state.ui.rightWidth]);

  // Narrow screens: drawers start closed so the center workspace is primary.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 980) {
      dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } });
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('theme');
      if (t === 'dark' || t === 'light') dispatch({ type: 'ui/set', patch: { theme: t } });
      const v = (params.get('view') || '').toLowerCase();
       if (v === 'overview' || v === 'savings' || v === 'models' || v === 'tools' || v === 'memory' || v === 'evals' || v === 'cache' || v === 'alerts' || v === 'projects' || v === 'billing' || v === 'settings' || v === 'run' || v === 'intelligence' || v === 'conversations' || v === 'traces' || v === 'api') {
        dispatch({ type: 'ui/set', patch: { view: v as View } });
      }
    } catch { /* ignore */ }
  }, []);

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
  const activeRun = state.server.runs.find(r => r.id === state.server.activeRunId);
  const effStatus = snap ? effectiveStatus(snap.status, activeRun?.status) : null;
  const fresh = freshnessLabel(state.server.conn.status, state.server.conn.lastUpdate);
  const snapTerminal = !!effStatus && ['completed', 'failed', 'cancelled'].includes(effStatus);
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 980;
  const drawerOpen = (state.ui.leftOpen || state.ui.rightOpen) && narrow;
  const isRunView = state.ui.view === 'run';

  const resizeLeft = useCallback((dx: number) => {
    dispatch({ type: 'ui/set', patch: { leftWidth: clampWidth(state.ui.leftWidth + dx, LEFT_MIN, LEFT_MAX) } });
  }, [dispatch, state.ui.leftWidth]);
  const resizeRight = useCallback((dx: number) => {
    dispatch({ type: 'ui/set', patch: { rightWidth: clampWidth(state.ui.rightWidth - dx, RIGHT_MIN, RIGHT_MAX) } });
  }, [dispatch, state.ui.rightWidth]);

  const vw = useViewportWidth();
  const effLeft = vw <= 1024 ? Math.min(state.ui.leftWidth, 216) : vw <= 1200 ? Math.min(state.ui.leftWidth, 236) : vw <= 1280 ? Math.min(state.ui.leftWidth, 252) : Math.min(state.ui.leftWidth, 292);
  const effRight = vw <= 1024 ? Math.min(state.ui.rightWidth, 308) : vw <= 1200 ? Math.min(state.ui.rightWidth, 328) : vw <= 1280 ? Math.min(state.ui.rightWidth, 340) : Math.min(state.ui.rightWidth, 372);
  const rightShown = isRunView && !!snap && state.ui.rightOpen;
  const shellStyle: React.CSSProperties = narrow ? {} : {
    gridTemplateColumns: [
      ...(state.ui.leftOpen ? [`${effLeft}px`, '0px'] : []),
      'minmax(0,1fr)',
      ...(rightShown ? ['0px', `${effRight}px`] : []),
    ].join(' '),
  } as React.CSSProperties;

  return (
    <div className="app cx-app cx">
      <ConsoleTopBar />
      <div className="shell cx-shell" style={{ ...shellStyle, ['--cx-left' as string]: `${effLeft}px`, ['--cx-right' as string]: `${effRight}px` }}>
        <ConsoleSidebar />
        {!narrow && state.ui.leftOpen && <ResizeHandle side="left" onResize={resizeLeft} />}
        <main className="center cx-center" aria-label="Workspace">
          <PageHeader title={state.ui.view === 'run' ? 'Run Execution' : state.ui.view === 'overview' ? 'Overview' : state.ui.view === 'savings' ? 'Savings' : state.ui.view ? capitalizeFirst(state.ui.view) : 'OrchestraAI'} eyebrow={state.ui.view !== 'run' && state.ui.view ? getEyebrow(state.ui.view) : undefined} view={state.ui.view} />
          {state.ui.view !== 'run' ? (
           state.ui.view === 'overview' ? <OverviewPage /> : state.ui.view === 'savings' ? <SavingsPage /> : state.ui.view === 'intelligence' ? <React.Suspense fallback={<div className="page" aria-label="Loading intelligence"><Skeleton lines={7} /></div>}><IntelligencePage /></React.Suspense> : state.ui.view === 'models' ? <ModelsPage /> : state.ui.view === 'memory' ? <MemoryPage /> : state.ui.view === 'tools' ? <ToolsPage /> : state.ui.view === 'evals' ? <OperationsPage kind="alerts" /> : state.ui.view === 'cache' ? <OperationsPage kind="cache" /> : state.ui.view === 'alerts' ? <OperationsPage kind="alerts" /> : state.ui.view === 'projects' ? <ProjectsPage /> : state.ui.view === 'billing' ? <BillingPage /> : state.ui.view === 'settings' ? <SettingsPage /> : state.ui.view === 'conversations' ? <OperationsPage kind="sessions" /> : state.ui.view === 'traces' ? <IntelligencePage /> : state.ui.view === 'api' ? <div className="page"><div className="o2-banner info" role="alert"><span>Developer API reference — coming soon.</span></div></div> : null
          ) : !snap ? (
            state.server.conn.status === 'disconnected' ? (
              <div className="o2-banner err" role="alert" style={{ margin: '12px 24px 0' }}>
                <span><b>Backend unavailable</b> — start it with `npm start` (port 8787) and reload. No fake runtime is shown.</span>
                <button className="o2-btn" onClick={() => loadAll()}>Retry</button>
              </div>
            ) : (
              <div className="page" aria-label="Loading runtime state"><Skeleton lines={8} /></div>
            )
          ) : (
            <>
              {fresh !== 'LIVE' && !snapTerminal && (
                <div className={`o2-banner ${fresh === 'STALE' ? 'warn' : 'err'}`} role="alert">
                  <span>{fresh === 'STALE' ? 'STALE DATA — live connection lost. ' : 'DISCONNECTED — '}Last update: {snap.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : 'never'}. State below is marked stale, not current.</span>
                </div>
              )}
              {fresh === 'DISCONNECTED' && snapTerminal && (
                <div className="o2-banner err" role="alert">
                  <span>DISCONNECTED — showing the final saved state. It is complete, not live.</span>
                </div>
              )}
              {failedBanner(snap.status, activeRun?.status)}
              <FirstRunBanner />
              <RunHeader />
              <MessageList messages={snap.messages} />
              <Composer />
            </>
          )}
        </main>
        {!narrow && isRunView && snap && state.ui.rightOpen && <ResizeHandle side="right" onResize={resizeRight} />}
        {isRunView && snap && <LiveIntelligence />}
        {drawerOpen && (
          <button className="scrim cx-scrim" aria-label="Close panels"
            onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false, rightOpen: false } })} />
        )}
      </div>
      {!narrow && !state.ui.leftOpen && (
        <button className="rail-fab rail-left" aria-label="Open navigation sidebar" title="Open sidebar" onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: true } })}>
          <IconChevronRight size={15} />
        </button>
      )}
      {!narrow && isRunView && snap && !state.ui.rightOpen && (
        <button className="rail-fab rail-right" aria-label="Open live intelligence panel" title="Open live intelligence" onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: true } })}>
          <IconChevronLeft size={15} />
        </button>
      )}
      <CommandPalette />
      <NewRunDialog />
      <Onboarding />
      <Toasts />
    </div>
  );
}

function capitalizeFirst(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getEyebrow(view: View): string {
  const map: Record<View, string> = {
    overview: 'Executive summary and run economics',
    savings: 'Customer economics and modeled savings',
    run: 'Live execution and runtime evidence',
    models: 'Model catalog and provider routing',
    tools: 'Tool executor and activity',
    memory: 'Memory store and context',
    evals: 'Evaluation and quality evidence',
    cache: 'Cache hit rate and provider calls avoided',
    alerts: 'Reliability control and provider health',
    projects: 'Workspace projects and teams',
    billing: 'BYOK platform accounting',
    settings: 'Configuration and policies',
    intelligence: 'Observability and analytics',
    conversations: 'Conversation history and bounded prompts',
    traces: 'Execution traces and model decisions',
    api: 'Developer tools and API reference',
  };
  return map[view] || '';
}

export default function App() {
  const pathname = typeof window === 'undefined' ? '/console' : window.location.pathname;
  if (pathname === '/' || pathname === '/welcome') return <LandingPage />;
  if (pathname === '/pricing') return <PricingPage />;
  if (pathname === '/auth' || pathname === '/login' || pathname === '/signup') return <AuthPage />;
  return <RuntimeProvider><Boot /></RuntimeProvider>;
}
