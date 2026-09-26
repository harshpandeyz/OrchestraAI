// Run Studio — the heart of OrchestraAI. Goal → Plan → Execution →
// Artifacts → Verification → Evidence. Chat is one Activity tab, not the
// whole product. All tabs derive from RuntimeSnapshot; missing data renders
// as Unknown/empty, never invented.
import React, { useMemo, useState } from 'react';
import type { ChatMessage, RuntimeSnapshot, Run } from '../../types';
import { ExecutionGraph, snapshotToGraph } from './ExecutionGraph';
import { ExecutionTimeline } from '../execution/ExecutionTimeline';
import { EvidencePanel } from '../outcome/EvidencePanel';
import { ArtifactList } from '../execution/ArtifactsViewer';
import { DiffViewer } from '../execution/DiffViewer';
import { ResultPanel } from '../Center';
import { MessageList } from '../Center';
import { Status } from '../v2/cards';
import { DataTable } from '../v2/table';
import { usd, relTime } from '../ui';

type Tab = 'goal' | 'plan' | 'execution' | 'artifacts' | 'verification' | 'evidence' | 'activity';

const TABS: { id: Tab; label: string }[] = [
  { id: 'goal', label: 'Goal' },
  { id: 'plan', label: 'Plan' },
  { id: 'execution', label: 'Execution' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'verification', label: 'Verification' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'activity', label: 'Activity' },
];

export function ExecutionWaterfall({ snap }: { snap: RuntimeSnapshot }) {
  const rows = (snap.trace || []).filter((t) => typeof t.durationMs === 'number' && (t.durationMs as number) > 0).slice(-12);
  if (!rows.length) {
    const tools = (snap.tools || []).filter((t) => t.calls > 0).slice(0, 6);
    if (!tools.length) return null;
    const max = Math.max(...tools.map((t) => t.avgLatencyMs || 0), 1);
    return (
      <div style={{ marginTop: 12 }} aria-label="Agent waterfall">
        <div className="v2-eyebrow">Agent waterfall · average latencies (observed)</div>
        <div className="v2-waterfall">
          {tools.map((t) => (
            <div key={t.name} className="v2-wf-row">
              <span className="k" title={t.description || t.name}>{t.name.slice(0, 18)}</span>
              <span className="v2-wf-bar" role="img" aria-label={`${t.name} average ${(t.avgLatencyMs / 1000).toFixed(1)} seconds`}><i style={{ width: `${((t.avgLatencyMs || 0) / max) * 100}%` }} /></span>
              <span className="v">{(t.avgLatencyMs / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const max = Math.max(...rows.map((t) => t.durationMs as number), 1);
  return (
    <div style={{ marginTop: 12 }} aria-label="Execution waterfall">
      <div className="v2-eyebrow">Execution waterfall · observed step durations</div>
      <div className="v2-waterfall">
        {rows.map((t) => (
          <div key={t.seq} className="v2-wf-row">
            <span className="k" title={t.label}>{t.label.slice(0, 18)}</span>
            <span className="v2-wf-bar" role="img" aria-label={`${t.label} ${((t.durationMs as number) / 1000).toFixed(1)} seconds`}><i style={{ width: `${((t.durationMs as number) / max) * 100}%` }} /></span>
            <span className="v">{((t.durationMs as number) / 1000).toFixed(1)}s</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function verificationState(snap: RuntimeSnapshot): 'verified' | 'partial' | 'claimed' | 'failed' | 'unknown' {  const status = String(snap.status || '');
  if (status === 'failed') return 'failed';
  const verifs = snap.execution?.verifications || [];
  const tests = snap.execution?.tests || [];
  const passed = [...verifs, ...tests].filter((v) => v.passed);
  const total = [...verifs, ...tests].length;
  const traceVerified = snap.trace.some((t) => t.type === 'verification.passed');
  if (status === 'completed' && (passed.length > 0 || traceVerified)) return total > 0 && passed.length < total ? 'partial' : 'verified';
  if (status === 'completed') return 'claimed';
  return 'unknown';
}

export function RunStudio({ snap, run, messages, defaultTab }: {
  snap: RuntimeSnapshot;
  run?: Run | null;
  messages: ChatMessage[];
  defaultTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(defaultTab || 'execution');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const graph = useMemo(() => snapshotToGraph(snap), [snap]);
  const selected = graph.find((g) => g.id === selectedNode) || null;

  const goal = useMemo(() => {
    const firstUser = messages.find((m) => m.role === 'user');
    return { title: run?.title || 'Untitled goal', ask: firstUser?.content || null, mode: run?.taskMode || 'general', budget: run?.budget ?? snap.cost.budgetUsd };
  }, [messages, run, snap]);

  const artifacts = snap.execution?.artifacts || [];
  const files = snap.execution?.files || [];
  const changesets = snap.execution?.changesets || [];
  const verifs = [...(snap.execution?.verifications || []), ...(snap.execution?.tests || [])];
  const vState = verificationState(snap);

  return (
    <section aria-label="Run studio" style={{ maxWidth: 860, width: '100%', margin: '0 auto', padding: '0 32px' }}>
      {(String(snap.status) === 'completed' || String(snap.status) === 'failed') && <ResultPanel snap={snap} />}
      <div className="inspector-nav" role="tablist" aria-label="Run studio tabs" style={{ position: 'static', padding: '12px 0' }}>
        {TABS.map((t) => (
          <a key={t.id} href={`#studio-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`studio-${t.id}`}
            onClick={(e) => { e.preventDefault(); setTab(t.id); }}>{t.label}</a>
        ))}
      </div>

      {tab === 'goal' && (
        <div id="studio-goal" role="tabpanel" aria-label="Goal">
          <h3 className="v2-section">{goal.title}</h3>
          <p className="v2-body" style={{ color: 'var(--text-muted)' }}>{goal.ask || 'No user request recorded yet — the goal appears with the first message.'}</p>
          <p className="v2-meta">Mode {goal.mode} · Budget {goal.budget != null ? usd(goal.budget) : 'Unknown'} · Created {run?.createdAt ? relTime(run.createdAt) : 'unknown'}</p>
        </div>
      )}

      {tab === 'plan' && (
        <div id="studio-plan" role="tabpanel" aria-label="Plan">
          {!snap.execution?.plan ? (
            <div className="v2-empty" role="status"><b>No plan recorded</b><span>Plans appear after the planning stage. The timeline below shows observed progress meanwhile.</span></div>
          ) : (
            <DataTable
              rows={snap.execution.plan.steps.map((s) => ({ id: s.id, role: s.description, status: s.status, detail: `deps: ${(s.dependencies || []).join(', ') || 'none'}` }))}
              ariaLabel="Plan steps"
              searchKeys={(r) => `${r.role} ${r.status}`}
              columns={[
                { key: 'role', header: 'Step', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
                { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
                { key: 'detail', header: 'Dependencies', render: (r) => <span className="v2-meta">{r.detail}</span> },
              ]}
            />
          )}
        </div>
      )}

      {tab === 'execution' && (
        <div id="studio-execution" role="tabpanel" aria-label="Execution">
          <ExecutionGraph snap={snap} selectedId={selectedNode} onSelect={setSelectedNode} />
          {selected && <p className="v2-meta" role="status" style={{ marginTop: 8 }}>Selected: <b>{selected.label}</b> · {selected.status.toUpperCase()}{selected.detail ? ` · ${selected.detail}` : ''}</p>}
          <ExecutionWaterfall snap={snap} />
          <div style={{ marginTop: 12 }}>
            <ExecutionTimeline trace={snap.trace} status={String(snap.status)} />
          </div>
        </div>
      )}

      {tab === 'artifacts' && (
        <div id="studio-artifacts" role="tabpanel" aria-label="Artifacts">
          {artifacts.length === 0 && files.length === 0 && changesets.length === 0 ? (
            <div className="v2-empty" role="status"><b>No artifacts</b><span>Code, diffs, files, and generated assets appear here when the run produces them.</span></div>
          ) : (
            <>
              {artifacts.length > 0 && <ArtifactList artifacts={artifacts} />}
              {files.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="v2-eyebrow">Files</div>
                  <ul>{files.slice(0, 20).map((f) => <li key={f} className="v2-meta">{f}</li>)}</ul>
                </div>
              )}
              {changesets.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="v2-eyebrow">Changesets — review with evidence</div>
                  {changesets.slice(0, 5).map((c) => (
                    <DiffViewer key={c.id} snap={snap} changeset={c} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'verification' && (
        <div id="studio-verification" role="tabpanel" aria-label="Verification">
          <p role="status"><Status status={vState === 'verified' ? 'verified' : vState === 'failed' ? 'failed' : vState === 'partial' ? 'waiting' : 'unknown'} label={vState === 'verified' ? 'VERIFIED' : vState === 'partial' ? 'PARTIALLY VERIFIED' : vState === 'claimed' ? 'CLAIMED' : vState === 'failed' ? 'FAILED' : 'UNKNOWN'} /></p>
          {verifs.length === 0 ? (
            <div className="v2-empty" role="status"><b>{vState === 'claimed' ? 'Claimed, not verified' : 'No verification yet'}</b><span>The agent returned a response, but no test/diff/security/browser checks are recorded. Completion is claimed — not verified.</span></div>
          ) : (
            <ul>
              {verifs.map((v, i) => (
                <li key={i} className="v2-body">{v.passed ? '✓' : '✕'} {v.summary} <span className="v2-meta">· {v.kind}{v.at ? ` · ${relTime(v.at)}` : ''}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'evidence' && (
        <div id="studio-evidence" role="tabpanel" aria-label="Evidence">
          <EvidencePanel snap={snap} />
        </div>
      )}

      {tab === 'activity' && (
        <div id="studio-activity" role="tabpanel" aria-label="Activity">
          <MessageList messages={messages} />
        </div>
      )}
    </section>
  );
}
