import React, { useState } from 'react';
import { useRuntime } from '../state/store';
import { IconChevronDown } from './icons';

export function Section({ id, title, children, defaultOpen, count, flashKey }: { id: string; title: string; children: React.ReactNode; defaultOpen?: boolean; count?: number | string; flashKey?: string | number }) {
  const { state, dispatch } = useRuntime();
  const open = state.ui.expanded[id] ?? defaultOpen ?? true;
  const [flash, setFlash] = useState<string | number | null>(null);
  const fk = flashKey !== undefined ? String(flashKey) : null;
  const isFlash = fk !== null && flash === fk;
  React.useEffect(() => { if (fk !== null) { setFlash(fk); const t = setTimeout(() => setFlash(null), 900); return () => clearTimeout(t); } }, [fk]);
  // Anchor id for inspector quick-nav
  return (
    <section className={`card${isFlash ? ' flash' : ''}`} aria-label={title} id={`sec-${id}`}>
      <h3>{title}{count !== undefined && count !== '' ? <span className="cnt">{count}</span> : null}<button aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`} aria-expanded={open} onClick={() => dispatch({ type: 'ui/toggle', key: id })}><span className={open ? 'sec-chev open' : 'sec-chev'} aria-hidden="true"><IconChevronDown size={14} /></span></button></h3>
      {open && <div>{children}</div>}
    </section>
  );
}

export function KV({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return <div className="kv" title={title}><span className="k">{k}</span><span className="v">{v}</span></div>;
}

export function StatusDot({ status }: { status: string }) {
  const s = String(status || '').toLowerCase();
  const cls = /healthy|idle|done|success|completed|warm|live|active|enabled|pass|hit|kept|current/.test(s) ? 'healthy'
    : /degraded|running|cooling|warn|planning|stale|reconnecting|compressed|pending|selected/.test(s) ? 'degraded'
    : /down|error|failed|cold|disconnected|exceeded|unavailable|miss|removed|rejected/.test(s) ? 'down' : 'idle';
  return <span className={`status-dot ${cls}`} aria-hidden="true" />;
}

export function usd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const neg = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a !== 0 && a < 0.001) return `${neg}$${a.toFixed(6)}`;
  return `${neg}$${a.toFixed(3)}`;
}

export function fmtInt(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtK(n: number | undefined | null, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return `${(n / 1000).toFixed(digits)}k`;
  return `${Math.round(n)}`;
}

export function fmtSec(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtPct(x: number | undefined | null, digits = 0): string {
  if (x === undefined || x === null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtTime(ts: string | undefined | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleTimeString('en-GB', opts || { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
}

export function Empty({ what, hint, action }: { what: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty" role="status">
      <b>{what} — no data</b>
      <span>{hint || 'Waiting for backend telemetry. Nothing is invented here.'}</span>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div aria-label="Loading" role="status">{Array.from({ length: lines }).map((_, i) => <div key={i} className="skel" style={{ width: `${92 - i * 9}%` }} />)}</div>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="copybtn" aria-label={label || 'Copy to clipboard'} title="Copy"
      onClick={async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch { /* clipboard unavailable */ } }}>
      {ok ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Meter({ value, max, label, hotAt = 0.8, critAt = 0.95 }: { value: number; max: number; label: string; hotAt?: number; critAt?: number }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const cls = pct >= critAt ? 'crit' : pct >= hotAt ? 'hot' : '';
  return (
    <div className="budget-wrap">
      <div className={`budget-bar ${cls}`} role="img" aria-label={label} title={label}><i style={{ width: `${pct * 100}%` }} /></div>
    </div>
  );
}

export function relTime(ts: string | undefined | null): string {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function elapsed(startTs: string | undefined | null, endTs?: string | null): string {
  if (!startTs) return '—';
  try {
    const end = endTs ? new Date(endTs).getTime() : Date.now();
    const ms = Math.max(0, end - new Date(startTs).getTime());
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  } catch { return '—'; }
}

export function statusPill(status: string | undefined | null): 'ok' | 'warn' | 'err' | 'info' | 'neutral' {
  const s = String(status || '').toLowerCase();
  if (/completed|success|done|healthy|warm|live|active|kept|hit|current/.test(s)) return 'ok';
  if (/failed|error|down|cold|exceeded|unavailable|rejected|removed|miss/.test(s)) return 'err';
  if (/running|planning|stale|cooling|compressed|pending|selected|waiting/.test(s)) return 'warn';
  if (/idle|cancelled/.test(s)) return 'neutral';
  return 'info';
}

export function shortId(id: string | undefined | null, head = 8): string {
  if (!id) return '—';
  return id.length > head + 4 ? `${id.slice(0, head)}…` : id;
}

// Display-only cleanup for snippets stored before the runtime summarized tool
// results (literal "\n" escapes from raw JSON). Server data is untouched.
export function displaySnippet(snippet: string | null | undefined): string {
  if (!snippet) return '';
  return String(snippet).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}
