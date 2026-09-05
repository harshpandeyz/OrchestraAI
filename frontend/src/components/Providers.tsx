import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { Empty, fmtSec, relTime } from './ui';
import type { ProviderInfo } from '../types';

function statusPill(p: ProviderInfo): { cls: string; label: string } {
  if (p.connected) {
    if (p.healthy === false) return { cls: 'warn', label: 'DEGRADED' };
    return { cls: 'ok', label: 'CONNECTED' };
  }
  if (p.configured) return { cls: 'warn', label: 'NOT VERIFIED' };
  return { cls: 'neutral', label: 'NOT CONNECTED' };
}

function ConnectForm({ provider, onDone }: { provider: ProviderInfo; onDone: (p: ProviderInfo, mode: string) => void }) {
  const { dispatch } = useRuntime();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'idle' | 'testing' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<{ latencyMs?: number; modelCount?: number | null } | null>(null);

  const test = async () => {
    if (busy !== 'idle' || key.trim().length < 8) return;
    setBusy('testing');
    setError(null);
    setTestOk(null);
    try {
      const res = await api.testProvider(provider.id, key.trim());
      setTestOk({ latencyMs: res.latencyMs, modelCount: res.modelCount });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setBusy('idle');
    }
  };

  const save = async () => {
    if (busy !== 'idle' || key.trim().length < 8) return;
    setBusy('saving');
    setError(null);
    try {
      // Connect verifies before persisting: the key is saved only when it works.
      const res = await api.connectProvider(provider.id, key.trim());
      setKey('');
      setTestOk(null);
      onDone(res.provider, res.mode);
      dispatch({ type: 'toast/push', toast: { kind: 'ok', title: `${provider.label} connected`, body: 'LIVE mode enabled.' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect — check the key and try again.');
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="prov-connect">
      <label>
        <span>API key</span>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off"
          placeholder={`Paste ${provider.label} API key`} aria-label={`${provider.label} API key`}
          onKeyDown={(e) => { if (e.key === 'Enter') void test(); }} />
      </label>
      <small className="nr-hint">Sent to the backend once, stored encrypted on this machine, never shown again.</small>
      {testOk && (
        <div className="banner ok" role="status">
          <span><b>Key works.</b>{testOk.latencyMs !== undefined ? ` Verified in ${fmtSec(testOk.latencyMs)}.` : ''}{testOk.modelCount !== null && testOk.modelCount !== undefined ? ` ${testOk.modelCount} models visible.` : ''} Save to enable LIVE mode.</span>
        </div>
      )}
      {error && <div className="banner err" role="alert"><span>{error}</span></div>}
      <div className="nr-actions">
        <button className="icon-btn sm" onClick={test} disabled={busy !== 'idle' || key.trim().length < 8}>
          {busy === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button className="icon-btn sm primary" onClick={save} disabled={busy !== 'idle' || key.trim().length < 8}>
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ProviderCard({ provider, onChange }: { provider: ProviderInfo; onChange: () => void }) {
  const { dispatch } = useRuntime();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pill = statusPill(provider);

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.disconnectProvider(provider.id);
      onChange();
      dispatch({
        type: 'toast/push',
        toast: res.provider.configured
          ? { kind: 'info', title: `${provider.label} stored key removed`, body: 'An environment key is still present.' }
          : { kind: 'warn', title: `${provider.label} disconnected`, body: 'Runtime falls back to Demo mode.' },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.testProvider(provider.id);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Health check failed');
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="settings-card prov-card" aria-label={`${provider.label} provider`}>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">{provider.label}</span>
          <span className="settings-row-desc">
            {provider.configured
              ? `Key ${provider.source === 'env' ? 'from environment' : 'stored securely'}${provider.keyMasked ? ` (${provider.keyMasked})` : ''}`
              : 'No key configured'}
            {provider.lastVerifiedAt ? ` · verified ${relTime(provider.lastVerifiedAt)}` : ''}
          </span>
        </div>
        <span className={`pill sm ${pill.cls}`}>{pill.label}</span>
      </div>
      {(provider.lastError || error) && (
        <div className="settings-row">
          <span className="settings-row-desc" role="alert" style={{ color: 'var(--err)' }}>
            {error || provider.lastError} — check the key or try again later.
          </span>
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-desc">
            {provider.lastCheckedAt ? `Last checked ${relTime(provider.lastCheckedAt)}` : 'Never checked'}
            {provider.lastLatencyMs !== null && provider.lastLatencyMs !== undefined ? ` · ${fmtSec(provider.lastLatencyMs)}` : ''}
            {provider.modelCount !== null && provider.modelCount !== undefined ? ` · ${provider.modelCount} models` : ''}
          </span>
        </div>
        <div className="settings-row-controls">
          {provider.configured && (
            <button className="chip" aria-pressed="false" onClick={recheck} disabled={busy}>
              {busy ? 'Checking…' : 'Check health'}
            </button>
          )}
          {provider.configured && provider.source === 'stored' && (
            <button className="chip" aria-pressed="false" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          )}
          <button className="chip" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>
            {provider.configured && provider.source === 'stored' ? (expanded ? 'Hide key form' : 'Update key') : expanded ? 'Hide' : 'Connect'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="settings-row">
          <ConnectForm provider={provider} onDone={() => { setExpanded(false); onChange(); }} />
        </div>
      )}
    </article>
  );
}

/** Providers tab: connect / verify / disconnect + health. No secrets rendered. */
export function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getProviders()
      .then(({ providers: p, mode: m }) => { setProviders(p); setMode(m); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Backend unavailable'));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="settings-card" role="alert">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Backend unavailable</span>
            <span className="settings-row-desc">{error} — provider status is unknown, never assumed.</span>
          </div>
          <button className="icon-btn sm" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }
  if (!providers) {
    return (
      <div className="settings-card" role="status" aria-label="Loading providers">
        <div className="settings-row"><span className="settings-row-desc">Checking provider status…</span></div>
      </div>
    );
  }
  const anyLive = mode === 'live' && providers.some((p) => p.connected);
  return (
    <div className="prov-list">
      <div className={`banner ${anyLive ? 'info' : 'warn'}`} role="status" style={{ margin: '0 0 12px' }}>
        <span>
          {anyLive
            ? <>LIVE mode — real provider calls with your configured credentials.</>
            : <>Demo mode — connect a provider below to enable LIVE model execution. Keys stay server-side and encrypted.</>}
        </span>
      </div>
      {providers.length === 0 && <Empty what="Providers" hint="No supported providers reported by the backend." />}
      {providers.map((p) => <ProviderCard key={p.id} provider={p} onChange={load} />)}
    </div>
  );
}
