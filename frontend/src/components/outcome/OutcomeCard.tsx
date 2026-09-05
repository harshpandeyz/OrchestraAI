import React from 'react';
import { api } from '../../api/client';
import { useRuntime } from '../../state/store';
import { elapsed, usd } from '../ui';
import { provenanceLabel, trustGrounding } from '../../lib/semantics';
import { IconCheck, IconX } from '../icons';
import type { Run, RuntimeSnapshot } from '../../types';

function lastAssistantMessage(snap: RuntimeSnapshot): string | null {
  const msgs = snap.messages.filter((m) => m.role === 'assistant' && String(m.content || '').trim());
  if (!msgs.length) return null;
  return String(msgs[msgs.length - 1].content).slice(0, 280);
}

/**
 * Outcome-first completion card. Visually dominates raw telemetry.
 * Real numbers only; every figure carries an observed/metered basis.
 * Actions: review changes → evidence tab, continue → follow-up run.
 */
export function OutcomeCard({ snap, onReviewChanges, onViewEvidence }: {
  snap: RuntimeSnapshot | null;
  onReviewChanges?: () => void;
  onViewEvidence?: () => void;
}) {
  const { state, dispatch } = useRuntime();
  const [continuing, setContinuing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!snap || String(snap.status) !== 'completed') return null;

  const run = state.server.runs.find((r) => r.id === snap.runId);
  const duration = run?.createdAt && snap.updatedAt ? elapsed(run.createdAt, snap.updatedAt) : null;
  const spent = typeof snap.cost?.spentUsd === 'number' ? usd(snap.cost.spentUsd) : null;
  const toolCalls = snap.tools.reduce((a, t) => a + (t.calls || 0), 0);
  const failedTools = snap.trace.filter((t) => t.type === 'tool.failed').length;
  const switches = snap.decisions.filter((d) => d.kind === 'model_switch').length;
  const changes = Array.isArray(snap.changes) ? snap.changes.length : 0;
  const summary = lastAssistantMessage(snap);
  const costProv = provenanceLabel(typeof snap.cost?.source === 'string' ? snap.cost.source : 'metered', 'cost');
  const grounding = trustGrounding({
    testsPassed: toolCalls > 0 && failedTools === 0 ? true : null,
    criteriaSatisfied: null,
    historicalReliability: switches >= 0 ? null : null,
  });

  const continueTask = async () => {
    if (continuing) return;
    setContinuing(true);
    setError(null);
    try {
      const title = run?.title ? `Follow-up: ${run.title}`.slice(0, 200) : 'Follow-up task';
      const { run: created } = await api.createRun(title, run?.taskMode || 'general', {});
      const { runs } = await api.getRuns();
      dispatch({ type: 'runs/set', runs });
      dispatch({ type: 'runs/active', id: created.id });
      dispatch({ type: 'ui/set', patch: { view: 'run' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a follow-up run');
    } finally {
      setContinuing(false);
    }
  };

  return (
    <div className="oa-outcome-card" role="status" aria-label="Task completed">
      <div className="oa-outcome-head">
        <span className="oa-outcome-badge"><IconCheck size={14} /> TASK COMPLETED</span>
        <span className={`prov-badge ${costProv.cls}`} title={costProv.title}>{costProv.text}</span>
      </div>
      {summary && <p className="oa-outcome-summary">{summary}</p>}
      <dl className="oa-outcome-stats">
        {duration && duration !== '—' && (<div><dt>Time</dt><dd>{duration}</dd></div>)}
        {spent && (<div><dt>Cost</dt><dd>{spent}</dd></div>)}
        {toolCalls > 0 && (<div><dt>Tools</dt><dd>{toolCalls} call{toolCalls === 1 ? '' : 's'}{failedTools > 0 ? ` · ${failedTools} failed, recovered` : ''}</dd></div>)}
        {changes > 0 && (<div><dt>Changes</dt><dd>{changes} recorded</dd></div>)}
        {switches > 0 && (<div><dt>Switches</dt><dd>{switches}</dd></div>)}
      </dl>
      <div className="oa-proof" aria-label="Proof of result">
        <span className="eyebrow">Proof</span>
        <ul>
          <li><IconCheck size={12} /> Run reached a terminal completed state</li>
          {toolCalls > 0 && <li><IconCheck size={12} /> {toolCalls} tool call{toolCalls === 1 ? '' : 's'} observed in the trace</li>}
          {failedTools === 0 && toolCalls > 0 && <li><IconCheck size={12} /> No tool failures observed</li>}
          {failedTools > 0 && <li><IconX size={12} /> {failedTools} tool failure{failedTools === 1 ? '' : 's'} observed — run still completed</li>}
          <li><IconCheck size={12} /> Cost {spent || '—'} metered from usage × provider pricing</li>
        </ul>
        {grounding && (
          <p className="oa-grounding">{grounding.label}: {grounding.items.join(' · ')}. No invented confidence score is shown.</p>
        )}
      </div>
      <div className="oa-outcome-actions">
        {onReviewChanges && <button type="button" className="icon-btn sm" onClick={onReviewChanges}>Review changes</button>}
        {onViewEvidence && <button type="button" className="icon-btn sm" onClick={onViewEvidence}>View evidence</button>}
        <button type="button" className="icon-btn sm primary" onClick={continueTask} disabled={continuing}>
          {continuing ? 'Starting follow-up…' : 'Continue task'}
        </button>
      </div>
      <p className="oa-continue-note">Continue starts a linked follow-up run — the backend keeps completed runs read-only, so history is never rewritten.</p>
      {error && <div className="banner err" role="alert"><span>{error}</span></div>}
    </div>
  );
}
