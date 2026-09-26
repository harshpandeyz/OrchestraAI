// Diff experience: file tree + diff + why/agent/tests/risk + actions.
// Accept/Reject call the real apply/rollback endpoints (approval-gated
// applies surface the approval need honestly). Ask agent focuses composer.
import React from 'react';
import { api } from '../../api/client';
import { useRuntime } from '../../state/store';
import { Status } from '../v2/cards';
import type { ChangeSetView, RuntimeSnapshot } from '../../types';

export function DiffViewer({ snap, changeset }: { snap: RuntimeSnapshot; changeset: ChangeSetView }) {
  const { dispatch } = useRuntime();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const files = (changeset.files || []).map((f) => (typeof f === 'string' ? f : f.path));
  const [selectedFile, setSelectedFile] = React.useState<string | null>(files[0] || null);
  const why = snap.decisions.slice(-1)[0];
  const tests = [...(snap.execution?.verifications || []), ...(snap.execution?.tests || [])].slice(0, 3);
  const agent = snap.activeModelId ? String(snap.activeModelId).split('/').pop() : 'Unknown agent';

  const act = async (kind: 'apply' | 'rollback') => {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === 'apply') {
        const r = await api.applyChangeset(snap.runId, changeset.id);
        if (r.needsApproval) setMsg(`Approval required before apply (approval ${String(r.approvalId || '').slice(0, 8)}…). Decide in Approvals, then retry.`);
        else setMsg('Changeset applied.');
      } else {
        const r = await api.rollbackChangeset(snap.runId, changeset.id);
        setMsg(r.ok ? 'Changeset rolled back.' : `Rollback failed: ${r.error || 'unknown'}`);
      }
      try { await api.getState(snap.runId); } catch { /* SSE refreshes */ }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="v2-decision" aria-label={`Changeset ${changeset.id}`}>
      <div className="v2-decision-top">
        <b title={changeset.id}>Changeset {changeset.id.slice(0, 12)}…</b>
        <Status status={changeset.status || 'unknown'} />
        <span className="v2-meta">+{changeset.additions || 0}/−{changeset.deletions || 0}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, marginTop: 8 }}>
        <div role="tree" aria-label="Changed files">
          <div className="v2-eyebrow">Files ({files.length})</div>
          {files.length === 0 && <p className="v2-meta">No file list recorded.</p>}
          {files.slice(0, 30).map((f) => (
            <button key={f} type="button" role="treeitem" aria-selected={selectedFile === f} onClick={() => setSelectedFile(f)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: selectedFile === f ? 'var(--primary-soft)' : 'none', border: 0, padding: '4px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>
              {f}
            </button>
          ))}
        </div>
        <div>
          <div className="v2-eyebrow">Diff · {selectedFile || 'no file selected'}</div>
          <pre className="o2-raw">{selectedFile ? `--- a/${selectedFile}\n+++ b/${selectedFile}\n@@ changes proposed by ${agent} @@\n(Inline hunks render when the backend ships them — file identity above is real.)` : 'Select a file.'}</pre>
          <div className="v2-eyebrow" style={{ marginTop: 8 }}>Why changed</div>
          <p style={{ fontSize: 13 }}>{why ? String(why.decision).slice(0, 200) : 'Unknown — no decision recorded.'}</p>
          <p className="v2-meta">Agent {agent} · Tests {tests.length ? tests.map((t) => `${t.passed ? '✓' : '✕'} ${t.summary.slice(0, 60)}`).join(' · ') : 'not recorded'} · Risk {changeset.status === 'applied' ? 'applied' : 'pending review'}</p>
        </div>
      </div>
      {msg && <p role="status" className="v2-meta" style={{ marginTop: 8 }}>{msg}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="o2-btn primary" disabled={busy !== null} onClick={() => void act('apply')}>{busy === 'apply' ? 'Applying…' : 'Accept'}</button>
        <button type="button" className="o2-btn danger" disabled={busy !== null} onClick={() => void act('rollback')}>{busy === 'rollback' ? 'Rolling back…' : 'Reject'}</button>
        <button type="button" className="o2-btn" onClick={() => dispatch({ type: 'ui/set', patch: { view: 'run' } })}>Open</button>
        <button type="button" className="o2-btn" onClick={() => { dispatch({ type: 'ui/set', patch: { view: 'run' } }); setTimeout(() => (document.getElementById('prompt') as HTMLTextAreaElement | null)?.focus(), 60); }}>Ask agent</button>
      </div>
    </div>
  );
}
