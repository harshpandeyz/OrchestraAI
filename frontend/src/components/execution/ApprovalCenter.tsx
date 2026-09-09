// Approval UX V2 — WHAT/WHY/RISK/IMPACT/EVIDENCE/ROLLBACK + scoped approve.
// Backend enforces single-use/expiry; scope (once/run/project) is recorded
// as request intent and labelled honestly. High-risk requires an explicit
// confirm step so it is hard to approve accidentally. Edit is disabled —
// the backend exposes no approval-edit endpoint.
import React from 'react';
import { useRuntime } from '../../state/store';
import { api } from '../../api/client';
import { Empty } from '../ui';
import { Status } from '../v2/cards';
import type { ApprovalRecord, RuntimeSnapshot } from '../../types';

type Scope = 'once' | 'run' | 'project';

function riskOf(a: ApprovalRecord): 'high' | 'medium' | 'low' {
  const r = String(a.riskLevel || a.risk || '').toLowerCase();
  if (r.includes('high') || r.includes('crit')) return 'high';
  if (r.includes('med') || r.includes('mod')) return 'medium';
  return 'low';
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ margin: '4px 0' }}>
      <span className="v2-eyebrow">{label}</span>
      <div style={{ fontSize: 13 }}>{value}</div>
    </div>
  );
}

function ApprovalCard({ snap, approval }: { snap: RuntimeSnapshot; approval: ApprovalRecord }) {
  const [scope, setScope] = React.useState<Scope>('once');
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const risk = riskOf(approval);
  const needsConfirm = risk === 'high' && !confirmed;

  const decide = async (decision: 'approve' | 'deny') => {
    if (busy || (decision === 'approve' && needsConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(snap.runId, approval.id, decision);
      try { await api.getState(snap.runId); } catch { /* SSE refreshes */ }
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : String(e)).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="v2-decision" data-high-risk={risk === 'high' ? 'true' : 'false'} aria-label={`Approval required: ${approval.title || approval.id}`}>
      <div className="v2-decision-top">
        <b>{approval.title || approval.actionType || approval.tool || 'Pending action'}</b>
        <Status status={risk === 'high' ? 'blocked' : risk === 'medium' ? 'waiting' : 'verified'} label={`${risk.toUpperCase()} RISK`} />
      </div>
      <Field label="What" value={approval.description || approval.detail || approval.actionType || 'Unknown — the backend did not describe this action.'} />
      <Field label="Why" value={approval.reason || 'Unknown — no reason recorded.'} />
      <Field label="Risk" value={`${risk.toUpperCase()}${approval.riskLevel || approval.risk ? ` · ${approval.riskLevel || approval.risk}` : ''}`} />
      <Field label="Impact" value={Array.isArray(approval.affectedResources) && approval.affectedResources.length ? approval.affectedResources.slice(0, 5).join(', ') : 'Unknown — no affected resources listed.'} />
      <Field label="Evidence" value={<span className="v2-meta">Tool {approval.tool || approval.actionType || 'unknown'} · requested {approval.expiresAt ? `expires ${new Date(approval.expiresAt).toLocaleString()}` : 'no expiry listed'} · single-use, server-enforced</span>} />
      <Field label="Rollback" value={<span className="v2-meta">Deny to refuse safely. Applied changes roll back via the changesets surface where the backend supports it.</span>} />

      <fieldset style={{ border: '1px solid var(--border-soft)', borderRadius: 10, marginTop: 8 }}>
        <legend className="v2-meta">Approval scope (request intent — backend enforces single-use)</legend>
        {(['once', 'run', 'project'] as Scope[]).map((s) => (
          <label key={s} style={{ display: 'inline-flex', gap: 6, marginRight: 12, fontSize: 13 }}>
            <input type="radio" name={`scope-${approval.id}`} checked={scope === s} onChange={() => setScope(s)} />
            {s === 'once' ? 'Approve once' : s === 'run' ? 'Approve for run' : 'Approve for project'}
          </label>
        ))}
      </fieldset>

      {risk === 'high' && (
        <label style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 13, fontWeight: 700 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-label="Confirm high-risk approval" />
          I understand this is high-risk and hard to undo
        </label>
      )}

      {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="o2-btn primary" disabled={busy || needsConfirm} onClick={() => void decide('approve')} aria-label={needsConfirm ? 'Confirm the risk checkbox to approve' : `Approve ${scope === 'once' ? 'once' : scope === 'run' ? 'for this run' : 'for this project'}`}>
          {busy ? 'Working…' : scope === 'once' ? 'Approve once' : scope === 'run' ? 'Approve for run' : 'Approve for project'}
        </button>
        <button type="button" className="o2-btn danger" disabled={busy} onClick={() => void decide('deny')}>Reject</button>
        <button type="button" className="o2-btn" disabled={busy} title={note ? undefined : 'Add a note, then request changes (records a deny with context)'} onClick={() => void decide('deny')}>Request changes</button>
        <button type="button" className="o2-btn" disabled title="Edit is not exposed by the backend — deny and re-request instead">Edit</button>
      </div>
      <input className="mini-search" style={{ marginTop: 8 }} placeholder="Note for request-changes (optional)…" aria-label="Change request note" value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="v2-meta">Single-use and expires automatically — replaying an approval fails server-side.</p>
    </article>
  );
}

export function ApprovalCenter({ snap }: { snap: RuntimeSnapshot | null }) {
  const { state } = useRuntime();
  const exec = snap?.execution || null;
  const fromExec: ApprovalRecord[] = exec?.pendingApprovals || [];
  const legacy: ApprovalRecord[] = snap?.approvals?.filter((a) => a.status === 'pending' || a.status === 'PENDING') || [];
  const pending = fromExec.length ? fromExec : legacy;
  const toolPolicy = snap?.meta?.toolPolicy || snap?.toolPolicy || 'auto';
  const tools = snap?.tools || state.server.tools;

  if (pending.length > 0) {
    return (
      <div className="oa-approvals" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {exec?.waitingForApproval && <p className="oa-continue-note" role="status">Agent is waiting for approval — nothing executes until you decide.</p>}
        {pending.map((a) => <ApprovalCard key={a.id} snap={snap!} approval={a} />)}
      </div>
    );
  }

  return (
    <div className="oa-approvals-empty">
      <Empty what="Approvals" hint="No pending approvals. Risky actions (file edits, git writes, deploys) appear here with full context and wait for your decision. Nothing is auto-approved." />
      <div className="oa-permissions" aria-label="Tool permissions">
        <span className="eyebrow">Tool permissions (observed)</span>
        <div className="oa-perm-grid">
          {(tools || []).slice(0, 8).map((t) => {
            const blocked = t.status !== 'enabled';
            const readonly = toolPolicy === 'readonly';
            const perm = blocked ? 'blocked' : readonly ? 'approval' : 'allowed';
            return (
              <div key={t.name} className="oa-perm-row">
                <span className="oa-perm-name" title={t.description || t.name}>{t.name}</span>
                <span className={`pill sm ${perm === 'allowed' ? 'ok' : perm === 'approval' ? 'warn' : 'err'}`}>
                  {perm === 'allowed' ? 'ALLOWED' : perm === 'approval' ? 'READ-ONLY' : 'BLOCKED'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="oa-continue-note">Policy: {toolPolicy === 'readonly' ? 'Read-only — file edits and deploys are blocked.' : 'Auto — normal work within permissions.'} Change it in Settings → Runtime.</p>
      </div>
    </div>
  );
}
