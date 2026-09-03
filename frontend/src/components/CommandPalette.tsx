import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';

interface Entry { group: string; label: string; sub: string; run: () => void }

export function CommandPalette() {
  const { state, dispatch } = useRuntime();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = state.ui.paletteOpen;
  const close = () => { dispatch({ type: 'ui/set', patch: { paletteOpen: false } }); setQ(''); setSel(0); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dispatch({ type: 'ui/set', patch: { paletteOpen: !open } }); }
      else if (e.key === 'Escape' && open) close();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open ]);

  const entries: Entry[] = useMemo(() => {
    const ql = q.toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Entry[] = [];
    out.push(
      { group: 'Actions', label: 'New run', sub: 'create session', run: async () => { try { const { run } = await api.createRun('New agent run', state.ui.taskMode); const { runs } = await api.getRuns(); dispatch({ type: 'runs/set', runs }); dispatch({ type: 'runs/active', id: run.id }); dispatch({ type: 'ui/set', patch: { view: 'run' } }); } catch { /* banner */ } } },
      { group: 'Actions', label: 'Focus composer', sub: 'press /', run: () => { dispatch({ type: 'ui/set', patch: { view: 'run' } }); setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 50); } },
      { group: 'Actions', label: state.ui.rightOpen ? 'Hide runtime inspector' : 'Show runtime inspector', sub: 'toggle panel', run: () => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } }) },
      { group: 'Actions', label: 'Open models', sub: 'catalog', run: () => dispatch({ type: 'ui/set', patch: { view: 'models' } }) },
      { group: 'Actions', label: 'Open tools', sub: 'registry', run: () => dispatch({ type: 'ui/set', patch: { view: 'tools' } }) },
      { group: 'Actions', label: 'Open memory', sub: 'search', run: () => dispatch({ type: 'ui/set', patch: { view: 'memory' } }) },
      { group: 'Actions', label: 'Open evaluations', sub: 'quality', run: () => dispatch({ type: 'ui/set', patch: { view: 'evals' } }) },
      { group: 'Actions', label: `Switch theme (${state.ui.theme === 'dark' ? 'light' : 'dark'})`, sub: 'appearance', run: () => dispatch({ type: 'ui/set', patch: { theme: state.ui.theme === 'dark' ? 'light' : 'dark' } }) },
    );
    state.server.runs.filter(r => match(r.title + r.id)).slice(0, 5).forEach(r =>
      out.push({ group: 'Runs', label: r.title, sub: `run · ${r.status}`, run: () => { dispatch({ type: 'runs/active', id: r.id }); dispatch({ type: 'ui/set', patch: { view: 'run' } }); } }));
    state.server.models.filter(m => match(m.name + m.provider + m.id)).slice(0, 4).forEach(m =>
      out.push({ group: 'Models', label: m.name, sub: `model · ${m.provider} · ${m.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'models', modelQuery: m.name } }) }));
    state.server.tools.filter(t => match(t.name + t.description)).slice(0, 4).forEach(t =>
      out.push({ group: 'Tools', label: t.name, sub: `tool · ${t.status}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'tools', toolQuery: t.name } }) }));
    state.server.memItems.filter(m => match(m.title + m.snippet)).slice(0, 3).forEach(m =>
      out.push({ group: 'Memory', label: m.title, sub: `memory · ${m.scope}`, run: () => dispatch({ type: 'ui/set', patch: { view: 'memory', memQuery: m.title } }) }));
    if (ql) return out.filter(e => match(e.label + e.sub + e.group));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, state.server.runs, state.server.models, state.server.tools, state.server.memItems, state.ui.rightOpen, state.ui.theme, state.ui.taskMode]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (!open) return;
    const el = document.querySelector(`[data-pal-idx="${sel}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      try { (el as HTMLElement).scrollIntoView({ block: 'nearest' }); } catch { /* older engines */ }
    }
  }, [sel, open ]);

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel(s => Math.min(entries.length - 1, s + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); const e = entries[Math.min(sel, entries.length - 1)]; if (e) { close(); e.run(); } }
  };

  if (!open) return null;
  const groups: { name: string; items: { e: Entry; idx: number }[] }[] = [];
  entries.slice(0, 30).forEach((e, idx) => {
    let g = groups.find(g => g.name === e.group);
    if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
    g.items.push({ e, idx });
  });

  return (
    <div className="palette-overlay" onClick={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={e => e.stopPropagation()}>
        <input ref={inputRef} placeholder="Search runs, models, tools, memories — or type an action…" aria-label="Global search"
          value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="pal-hint"><kbd>↑↓</kbd> navigate · <kbd>⏎</kbd> open · <kbd>esc</kbd> close</div>
        {groups.map(g => (
          <div key={g.name}>
            <div className="grp">{g.name}</div>
            {g.items.map(({ e, idx }) => (
              <button key={idx} data-pal-idx={idx} className={idx === sel ? 'sel' : ''} role="option" aria-selected={idx === sel}
                onMouseEnter={() => setSel(idx)}
                onClick={() => { close(); e.run(); }}>
                <b>{e.label}</b><span className="sub">{e.sub}</span>
              </button>
            ))}
          </div>
        ))}
        {entries.length === 0 && <div className="empty" role="status"><b>No matches</b><span>Try a different search.</span></div>}
      </div>
    </div>
  );
}
