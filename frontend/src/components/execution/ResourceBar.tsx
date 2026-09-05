import React from 'react';
import { elapsed, fmtK, fmtSec, usd } from '../ui';
import type { Run, RuntimeSnapshot } from '../../types';

/** Persistent but secondary resource summary: cost / time / tokens / tools. */
export function ResourceBar({ snap, run }: { snap: RuntimeSnapshot | null; run?: Pick<Run, 'createdAt'> | null }) {
  if (!snap) return null;
  const spent = typeof snap.cost?.spentUsd === 'number' ? snap.cost.spentUsd : null;
  const budget = typeof snap.cost?.budgetUsd === 'number' ? snap.cost.budgetUsd : null;
  const dur = run?.createdAt && snap.updatedAt ? elapsed(run.createdAt, snap.updatedAt) : null;
  const tokens = typeof snap.context?.usedTokens === 'number' ? fmtK(snap.context.usedTokens, 1) : null;
  const toolCalls = snap.tools.reduce((a, t) => a + (t.calls || 0), 0);
  const switches = snap.decisions.filter((d) => d.kind === 'model_switch').length;
  const latency = snap.latency?.totalMs ? fmtSec(snap.latency.totalMs) : null;
  // OBSERVED vs ESTIMATED: token counts are observed provider usage; cost is
  // metered only when provider pricing is known (see cost.source) and
  // estimated otherwise. Context tokens are plan estimates, never exact
  // tokenizer counts. Estimates render with a ~ prefix, never as facts.
  const costEstimated = typeof snap.cost?.source === 'string' && snap.cost.source.startsWith('estimated');
  return (
    <div className="oa-resources" role="status" aria-label="Run resources">
      {spent !== null && budget ? <span title={costEstimated ? `Spent ${usd(spent)} of ${usd(budget)} (estimated — provider pricing unknown)` : `Spent ${usd(spent)} of ${usd(budget)} (metered)`}>{costEstimated ? '~' : ''}{usd(spent)} / {usd(budget)}</span> : null}
      {dur && dur !== '—' && <span title="Elapsed time">{dur}</span>}
      {latency && latency !== '—' && <span title="Total runtime latency (observed)">{latency}</span>}
      {tokens && tokens !== '—' && <span title="Estimated context tokens from the prompt plan (not an exact tokenizer count)">~{tokens} tokens</span>}
      {toolCalls > 0 && <span title="Tool calls observed">{toolCalls} tool{toolCalls === 1 ? '' : 's'}</span>}
      {switches > 0 && <span title="Model switches observed">{switches} switch{switches === 1 ? '' : 'es'}</span>}
    </div>
  );
}
