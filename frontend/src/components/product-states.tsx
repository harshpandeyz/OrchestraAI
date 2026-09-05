// Shared honest-state banners. Every major page renders backend truth:
// loading → empty → degraded → error → unavailable → demo → no-provider.
// Nothing here invents zeroes; unknown stays unknown.
import React from 'react';

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span><b>Couldn&apos;t load this view.</b> {message}</span>
      {onRetry && <button className="o2-btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function DemoModeNote({ mode }: { mode: string | null | undefined }) {
  if (mode !== 'demo') return null;
  return (
    <div className="banner info" role="status">
      <span><b>Demo mode.</b> Labeled mock responses so you can explore offline — nothing here calls a real model. Connect a provider to enable LIVE.</span>
    </div>
  );
}

export function NoProviderNote({ onConnect }: { onConnect?: () => void }) {
  return (
    <div className="banner warn" role="status">
      <span><b>No provider connected.</b> Runs execute in Demo mode until a verified key is saved. Keys stay server-side and encrypted.</span>
      {onConnect && <button className="o2-btn" onClick={onConnect}>Connect provider</button>}
    </div>
  );
}

export function DegradedNote({ detail }: { detail?: string }) {
  return (
    <div className="banner warn" role="status">
      <span><b>Degraded.</b> {detail || 'Live updates are delayed — values below are the last saved state, not current.'}</span>
    </div>
  );
}

export function ReconciliationNote({ status }: { status: string | null | undefined }) {
  const s = String(status || 'not_invoice_reconciled');
  const reconciled = s === 'reconciled' || s === 'invoice_reconciled';
  return (
    <p className="recon-note" role="note">
      Reconciliation: <b>{reconciled ? 'Reconciled' : 'Not invoice-reconciled'}</b>
      {!reconciled && ' — modeled figures are not provider invoices and no automatic invoice matching runs in V1.'}
    </p>
  );
}
