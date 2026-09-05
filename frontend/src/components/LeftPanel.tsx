import React, { useMemo, useState } from 'react';
import { useRuntime } from '../state/store';
import { relTime, statusPill } from './ui';
import { Tip, shortcutLabel } from './Tooltip';
import {
  IconActivity, IconAlert, IconChevronLeft, IconCopy, IconCreditCard, IconDots, IconEval, IconFile, IconMemory,
  IconModel, IconPlus, IconSearch, IconSettings, IconTool, IconX,
} from './icons';

const PRIMARY_NAV = [
  { view: 'overview' as const, label: 'Overview', hint: 'Money, savings, and health', Icon: IconActivity },
  { view: 'savings' as const, label: 'Savings', hint: 'Modeled economics and proof', Icon: IconActivity },
];

const OPERATIONS_NAV = [
  { view: 'run' as const, label: 'Requests / Runs', hint: 'Open the active run workspace', Icon: IconActivity },
  { view: 'sessions' as const, label: 'Sessions', hint: 'Persisted request history', Icon: IconMemory },
  { view: 'prompts' as const, label: 'Prompts', hint: 'Bounded PromptPlan composition', Icon: IconFile },
  { view: 'cache' as const, label: 'Cache', hint: 'Local and semantic cache impact', Icon: IconMemory },
  { view: 'alerts' as const, label: 'Alerts', hint: 'Reliability and policy signals', Icon: IconAlert },
];

const LIBRARY_NAV = [
  { view: 'models' as const, label: 'Models', Icon: IconModel, hint: 'Browse model catalog' },
  { view: 'tools' as const, label: 'Tools', Icon: IconTool, hint: 'Tool registry' },
  { view: 'memory' as const, label: 'Memory', Icon: IconMemory, hint: 'Working + long-term memory' },
  { view: 'evals' as const, label: 'Evaluations', Icon: IconEval, hint: 'Runtime quality' },
];

export function LeftPanel() {
  const { state, dispatch } = useRuntime();
  const { runs, activeRunId } = state.server;
  const q = state.ui.runQuery.toLowerCase();
  const statusFilter = state.ui.runStatusFilter || 'all';
  const filtered = useMemo(
    () => runs
      .filter((r) => statusFilter === 'all' || String(r.status).toLowerCase() === statusFilter)
      .filter((r) => !q || (r.title + r.id + r.taskMode + r.status).toLowerCase().includes(q))
      .slice(0, 60),
    [runs, q, statusFilter],
  );
  const [overflowId, setOverflowId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const go = (view: typeof state.ui.view, anchor: string | null = null) => {
    dispatch({ type: 'ui/set', patch: { view, settingsAnchor: anchor, leftOpen: window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };
  const newRun = () => {
    dispatch({ type: 'ui/set', patch: { newRunOpen: true } });
  };
  const pickRun = (id: string) => {
    dispatch({ type: 'runs/active', id });
    dispatch({ type: 'ui/set', patch: { view: 'run', leftOpen: window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };
  const copyId = async (id: string) => {
    try { await navigator.clipboard.writeText(id); setCopiedId(id); setTimeout(() => setCopiedId(c => c === id ? null : c), 1400); }
    catch { /* clipboard unavailable */ }
    setOverflowId(null);
  };

  return (
    <nav className={`left ${state.ui.leftOpen ? 'open' : ''}`} aria-label="Primary">
      <div className="left-head">
        <Tip label="Start a new run" shortcut={shortcutLabel('mod+n')}>
          <button className="newrun-btn" onClick={newRun} aria-label={`Create a new run (${shortcutLabel('mod+n')})`}>
            <IconPlus size={16} /> New Run
          </button>
        </Tip>
        <Tip label="Collapse sidebar">
          <button className="icon-btn icon-only left-collapse" aria-label="Collapse navigation sidebar"
            onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false } })}>
            <IconChevronLeft size={16} />
          </button>
        </Tip>
      </div>

      <div className="nav-sec">Recent runs <span className="n">{runs.length}</span></div>
      {runs.length > 1 && (
        <div className="nav-search-wrap">
          <IconSearch size={14} />
          <input className="nav-search" placeholder="Filter runs…" aria-label="Filter runs" value={state.ui.runQuery}
            onChange={e => dispatch({ type: 'ui/set', patch: { runQuery: e.target.value } })} />
          {state.ui.runQuery ? (
            <button className="search-clear sm" aria-label="Clear run filter" onClick={() => dispatch({ type: 'ui/set', patch: { runQuery: '' } })}><IconX size={13} /></button>
          ) : (
            <button className="search-clear sm" aria-label="Filter runs by status" aria-expanded={filterOpen} aria-haspopup="menu"
              title={statusFilter === 'all' ? 'Filter by status' : `Status: ${statusFilter}`}
              onClick={() => setFilterOpen((v) => !v)}>
              <IconDots size={13} />
            </button>
          )}
        </div>
      )}
      {filterOpen && (
        <div className="overflow-menu static" role="menu" aria-label="Filter runs by status">
          {(['all', 'running', 'planning', 'completed', 'failed', 'cancelled'] as const).map((s) => (
            <button key={s} role="menuitemradio" aria-checked={statusFilter === s}
              onClick={() => { dispatch({ type: 'ui/set', patch: { runStatusFilter: s } }); setFilterOpen(false); }}>
              {s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      )}
      <div className="run-list" role="listbox" aria-label="Runs">
        {filtered.length === 0 && (
          <div className="empty" role="status"><b>No runs yet</b><span>Press New Run above to start your first task.</span></div>
        )}
        {filtered.map(r => {
          const isActive = r.id === activeRunId;
          const dot = statusPill(r.status) === 'ok' ? 'healthy' : statusPill(r.status) === 'err' ? 'down' : statusPill(r.status) === 'warn' ? 'degraded' : 'idle';
          return (
            <div key={r.id} className={`run-row ${isActive ? 'active' : ''}`}>
              <button role="option" aria-selected={isActive} aria-current={isActive ? 'true' : undefined}
                className={`run-item ${isActive ? 'active' : ''}`} onClick={() => pickRun(r.id)}
                title={`${r.title} · ${r.status}`}>
                <span className="r1">
                  <span className={`status-dot ${dot}`} aria-hidden="true" />
                  <span className="t">{r.title}</span>
                </span>
                <span className="s">
                  <span>{relTime(r.updatedAt)}</span>
                  {typeof r.spent === 'number' && r.spent > 0 && (
                    <span className="modeltag" title={`Spent $${r.spent.toFixed(4)} of $${r.budget}`}>${r.spent.toFixed(3)}</span>
                  )}
                </span>
              </button>
              <button className="run-overflow" aria-label={`Actions for ${r.title}`} aria-expanded={overflowId === r.id} aria-haspopup="menu"
                onClick={() => setOverflowId(overflowId === r.id ? null : r.id)}>
                <IconDots size={15} />
              </button>
              {overflowId === r.id && (
                <div className="overflow-menu" role="menu" aria-label={`Actions for ${r.title}`}>
                  <button role="menuitem" onClick={() => copyId(r.id)}>
                    <IconCopy size={14} /> {copiedId === r.id ? 'Copied!' : 'Copy run ID'}
                  </button>
                  <button role="menuitem" onClick={() => { setOverflowId(null); pickRun(r.id); }}>Open run</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="nav-sec">Library</div>
      {PRIMARY_NAV.map((i) => (
        <button key={i.label} className={`nav-item ${state.ui.view === i.view ? 'active' : ''}`}
          aria-current={state.ui.view === i.view ? 'page' : undefined} title={i.hint} onClick={() => go(i.view)}>
          <span className="ico" aria-hidden="true"><i.Icon size={15} /></span>{i.label}
        </button>
      ))}
      {OPERATIONS_NAV.map((i) => (
        <button key={i.label} className={`nav-item ${state.ui.view === i.view ? 'active' : ''}`}
          aria-current={state.ui.view === i.view ? 'page' : undefined} title={i.hint} onClick={() => go(i.view)}>
          <span className="ico" aria-hidden="true"><i.Icon size={15} /></span>{i.label}
        </button>
      ))}
      {LIBRARY_NAV.map(i => {
        const count = i.view === 'models' ? state.server.models.length : i.view === 'tools' ? state.server.tools.length : i.view === 'memory' ? state.server.memItems.length : state.server.evals.length;
        return (
          <button key={i.label} className={`nav-item ${state.ui.view === i.view ? 'active' : ''}`}
            aria-current={state.ui.view === i.view ? 'page' : undefined} title={i.hint} onClick={() => go(i.view)}>
            <span className="ico" aria-hidden="true"><i.Icon size={15} /></span>{i.label}
            <span className="count">{count}</span>
          </button>
        );
      })}

      <div className="nav-sec">System</div>
      <button className={`nav-item ${state.ui.view === 'projects' ? 'active' : ''}`} aria-current={state.ui.view === 'projects' ? 'page' : undefined}
        title="Projects and teams" onClick={() => go('projects')}><span className="ico" aria-hidden="true"><IconModel size={15} /></span>Projects / Teams</button>
      <button className={`nav-item ${state.ui.view === 'billing' ? 'active' : ''}`} aria-current={state.ui.view === 'billing' ? 'page' : undefined}
        title="BYOK platform fee accounting" onClick={() => go('billing')}><span className="ico" aria-hidden="true"><IconCreditCard size={15} /></span>Billing</button>
      <button className={`nav-item ${state.ui.view === 'settings' && state.ui.settingsAnchor === 'runtime' ? 'active' : ''}`}
        aria-current={state.ui.view === 'settings' && state.ui.settingsAnchor === 'runtime' ? 'page' : undefined}
        title="Quality, latency, budget and switching constraints"
        onClick={() => go('settings', 'runtime')}>
        <span className="ico" aria-hidden="true"><IconSettings size={15} /></span>Policies
      </button>
      <button className={`nav-item ${state.ui.view === 'settings' ? 'active' : ''}`}
        aria-current={state.ui.view === 'settings' ? 'page' : undefined}
        title="Application preferences, provider connections, runtime defaults"
        onClick={() => go('settings')}>
        <span className="ico" aria-hidden="true"><IconSettings size={15} /></span>Settings
      </button>
    </nav>
  );
}
