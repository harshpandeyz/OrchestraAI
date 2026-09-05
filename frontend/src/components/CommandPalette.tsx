import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import '../styles/command-palette.css';

interface Entry {
  group: string;
  label: string;
  sub: string;
  shortcut?: string;
  run: () => void;
}

const GROUP_ORDER = ['Navigation', 'Actions', 'Runs', 'Models', 'Tools', 'Memory'];

export function CommandPalette() {
  const { state, dispatch } = useRuntime();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
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
    }
  }, [open]);

  const entries: Entry[] = useMemo(() => {
    const ql = q.toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Entry[] = [];
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    const modN = mac ? '⌘N' : 'Ctrl+N';

    // Navigation: no invented shortcuts. Only genuinely useful shortcuts
    // (New Run, Focus composer, palette) carry a hint.
    out.push(
      { group: 'Navigation', label: 'Runs', sub: 'conversation history', run: () => dispatch({ type: 'ui/set', patch: { view: 'run' } }) },
      { group: 'Navigation', label: 'Models', sub: 'model intelligence', run: () => dispatch({ type: 'ui/set', patch: { view: 'models' } }) },
      { group: 'Navigation', label: 'Tools', sub: 'execution capabilities', run: () => dispatch({ type: 'ui/set', patch: { view: 'tools' } }) },
      { group: 'Navigation', label: 'Memory', sub: 'agent knowledge', run: () => dispatch({ type: 'ui/set', patch: { view: 'memory' } }) },
      { group: 'Navigation', label: 'Evaluations', sub: 'runtime quality', run: () => dispatch({ type: 'ui/set', patch: { view: 'evals' } }) },
      { group: 'Navigation', label: 'Settings', sub: 'preferences + providers', run: () => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: null } }) },
    );

    out.push(
      { group: 'Actions', label: 'New Run', sub: 'start a task', shortcut: modN, run: () => dispatch({ type: 'ui/set', patch: { newRunOpen: true, view: 'run' } }) },
      { group: 'Actions', label: 'Focus Composer', sub: 'type a message', shortcut: '/', run: () => { dispatch({ type: 'ui/set', patch: { view: 'run' } }); setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 50); } },
      { group: 'Actions', label: state.ui.rightOpen ? 'Hide Inspector' : 'Show Inspector', sub: 'toggle panel', run: () => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } }) },
      { group: 'Actions', label: 'Connect Provider', sub: 'keys, verification, health', run: () => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: 'providers' } }) },
      { group: 'Actions', label: 'Runtime Settings', sub: 'presets and defaults', run: () => dispatch({ type: 'ui/set', patch: { view: 'settings', settingsAnchor: 'runtime' } }) },
      { group: 'Actions', label: 'Refresh Model Catalog', sub: 'discover new models', run: () => { dispatch({ type: 'ui/set', patch: { view: 'models' } }); void api.refreshModels().then(() => api.getModels().then(({ models }) => dispatch({ type: 'models/set', models }))).catch(() => {}); } },
      { group: 'Actions', label: `Switch to ${state.ui.theme === 'dark' ? 'Light' : 'Dark'} Theme`, sub: 'appearance', run: () => dispatch({ type: 'ui/set', patch: { theme: state.ui.theme === 'dark' ? 'light' : 'dark' } }) },
    );

    // Contextual actions appear only when relevant — never a dead button.
    const snapStatus = String(state.server.snapshot?.status || '');
    const busy = ['running', 'planning', 'waiting'].includes(snapStatus);
    if (busy && state.server.activeRunId) {
      const id = state.server.activeRunId;
      out.push({ group: 'Actions', label: 'Stop Run', sub: 'interrupt execution', shortcut: 'Esc', run: () => { void api.cancelRun(id).catch(() => {}); } });
    }
    if (snapStatus === 'failed' && state.server.activeRunId) {
      const id = state.server.activeRunId;
      out.push({ group: 'Actions', label: 'Retry Run', sub: 'resume from checkpoint', run: () => { void api.retryRun(id).catch(() => {}); } });
    }

    state.server.runs.filter(r => match(r.title + ' ' + r.id + ' ' + r.status)).slice(0, 6).forEach(r =>
      out.push({ group: 'Runs', label: r.title, sub: `run \u00b7 ${r.status}`, run: () => { dispatch({ type: 'runs/active', id: r.id }); dispatch({ type: 'ui/set', patch: { view: 'run' } }); } }));

    state.server.models.filter(m => match(m.name + ' ' + m.provider + ' ' + m.id + ' ' + m.capabilities.join(' '))).slice(0, 5).forEach(m =>
      out.push({ group: 'Models', label: m.name, sub: `model \u00b7 ${m.provider} \u00b7 ${m.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'models', modelQuery: m.name } }) }));

    state.server.tools.filter(t => match(t.name + ' ' + t.description)).slice(0, 5).forEach(t =>
      out.push({ group: 'Tools', label: t.name, sub: `tool \u00b7 ${t.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'tools', toolQuery: t.name } }) }));

    state.server.memItems.filter(m => match(m.title + ' ' + m.snippet + ' ' + m.source)).slice(0, 4).forEach(m =>
      out.push({ group: 'Memory', label: m.title, sub: `memory \u00b7 ${m.scope}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'memory', memQuery: m.title } }) }));

    if (ql) return out.filter(e => match(e.label + ' ' + e.sub + ' ' + e.group));
    return out;
  }, [q, state.server.runs, state.server.models, state.server.tools, state.server.memItems, state.server.snapshot, state.server.activeRunId, state.ui.rightOpen, state.ui.theme, state.ui.taskMode, dispatch]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-pal-idx="${sel}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      try { (el as HTMLElement).scrollIntoView({ block: 'nearest' }); } catch { /* older engines */ }
    }
  }, [sel, open]);

  const onKey = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel(s => Math.min(entries.length - 1, s + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const e = entries[Math.min(sel, entries.length - 1)];
      if (e) { close(); e.run(); }
    }
  }, [entries, sel, close]);

  if (!open) return null;
  const groups: { name: string; items: { e: Entry; idx: number }[] }[] = [];
  entries.slice(0, 40).forEach((e, idx) => {
    let g = groups.find(g => g.name === e.group);
    if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
    g.items.push({ e, idx });
  });

  groups.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.name);
    const bi = GROUP_ORDER.indexOf(b.name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="palette-overlay" onClick={close} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={e => e.stopPropagation()}
      >
        <div className="palette-input-wrap">
          <input
            ref={inputRef}
            placeholder="Search runs, models, tools, memories…"
            aria-label="Search commands and navigate"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className="palette-esc" aria-label="Press Escape to close">esc</kbd>
        </div>
        <div className="palette-hint">
          <span><kbd>&uarr;&darr;</kbd> navigate</span>
          <span><kbd>&crarr;</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Command results">
          {groups.map(g => (
            <div key={g.name} className="palette-group">
              <div className="palette-group-label" role="presentation">{g.name}</div>
              {g.items.map(({ e, idx }) => (
                <button
                  key={idx}
                  data-pal-idx={idx}
                  className={`palette-item${idx === sel ? ' selected' : ''}`}
                  role="option"
                  aria-selected={idx === sel}
                  onMouseEnter={() => setSel(idx)}
                  onClick={() => { close(); e.run(); }}
                >
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
