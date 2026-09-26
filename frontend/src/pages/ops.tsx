// V2 operate/build pages — honest surfaces over existing backend data.
// Agents: observed agent activity from trace/plan/tools (no invented catalog).
// Skills: memory-backed capabilities (empty until backend ships skills).
// Workflows: run plans from execution.plan. Workspaces: projects + runtime.
// Approvals: pending approvals from snapshot. Deployments/Incidents: honest
// empty states (backend exposes none) + derived failure attention.
import React from 'react';
import { useRuntime } from '../state/store';
import { navigateRoute } from '../lib/routes';
import { api } from '../api/client';
import { Empty, relTime, usd } from '../components/ui';
import { Status } from '../components/v2/cards';
import { DataTable } from '../components/v2/table';
import { ApprovalCenter } from '../components/execution/ApprovalCenter';

export function AgentsPage() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  const trace = snap?.trace || [];
  const toolNames = [...new Set(trace.filter((t) => t.type.startsWith('tool.')).map((t) => t.label.slice(0, 60)))].slice(0, 8);
  const planSteps = snap?.execution?.plan?.steps || [];
  const agents = planSteps.length
    ? planSteps.map((s) => ({ id: s.id, role: s.description.slice(0, 60), status: s.status, detail: `deps: ${(s.dependencies || []).join(', ') || 'none'}` }))
    : toolNames.map((t, i) => ({ id: `observed-${i}`, role: t, status: 'observed', detail: 'Observed tool activity — no agent catalog exposed by the backend' }));
  return (
    <div className="page">
      <h2>Agents</h2>
      <p className="lede">Observed agent work for the active run. The backend exposes no standalone agent catalog — nothing is invented.</p>
      {!snap ? <Empty what="Agents" hint="Select a run to see observed agent activity." /> : agents.length === 0 ? (
        <Empty what="Agents" hint="No agent steps observed yet. Activity appears as the run plans and executes." action={<span className="v2-meta">Plan + tool trace are the source of truth.</span>} />
      ) : (
        <DataTable
          rows={agents}
          ariaLabel="Agents"
          searchKeys={(r) => `${r.role} ${r.status}`}
          rowActions={(r) => (
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button type="button" className="icon-btn sm" onClick={() => { if (state.server.activeRunId) { dispatch({ type: 'ui/set', patch: { view: 'run' } }); navigateRoute('run', state.server.activeRunId); } }} aria-label={`Inspect ${r.role}`}>Inspect</button>
              <button type="button" className="icon-btn sm" onClick={() => { dispatch({ type: 'ui/set', patch: { view: 'evals' } }); navigateRoute('evals'); }} aria-label="Benchmark agent">Benchmark</button>
              <button type="button" className="icon-btn sm" disabled title="Disable is not exposed by the backend">Disable</button>
            </span>
          )}
          columns={[
            { key: 'role', header: 'Role / step', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
            { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
            { key: 'detail', header: 'Detail', render: (r) => <span className="v2-meta">{r.detail}</span> },
          ]}
          emptyTitle="No agents"
          emptyHint="No agent activity observed for this run yet."
        />
      )}
    </div>
  );
}

export function SkillsPage() {
  const { state } = useRuntime();
  const items = state.server.memItems;
  return (
    <div className="page">
      <h2>Skills</h2>
      <p className="lede">Reusable capabilities. The backend exposes no skill registry yet — memory-backed skills appear here when recorded.</p>
      {items.length === 0 ? (
        <Empty what="Skills" hint="No skills recorded. Turn a production run into a reusable skill once the backend ships versioned skills." />
      ) : (
        <DataTable
          rows={items.map((m) => ({ id: m.id, role: m.title, status: m.status, detail: `${m.scope} · ${(m.importance * 100).toFixed(0)}% importance` }))}
          ariaLabel="Skills"
          searchKeys={(r) => `${r.role}`}
          columns={[
            { key: 'role', header: 'Skill', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
            { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
            { key: 'detail', header: 'Detail', render: (r) => <span className="v2-meta">{r.detail}</span> },
          ]}
          emptyTitle="No skills"
          emptyHint="No skill-like memory recorded."
        />
      )}
    </div>
  );
}

export function WorkflowsPage() {
  const { state } = useRuntime();
  const snap = state.server.snapshot;
  const plan = snap?.execution?.plan;
  return (
    <div className="page">
      <h2>Workflows</h2>
      <p className="lede">Executable run plans. Authoritative state comes from the backend plan — never reconstructed locally.</p>
      {!snap ? <Empty what="Workflows" hint="Select a run to inspect its plan." /> : !plan ? (
        <Empty what="Workflow plan" hint="No plan recorded for this run yet. Plans appear after the planning stage." />
      ) : (
        <>
          <p className="v2-meta">Version {plan.version} · updated {relTime(plan.updatedAt)}</p>
          <DataTable
            rows={plan.steps.map((s) => ({ id: s.id, role: s.description, status: s.status, detail: `deps: ${(s.dependencies || []).join(', ') || 'none'}` }))}
            ariaLabel="Workflow steps"
            searchKeys={(r) => `${r.role} ${r.status}`}
            columns={[
              { key: 'role', header: 'Step', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
              { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
              { key: 'detail', header: 'Dependencies', render: (r) => <span className="v2-meta">{r.detail}</span> },
            ]}
          />
        </>
      )}
    </div>
  );
}

export function WorkspacesPage() {
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    api.getProjects().then(({ projects: p }) => setProjects((p || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
  }, []);
  const { state } = useRuntime();
  const snap = state.server.snapshot;
  return (
    <div className="page">
      <h2>Workspaces</h2>
      <p className="lede">Development environments. Sandbox/branch/snapshot detail appears here when the backend exposes it — repository identity comes from projects today.</p>
      {projects.length === 0 ? <Empty what="Workspaces" hint="No projects yet. Create a project to attach runs to a workspace." /> : (
        <DataTable
          rows={projects.map((p) => ({ id: p.id, role: p.name, status: snap ? 'active' : 'unknown', detail: snap ? `active run: ${snap.runId.slice(0, 12)}…` : 'No active run' }))}
          ariaLabel="Workspaces"
          searchKeys={(r) => r.role}
          columns={[
            { key: 'role', header: 'Workspace', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
            { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
            { key: 'detail', header: 'Detail', render: (r) => <span className="v2-meta">{r.detail}</span> },
          ]}
        />
      )}
      <p className="v2-meta" style={{ marginTop: 8 }}>Sandbox runtime, branch, dependencies, services, snapshot/restore: Unknown — not exposed by the backend. Shown as Unknown, never faked.</p>
      <p className="v2-meta">Active run spend: {snap ? usd(snap.cost.spentUsd) : '—'}</p>
      <p className="v2-meta">Projects in store: {state.server.runs.length} runs tracked.</p>
    </div>
  );
}

export function ApprovalsPage() {
  const { state, dispatch } = useRuntime();
  const snap = state.server.snapshot;
  const [alerts, setAlerts] = React.useState<{ id: string; severity: string; title: string }[]>([]);
  React.useEffect(() => {
    api.getAlerts().then(({ alerts: a }) => setAlerts((a || []).slice(0, 10))).catch(() => {});
  }, []);
  const runs = state.server.runs;
  const failed = runs.filter((r) => String(r.status).toLowerCase() === 'failed').slice(0, 5);
  const waiting = runs.filter((r) => ['running', 'planning', 'waiting'].includes(String(r.status).toLowerCase())).slice(0, 5);
  const completed = runs.filter((r) => String(r.status).toLowerCase() === 'completed').slice(0, 5);
  const failedEvals = state.server.evals.filter((e) => e.pass === false || e.passed === false).slice(0, 5);
  const pendingCount = (snap?.execution?.pendingApprovals || []).length;
  const goRun = (id: string) => {
    dispatch({ type: 'runs/active', id });
    dispatch({ type: 'ui/set', patch: { view: 'run' } });
    navigateRoute('run', id);
  };
  return (
    <div className="page">
      <h2>Approvals</h2>
      <p className="lede">Everything waiting for a human decision. Nothing executes until you decide — nothing is auto-approved.</p>
      {!snap ? <Empty what="Approvals" hint="Select a run to review its approval queue." /> : <ApprovalCenter snap={snap} />}
      <h3 className="v2-section" style={{ marginTop: 20 }}>Agent inbox — what needs your attention</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
        <div className="v2-decision">
          <div className="v2-decision-top"><b>Needs approval</b><span className="v2-meta">{pendingCount || '—'}</span></div>
          <p className="v2-meta">{pendingCount ? `${pendingCount} waiting in the active run.` : 'No pending approvals in the active run.'}</p>
        </div>
        <div className="v2-decision" data-high-risk={failed.length ? 'true' : 'false'}>
          <div className="v2-decision-top"><b>Failed</b><span className="v2-meta">{failed.length}</span></div>
          {failed.length === 0 ? <p className="v2-meta">No failed runs.</p> : failed.map((r) => <button key={r.id} type="button" className="link-btn" style={{ display: 'block' }} onClick={() => goRun(r.id)}>{r.title}</button>)}
        </div>
        <div className="v2-decision">
          <div className="v2-decision-top"><b>In flight</b><span className="v2-meta">{waiting.length}</span></div>
          {waiting.length === 0 ? <p className="v2-meta">Nothing running.</p> : waiting.map((r) => <button key={r.id} type="button" className="link-btn" style={{ display: 'block' }} onClick={() => goRun(r.id)}>{r.title} · {r.status}</button>)}
        </div>
        <div className="v2-decision">
          <div className="v2-decision-top"><b>Security & alerts</b><span className="v2-meta">{alerts.length}</span></div>
          {alerts.length === 0 ? <p className="v2-meta">No alerts.</p> : alerts.slice(0, 4).map((a) => <p key={a.id} className="v2-meta">[{a.severity}] {a.title}</p>)}
        </div>
        <div className="v2-decision">
          <div className="v2-decision-top"><b>Regression</b><span className="v2-meta">{failedEvals.length}</span></div>
          {failedEvals.length === 0 ? <p className="v2-meta">No failed evaluations.</p> : failedEvals.map((e) => <p key={e.id} className="v2-meta">{String(e.name || e.id)} · run {String(e.runId).slice(0, 8)}</p>)}
        </div>
        <div className="v2-decision">
          <div className="v2-decision-top"><b>Completed</b><span className="v2-meta">{completed.length}</span></div>
          {completed.length === 0 ? <p className="v2-meta">No completed runs yet.</p> : completed.map((r) => <button key={r.id} type="button" className="link-btn" style={{ display: 'block' }} onClick={() => goRun(r.id)}>{r.title}</button>)}
        </div>
      </div>
      <p className="v2-meta" style={{ marginTop: 8 }}>Needs clarification: Unknown — the backend exposes no clarification queue; waiting runs above are the closest signal.</p>
    </div>
  );
}

export function DeploymentsPage() {
  return (
    <div className="page">
      <h2>Deployments</h2>
      <p className="lede">Release targets for agent-built changes.</p>
      <Empty what="Deployments" hint="The backend exposes no deployment targets yet. Connect a deployment provider to enable this surface." />
    </div>
  );
}

export function IncidentsPage() {
  const { state } = useRuntime();
  const failed = state.server.runs.filter((r) => String(r.status).toLowerCase() === 'failed');
  return (
    <div className="page">
      <h2>Incidents</h2>
      <p className="lede">Failed runs that need attention. Derived from real run records only.</p>
      {failed.length === 0 ? <Empty what="Incidents" hint="No failed runs. Failures appear here with trace + retry paths." /> : (
        <DataTable
          rows={failed.map((r) => ({ id: r.id, role: r.title, status: r.status, detail: `${relTime(r.updatedAt)} · ${usd(r.spent)} spent` }))}
          ariaLabel="Incidents"
          searchKeys={(r) => r.role}
          columns={[
            { key: 'role', header: 'Run', render: (r) => <b>{r.role}</b>, sortValue: (r) => r.role },
            { key: 'status', header: 'Status', render: (r) => <Status status={r.status} />, sortValue: (r) => r.status },
            { key: 'detail', header: 'Detail', render: (r) => <span className="v2-meta">{r.detail}</span> },
          ]}
        />
      )}
    </div>
  );
}
