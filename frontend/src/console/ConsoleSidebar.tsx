// Console sidebar, v4: authenticated console navigation — restrained, typography-first.
import React, { useMemo } from 'react';
import { useRuntime } from '../state/store';
import { relTime } from '../components/ui';
import { Tip, shortcutLabel } from '../components/Tooltip';
import { IconPlus, IconSearch, IconSettings, IconChevronRight, IconChevronDown } from '../components/icons';

const NAV = [
  { view: 'overview' as const, label: 'Home' },
  { view: 'run' as const, label: 'Runs' },
  { view: 'models' as const, label: 'Models' },
  { view: 'tools' as const, label: 'Tools' },
  { view: 'memory' as const, label: 'Memory' },
  { view: 'evals' as const, label: 'Evaluations' },
  { view: 'projects' as const, label: 'Projects' },
  { view: 'settings' as const, label: 'Settings' },
];

const MORE_NAV = [
  { view: 'savings' as const, label: 'Savings' },
  { view: 'cache' as const, label: 'Cache' },
  { view: 'alerts' as const, label: 'Alerts' },
  { view: 'billing' as const, label: 'Billing' },
  { view: 'intelligence' as const, label: 'Intelligence' },
  { view: 'conversations' as const, label: 'Conversations' },
  { view: 'traces' as const, label: 'Traces' },
  { view: 'api' as const, label: 'API' },
];

const GROUPED_HISTORY = [
  { label: 'Today', filter: (r: any) => new Date().toDateString() === new Date(r.updatedAt).toDateString() },
  { label: 'Yesterday', filter: (r: any) => {
    const yesterday = new Date(Date.now() - 86400000);
    return new Date().toDateString() !== new Date(r.updatedAt).toDateString() && yesterday.toDateString() === new Date(r.updatedAt).toDateString();
  }},
  { label: 'Older', filter: (r: any) => {
    const day = new Date(r.updatedAt).toDateString();
    return day !== new Date().toDateString() && day !== new Date(Date.now() - 86400000).toDateString();
  }},
];

function dot(status: string): string {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return '';
  if (s === 'running' || s === 'planning' || s === 'waiting') return 'work';
  if (s === 'failed') return 'bad';
  if (s === 'cancelled') return '';
  return '';
}

export function RunStatusGlyph({ status }: { status: string }) {
  const s = String(status || '').toLowerCase();
  const label = s || 'idle';
  return <span className={`o2-dot ${dot(status)}`} title={label} aria-label={`Status ${label}`} role="img" />;
}

function sortByUpdatedAt(runs: any[]) {
  return [...runs].sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function ConsoleSidebar() {
  const { state, dispatch } = useRuntime();
  const { runs, activeRunId } = state.server;
  const q = state.ui.runQuery.toLowerCase();

  const visible = useMemo(
    () => runs.filter((r: any) => !q || (r.title + r.id + r.taskMode + r.status).toLowerCase().includes(q)).slice(0, 40),
    [runs, q],
  );

  const go = (view: typeof state.ui.view) => {
    dispatch({ type: 'ui/set', patch: { view, leftOpen: typeof window !== 'undefined' && window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };
  const pickRun = (id: string) => {
    dispatch({ type: 'runs/active', id });
    dispatch({ type: 'ui/set', patch: { view: 'run', leftOpen: typeof window !== 'undefined' && window.innerWidth > 980 ? state.ui.leftOpen : false } });
  };

  return (
    <nav className={`o2-side ${state.ui.leftOpen ? 'open' : ''}`} aria-label="Primary navigation">
      <Tip label="Start a new run" shortcut={shortcutLabel('mod+n')}>
        <button className="o2-newrun" onClick={() => dispatch({ type: 'ui/set', patch: { newRunOpen: true } })} aria-label={`Create a new run (${shortcutLabel('mod+n')})`}>
          <IconPlus size={16} /> New Run
        </button>
      </Tip>

      <div className="o2-navgroup">
        {NAV.map((i) => {
          const active = state.ui.view === i.view;
          return (
            <button key={i.view} className={`o2-navitem ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => go(i.view)}>
              <span className="o2-ico" aria-hidden="true"><IconPlus size={15} /></span>
              {i.label}
            </button>
          );
        })}
      </div>

      <div className="o2-navsec">Runs <span className="o2-n">{runs.length}</span></div>

      <div className="o2-searchwrap">
        <IconSearch size={13} />
        <input className="o2-search" placeholder="Filter runs" aria-label="Filter runs" value={state.ui.runQuery}
          onChange={(e) => dispatch({ type: 'ui/set', patch: { runQuery: e.target.value } })} />
      </div>

      <div className="o2-grouped-history" role="region" aria-label="Run history">
        <div className="o2-grouped-history-header">
          <span className="o2-group-label">History</span>
          <IconChevronDown size={12} />
        </div>
        <div className="o2-grouped-history-list">
          {GROUPED_HISTORY.map((section) => {
            const filtered = sortByUpdatedAt(runs.filter(section.filter));
            const itemCount = filtered.length;
            return (
              <div key={section.label} className={`o2-grouped-history-item${itemCount > 0 ? '' : ' o2-empty'}`} role="button" aria-label={`${section.label} runs`} onClick={() => dispatch({ type: 'ui/set', patch: { runQuery: '' } })} style={{ cursor: itemCount > 0 ? 'pointer' : 'default' }}>
                <span className="o2-grouped-history-label">{section.label}</span>
                {itemCount > 0 && <span className="o2-grouped-history-count">{itemCount}</span>}
              </div>
            );
          })}
          {runs.length === 0 && (
            <div className="o2-grouped-history-item o2-empty" style={{ cursor: 'default' }}>
              <span>No runs yet</span>
            </div>
          )}
        </div>
      </div>

      <div className="o2-run-list" role="listbox" aria-label="Recent runs">
        {visible.length === 0 ? (
          <div className="o2-grouped-history-item o2-empty" role="status">No matching runs</div>
        ) : visible.map((run) => (
          <div
            key={run.id}
            className={`o2-run-item${run.id === activeRunId ? ' active' : ''}`}
            role="option"
            aria-selected={run.id === activeRunId}
            aria-label={`${run.title} · ${run.status}`}
            tabIndex={0}
            onClick={() => pickRun(run.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRun(run.id); } }}
          >
            <RunStatusGlyph status={run.status} />
            <span className="o2-run-item-title" title={run.title}>{run.title}</span>
            <span className="o2-run-item-time">{relTime(run.updatedAt)}</span>
          </div>
        ))}
      </div>

      <div className="o2-sidefoot">
        <button className="o2-navitem" aria-label="Collapse navigation sidebar" onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false } })}>
          « Collapse
        </button>
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, padding: '6px 10px', fontSize: 12.5 }}>More views</summary>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
            {MORE_NAV.map((i) => (
              <button key={i.view} className={`o2-navitem ${state.ui.view === i.view ? 'active' : ''}`}
                aria-current={state.ui.view === i.view ? 'page' : undefined} onClick={() => go(i.view)}>
                {i.label}
              </button>
            ))}
            <button className="o2-navitem" onClick={() => dispatch({ type: 'ui/set', patch: { view: 'settings' as const, settingsAnchor: 'runtime' } })}>
              Policies
            </button>
          </div>
        </details>
      </div>
    </nav>
  );
}
