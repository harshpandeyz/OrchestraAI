import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import type { ProviderInfo } from '../types';
import './NewRunDialog.css';

const FLAG = 'orchestra-onboarded-v1';

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return true; // private mode: never nag
  }
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(FLAG);
  } catch { /* ignore */ }
}

function markDone() {
  try {
    localStorage.setItem(FLAG, '1');
  } catch { /* ignore */ }
}

/**
 * Lightweight first-launch setup: connect a provider, verify, run the first
 * task. Shows once (until completed or dismissed); resettable from Settings.
 */
export function Onboarding() {
  const { dispatch } = useRuntime();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState('openrouter');

  useEffect(() => {
    if (isOnboarded()) return;
    let cancelled = false;
    api.getProviders()
      .then(({ providers: p, mode: m }) => {
        if (cancelled) return;
        setProviders(p || []);
        setMode(m || null);
        const anyConnected = (p || []).some((x) => x.connected);
        if (!anyConnected) {
          setVisible(true);
        } else {
          markDone();
        }
      })
      .catch(() => { /* backend down: stay silent, banner covers it */ });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    markDone();
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [visible, dismiss]);

  if (!visible) return null;

  const connect = async () => {
    if (busy || apiKey.trim().length < 8) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.connectProvider(picked, apiKey.trim());
      setProviders((prev) => prev.map((p) => (p.id === picked ? res.provider : p)));
      setMode(res.mode);
      setApiKey('');
      setStep(2);
      if (res.mode === 'live') markDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed — check the key and try again.');
    } finally {
      setBusy(false);
    }
  };

  const startFirstRun = () => {
    dismiss();
    dispatch({ type: 'ui/set', patch: { view: 'run', newRunOpen: true } });
  };

  const steps = ['Connect a provider', 'Verify connection', 'Run your first task'];
  const connected = providers.some((p) => p.connected);

  return (
    <div className="nr-overlay" role="presentation">
      <div className="nr-dialog" role="dialog" aria-modal="true" aria-label="Welcome to OrchestraAI" onClick={(e) => e.stopPropagation()}>
        <div className="nr-head">
          <div>
            <h2>Welcome to OrchestraAI</h2>
            <p>Three quick steps to your first live run.</p>
          </div>
          <button className="icon-btn icon-only" aria-label="Dismiss setup" onClick={dismiss}>✕</button>
        </div>
        <ol className="ob-steps" aria-label="Setup progress">
          {steps.map((s, i) => (
            <li key={s} className={i < step || (i === 2 && connected) ? 'done' : i === step ? 'active' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="ob-num" aria-hidden="true">{i + 1}</span> {s}
            </li>
          ))}
        </ol>
        {step === 0 && (
          <div className="nr-field">
            <span id="ob-prov-label">Choose a provider</span>
            <div className="nr-modes" role="radiogroup" aria-labelledby="ob-prov-label">
              {providers.map((p) => (
                <button key={p.id} className="chip" aria-pressed={picked === p.id} onClick={() => setPicked(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <small className="nr-hint">Keys are stored encrypted on this machine and never shown again.</small>
            <div className="nr-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="icon-btn primary" onClick={() => setStep(1)}>Continue</button>
            </div>
          </div>
        )}
        {step === 1 && (
          <div>
            <label className="nr-field">
              <span>{providers.find((p) => p.id === picked)?.label || picked} API key</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
                placeholder="Paste API key" aria-label="Provider API key"
                onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
            </label>
            {error && <div className="banner err" role="alert"><span>{error}</span></div>}
            <div className="nr-actions">
              <button className="icon-btn" onClick={() => setStep(0)}>Back</button>
              <button className="icon-btn primary" onClick={connect} disabled={busy || apiKey.trim().length < 8}>
                {busy ? 'Verifying…' : 'Test & save'}
              </button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div>
            <div className="banner ok" role="status">
              <span><b>{connected || mode === 'live' ? 'LIVE enabled.' : 'Key saved.'}</b> OrchestraAI can now use real models.</span>
            </div>
            <div className="nr-actions">
              <button className="icon-btn" onClick={dismiss}>Explore first</button>
              <button className="icon-btn primary" onClick={startFirstRun}>Start my first run</button>
            </div>
          </div>
        )}
        <div className="nr-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
          <button className="link-btn" onClick={dismiss}>Continue in Demo mode</button>
        </div>
      </div>
    </div>
  );
}
