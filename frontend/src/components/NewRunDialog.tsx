import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import type { ModelInfo, RuntimePreset, RuntimeSettings } from '../types';
import './NewRunDialog.css';

const TASK_MODES = [
  { id: 'auto', label: 'Auto', hint: 'Let OrchestraAI choose the approach' },
  { id: 'code', label: 'Coding', hint: 'Implement and edit with runtime context' },
  { id: 'research', label: 'Research', hint: 'Investigate across code and docs' },
  { id: 'debug', label: 'Debugging', hint: 'Diagnose failures and trace causes' },
  { id: 'general', label: 'General', hint: 'Open-ended agent assistance' },
];

const AUTONOMY: { id: 'auto' | 'readonly'; label: string; hint: string }[] = [
  { id: 'auto', label: 'Autonomous', hint: 'I execute normal work within your permissions.' },
  { id: 'readonly', label: 'Restricted', hint: 'I operate under strict limitations — no file edits or deploys.' },
];

const INTENT_TEMPLATES: { label: string; title: string; taskMode: string }[] = [
  { label: 'Fix bug', title: 'Fix bug: ', taskMode: 'debug' },
  { label: 'Build feature', title: 'Build feature: ', taskMode: 'code' },
  { label: 'Research', title: 'Research: ', taskMode: 'research' },
  { label: 'Review', title: 'Review: ', taskMode: 'general' },
  { label: 'Analyze', title: 'Analyze: ', taskMode: 'research' },
  { label: 'Automate', title: 'Automate: ', taskMode: 'code' },
  { label: 'Deploy', title: 'Deploy: ', taskMode: 'code' },
  { label: 'Security audit', title: 'Security audit: ', taskMode: 'debug' },
  { label: 'Fix CI', title: 'Fix CI: ', taskMode: 'debug' },
  { label: 'Review PR', title: 'Review PR: ', taskMode: 'general' },
];

/**
 * New task flow: outcome-first. "What do you want done?" dominates;
 * "How should I work?" maps to real backend presets + tool policy with
 * plain-language consequences. Advanced runtime settings stay collapsed.
 * No fake per-tool checkboxes or success criteria — the backend supports
 * preset / budget / model / switching / compaction / toolPolicy only.
 */
export function NewRunDialog() {
  const { state, dispatch } = useRuntime();
  const open = state.ui.newRunOpen;
  const [title, setTitle] = useState('New agent run');
  const [taskMode, setTaskMode] = useState(state.ui.taskMode);
  const [presets, setPresets] = useState<RuntimePreset[]>([]);
  const [defaults, setDefaults] = useState<RuntimeSettings | null>(null);
  const [preset, setPreset] = useState('balanced');
  const [toolPolicy, setToolPolicy] = useState<'auto' | 'readonly'>('auto');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [budget, setBudget] = useState('0.50');
  const [preferredModel, setPreferredModel] = useState('');
  const [allowSwitching, setAllowSwitching] = useState(true);
  const [allowCompaction, setAllowCompaction] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('New agent run');
    setTaskMode(state.ui.taskMode);
    setError(null);
    setShowAdvanced(false);
    setPreferredModel('');
    setBudget('0.50');
    api.getRuntimeSettings()
      .then(({ settings, presets: p }) => {
        setDefaults(settings);
        setPresets(p);
        setPreset(settings.defaultPreset || 'balanced');
        setAllowSwitching(settings.allowSwitching);
        setAllowCompaction(settings.allowCompaction);
        setToolPolicy(settings.toolPolicy || 'auto');
        if (typeof settings.defaultBudgetUsd === 'number') setBudget(String(settings.defaultBudgetUsd.toFixed(2)));
      })
      .catch(() => { setPresets([]); });
    api.getModels().then(({ models: m }) => setModels(m || [])).catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'ui/set', patch: { newRunOpen: false } });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, dispatch]);

  if (!open) return null;

  const activePreset = presets.find((p) => p.id === preset);
  const close = () => dispatch({ type: 'ui/set', patch: { newRunOpen: false } });

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const budgetNum = budget.trim() === '' ? undefined : Number(budget);
      const { run } = await api.createRun(title.trim() || 'New agent run', taskMode, {
        preset,
        ...(budgetNum !== undefined && Number.isFinite(budgetNum) ? { budget: Math.max(0, Math.min(1000, budgetNum)) } : {}),
        ...(preferredModel ? { preferredModel } : {}),
        ...(defaults && allowSwitching !== defaults.allowSwitching ? { allowSwitching } : {}),
        ...(defaults && allowCompaction !== defaults.allowCompaction ? { allowCompaction } : {}),
        ...(defaults && toolPolicy !== defaults.toolPolicy ? { toolPolicy } : !defaults ? { toolPolicy } : {}),
      });
      dispatch({ type: 'ui/set', patch: { taskMode, newRunOpen: false, view: 'run' } });
      const { runs } = await api.getRuns();
      dispatch({ type: 'runs/set', runs });
      dispatch({ type: 'runs/active', id: run.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create run');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="nr-overlay" onClick={close} role="presentation">
      <div className="nr-dialog" role="dialog" aria-modal="true" aria-label="Start a new run" onClick={(e) => e.stopPropagation()}>
        <div className="nr-head">
          <div>
            <h2>What do you want done?</h2>
            <p>Describe the outcome. OrchestraAI handles context, model choice, tools and verification.</p>
          </div>
          <button className="icon-btn icon-only" aria-label="Close new run dialog" onClick={close}>✕</button>
        </div>
        <label className="nr-field nr-task">
          <span className="sr-only">Task title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Fix the authentication refresh bug…" aria-label="Task title" autoFocus />
        </label>
        <div className="nr-field">
          <span id="nr-template-label">Start from a template</span>
          <div className="nr-modes" role="group" aria-labelledby="nr-template-label" style={{ flexWrap: 'wrap' }}>
            {INTENT_TEMPLATES.map((t) => (
              <button key={t.label} type="button" className="chip" title={`Template: ${t.label} (sets ${t.taskMode} mode)`}
                onClick={() => { setTaskMode(t.taskMode); setTitle((prev) => (prev === 'New agent run' || !prev ? t.title : prev)); dispatch({ type: 'ui/set', patch: { taskMode: t.taskMode } }); }}>
                {t.label}
              </button>
            ))}
          </div>
          <small className="nr-hint">Templates set the task mode and title prefix — execution still follows backend presets and policy.</small>
        </div>
        <div className="nr-field">
          <span id="nr-mode-label">Task mode</span>
          <div className="nr-modes" role="radiogroup" aria-labelledby="nr-mode-label">
            {TASK_MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={taskMode === m.id} title={m.hint}
                className="chip" aria-pressed={taskMode === m.id} onClick={() => setTaskMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <small className="nr-hint">{TASK_MODES.find((m) => m.id === taskMode)?.hint}</small>
        </div>
        <div className="nr-field">
          <span id="nr-preset-label">How should I work?</span>
          <div className="nr-modes" role="radiogroup" aria-labelledby="nr-preset-label">
            {(presets.length ? presets : [{ id: 'balanced', label: 'Balanced', blurb: '', consequence: '' }]).map((p) => (
              <button key={p.id} role="radio" aria-checked={preset === p.id}
                className="chip" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {activePreset?.consequence && <small className="nr-hint">{activePreset.consequence}</small>}
        </div>
        <div className="nr-field">
          <span id="nr-autonomy-label">Tools</span>
          <div className="nr-modes" role="radiogroup" aria-labelledby="nr-autonomy-label">
            {AUTONOMY.map((a) => (
              <button key={a.id} role="radio" aria-checked={toolPolicy === a.id} title={a.hint}
                className="chip" aria-pressed={toolPolicy === a.id} onClick={() => setToolPolicy(a.id)}>
                {a.label}
              </button>
            ))}
          </div>
          <small className="nr-hint">{AUTONOMY.find((a) => a.id === toolPolicy)?.hint} Per-tool approvals arrive with the Session 3 approval queue.</small>
        </div>
        <label className="nr-field">
          <span>Budget (USD)</span>
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="0.50" aria-label="Run budget in USD" />
        </label>
        <button className="link-btn nr-adv-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? 'Hide advanced runtime settings' : 'Advanced runtime settings'}
        </button>
        {showAdvanced && (
          <div className="nr-advanced">
            <label className="nr-field">
              <span>Model — Auto lets OrchestraAI choose</span>
              <select value={preferredModel} onChange={(e) => setPreferredModel(e.target.value)} aria-label="Preferred model">
                <option value="">Auto (recommended)</option>
                {models.slice(0, 100).map((m) => (
                  <option key={m.id} value={m.id}>{m.name} · {m.provider}</option>
                ))}
              </select>
            </label>
            <label className="nr-check">
              <input type="checkbox" checked={allowSwitching} onChange={(e) => setAllowSwitching(e.target.checked)} />
              <span>Allow model switching <small>Keep on unless you need one model for the whole run.</small></span>
            </label>
            <label className="nr-check">
              <input type="checkbox" checked={allowCompaction} onChange={(e) => setAllowCompaction(e.target.checked)} />
              <span>Allow context optimization <small>Reclaim tokens automatically when context fills.</small></span>
            </label>
          </div>
        )}
        {error && <div className="banner err" role="alert"><span>{error}</span></div>}
        <div className="nr-actions">
          <button className="icon-btn" onClick={close}>Cancel</button>
          <button className="icon-btn primary" onClick={create} disabled={creating} aria-label="Run task">
            {creating ? 'Starting…' : 'Run task'}
          </button>
        </div>
      </div>
    </div>
  );
}
