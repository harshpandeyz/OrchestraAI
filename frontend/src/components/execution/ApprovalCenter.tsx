import React from 'react';
import { useRuntime } from '../../state/store';
import { api } from '../../api/client';
import { Empty } from '../ui';
import type { ApprovalRecord, RuntimeSnapshot } from '../../types';

/**
 * Approval center (Session 3 approval queue). Reads the backend execution
 * view (snapshot.execution.pendingApprovals, legacy snap.approvals
 * fallback) — never invents approvals. Approve/Deny call the real
 * backend endpoints; single-use/expiry are enforced server-side and the
 * snapshot refresh reflects the outcome.
 *
 * Tool permissions below come from real data: registry status + the run's
 * tool policy (auto / readonly).
 */
export function ApprovalCenter({ snap }: { snap: RuntimeSnapshot | null }) {
  const { state } = useRuntime();
  const exec = snap?.execution || null;
  const fromExec: ApprovalRecord[] = exec?.pendingApprovals || [];
  const legacy: ApprovalRecord[] = snap?.approvals?.filter((a) => a.status === 'pending' || a.status === 'PENDING') || [];
  const pending = fromExec.length ? fromExec : legacy;
  const toolPolicy = snap?.meta?.toolPolicy || snap?.toolPolicy || 'auto';
  const tools = snap?.tools || state.server.tools;
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const decide = async (approval: ApprovalRecord, decision: 'approve' | 'deny') => {
    const runId = snap?.runId;
    if (!runId || !approval?.id || busy) return;
    setBusy(approval.id);
    setError(null);
    try {
      await api.decideApproval(runId, approval.id, decision);
      // Refresh the snapshot so the consumed approval disappears (the
      // server is the source of truth; we do not mutate locally).
      try {
        const s = await api.getState(runId);
        void s;
      } catch { /* snapshot refreshes on next poll/SSE */ }
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : String(e)).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  if (pending.length > 0) {
    return (
      <div className="oa-approvals">
        {exec?.waitingForApproval && <p className="oa-continue-note" role="status">Agent is waiting for approval — nothing executes until you decide.</p>}
        {error && <p className="oa-continue-note" role="alert">{error}</p>}
        {pending.map((a) => (
          <article key={a.id} className="oa-approval-card" aria-label={`Approval required: ${a.title || a.id}`}>
            <span className="oa-approval-badge">ACTION REQUIRES APPROVAL</span>
            <b>{a.title || a.actionType || a.tool || 'Pending action'}</b>
            {a.description && <p>{a.description}</p>}
            {a.detail && <p>{a.detail}</p>}
            {(a.riskLevel || a.risk) && <p className="meta">Risk: {a.riskLevel || a.risk}</p>}
            {a.reason && <p className="meta">Why: {a.reason}</p>}
            {Array.isArray(a.affectedResources) && a.affectedResources.length > 0 && (
              <p className="meta">Affects: {a.affectedResources.slice(0, 5).join(', ')}</p>
            )}
            {a.expiresAt && <p className="meta">Expires: {new Date(a.expiresAt).toLocaleString()}</p>}
            <div className="oa-outcome-actions">
              <button type="button" className="icon-btn sm primary" disabled={busy === a.id} onClick={() => void decide(a, 'approve')}>{busy === a.id ? 'Working…' : 'Approve this change'}</button>
              <button type="button" className="icon-btn sm danger" disabled={busy === a.id} onClick={() => void decide(a, 'deny')}>Deny</button>
            </div>
            <p className="oa-continue-note">Single-use and expires automatically — replaying an approval fails.</p>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="oa-approvals-empty">
      <Empty
        what="Approvals"
        hint="No pending approvals. Risky actions (file edits, git writes, deploys) appear here with full context and wait for your decision. Nothing is auto-approved."
      />
      <div className="oa-permissions" aria-label="Tool permissions">
        <span className="eyebrow">Tool permissions (observed)</span>
        <div className="oa-perm-grid">
          {(tools || []).slice(0, 8).map((t) => {
            const blocked = t.status !== 'enabled';
            const readonly = toolPolicy === 'readonly';
            const state = blocked ? 'blocked' : readonly ? 'approval' : 'allowed';
            return (
              <div key={t.name} className="oa-perm-row">
                <span className="oa-perm-name" title={t.description || t.name}>{t.name}</span>
                <span className={`pill sm ${state === 'allowed' ? 'ok' : state === 'approval' ? 'warn' : 'err'}`}>
                  {state === 'allowed' ? 'ALLOWED' : state === 'approval' ? 'READ-ONLY' : 'BLOCKED'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="oa-continue-note">
          Policy: {toolPolicy === 'readonly' ? 'Read-only — file edits and deploys are blocked.' : 'Auto — normal work within permissions.'} Change it in Settings → Runtime.
        </p>
      </div>
    </div>
  );
}
