// Shared economics language. The backend (SavingsEngine + immutable pricing
// snapshots) is authoritative — this module only labels backend values.
// It never computes provider prices, fees, or savings.
import React from 'react';

export const ECON_BASIS: { key: string; label: string; meaning: string }[] = [
  { key: 'estimated', label: 'Estimated', meaning: 'Projection before or during a run (e.g. projected cost). May move.' },
  { key: 'actual', label: 'Actual', meaning: 'Metered provider spend from observed usage. Paid to your provider directly.' },
  { key: 'modeled', label: 'Modeled', meaning: 'Counterfactual baseline vs actual from the SavingsEngine. An estimate, not an invoice.' },
  { key: 'verified', label: 'Verified', meaning: 'Modeled with complete usage + immutable pricing snapshots. Otherwise labeled insufficient or incomplete.' },
];

export function EconomicsLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className="econ-legend" role="note" aria-label="How to read cost numbers">
      <span className="econ-legend-title">How to read these numbers</span>
      <dl className={compact ? 'econ-basis compact' : 'econ-basis'}>
        {ECON_BASIS.map((b) => (
          <div key={b.key} className="econ-basis-row">
            <dt><span className={`pill sm neutral econ-${b.key}`}>{b.label}</span></dt>
            <dd>{b.meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="econ-legend-foot">Backend is authoritative — this UI never prices providers, applies fees, or reconciles invoices.</p>
    </div>
  );
}

export function CostBasisBadge({ basis, title }: { basis: 'estimated' | 'actual' | 'modeled' | 'verified' | 'insufficient' | 'incomplete'; title?: string }) {
  const label =
    basis === 'estimated' ? 'ESTIMATED' :
    basis === 'actual' ? 'ACTUAL' :
    basis === 'modeled' ? 'MODELED' :
    basis === 'verified' ? 'VERIFIED' :
    basis === 'insufficient' ? 'INSUFFICIENT DATA' : 'INCOMPLETE';
  const cls = basis === 'verified' || basis === 'actual' ? 'ok' : basis === 'modeled' || basis === 'estimated' ? 'info' : 'neutral';
  return <span className={`pill sm ${cls}`} title={title || label}>{label}</span>;
}
