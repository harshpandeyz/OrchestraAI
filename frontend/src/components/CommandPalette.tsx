// Command palette V2 — universal operating layer (⌘K/Ctrl+K).
// Search/navigate + run lifecycle (new/continue/fork/replay/approve) +
// model/project/artifact/workflow/workspace targets. Searches runs,
// projects, models, tools, skills (memory-backed, honest), artifacts,
// files, settings. Agents/workspaces without backend catalogs navigate to
// their pages instead of inventing entries.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { navigateRoute } from '../lib/routes';
import '../styles/command-palette.css';
import type { ProjectInfo } from '../types';

interface Entry {
  group: string;
  label: string;
  sub: string;
  shortcut?: string;
  run: () => void;
}

const GROUP_ORDER = ['Navigation', 'Actions', 'Runs', 'Projects', 'Models', 'Tools', 'Artifacts', 'Files', 'Memory', 'Settings'];

export function CommandPalette() {
  const { state, dispatch } = useRuntime();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const open = state.ui.paletteOpen;

  const close = useCallback(() => {
    dispatch({ type: 'ui/set', patch: { paletteOpen: false } });
    setQ('');
    setSel(0);
  }, [dispatch]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch({ type: 'ui/set', patch: { paletteOpen: !open } });
      } else if (e.key === 'Escape' && open) {
        close();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, close, dispatch]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
      api.getProjects().then(({ projects: p }) => setProjects(p || [])).catch(() => {});
    }
  }, [open]);

  const goView = useCallback((view: Parameters<typeof navigateRoute>[0], runId?: string | null) => {
    dispatch({ type: 'ui/set', patch: { view, ...(view === 'run' && runId ? {} : {}) } });
    navigateRoute(view, runId);
  }, [dispatch]);

  const entries: Entry[] = useMemo(() => {
    const ql = q.toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Entry[] = [];
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    const modN = mac ? '⌘N' : 'Ctrl+N';
    const snap = state.server.snapshot;
    const activeId = state.server.activeRunId;
    const snapStatus = String(snap?.status || '');
    const busy = ['running', 'planning', 'waiting'].includes(snapStatus);
    const terminal = ['completed', 'failed', 'cancelled'].includes(snapStatus);

    out.push(
      { group: 'Navigation', label: 'Overview', sub: 'workspace home', run: () => goView('overview') },
      { group: 'Navigation', label: 'Runs', sub: 'run studio', run: () => goView('run', activeId) },
      { group: 'Navigation', label: 'Agents', sub: 'agent activity', run: () => goView('agents') },
      { group: 'Navigation', label: 'Models', sub: 'model intelligence', run: () => goView('models') },
      { group: 'Navigation', label: 'Workflows', sub: 'run plans', run: () => goView('workflows') },
      { group: 'Navigation', label: 'Tools', sub: 'execution capabilities', run: () => goView('tools') },
      { group: 'Navigation', label: 'Skills', sub: 'capabilities', run: () => goView('skills') },
      { group: 'Navigation', label: 'Workspaces', sub: 'environments', run: () => goView('workspaces') },
      { group: 'Navigation', label: 'Evaluations', sub: 'runtime quality', run: () => goView('evals') },
      { group: 'Navigation', label: 'Analytics', sub: 'intelligence', run: () => goView('intelligence') },
      { group: 'Navigation', label: 'Approvals', sub: 'attention queue', run: () => goView('approvals') },
      { group: 'Navigation', label: 'Alerts', sub: 'reliability', run: () => goView('alerts') },
      { group: 'Navigation', label: 'Incidents', sub: 'failures', run: () => goView('incidents') },
      { group: 'Navigation', label: 'Settings', sub: 'preferences + providers', run: () => goView('settings') },
    );

    out.push(
      { group: 'Actions', label: 'New Run', sub: 'start a task', shortcut: modN, run: () => dispatch({ type: 'ui/set', patch: { newRunOpen: true, view: 'run' } }) },
      { group: 'Actions', label: 'Focus Composer', sub: 'type a message', shortcut: '/', run: () => { goView('run', activeId); setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 50); } },
      { group: 'Actions', label: state.ui.rightOpen ? 'Hide Inspector' : 'Show Inspector', sub: 'toggle panel', run: () => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } }) },
      { group: 'Actions', label: 'Connect Provider', sub: 'keys, verification, health', run: () => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: 'providers' } }) },
      { group: 'Actions', label: `Switch to ${state.ui.theme === 'dark' ? 'Light' : 'Dark'} Theme`, sub: 'appearance', run: () => dispatch({ type: 'ui/set', patch: { theme: state.ui.theme === 'dark' ? 'light' : 'dark' } }) },
    );

    if (activeId) {
      out.push({ group: 'Actions', label: 'Open Active Run', sub: activeId.slice(0, 12), run: () => { dispatch({ type: 'runs/active', id: activeId }); goView('run', activeId); } });
      if (terminal) {
        out.push({ group: 'Actions', label: 'Continue Run', sub: 'linked follow-up', run: () => { goView('run', activeId); setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 80); } });
        out.push({ group: 'Actions', label: 'Replay Run', sub: 'resume from checkpoint', run: () => { void api.retryRun(activeId).catch(() => {}); } });
      }
      if (!busy) {
        out.push({ group: 'Actions', label: 'Fork Run', sub: 'independent copy', run: () => { void api.forkRun(activeId).then(() => api.getRuns().then(({ runs }) => dispatch({ type: 'runs/set', runs }))).catch(() => {}); } });
      }
      if (busy) {
        out.push({ group: 'Actions', label: 'Stop Run', sub: 'interrupt execution', shortcut: 'Esc', run: () => { void api.cancelRun(activeId).catch(() => {}); } });
      }
      if (snapStatus === 'failed') {
        out.push({ group: 'Actions', label: 'Retry Run', sub: 'resume from checkpoint', run: () => { void api.retryRun(activeId).catch(() => {}); } });
      }
      const pending = (snap?.execution?.pendingApprovals || []).length;
      if (pending > 0) {
        out.push({ group: 'Actions', label: `Review ${pending} Approval${pending === 1 ? '' : 's'}`, sub: 'attention needed', run: () => goView('approvals') });
      }
      const modelId = snap?.activeModelId;
      if (modelId) {
        out.push({ group: 'Actions', label: 'Open Active Model', sub: modelId.split('/').pop() || modelId, run: () => dispatch({ type: 'ui/set', patch: { view: 'models', modelQuery: modelId } }) });
        out.push({ group: 'Actions', label: 'Benchmark Active Model', sub: 'evaluation evidence', run: () => goView('evals') });
      }
      if ((snap?.execution?.artifacts || []).length) {
        out.push({ group: 'Actions', label: 'Open Run Artifacts', sub: `${snap!.execution!.artifacts!.length} files`, run: () => goView('run', activeId) });
      }
      if (snap?.execution?.plan) {
        out.push({ group: 'Actions', label: 'Open Workflow Plan', sub: `${snap.execution.plan.steps.length} steps`, run: () => goView('workflows') });
      }
    }

    state.server.runs.filter((r) => match(`${r.title} ${r.id} ${r.status}`)).slice(0, 6).forEach((r) =>
      out.push({ group: 'Runs', label: r.title, sub: `run · ${r.status}`, run: () => { dispatch({ type: 'runs/active', id: r.id }); goView('run', r.id); } }));

    projects.filter((p) => match(`${p.name} ${p.id}`)).slice(0, 4).forEach((p) =>
      out.push({ group: 'Projects', label: p.name, sub: 'project · switch workspace', run: () => goView('workspaces') }));

    state.server.models.filter((m) => match(`${m.name} ${m.provider} ${m.id} ${(m.capabilities || []).join(' ')}`)).slice(0, 5).forEach((m) =>
      out.push({ group: 'Models', label: m.name, sub: `model · ${m.provider} · ${m.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'models', modelQuery: m.name } }) }));

    state.server.tools.filter((t) => match(`${t.name} ${t.description}`)).slice(0, 5).forEach((t) =>
      out.push({ group: 'Tools', label: t.name, sub: `tool · ${t.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'tools', toolQuery: t.name } }) }));

    const artifacts = snap?.execution?.artifacts || [];
    artifacts.filter((a) => match(`${a.name || a.id} ${a.type}`)).slice(0, 4).forEach((a) =>
      out.push({ group: 'Artifacts', label: String(a.name || a.id), sub: `artifact · ${a.type}`, run: () => goView('run', activeId) }));

    const files = [...(snap?.execution?.files || []), ...(snap?.execution?.changesets || []).flatMap((c) => (c.files || []).map((f) => typeof f === 'string' ? f : f.path))];
    [...new Set(files)].filter((f) => match(String(f))).slice(0, 4).forEach((f) =>
      out.push({ group: 'Files', label: String(f), sub: 'file · run evidence', run: () => goView('run', activeId) }));

    state.server.memItems.filter((m) => match(`${m.title} ${m.snippet} ${m.source}`)).slice(0, 4).forEach((m) =>
      out.push({ group: 'Memory', label: m.title, sub: `memory · ${m.scope}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'memory', memQuery: m.title } }) }));

    ['Providers', 'Runtime', 'Appearance', 'Composer'].filter((s) => match(s)).forEach((s) =>
      out.push({ group: 'Settings', label: `${s} Settings`, sub: 'settings section', run: () => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: s.toLowerCase() } }) }));

    if (ql) return out.filter((e) => match(`${e.label} ${e.sub} ${e.group}`));
    return out;
  }, [q, state.server.runs, state.server.models, state.server.tools, state.server.memItems, state.server.snapshot, state.server.activeRunId, state.ui.rightOpen, state.ui.theme, projects, dispatch, goView]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-pal-idx="${sel}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      try { (el as HTMLElement).scrollIntoView({ block: 'nearest' }); } catch { /* older engines */ }
    }
  }, [sel, open]);

  const onKey = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel((s) => Math.min(entries.length - 1, s + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const e = entries[Math.min(sel, entries.length - 1)];
      if (e) { close(); e.run(); }
    }
  }, [entries, sel, close]);

  if (!open) return null;
  const groups: { name: string; items: { e: Entry; idx: number }[] }[] = [];
  entries.slice(0, 60).forEach((e, idx) => {
    let g = groups.find((x) => x.name === e.group);
    if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
    g.items.push({ e, idx });
  });

  groups.sort((a, b) => (GROUP_ORDER.indexOf(a.name) === -1 ? 99 : GROUP_ORDER.indexOf(a.name)) - (GROUP_ORDER.indexOf(b.name) === -1 ? 99 : GROUP_ORDER.indexOf(b.name)));

  return (
    <div className="palette-overlay" onClick={close} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-wrap">
          <input ref={inputRef} placeholder="Search runs, projects, models, tools, artifacts, files, settings…" aria-label="Search commands and navigate" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <kbd className="palette-esc" aria-label="Press Escape to close">esc</kbd>
        </div>
        <div className="palette-hint">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Command results">
          {groups.map((g) => (
            <div key={g.name} className="palette-group">
              <div className="palette-group-label" role="presentation">{g.name}</div>
              {g.items.map(({ e, idx }) => (
                <button key={idx} data-pal-idx={idx} className={`palette-item${idx === sel ? ' selected' : ''}`} role="option" aria-selected={idx === sel} onMouseEnter={() => setSel(idx)} onClick={() => { close(); e.run(); }}>
                  <span className="palette-item-label">{e.label}</span>
                  <span className="palette-item-sub">{e.sub}</span>
                  {e.shortcut && <kbd className="palette-item-shortcut">{e.shortcut}</kbd>}
                </button>
              ))}
            </div>
          ))}
          {entries.length === 0 && (
            <div className="palette-empty" role="status">
              <b>No matching commands</b>
              <span>Try a different search term.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
