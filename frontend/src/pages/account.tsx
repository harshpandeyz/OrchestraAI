import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Empty, Skeleton, fmtPct, usd } from '../components/ui';
import { EconomicsLegend, CostBasisBadge } from '../components/economics';
import { PageError, ReconciliationNote } from '../components/product-states';
import type { AlertRecord, BillingResponse, CacheOverview, ProjectInfo, SessionRecord } from '../types';
import '../styles/account.css';

function Surface({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return <div className="page account-page"><div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div></div>{children}</div>;
}

export function BillingPage() {
  const [data, setData] = useState<BillingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.getBilling().then((r) => setData(r)).catch((e) => setError(e instanceof Error ? e.message : 'Unable to load billing'));
  };
  useEffect(() => { let cancelled = false; api.getBilling().then((r) => !cancelled && setData(r)).catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Unable to load billing')); return () => { cancelled = true; }; }, []);
  if (error) return <Surface title="Billing" eyebrow="BYOK ACCOUNTING"><PageError message={error} onRetry={load} /><p className="recon-note">No figures are shown because the backend could not be reached — nothing is assumed.</p></Surface>;
  if (!data) return <Surface title="Billing" eyebrow="BYOK ACCOUNTING"><Skeleton lines={5} /></Surface>;
  const b = data.billing || ({} as BillingResponse['billing']);
  const lines = data.lineItems || [];
  const quality = (b as { dataQuality?: { verifiedCount?: number; insufficientCount?: number; incompleteCount?: number } }).dataQuality;
  const hasUsage = (b.runCount || 0) > 0 || lines.length > 0;
  return <Surface title="Billing" eyebrow="BYOK ACCOUNTING">
    <div className="account-note"><b>BYOK platform accounting · beta/manual reconciliation.</b> You pay providers directly; Orchestra never fronts inference. All figures are the SavingsEngine result — <b>modeled, not invoice-reconciled</b>. No self-serve Stripe subscription or automatic provider invoice matching exists in V1.</div>
    <section className="surface-card" aria-label="Current period summary">
      <div className="surface-head"><div><h3>Current period</h3><p>{(b as { period?: string }).period || 'Current period'} · {(b as { currency?: string }).currency || 'USD'} · {b.source || 'modeled (SavingsEngine)'}</p></div><span className="pill sm neutral">{b.invoiceStatus || 'not_invoice_reconciled'}</span></div>
      <div className="econ-grid">
        <div className="econ-metric"><span>Plan</span><strong>Beta/manual</strong><small>No subscription in V1</small></div>
        <div className="econ-metric"><span>Modeled baseline <CostBasisBadge basis="modeled" /></span><strong>{usd(b.baselineCost)}</strong><small>Counterfactual reference</small></div>
        <div className="econ-metric"><span>Provider spend <CostBasisBadge basis="actual" /></span><strong>{usd(b.optimizedProviderCost)}</strong><small>Paid directly by you</small></div>
        <div className="econ-metric"><span>Platform fee{b.platformFee !== null && b.platformFee !== undefined && (b as { platformFeePct?: number }).platformFeePct !== undefined ? ` (${fmtPct(((b as { platformFeePct?: number }).platformFeePct || 0) / 100, 0)})` : ''}</span><strong>{usd(b.platformFee)}</strong><small>On eligible modeled savings only</small></div>
        <div className="econ-metric"><span>Customer final cost</span><strong>{usd(b.customerFinalCost)}</strong><small>Provider spend + fee</small></div>
        <div className="econ-metric positive"><span>Customer net savings <CostBasisBadge basis={quality && (quality.insufficientCount || quality.incompleteCount) ? 'insufficient' : 'modeled'} /></span><strong>{usd(b.customerNetSavings)}</strong><small>{b.savingsRate !== null && b.savingsRate !== undefined ? `${fmtPct(b.savingsRate || 0)} eligible rate` : 'No verified rate yet'}</small></div>
      </div>
      <ReconciliationNote status={b.invoiceStatus} />
      {quality && ((quality.insufficientCount || 0) + (quality.incompleteCount || 0) > 0) ? (
        <p className="recon-note" role="status">Data quality: {quality.verifiedCount || 0} verified · {quality.insufficientCount || 0} insufficient · {quality.incompleteCount || 0} incomplete — unverified runs never count as savings.</p>
      ) : null}
    </section>
    <EconomicsLegend compact />
    <section className="surface-card"><div className="surface-head"><div><h3>Billing history</h3><p>{data.note || 'Line items are modeled periods, not invoices.'}</p></div><span className="pill sm neutral">{b.invoiceStatus || 'not_invoice_reconciled'}</span></div>{lines.length ? <div className="billing-list" role="list" aria-label="Billing history">{lines.map((line, i) => <div className="billing-row" role="listitem" key={`${line.period}-${i}`}><span><b>{line.period}</b><small> · {line.currency || (b as { currency?: string }).currency || 'USD'}</small></span><span>{line.economicsStatus || line.status} · {line.reconciliation || line.invoiceStatus}</span><b>{usd(line.platformFee)}</b><small>{usd(line.customerNetSavings)} net · {usd(line.optimizedProviderCost)} provider</small></div>)}</div> : hasUsage ? <Empty what="Billing history" hint="Runs exist but no billable period has closed yet — history appears when a period aggregates." /> : <Empty what="Billing history" hint="A completed run with eligible modeled savings will create a line item. Nothing is billed until then." />}</section>
  </Surface>;
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api.getProjects().then((r) => setProjects(r.projects || [])).catch((e) => setError(e instanceof Error ? e.message : 'Unable to load projects'));
  useEffect(() => { load(); }, []);
  const create = async (e: React.FormEvent) => { e.preventDefault(); if (!name.trim()) return; setError(null); try { await api.createProject(name.trim()); setName(''); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create project'); } };
  if (!projects && !error) return <Surface title="Projects / Teams" eyebrow="WORKSPACE"><Skeleton lines={5} /></Surface>;
  return <Surface title="Projects / Teams" eyebrow="WORKSPACE">
    {error && <div className="banner err" role="alert">{error}</div>}
    <section className="surface-card"><div className="surface-head"><div><h3>Projects</h3><p>Reference model, optimization policy, and privacy mode are scoped per project.</p></div></div>{projects?.length ? <div className="project-list">{projects.map((project) => <div className="project-row" key={project.id}><div><b>{project.name}</b><small>{project.policy} · {project.privacyMode}</small></div><span className="mono">{project.id}</span></div>)}</div> : <Empty what="Projects" hint="Create a project to give your first request a durable home." />}<form className="inline-form" onSubmit={create}><input aria-label="New project name" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} /><button className="icon-btn primary" disabled={!name.trim()}>Create project</button></form></section>
  </Surface>;
}

export function OperationsPage({ kind }: { kind: 'sessions' | 'prompts' | 'cache' | 'alerts' }) {
  const copy = {
    sessions: ['Sessions', 'REQUEST HISTORY', 'Every request is persisted as a run with a trace, timeline, and reloadable final state.'],
    prompts: ['Prompts', 'PROMPT GOVERNANCE', 'PromptPlan is the authoritative prompt contract. Inspect its bounded system, task, history, memory, tools, and evidence composition in a run detail.'],
    cache: ['Cache', 'CACHE CONTROL', 'Local response hits are provider-call-free. Semantic reuse remains gated by freshness, fingerprint, model, and tool-dependency evidence.'],
    alerts: ['Alerts', 'RELIABILITY CONTROL', 'No alert rules are configured yet. Provider health and runtime failures remain visible in the live trace and model catalog.'],
  } as const;
  const [title, eyebrow, description] = copy[kind];
  type OperationData = { sessions?: SessionRecord[]; cache?: CacheOverview; alerts?: AlertRecord[] };
  const [data, setData] = useState<OperationData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setLoadError(null);
    const load: Promise<OperationData> = kind === 'sessions' ? api.getSessions() : kind === 'cache' ? api.getCache() : kind === 'alerts' ? api.getAlerts() : Promise.resolve({});
    load.then((r) => setData(r)).catch((e) => { setLoadError(e instanceof Error ? e.message : 'Backend unavailable'); setData({}); });
  }, [kind]);
  return <Surface title={title} eyebrow={eyebrow}><section className="surface-card operations-card"><h3>{description}</h3>
    {loadError && <PageError message={`${loadError} — showing no data rather than stale data.`} />}
    {!data && !loadError && <Skeleton lines={3} />}
    {kind === 'cache' && data?.cache ? <div className="cache-tiles"><div><span>Hit rate</span><b>{Math.round((data.cache.hitRate || 0) * 100)}%</b></div><div><span>Provider calls avoided</span><b>{data.cache.hits || 0}</b></div><div><span>Cached input tokens</span><b>{data.cache.cachedTokens || 0}</b></div></div> : null}
    {kind === 'sessions' && data?.sessions?.length ? <div className="project-list">{data.sessions.slice(0, 50).map((session) => <div className="project-row" key={session.sessionId}><div><b>{session.title || session.sessionId}</b><small>{session.status} · {session.projectId || 'unassigned'}</small></div><span className="mono">{session.sessionId}</span></div>)}</div> : null}
    {kind === 'alerts' && data?.alerts?.length ? <div className="project-list">{data.alerts.map((alert) => <div className="project-row" key={alert.id}><div><b>{alert.title}</b><small>{alert.severity} · {alert.source}</small></div><span>{alert.at ? new Date(alert.at).toLocaleString() : 'observed'}</span></div>)}</div> : null}
    {data && ((kind === 'sessions' && !data.sessions?.length) || (kind === 'alerts' && !data.alerts?.length) || (kind === 'cache' && !data.cache)) ? <Empty what={`${title} data`} hint="Complete a real run to populate this surface with observed data." /> : null}
    {kind === 'prompts' ? <Empty what="Prompt plans" hint="Open a run and inspect its bounded PromptPlan composition." /> : null}
  </section></Surface>;
}
