// V2 shared primitives: Status, Metric, DecisionCard, RiskCard,
// CostWaterfall, ContextComposition, WhyPopover. All honest: Unknown stays
// Unknown, never invented. Uses semantic tokens from styles/tokens.css.
import React, { useEffect, useRef, useState } from 'react';
import './v2.css';
import { usd } from '../ui';
import type { Decision } from '../../types';

export type ExecTone = 'running' | 'waiting' | 'blocked' | 'failed' | 'verified' | 'unknown' | 'neutral' | 'ok' | 'warn' | 'err' | 'info';

export function mapStatusToTone(status: string | null | undefined): ExecTone {
  const s = String(status || '').toLowerCase();
  if (['running', 'planning', 'executing'].includes(s)) return 'running';
  if (['waiting', 'waiting_for_tool', 'paused'].includes(s)) return 'waiting';
  if (['blocked', 'recovery_blocked'].includes(s)) return 'blocked';
  if (['failed', 'error', 'down', 'unavailable'].includes(s)) return 'failed';
  if (['verified', 'completed', 'success', 'healthy', 'passed'].includes(s)) return 'verified';
  if (['degraded', 'stale', 'pending', 'selected'].includes(s)) return 'waiting';
  return 'unknown';
}

export function Status({ status, label }: { status: string | null | undefined; label?: string }) {
  const tone = mapStatusToTone(status);
  const text = label || (status ? String(status).toUpperCase() : 'UNKNOWN');
  return (
    <span className="v2-status" data-tone={tone} role="status" aria-label={`Status ${text}`}>
      <span className="v2-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function Metric({ label, value, sub, mono }: { label: string; value: React.ReactNode; sub?: string; mono?: boolean }) {
  return (
    <div className="v2-metric">
      <span className="v2-m-label">{label}</span>
      <span className="v2-m-value" style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 15 } : undefined}>{value}</span>
      {sub && <span className="v2-m-sub">{sub}</span>}
    </div>
  );
}

/** Reusable decision card — actual backend values only, Unknown otherwise. */
export function DecisionCard({ title, decision, selectedLabel, scores, why, alternatives, highRisk }: {
  title?: string;
  decision: Decision | null | undefined;
  selectedLabel?: string;
  scores?: { label: string; value: string }[];
  why?: string[];
  alternatives?: { id: string; note?: string }[];
  highRisk?: boolean;
}) {
  if (!decision) {
    return (
      <div className="v2-decision" data-high-risk={highRisk ? 'true' : 'false'}>
        <div className="v2-decision-top"><b>{title || 'Decision'}</b><Status status="unknown" label="UNKNOWN" /></div>
        <p className="v2-meta">No decision recorded yet — appears after the first routing evaluation. Nothing is inferred.</p>
      </div>
    );
  }
  const factors = Array.isArray(decision.factors) ? decision.factors : [];
  return (
    <div className="v2-decision" data-high-risk={highRisk ? 'true' : 'false'}>
      <div className="v2-decision-top">
        <b>{selectedLabel || String(decision.decision).slice(0, 80)}</b>
        <Status status="verified" label="RECORDED" />
      </div>
      {scores && scores.length > 0 && (
        <div className="v2-decision-scores">
          {scores.map((s) => (
            <div key={s.label} className="v2-decision-score"><div className="l">{s.label}</div><div className="n">{s.value}</div></div>
          ))}
        </div>
      )}
      {(why && why.length > 0) || factors.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div className="v2-eyebrow">Why</div>
          {(why || []).map((w, i) => <div key={i} className="v2-factor"><span className="mk pass" aria-hidden="true">✓</span><span>{w}</span></div>)}
          {factors.slice(0, 5).map((f) => (
            <div key={f.key} className="v2-factor">
              <span className={`mk ${f.status}`} aria-hidden="true">{f.status === 'pass' ? '✓' : f.status === 'warn' ? '!' : '✕'}</span>
              <span>{f.label}{f.detail ? <span className="v2-meta"> — {f.detail}</span> : null}</span>
            </div>
          ))}
        </div>
      ) : null}
      {alternatives && alternatives.length > 0 && (
        <div className="v2-alts">
          <span className="v2-eyebrow">Alternatives</span>
          {alternatives.slice(0, 4).map((a) => <span key={a.id}>{a.id}{a.note ? ` — ${a.note}` : ''}</span>)}
        </div>
      )}
      <div className="v2-meta" style={{ marginTop: 6 }}>{decision.kind} · {decision.timestamp ? new Date(decision.timestamp).toLocaleString() : 'unknown time'}</div>
    </div>
  );
}

/** Risk card — high-risk visually dominates. Unknown when backend has none. */
export function RiskCard({ filesAffected, externalActions, irreversible, approvalRequired, level }: {
  filesAffected?: number | null;
  externalActions?: number | null;
  irreversible?: number | null;
  approvalRequired?: boolean | null;
  level?: string | null;
}) {
  const unknown = filesAffected == null && externalActions == null && irreversible == null && approvalRequired == null && !level;
  const lv = String(level || (irreversible && irreversible > 0 ? 'high' : externalActions && externalActions > 0 ? 'medium' : 'low')).toLowerCase();
  const data = lv.includes('high') ? 'high' : lv.includes('med') ? 'medium' : 'low';
  if (unknown) {
    return (
      <div className="v2-risk" data-level="low">
        <div className="v2-decision-top"><b>Risk</b><Status status="unknown" label="UNKNOWN" /></div>
        <p className="v2-meta">No risk metadata exposed by the backend for this run yet.</p>
      </div>
    );
  }
  return (
    <div className="v2-risk" data-level={data} role={data === 'high' ? 'alert' : 'status'} aria-label={`Risk ${data}`}>
      <div className="v2-decision-top"><b>Risk</b><Status status={data === 'high' ? 'blocked' : data === 'medium' ? 'waiting' : 'verified'} label={data.toUpperCase()} /></div>
      <div className="v2-risk-grid">
        <div className="v2-risk-cell"><div className="l">Files affected</div><div className="n">{filesAffected ?? '—'}</div></div>
        <div className="v2-risk-cell"><div className="l">External actions</div><div className="n">{externalActions ?? '—'}</div></div>
        <div className="v2-risk-cell"><div className="l">Irreversible</div><div className="n">{irreversible ?? '—'}</div></div>
        <div className="v2-risk-cell"><div className="l">Approval</div><div className="n">{approvalRequired == null ? '—' : approvalRequired ? 'Required' : 'No'}</div></div>
      </div>
    </div>
  );
}

/** Compact cost waterfall from real breakdown rows only. */
export function CostWaterfall({ rows, total, budget, remaining }: {
  rows: { key: string; label: string; usd: number }[];
  total?: number | null;
  budget?: number | null;
  remaining?: number | null;
}) {
  if (!rows.length) {
    return (
      <div className="v2-decision">
        <div className="v2-decision-top"><b>Cost</b><Status status="unknown" label="UNKNOWN" /></div>
        <p className="v2-meta">No cost breakdown recorded yet.</p>
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.usd || 0)), 1e-9);
  return (
    <div className="v2-decision">
      <div className="v2-decision-top"><b>Cost</b>{total != null ? <span className="v2-m-value v2-mono">{usd(total)}</span> : null}</div>
      <div className="v2-waterfall">
        {rows.map((r) => (
          <div key={r.key} className="v2-wf-row">
            <span className="k" title={r.label}>{r.label}</span>
            <span className="v2-wf-bar" role="img" aria-label={`${r.label} ${usd(r.usd)}`}><i style={{ width: `${(Math.abs(r.usd || 0) / max) * 100}%` }} /></span>
            <span className="v">{usd(r.usd)}</span>
          </div>
        ))}
      </div>
      {(budget != null || remaining != null) && (
        <div className="v2-meta" style={{ marginTop: 8 }}>
          {budget != null ? <>Budget {usd(budget)}</> : null}{budget != null && remaining != null ? ' · ' : ''}{remaining != null ? <>Remaining {usd(remaining)}</> : null}
        </div>
      )}
    </div>
  );
}

const SEG_COLORS = ['var(--primary)', 'var(--secondary)', 'var(--selection)', 'var(--warning)', 'var(--success)', 'var(--text-faint)', 'var(--info)'];

/** Visual context composition with drill-down where items exist. */
export function ContextComposition({ segments, items }: {
  segments: { key: string; label: string; tokensPct: number }[];
  items?: { id: string; kind: string; title: string; tokens: number; relevance: number; status: string }[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!segments.length) {
    return (
      <div className="v2-decision">
        <div className="v2-decision-top"><b>Context</b><Status status="unknown" label="UNKNOWN" /></div>
        <p className="v2-meta">No context composition reported yet.</p>
      </div>
    );
  }
  return (
    <div className="v2-decision">
      <div className="v2-decision-top"><b>Context</b></div>
      <div className="v2-ctx-seg" role="img" aria-label={segments.map((s) => `${s.label} ${(s.tokensPct * 100).toFixed(0)} percent`).join(', ')}>
        {segments.map((s, i) => <i key={s.key} style={{ width: `${Math.max(1, s.tokensPct * 100)}%`, background: SEG_COLORS[i % SEG_COLORS.length] }} title={`${s.label} ${(s.tokensPct * 100).toFixed(1)}%`} />)}
      </div>
      <div className="v2-ctx-legend">
        {segments.map((s) => (
          <React.Fragment key={s.key}>
            <button type="button" className="link-btn" style={{ textAlign: 'left', padding: 0 }} onClick={() => setOpen((v) => (v === s.key ? null : s.key))} aria-expanded={open === s.key}>{s.label}</button>
            <b>{(s.tokensPct * 100).toFixed(0)}%</b>
          </React.Fragment>
        ))}
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {!(items || []).length ? (
            <p className="v2-meta">No per-source items recorded for this segment.</p>
          ) : (
            (items || []).slice(0, 8).map((it) => (
              <div key={it.id} className="v2-factor"><span className="mk pass" aria-hidden="true">·</span><span>{it.title} <span className="v2-meta">· {it.tokens} tok · {(it.relevance * 100).toFixed(0)}% relevant · {it.status}</span></span></div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Universal Why interaction: popover for data, tooltip for meaning. */
export function WhyPopover({ label, title, lines, meta }: {
  label?: string;
  title: string;
  lines: string[];
  meta?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDoc);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDoc); };
  }, [open ]);
  return (
    <span className="v2-why-pop" ref={ref}>
      <button type="button" className="v2-why-btn" aria-expanded={open} aria-label={`Why? ${title}`} title={title} onClick={() => setOpen((v) => !v)}>
        {label || 'Why?'}
      </button>
      {open && (
        <span className="v2-why-card" role="dialog" aria-label={title}>
          <h4>{title}</h4>
          {lines.length ? lines.slice(0, 6).map((l, i) => <div key={i} style={{ margin: '3px 0' }}>• {l}</div>) : <div className="v2-meta">Unknown — the backend did not record a reason.</div>}
          {meta && <div className="v2-meta" style={{ marginTop: 6 }}>{meta}</div>}
        </span>
      )}
    </span>
  );
}
