import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Empty, Skeleton, usd } from '../components/ui';
import type { AlertRecord, BillingResponse, CacheOverview, ProjectInfo, SessionRecord } from '../types';
import '../styles/account.css';

function Surface({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return <div className="page account-page"><div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div></div>{children}</div>;
}

export function BillingPage() {
  const [data, setData] = useState<BillingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; api.getBilling().then((r) => !cancelled && setData(r)).catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Unable to load billing')); return () => { cancelled = true; }; }, []);
  if (error) return <Surface title="Billing" eyebrow="ACCOUNTING"><div className="banner err">{error}</div></Surface>;
  if (!data) return <Surface title="Billing" eyebrow="ACCOUNTING"><Skeleton lines={5} /></Surface>;
  const b = data.billing || {};
  return <Surface title="Billing" eyebrow="BYOK ACCOUNTING">
    <div className="account-note"><b>BYOK platform accounting · beta/manual reconciliation.</b> You pay providers directly; Orchestra never fronts inference. These figures come from the same SavingsEngine result used on Savings and are modeled, not invoice-reconciled. No self-serve Stripe subscription or automatic provider invoice matching is enabled in V1.</div>
    <div className="econ-grid"><div className="econ-metric"><span>Eligible savings</span><strong>{usd(b.eligibleSavings)}</strong></div><div className="econ-metric"><span>Platform fee</span><strong>{usd(b.platformFee)}</strong></div><div className="econ-metric"><span>Customer final cost</span><strong>{usd(b.customerFinalCost)}</strong></div><div className="econ-metric positive"><span>Net customer savings</span><strong>{usd(b.customerNetSavings)}</strong></div></div>
    <section className="surface-card"><div className="surface-head"><div><h3>Billing history</h3><p>{b.period || 'Current period'} · modeled only · not invoice-reconciled</p></div><span className="pill sm neutral">{b.invoiceStatus || 'not_invoice_reconciled'}</span></div>{data.lineItems?.length ? <div className="billing-list">{data.lineItems.map((line, i) => <div className="billing-row" key={`${line.period}-${i}`}><span>{line.period}</span><span>{line.status}</span><b>{usd(line.platformFee)}</b><small>{usd(line.customerNetSavings)} net</small></div>)}</div> : <Empty what="Billing history" hint="A completed run with eligible modeled savings will create a line item." />}</section>
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
  useEffect(() => {
    const load: Promise<OperationData> = kind === 'sessions' ? api.getSessions() : kind === 'cache' ? api.getCache() : kind === 'alerts' ? api.getAlerts() : Promise.resolve({});
    load.then((r) => setData(r)).catch(() => setData({}));
  }, [kind]);
  return <Surface title={title} eyebrow={eyebrow}><section className="surface-card operations-card"><h3>{description}</h3>
    {kind === 'cache' && data?.cache ? <div className="cache-tiles"><div><span>Hit rate</span><b>{Math.round((data.cache.hitRate || 0) * 100)}%</b></div><div><span>Provider calls avoided</span><b>{data.cache.hits || 0}</b></div><div><span>Cached input tokens</span><b>{data.cache.cachedTokens || 0}</b></div></div> : null}
    {kind === 'sessions' && data?.sessions?.length ? <div className="project-list">{data.sessions.slice(0, 50).map((session) => <div className="project-row" key={session.sessionId}><div><b>{session.title || session.sessionId}</b><small>{session.status} · {session.projectId || 'unassigned'}</small></div><span className="mono">{session.sessionId}</span></div>)}</div> : null}
    {kind === 'alerts' && data?.alerts?.length ? <div className="project-list">{data.alerts.map((alert) => <div className="project-row" key={alert.id}><div><b>{alert.title}</b><small>{alert.severity} · {alert.source}</small></div><span>{alert.at ? new Date(alert.at).toLocaleString() : 'observed'}</span></div>)}</div> : null}
    {data && ((kind === 'sessions' && !data.sessions?.length) || (kind === 'alerts' && !data.alerts?.length) || (kind === 'cache' && !data.cache)) ? <Empty what={`${title} data`} hint="Complete a real run to populate this surface with observed data." /> : null}
    {kind === 'prompts' ? <Empty what="Prompt plans" hint="Open a run and inspect its bounded PromptPlan composition." /> : null}
  </section></Surface>;
}
