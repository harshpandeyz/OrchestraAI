import React from 'react';
import { fmtTime, relTime, usd } from '../ui';
import { humanizeEvent } from '../../lib/semantics';
import { IconCheck, IconX } from '../icons';
import type { RuntimeSnapshot } from '../../types';

/**
 * Evidence view: proof of result from real snapshot state only.
 * Every item links back to its source (trace seq / tool / cost basis).
 * Categories with no backend data render as "not recorded", never as fake.
 */
export function EvidencePanel({ snap }: { snap: RuntimeSnapshot | null }) {
  if (!snap) return null;
  const tools = snap.tools.filter((t) => t.calls > 0);
  const failedTools = snap.trace.filter((t) => t.type === 'tool.failed');
  const toolFailedNames = [...new Set(failedTools.map((t) => t.label))].slice(0, 3);
  const changes = snap.changes.slice(-8).reverse();
  const decisions = snap.decisions.slice(-4).reverse();
  const compressions = snap.changes.filter((c) => /compress/i.test(c.label || ''));
  const cacheSaved = typeof snap.cache?.savedUsd === 'number' ? snap.cache.savedUsd : 0;
  const status = String(snap.status || '');

  return (
    <div className="oa-evidence">
      <div className="oa-ev-item">
        <span className="oa-ev-head"><b>Outcome</b><span className={`pill sm ${status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'neutral'}`}>{status.toUpperCase() || 'UNKNOWN'}</span></span>
        <span className="oa-ev-src">Source: run status · {snap.updatedAt ? fmtTime(snap.updatedAt) : 'unknown time'} · OBSERVED</span>
      </div>
      <div className="oa-ev-item">
        <span className="oa-ev-head"><b>Tools</b><span>{tools.length ? `${tools.reduce((a, t) => a + t.calls, 0)} calls observed` : 'No tool calls recorded'}</span></span>
        {tools.length > 0 ? (
          <ul className="oa-ev-list">
            {tools.slice(0, 5).map((t) => (
              <li key={t.name}><IconCheck size={12} /> {t.name} ×{t.calls} · {t.lastStatus || 'unknown'}</li>
            ))}
          </ul>
        ) : <span className="oa-ev-src">Not recorded for this run — nothing invented.</span>}
        {toolFailedNames.length > 0 && (
          <span className="oa-ev-src"><IconX size={11} /> Failures observed: {toolFailedNames.join(' · ').slice(0, 160)}</span>
        )}
      </div>
      <div className="oa-ev-item">
        <span className="oa-ev-head"><b>Changes</b><span>{changes.length ? `${snap.changes.length} runtime changes` : 'No changes recorded'}</span></span>
        {changes.length > 0 ? (
          <ul className="oa-ev-list">
            {changes.map((c) => (
              <li key={c.seq}>{c.label} <span className="oa-ev-src">seq {c.seq} · {relTime(c.ts)}</span></li>
            ))}
          </ul>
        ) : <span className="oa-ev-src">No file diffs are exposed by the backend yet — this panel will render them when Session 3 ships change payloads.</span>}
      </div>
      <div className="oa-ev-item">
        <span className="oa-ev-head"><b>Decisions</b><span>{decisions.length ? `${decisions.length} structured decisions` : 'No decisions recorded'}</span></span>
        {decisions.length > 0 ? (
          <ul className="oa-ev-list">
            {decisions.map((d, i) => {
              const h = humanizeEvent('', d.decision);
              void h;
              return <li key={i}>{String(d.decision).slice(0, 140)} <span className="oa-ev-src">{d.kind} · {relTime(d.timestamp)}</span></li>;
            })}
          </ul>
        ) : <span className="oa-ev-src">Routing and switch reasons appear here once recorded.</span>}
      </div>
      <div className="oa-ev-item">
        <span className="oa-ev-head"><b>Verification</b></span>
        <ul className="oa-ev-list">
          <li>Cost {usd(snap.cost?.spentUsd)} metered (usage × provider pricing) · OBSERVED</li>
          {compressions.length > 0 && <li>{compressions.length} context optimization{compressions.length === 1 ? '' : 's'} observed</li>}
          {cacheSaved > 0 && <li>Cache reuse saved {usd(cacheSaved)} · OBSERVED</li>}
          {compressions.length === 0 && !(cacheSaved > 0) && <li>No extra verification signals recorded for this run.</li>}
        </ul>
      </div>
    </div>
  );
}
