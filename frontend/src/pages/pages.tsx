import React, { useMemo, useState } from 'react';
import { useRuntime } from '../state/store';
import { Empty, StatusDot, fmtPct, fmtSec, relTime, usd } from '../components/ui';

type ModelSort = 'quality' | 'cost' | 'latency' | 'context' | 'reliability';

export function ModelsPage() {
  const { state, dispatch } = useRuntime();
  const [sort, setSort] = useState<ModelSort>('quality');
  const [onlyHealthy, setOnlyHealthy] = useState(false);
  const q = state.ui.modelQuery.toLowerCase();
  const rows = useMemo(() => {
    let r = state.server.models.filter(m => !q || (m.name + m.provider + m.id + m.capabilities.join(' ')).toLowerCase().includes(q));
    if (onlyHealthy) r = r.filter(m => m.status === 'healthy');
    const score = {
      quality: (m: typeof r[number]) => -m.quality,
      cost: (m: typeof r[number]) => m.outputPer1k,
      latency: (m: typeof r[number]) => m.avgLatencyMs,
      context: (m: typeof r[number]) => -m.contextWindow,
      reliability: (m: typeof r[number]) => -m.reliability,
    }[sort];
    return [...r].sort((a, b) => score(a) - score(b));
  }, [state.server.models, q, sort, onlyHealthy]);
  const activeId = state.server.snapshot?.activeModelId;
  const sorts: { id: ModelSort; label: string }[] = [
    { id: 'quality', label: 'Best quality' }, { id: 'cost', label: 'Lowest cost' },
    { id: 'latency', label: 'Fastest' }, { id: 'context', label: 'Largest context' }, { id: 'reliability', label: 'Most reliable' },
  ];
  return (
    <div className="page">
      <h2>Models</h2>
      <p className="lede">{state.server.models.length} registered · live catalog from the model registry. Nothing here is invented.</p>
      <div className="toolbar" role="toolbar" aria-label="Model filters">
        <input className="search" placeholder="Filter models…" aria-label="Filter models" value={state.ui.modelQuery} onChange={e => dispatch({ type: 'ui/set', patch: { modelQuery: e.target.value } })} />
        {sorts.map(s => <button key={s.id} className="chip" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
        <button className="chip" aria-pressed={onlyHealthy} onClick={() => setOnlyHealthy(v => !v)}>● Healthy only</button>
      </div>
      {rows.length === 0 ? <Empty what="Model catalog" hint={state.server.models.length ? 'No models match this filter.' : 'No models registered yet.'} /> : (
        <div className="model-grid">
          {rows.map(m => (
            <article key={m.id} className={`model-card ${m.id === activeId ? 'active' : ''}`} aria-label={`${m.name} model card`}>
              <div className="mc-top">
                <StatusDot status={m.status} />
                <b title={m.id}>{m.name}</b>
                {m.id === activeId && <span className="pill info sm">ACTIVE</span>}
              </div>
              <div className="mc-prov">{m.provider} · {m.status}</div>
              <div className="mc-caps">{m.capabilities.length ? m.capabilities.map(c => <span key={c} className="cap">{c}</span>) : <span className="cap dim">no capabilities listed</span>}</div>
              <div className="mc-stats">
                <span title="Context window">◧ {(m.contextWindow / 1000).toFixed(0)}k</span>
                <span title="Quality score">★ {m.quality.toFixed(2)}</span>
                <span title="Average latency">⏱ {fmtSec(m.avgLatencyMs)}</span>
                <span title="Reliability">♥ {fmtPct(m.reliability, 0)}</span>
              </div>
              <div className="kv"><span className="k">in / out / cached per 1k</span><span className="v">{usd(m.inputPer1k)} · {usd(m.outputPer1k)} · {usd(m.cachedPer1k)}</span></div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoryPage() {
  const { state, dispatch } = useRuntime();
  const [scope, setScope] = useState<'all' | 'working' | 'longterm'>('all');
  const q = state.ui.memQuery.toLowerCase();
  const rows = useMemo(() => {
    let r = state.server.memItems.filter(m => !q || (m.title + m.snippet + m.source).toLowerCase().includes(q));
    if (scope !== 'all') r = r.filter(m => m.scope === scope);
    return [...r].sort((a, b) => (b.importance - a.importance) || (new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()));
  }, [state.server.memItems, q, scope]);
  return (
    <div className="page">
      <h2>Memory</h2>
      <p className="lede">{rows.length} records · working + long-term. Raw vector internals stay server-side.</p>
      <div className="toolbar">
        <input className="search" placeholder="Search memory…" aria-label="Search memory" value={state.ui.memQuery} onChange={e => dispatch({ type: 'ui/set', patch: { memQuery: e.target.value } })} />
        {(['all', 'working', 'longterm'] as const).map(s => <button key={s} className="chip" aria-pressed={scope === s} onClick={() => setScope(s)}>{s}</button>)}
      </div>
      {rows.length === 0 ? <Empty what="Memory" hint={state.server.memItems.length ? 'No records match this search.' : 'No persistent memories yet.'} /> : (
        <div className="mem-grid">
          {rows.map(m => (
            <article key={m.id} className="mem-card">
              <div className="mc-top"><span className={`pill sm ${m.scope === 'working' ? 'info' : 'neutral'}`}>{m.scope}</span><span className="pill sm neutral">{m.status}</span><span className="rel">{relTime(m.lastUsedAt)}</span></div>
              <b>{m.title}</b>
              <p>{m.snippet || 'No summary available.'}</p>
              <div className="kv"><span className="k">{m.source || 'unknown'}</span><span className="v">imp {m.importance.toFixed(2)} · conf {m.confidence.toFixed(2)}</span></div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolsPage() {
  const { state, dispatch } = useRuntime();
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const q = state.ui.toolQuery.toLowerCase();
  const rows = useMemo(() => {
    let r = state.server.tools.filter(t => !q || (t.name + t.description).toLowerCase().includes(q));
    if (onlyEnabled) r = r.filter(t => t.status === 'enabled');
    return r;
  }, [state.server.tools, q, onlyEnabled]);
  return (
    <div className="page">
      <h2>Tools</h2>
      <p className="lede">{rows.length} registered · blocked tools are visually obvious and never silently called.</p>
      <div className="toolbar">
        <input className="search" placeholder="Filter tools…" aria-label="Filter tools" value={state.ui.toolQuery} onChange={e => dispatch({ type: 'ui/set', patch: { toolQuery: e.target.value } })} />
        <button className="chip" aria-pressed={onlyEnabled} onClick={() => setOnlyEnabled(v => !v)}>Enabled only</button>
      </div>
      {rows.length === 0 ? <Empty what="Tool registry" hint={state.server.tools.length ? 'No tools match this filter.' : 'No tools are currently available.'} /> : (
        <div className="tool-grid">
          {rows.map(t => {
            const blocked = t.status !== 'enabled';
            return (
              <article key={t.name} className={`tool-card ${blocked ? 'blocked' : ''} ${t.lastStatus === 'running' ? 'running' : ''}`}>
                <div className="mc-top">
                  {t.lastStatus === 'running' ? <span className="livedot" aria-hidden="true" /> : <StatusDot status={blocked ? 'down' : t.lastStatus === 'failed' ? 'failed' : 'idle'} />}
                  <b style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{t.name}</b>
                  {blocked ? <span className="pill err sm">BLOCKED</span> : t.lastStatus === 'running' ? <span className="pill warn sm">RUNNING</span> : <span className="pill ok sm">ENABLED</span>}
                </div>
                <p>{t.description || 'No description provided.'}</p>
                <div className="mc-stats"><span>×{t.calls} calls</span><span>{fmtSec(t.avgLatencyMs)} avg</span><span>{fmtPct(t.successRate, 0)} success</span></div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function EvalsPage() {
  const { state } = useRuntime();
  const evals = state.server.evals;
  return (
    <div className="page">
      <h2>Evaluations</h2>
      <p className="lede">Runtime quality metrics. Metrics appear only when the backend provides them — nothing is invented here.</p>
      {evals.length === 0 ? <Empty what="Evaluation metrics" hint="Run an evaluation to see runtime quality." /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Evaluation</th><th>Category</th><th>Score</th><th>Result</th><th>Model</th><th>Cost</th><th>Latency</th><th>Time</th></tr></thead>
          <tbody>{evals.map((e: any, i: number) => (
            <tr key={e.id || i}>
              <td><b>{e.name || e.id || `eval-${i}`}</b></td>
              <td>{e.category || '—'}</td>
              <td style={{ fontFamily: 'var(--mono)' }}>{typeof e.score === 'number' ? e.score.toFixed(3) : '—'}</td>
              <td>{e.pass === undefined && e.passed === undefined ? '—' : (e.pass ?? e.passed) ? <span className="pill ok sm">PASS</span> : <span className="pill err sm">FAIL</span>}</td>
              <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{e.model || e.modelId || '—'}</td>
              <td style={{ fontFamily: 'var(--mono)' }}>{typeof e.cost === 'number' ? usd(e.cost) : '—'}</td>
              <td style={{ fontFamily: 'var(--mono)' }}>{typeof e.latencyMs === 'number' ? fmtSec(e.latencyMs) : '—'}</td>
              <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{e.ts ? relTime(e.ts) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {state.server.evalNote && <p className="note">{state.server.evalNote}</p>}
    </div>
  );
}

export function SettingsPage() {
  const { state, dispatch } = useRuntime();
  return (
    <div className="page">
      <h2>Providers / Settings</h2>
      <p className="lede">Console preferences live here. Provider secrets are never rendered — redaction stays server-side.</p>
      <div className="setgrid">
        <section className="card" aria-label="Runtime backend">
          <h3>Runtime backend</h3>
          <div className="kv"><span className="k">Runtime API</span><span className="v">same-origin /api</span></div>
          <div className="kv"><span className="k">Event transport</span><span className="v">SSE · /api/runs/:id/events</span></div>
          <div className="kv"><span className="k">Secrets</span><span className="v">never rendered in console</span></div>
        </section>
        <section className="card" aria-label="Appearance">
          <h3>Appearance</h3>
          <div className="kv"><span className="k">Theme</span>
            <span className="v">
              <button className="chip" aria-pressed={state.ui.theme === 'dark'} onClick={() => dispatch({ type: 'ui/set', patch: { theme: 'dark' } })}>Dark</button>{' '}
              <button className="chip" aria-pressed={state.ui.theme === 'light'} onClick={() => dispatch({ type: 'ui/set', patch: { theme: 'light' } })}>Light</button>
            </span></div>
          <div className="kv"><span className="k">Panels</span>
            <span className="v">
              <button className="chip" aria-pressed={state.ui.leftOpen} onClick={() => dispatch({ type: 'ui/set', patch: { leftOpen: !state.ui.leftOpen } })}>Nav</button>{' '}
              <button className="chip" aria-pressed={state.ui.rightOpen} onClick={() => dispatch({ type: 'ui/set', patch: { rightOpen: !state.ui.rightOpen } })}>Inspector</button>
            </span></div>
        </section>
        <section className="card" aria-label="Composer defaults">
          <h3>Composer defaults</h3>
          <div className="kv"><span className="k">Task mode</span>
            <span className="v">
              {(['debug', 'code', 'research', 'general'] as const).map(m =>
                <React.Fragment key={m}><button className="chip" aria-pressed={state.ui.taskMode === m} onClick={() => dispatch({ type: 'ui/set', patch: { taskMode: m } })}>{m}</button>{' '}</React.Fragment>)}
            </span></div>
          <div className="kv"><span className="k">Send</span><span className="v"><kbd>Enter</kbd> · newline <kbd>Shift+Enter</kbd></span></div>
        </section>
        <section className="card" aria-label="Shortcuts">
          <h3>Shortcuts</h3>
          <div className="kv"><span className="k">Command palette</span><span className="v"><kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd></span></div>
          <div className="kv"><span className="k">Focus composer</span><span className="v"><kbd>/</kbd></span></div>
          <div className="kv"><span className="k">Close dialogs</span><span className="v"><kbd>Esc</kbd></span></div>
        </section>
      </div>
    </div>
  );
}
