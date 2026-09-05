// Standalone public pricing page: same 4 honest tiers as the landing
// section, plus the beta/manual-billing FAQ. No Stripe claims.
import React from 'react';
import '../styles/public.css';
import { Mark } from './landing/Nav';

const TIERS = [
  { name: 'Trial', price: '$0', per: 'to start · Demo included', blurb: 'Explore the console and watch routing explain itself before you spend anything.', cta: 'Start trial', href: '/auth?plan=trial', features: ['Demo mode + 1 workspace project', 'Routing, context & trace inspector', 'Provider setup guides'] },
  { name: 'Pro', price: 'Usage-based', per: 'BYOK · fee only on eligible modeled savings', blurb: 'For builders running real traffic on their own provider keys.', cta: 'Create workspace', href: '/auth?plan=pro', featured: true, features: ['Unlimited runs within your provider budget', 'Live model registry + failover', 'Per-run savings evidence', 'Approvals & audit trail'] },
  { name: 'Team', price: 'Usage-based', per: 'BYOK · per-project policies', blurb: 'Shared workspaces with project policies and review controls.', cta: 'Start a team workspace', href: '/auth?plan=team', features: ['Everything in Pro', 'Projects, roles & approvals', 'Per-project reference models', 'Shared savings reporting'] },
  { name: 'Enterprise', price: 'Contact', per: 'manual onboarding in beta', blurb: 'Security review and guided rollout — set up by hand, no self-serve contracts in V1.', cta: 'Contact us', href: '/auth?plan=enterprise', features: ['Security review support', 'Tenant isolation + audit export', 'Custom policies & budgets', 'Guided onboarding'] },
];

const FAQ = [
  { q: 'Do you mark up provider inference?', a: 'No. Providers bill your account directly (BYOK). The platform fee applies only to eligible modeled savings, shown beside provider cost on every run.' },
  { q: 'Are savings numbers invoices?', a: 'No. Baseline vs actual is modeled by the SavingsEngine from observed usage and immutable pricing snapshots. Billing views are labeled modeled and not invoice-reconciled.' },
  { q: 'Can I subscribe with Stripe today?', a: 'Not in V1. Billing is beta/manual — there are no self-serve subscriptions or automatic provider invoice matching. Enterprise onboarding is manual.' },
  { q: 'What does Demo mode do?', a: 'Demo uses labeled mock responses so you can explore offline. LIVE mode requires a verified provider key, stored encrypted server-side and never shown again.' },
];

export function PricingPage() {
  return (
    <div className="marketing lp">
      <header className="lp-navwrap">
        <div className="lp-nav">
          <a href="/" className="public-brand" aria-label="OrchestraAI home"><Mark />OrchestraAI</a>
          <div className="lp-nav-actions">
            <a href="/auth" className="lp-link">Sign in</a>
            <a href="/console" className="lp-btn secondary small">Open console</a>
            <a href="/auth" className="lp-btn primary small">Get started</a>
          </div>
        </div>
      </header>
      <main className="lp-price-page">
        <p className="lp-kicker">PRICING</p>
        <h1>Plans that stay honest about what&apos;s billed.</h1>
        <p className="lp-lede">Providers bill you directly. OrchestraAI charges a platform fee only on eligible modeled savings — and says so on every number.</p>
        <div className="lp-tiers" role="list" aria-label="Plans">
          {TIERS.map((t) => (
            <article key={t.name} className={`lp-tier${(t as { featured?: boolean }).featured ? ' featured' : ''}`} role="listitem" aria-label={`${t.name} plan`}>
              <span className="lp-price-tag">{t.name.toUpperCase()}</span>
              <p className="lp-tier-price"><b>{t.price}</b><span>{t.per}</span></p>
              <p className="lp-tier-blurb">{t.blurb}</p>
              <ul>{t.features.map((f) => <li key={f}><i aria-hidden="true">✓</i> {f}</li>)}</ul>
              <a href={t.href} className={`lp-btn ${(t as { featured?: boolean }).featured ? 'primary' : 'secondary'} full`}>{t.cta} →</a>
            </article>
          ))}
        </div>
        <div className="lp-faq" aria-label="Pricing questions">
          {FAQ.map((f) => (
            <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>
          ))}
        </div>
        <div className="lp-cta" style={{ marginTop: 28 }}>
          <a href="/auth" className="lp-btn primary large">Create your workspace →</a>
          <a href="/console" className="lp-btn secondary large">Open the console</a>
        </div>
      </main>
    </div>
  );
}
