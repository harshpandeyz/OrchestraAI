import React from 'react';
import { Reveal, useCycle, useReducedMotion } from './hooks';

const JOURNEY = ['Task', 'Context', 'Model', 'Execute', 'Done'];

function ConsoleFrame() {
  const reduced = useReducedMotion();
  const at = useCycle(JOURNEY.length, 2000);
  const active = reduced ? 2 : at;
  return (
    <div className="lp-browser lp-browser-rich" aria-label="Illustrative preview of the OrchestraAI console">
      <div className="lp-browser-bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>orchestra / console — illustrative preview</span>
        <em>
          <b className="lp-live-dot" /> LIVE
        </em>
      </div>
      <div className="lp-browser-body">
        <div className="lp-b-side" aria-hidden="true">
          <i className="on" />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="lp-b-main">
          <div className="lp-b-head">
            <div>
              <small>EXAMPLE RUN · NO ACCOUNT DATA</small>
              <strong>Refactor auth flow</strong>
            </div>
            <span className="lp-pill">OPTIMIZING</span>
          </div>
          <ol className="lp-journey" aria-hidden="true">
            {JOURNEY.map((j, i) => (
              <li key={j} className={i < active ? 'done' : i === active ? 'active' : ''}>
                {j}
              </li>
            ))}
          </ol>
          <p className="lp-b-res" aria-hidden="true">
            cost $0.009 / $0.10 · 420ms · 3 tools · 0 switches
          </p>
          <svg viewBox="0 0 300 44" className="lp-b-spark" aria-hidden="true" focusable="false">
            <path
              d="M4 36 C 40 34, 60 28, 90 26 S 150 20, 180 14 S 260 10, 296 6"
              fill="none"
              stroke="#0a85ff"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="296" cy="6" r="3.5" fill="#0a85ff" />
          </svg>
          <div className="lp-b-rows" aria-hidden="true">
            <div>
              <span className="lp-dot g" />
              <div>
                <b>Route selected · Claude-class</b>
                <small>quality floor satisfied · context fits · net benefit 96</small>
              </div>
              <code>$0.009</code>
            </div>
            <div>
              <span className="lp-dot b" />
              <div>
                <b>Tool completed · run_tests</b>
                <small>18 passed · 2 failing assertions → evidence kept</small>
              </div>
              <code>1.8s</code>
            </div>
            <div className="lp-b-live">
              <span className="lp-dot v lp-blink" />
              <div>
                <b>Provider stream · apply_patch</b>
                <small>usage captured · pricing snapshot attached</small>
              </div>
              <code>live</code>
            </div>
          </div>
        </div>
        <aside className="lp-b-insp" aria-hidden="true">
          <b>RUNTIME INSPECTOR</b>
          <div className="lp-insp-card">
            <small>MODEL</small>
            <strong>Claude-class</strong>
            <span>why → factors + alternatives</span>
          </div>
          <div className="lp-insp-card">
            <small>COST · CANONICAL</small>
            <strong>$0.009</strong>
            <span>provider-reported usage</span>
          </div>
          <div className="lp-insp-card">
            <small>EVIDENCE</small>
            <strong>4 items</strong>
            <span>tests · diff · usage · proof</span>
          </div>
        </aside>
      </div>
      <div className="lp-browser-foot">
        <span>STRUCTURE ONLY · NO ACCOUNT DATA</span>
        <a href="/console">Open the live console →</a>
      </div>
    </div>
  );
}

export function ConsoleShowcase() {
  return (
    <section className="lp-section lp-alt" id="console" aria-labelledby="console-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">THE ACTUAL PRODUCT</p>
          <h2 id="console-h">This is the console you&apos;ll use.</h2>
          <p className="lp-lede">
            Three panels — runs, workspace, runtime intelligence — with the journey strip, resource line and
            outcome-first evidence. Preview below mirrors the real layout; open it live.
          </p>
        </Reveal>
        <Reveal>
          <ConsoleFrame />
        </Reveal>
      </div>
    </section>
  );
}

const SECURITY = [
  {
    t: 'Keys stay yours',
    d: 'Paste once, verify live against the real provider, encrypted at rest — and never rendered again. V1 is BYOK: inference is billed by your provider account, never marked up.',
  },
  {
    t: 'Tenant isolation',
    d: 'Runs, approvals, billing and credentials are scoped to your workspace. Sessions are opaque, HttpOnly, and revocable; bearer tokens are operator-scoped.',
  },
  {
    t: 'Evidenced operations',
    d: 'Decisions, cost records, approvals and failovers are structured audit trails — replayable per run, exportable when compliance asks.',
  },
];

export function Security() {
  return (
    <section className="lp-section" id="security" aria-labelledby="security-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">SECURITY &amp; TRUST</p>
          <h2 id="security-h">Infrastructure you can hand to security review.</h2>
        </Reveal>
        <div className="lp-cards lp-cards-3">
          {SECURITY.map((s) => (
            <Reveal as="article" key={s.t} className="lp-card">
              <span className="lp-check" aria-hidden="true">
                ✓
              </span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const TIERS = [
  {
    name: 'Trial',
    price: '$0',
    per: 'to start · Demo included',
    blurb: 'Explore the console, run Demo workloads, and see routing explain itself.',
    cta: 'Start trial',
    href: '/auth?plan=trial',
    features: ['Demo mode + 1 workspace project', 'Routing, context & trace inspector', 'Community provider docs'],
  },
  {
    name: 'Pro',
    price: 'Usage-based',
    per: 'BYOK · fee only on eligible modeled savings',
    blurb: 'For builders running real traffic on their own provider keys.',
    cta: 'Create workspace',
    href: '/auth?plan=pro',
    featured: true,
    features: ['Unlimited runs within your provider budget', 'Live model registry + failover', 'Savings evidence per run', 'Approvals & audit trail'],
  },
  {
    name: 'Team',
    price: 'Usage-based',
    per: 'BYOK · per-project policies',
    blurb: 'Shared workspaces with project policies and review controls.',
    cta: 'Start a team workspace',
    href: '/auth?plan=team',
    features: ['Everything in Pro', 'Projects, roles & approvals', 'Per-project reference models', 'Shared savings reporting'],
  },
  {
    name: 'Enterprise',
    price: 'Contact',
    per: 'manual onboarding in beta',
    blurb: 'Security review, tenant controls, and guided rollout — set up by hand.',
    cta: 'Contact us',
    href: '/auth?plan=enterprise',
    features: ['Security review support', 'Tenant isolation + audit export', 'Custom policies & budgets', 'Guided onboarding'],
  },
];

export function Pricing() {
  return (
    <section className="lp-section lp-alt" id="pricing" aria-labelledby="pricing-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">SIMPLE BUSINESS MODEL</p>
          <h2 id="pricing-h">Bring your keys. Pay providers directly.</h2>
          <p className="lp-lede">
            V1 is BYOK: provider inference is billed by your provider account, never marked up. The platform fee
            applies only to eligible modeled savings and stays visible beside provider cost — modeled numbers are
            never presented as invoices. Billing is beta/manual: no self-serve Stripe subscriptions or automatic
            provider invoice matching in V1.
          </p>
        </Reveal>
        <div className="lp-tiers" role="list" aria-label="Plans">
          {TIERS.map((t) => (
            <Reveal as="article" key={t.name} className={`lp-tier${(t as { featured?: boolean }).featured ? ' featured' : ''}`}>
              <span className="lp-price-tag">{t.name.toUpperCase()}</span>
              <p className="lp-tier-price"><b>{t.price}</b><span>{t.per}</span></p>
              <p className="lp-tier-blurb">{t.blurb}</p>
              <ul>
                {t.features.map((f) => (
                  <li key={f}><i aria-hidden="true">✓</i> {f}</li>
                ))}
              </ul>
              <a href={t.href} className={`lp-btn ${((t as { featured?: boolean }).featured) ? 'primary' : 'secondary'} full`}>{t.cta} →</a>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className="lp-cta">
            <a href="/pricing" className="lp-btn secondary">Full pricing details</a>
            <a href="/auth" className="lp-btn primary">Create a workspace →</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
