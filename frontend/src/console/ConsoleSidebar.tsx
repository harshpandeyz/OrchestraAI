// Console sidebar V2: Workspace / Build / Intelligence / Operate IA.
// Collapsible groups, keyboard navigation, workspace switching, search.
// Collapsed mode via leftOpen=false rail affordance in App shell.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime } from '../state/store';
import type { View } from '../state/store';
import { relTime } from '../components/ui';
import { Tip, shortcutLabel } from '../components/Tooltip';
import { navigateRoute } from '../lib/routes';
import {
  IconChevronRight, IconHome, IconRuns, IconFolder, IconModel, IconEval,
  IconSettings, IconTool, IconMemory, IconCpu, IconNetwork,
  IconArchive, IconBell, IconMessages, IconCreditCard, IconShield, IconCode,
  IconSearch, IconPlus, IconChevronDown,
} from '../components/icons';
import { api } from '../api/client';
import type { ProjectInfo } from '../types';

type NavItem = { view: View; label: string; icon: (p: { size?: number; className?: string }) => React.ReactElement; anchor?: string };

const GROUPS: { id: string; label: string; items: NavItem[] }[] = [
  {
    id: 'workspace', label: 'Workspace', items: [
      { view: 'overview', label: 'Overview', icon: IconHome },
      { view: 'run', label: 'Runs', icon: IconRuns },
      { view: 'agents', label: 'Agents', icon: IconCpu },
      { view: 'models', label: 'Models', icon: IconModel },
    ],
  },
  {
    id: 'build', label: 'Build', items: [
      { view: 'workflows', label: 'Workflows', icon: IconNetwork },
      { view: 'tools', label: 'Tools', icon: IconTool },
      { view: 'skills', label: 'Skills', icon: IconShield },
      { view: 'workspaces', label: 'Workspaces', icon: IconFolder },
    ],
  },
  {
    id: 'intelligence', label: 'Intelligence', items: [
      { view: 'evals', label: 'Evaluations', icon: IconEval },
      { view: 'memory', label: 'Memory', icon: IconMemory },
      { view: 'intelligence', label: 'Analytics', icon: IconCpu },
    ],
  },
  {
    id: 'operate', label: 'Operate', items: [
      { view: 'approvals', label: 'Approvals', icon: IconShield },
      { view: 'alerts', label: 'Alerts', icon: IconBell },
      { view: 'deployments', label: 'Deployments', icon: IconArchive },
      { view: 'incidents', label: 'Incidents', icon: IconBell },
    ],
  },
];

const MORE: NavItem[] = [
  { view: 'savings', label: 'Savings', icon: IconCreditCard },
  { view: 'projects', label: 'Projects', icon: IconFolder },
  { view: 'billing', label: 'Billing', icon: IconCreditCard },
  { view: 'cache', label: 'Cache', icon: IconArchive },
  { view: 'conversations', label: 'Conversations', icon: IconMessages },
  { view: 'traces', label: 'Traces', icon: IconNetwork },
  { view: 'settings', label: 'Settings', icon: IconSettings },
  { view: 'api', label: 'API', icon: IconCode },
];

export function RunStatusGlyph({ status }: { status: string }) {
  const s = String(status || '').toLowerCase();
  const cls = s === 'completed' ? '' : s === 'running' || s === 'planning' || s === 'waiting' ? 'work' : s === 'failed' ? 'bad' : '';
  return <span className={`o2-dot ${cls}`} title={s || 'idle'} aria-label={`Status ${s || 'idle'}`} role="img" />;
}

function NavButton({ item, active, onGo }: { item: NavItem; active: boolean; onGo: (v: NavItem) => void }) {
  const Icon = item.icon;
  return (
    <button
      className={`o2-navitem ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => onGo(item)}
    >
      <span className="o2-ico" aria-hidden="true"><Icon size={15} /></span>
      {item.label}
    </button>
  );
}

export function ConsoleSidebar() {
  const { state, dispatch } = useRuntime();
  const { runs, activeRunId } = state.server;
  const q = state.ui.runQuery.toLowerCase();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ workspace: true, build: false, intelligence: false, operate: false });
  const [moreOpen, setMoreOpen] = useState(false);
  const [navFilter, setNavFilter] = useState('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<string>('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getProjects().then(({ projects: p }) => { if (!cancelled) setProjects(p || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => runs.filter((r: { title: string; id: string; taskMode: string; status: string }) => !q || (r.title + r.id + r.taskMode + r.status).toLowerCase().includes(q)).slice(0, 40),
    [runs, q],
  );

  const go = (item: NavItem) => {
    dispatch({ type: 'ui/set', patch: { view: item.view, ...(item.anchor ? { settingsAnchor: item.anchor } : {}), leftOpen: typeof window !== 'undefined' && window.innerWidth > 980 ? state.ui.leftOpen : false } });
    navigateRoute(item.view, item.view === 'run' ? activeRunId : null);
  };
  const pickRun = (id: string) => {
    dispatch({ type: 'runs/active', id });
    dispatch({ type: 'ui/set', patch: { view: 'run', leftOpen: typeof window !== 'undefined' && window.innerWidth > 980 ? state.ui.leftOpen : false } });
    navigateRoute('run', id);
  };

  const isActive = (item: NavItem) => state.ui.view === item.view && (!item.anchor || state.ui.settingsAnchor === item.anchor);
  const nq = navFilter.toLowerCase();
  const matchNav = (label: string) => !nq || label.toLowerCase().includes(nq);

  // Keyboard navigation across nav buttons + run list
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button.o2-navitem, .o2-run-item[tabindex]') || []);
    const idx = els.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(els.length - 1, idx + 1) : Math.max(0, idx - 1);
    els[next]?.focus();
  };

  return (
    <nav className={`o2-side ${state.ui.leftOpen ? 'open' : ''}`} aria-label="Primary navigation" ref={listRef} onKeyDown={onNavKey}>
      <Tip label="Start a new run" shortcut={shortcutLabel('mod+n')}>
        <button className="o2-newrun" onClick={() => dispatch({ type: 'ui/set', patch: { newRunOpen: true } })} aria-label={`Create a new run (${shortcutLabel('mod+n')})`}>
          <IconPlus size={16} /> New Run
        </button>
      </Tip>

      <div className="o2-searchwrap">
        <IconSearch size={13} />
        <input className="o2-search" placeholder="Search navigation" aria-label="Search navigation" value={navFilter} onChange={(e) => setNavFilter(e.target.value)} />
      </div>

      {/* Workspace switcher */}
      <div style={{ margin: '4px 0 6px' }}>
        <label className="v2-meta" htmlFor="ws-switch" style={{ marginLeft: 10 }}>Workspace</label>
        <select
          id="ws-switch"
          className="search"
          style={{ width: '100%', marginTop: 4 }}
          aria-label="Switch workspace"
          value={activeProject}
          onChange={(e) => {
            setActiveProject(e.target.value);
            const p = projects.find((x) => x.id === e.target.value);
            dispatch({ type: 'toast/push', toast: { kind: 'info', title: p ? `Workspace: ${p.name}` : 'Workspace: all projects' } });
          }}
        >
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="o2-navgroup" role="list">
        {GROUPS.map((g) => (
          <div key={g.id}>
            <button
              type="button"
              className="o2-advanced-toggle"
              aria-expanded={!!openGroups[g.id]}
              aria-controls={`nav-group-${g.id}`}
              onClick={() => setOpenGroups((s) => ({ ...s, [g.id]: !s[g.id] }))}
            >
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>{g.label}</span>
              <IconChevronRight size={13} className="o2-chev" aria-hidden="true" />
            </button>
            {openGroups[g.id] && (
              <div id={`nav-group-${g.id}`} role="group" aria-label={g.label}>
                {g.items.filter((i) => matchNav(i.label)).map((item) => (
                  <NavButton key={item.label} item={item} active={isActive(item)} onGo={go} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="o2-navsec">Runs <span className="o2-n">{runs.length}</span></div>
      <div className="o2-searchwrap">
        <IconSearch size={13} />
        <input className="o2-search" placeholder="Filter runs" aria-label="Filter runs" value={state.ui.runQuery}
          onChange={(e) => dispatch({ type: 'ui/set', patch: { runQuery: e.target.value } })} />
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

      <div className="o2-advanced-group">
        <button type="button" className="o2-advanced-toggle" aria-expanded={moreOpen} aria-controls="o2-more-list" onClick={() => setMoreOpen((v) => !v)}>
          <span className="o2-ico" aria-hidden="true"><IconSettings size={15} /></span>
          More
          <IconChevronDown size={13} aria-hidden="true" />
        </button>
        {moreOpen && (
          <div id="o2-more-list" className="o2-advanced-list">
            {MORE.filter((i) => matchNav(i.label)).map((item) => (
              <NavButton key={item.label} item={item} active={isActive(item)} onGo={go} />
            ))}
          </div>
        )}
      </div>

      <div className="o2-sidefoot">
        <button className="o2-navitem" aria-label="Collapse navigation sidebar" onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: false } })}>
          <span className="o2-ico" aria-hidden="true"><IconChevronRight size={15} /></span>
          « Collapse
        </button>
      </div>
    </nav>
  );
}
