import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import '../styles/public.css';

function Mark() { return <span className="public-mark" aria-hidden="true"><i /><i /><i /></span>; }

/** Reveal-on-scroll: adds .in when a section enters the viewport. Respects reduced motion via CSS. */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.lp-reveal'));
    if (!('IntersectionObserver' in window) || !els.length) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function Nav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
    <div className="lp-announce lp-announce-static" role="note">
      <span className="lp-announce-dot" aria-hidden="true" />
      <span><b>LIVE provider streaming</b> via OpenRouter &amp; Anthropic adapters — BYOK, Demo mode included.</span>
      <a href="/auth">Get started →</a>
    </div>
    <header className="lp-navwrap">
      <div className="lp-nav">
        <a href="/" className="public-brand" aria-label="OrchestraAI home"><Mark />OrchestraAI</a>
        <nav aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#models">Models</a>
          <a href="#console">Console</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="lp-nav-actions">
          <a href="/auth" className="lp-link">Sign in</a>
          <a href="/console" className="lp-btn secondary small">Open console</a>
          <a href="/auth" className="lp-btn primary small">Get started</a>
          <button
            className="lp-menu-btn"
            aria-expanded={open}
            aria-controls="lp-mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <nav id="lp-mobile-menu" className="lp-mobile" aria-label="Mobile">
          <a href="#how" onClick={() => setOpen(false)}>How it works</a>
          <a href="#models" onClick={() => setOpen(false)}>Models</a>
          <a href="#console" onClick={() => setOpen(false)}>Console</a>
          <a href="#pricing" onClick={() => setOpen(false)}>Pricing</a>
          <div className="lp-mobile-cta">
            <a href="/auth" className="lp-btn primary full" onClick={() => setOpen(false)}>Get started</a>
            <a href="/console" className="lp-btn secondary full" onClick={() => setOpen(false)}>Open console</a>
            <a href="/auth" className="lp-link" onClick={() => setOpen(false)}>Sign in</a>
          </div>
        </nav>
      )}
    </header>
    </>
  );
}

/** Hero routing visual: request → router → models → tools → result. Pure HTML/CSS/SVG. */
function RoutingVisual() {
  return (
    <div className="lp-hero-visual" role="img" aria-label="Diagram: a user request enters the intelligent router, which picks the best available model, runs tools, and returns a result.">
      <div className="lp-flow" aria-hidden="true">
        <svg className="lp-flow-lines" viewBox="0 0 640 380" preserveAspectRatio="none" focusable="false">
          <defs>
            <linearGradient id="lpFlow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#38bdf8" />
              <stop offset="0.5" stopColor="#0a85ff" />
              <stop offset="1" stopColor="#6366f1" />
            </linearGradient>
          </defs>
          <path className="lp-wire" d="M150 190 C 230 190, 230 90, 300 90" />
          <path className="lp-wire d2" d="M150 190 C 230 190, 230 190, 300 190" />
          <path className="lp-wire d3" d="M150 190 C 230 190, 230 290, 300 290" />
          <path className="lp-wire hot" d="M410 190 C 470 190, 470 140, 530 140" />
          <path className="lp-wire" d="M410 190 C 470 190, 470 240, 530 240" />
        </svg>
        <div className="lp-col lp-col-request">
          <div className="lp-node lp-request">
            <span className="lp-node-tag">USER REQUEST</span>
            <b>Refactor auth flow</b>
            <small>task + budget + quality floor</small>
          </div>
        </div>
        <div className="lp-col lp-col-router">
          <div className="lp-node lp-router">
            <span className="lp-router-pulse" />
            <span className="lp-node-tag blue">INTELLIGENT ROUTER</span>
            <b>Adaptive routing layer</b>
            <div className="lp-chips">
              <span>quality</span><span>cost</span><span>latency</span><span>reliability</span><span>context fit</span>
            </div>
          </div>
          <div className="lp-model-stack">
            <div className="lp-model"><i className="on" /><b>Candidate A</b><small>from registry</small></div>
            <div className="lp-model active"><i className="on" /><b>Candidate B · selected</b><small>best net benefit</small></div>
            <div className="lp-model"><i className="idle" /><b>Candidate C</b><small>standby / failover</small></div>
          </div>
        </div>
        <div className="lp-col lp-col-exec">
          <div className="lp-node lp-tools">
            <span className="lp-node-tag violet">TOOLS + EXECUTION</span>
            <b>search · read · test · patch</b>
            <small>validated, budgeted, observed</small>
          </div>
          <div className="lp-node lp-result">
            <span className="lp-node-tag green">RESULT</span>
            <b>Done, with proof ✓</b>
            <small>outcome · cost · evidence</small>
          </div>
        </div>
      </div>
      <p className="lp-visual-cap">Models come from your connected providers (<code>GET /api/models</code>). The router scores them on real policy — never a hard-coded list.</p>
    </div>
  );
}

const VALUES = [
  { t: 'Intelligent model selection', d: 'Every task is scored against the live registry — capability, context fit and policy — before a single token is spent.' },
  { t: 'Lower unnecessary cost', d: 'Total task cost is the target: routing, context size, cache reuse, retries and switching cost together.' },
  { t: 'Latency awareness', d: 'Slow or degraded paths lose. The router weighs observed latency against the quality you require.' },
  { t: 'Reliability & failover', d: 'Health is observed, not assumed. Failover happens on evidence, with cooldowns that prevent thrash.' },
  { t: 'Context-aware execution', d: 'Bounded evidence replaces raw dumps. History and memory stay selective so prompts stay lean.' },
  { t: 'Built-in observability', d: 'Decisions, factors, alternatives, cost and evidence stream live — structured, never free-text guesses.' },
];

const STEPS = [
  { n: '01', t: 'Request', d: 'You describe the task, budget and constraints. Nothing runs without an explicit policy.' },
  { n: '02', t: 'Understand', d: 'The runtime builds bounded context — files, memory, history — scored for relevance.' },
  { n: '03', t: 'Route', d: 'Candidates from GET /api/models are scored on quality, cost, latency, reliability and context fit.' },
  { n: '04', t: 'Execute', d: 'Tools run with validation and budgets; provider streaming flows back over live SSE.' },
  { n: '05', t: 'Evaluate', d: 'Outcomes, cost and evidence are reconciled. Learning updates only on proven results.' },
];

export function LandingPage() {
  useReveal();
  return <div className="marketing lp">
    <Nav />
    <main>
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <p className="lp-kicker"><span className="lp-kicker-pill">ADAPTIVE AGENT RUNTIME</span> BYOK · DEMO INCLUDED</p>
            <h1>Route every request to the <span className="lp-accent">right model.</span></h1>
            <p className="lp-sub">OrchestraAI is an adaptive execution layer: it picks the best model for each task, runs the work with validated tools, and proves what happened — balancing <b>quality, cost, latency and reliability</b> so you don&apos;t manage models by hand.</p>
            <div className="lp-cta">
              <a href="/auth" className="lp-btn primary large">Start building →</a>
              <a href="/console" className="lp-btn secondary large">Open the console</a>
            </div>
            <p className="lp-note"><span aria-hidden="true">✓</span> Demo mode included · Your provider keys stay yours · No fake metrics, ever</p>
            <dl className="lp-pipeline" aria-label="How a request flows">
              <div><dt>Request</dt><dd>→</dd></div>
              <div><dt>Router</dt><dd>→</dd></div>
              <div><dt>Model</dt><dd>→</dd></div>
              <div><dt>Tools</dt><dd>→</dd></div>
              <div><dt>Result</dt><dd></dd></div>
            </dl>
          </div>
          <RoutingVisual />
        </div>
        <div className="lp-trust" aria-label="What the runtime connects to">
          <div><b>OpenAI · Anthropic · OpenRouter</b><span>BYOK adapters with native streaming</span></div>
          <div><b>Live model registry</b><span>health, capability &amp; pricing metadata</span></div>
          <div><b>Validated tool runs</b><span>search, read, test, patch — budgeted</span></div>
          <div><b>One event stream</b><span>snapshots + replayable SSE</span></div>
        </div>
      </section>

      <section className="lp-section lp-reveal" id="value" aria-labelledby="value-h">
        <div className="lp-wrap">
          <p className="lp-kicker">WHY ORCHESTRAAI</p>
          <h2 id="value-h">An execution layer that earns its keep.</h2>
          <p className="lp-lede">Not a gateway with a new logo — a control plane that makes each request cheaper, faster or more reliable only when the evidence supports it.</p>
          <div className="lp-cards">
            {VALUES.map((v) => (
              <article key={v.t} className="lp-card">
                <span className="lp-check" aria-hidden="true">✓</span>
                <h3>{v.t}</h3>
                <p>{v.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-alt lp-reveal" id="how" aria-labelledby="how-h">
        <div className="lp-wrap">
          <p className="lp-kicker">HOW IT WORKS</p>
          <h2 id="how-h">Request → understand → route → execute → evaluate.</h2>
          <p className="lp-lede">The same loop the console shows live: planning, context build, model select, execution, observation and re-optimization — until done.</p>
          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="lp-step-n" aria-hidden="true">{s.n}</span>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-section lp-reveal" id="models" aria-labelledby="models-h">
        <div className="lp-wrap lp-split">
          <div>
            <p className="lp-kicker">MODEL INTELLIGENCE</p>
            <h2 id="models-h">You describe the task. The runtime picks the model.</h2>
            <p className="lp-lede">No hard-coded catalog in the UI — the console renders only <code>GET /api/models</code>. Each candidate carries capability, context window, observed latency, reliability and pricing metadata.</p>
            <ul className="lp-factors">
              <li><span>Quality</span><i style={{ width: '92%' }} /><b>floor held</b></li>
              <li><span>Cost</span><i style={{ width: '64%' }} /><b>total task</b></li>
              <li><span>Latency</span><i style={{ width: '71%' }} /><b>observed</b></li>
              <li><span>Reliability</span><i style={{ width: '84%' }} /><b>health-gated</b></li>
              <li><span>Context fit</span><i style={{ width: '78%' }} /><b>bounded</b></li>
              <li><span>Switch cost</span><i style={{ width: '32%' }} /><b>hysteresis</b></li>
            </ul>
            <p className="lp-fine">Switching is never free: cooldowns, hysteresis and a per-task switch cap prevent oscillation. “No safe switch found” keeps the current model — honestly.</p>
          </div>
          <div className="lp-decision" aria-label="Illustrative routing decision">
            <div className="lp-browser-bar" aria-hidden="true"><i /><i /><i /><span>routing · decision factors</span></div>
            <b className="lp-decision-title">Why this model?</b>
            <div className="lp-factor pass"><span>✓</span><div><b>Quality floor satisfied</b><small>capability + context fit pass policy</small></div></div>
            <div className="lp-factor pass"><span>✓</span><div><b>Net benefit beats switching cost</b><small>retry, cache-loss and latency included</small></div></div>
            <div className="lp-factor warn"><span>!</span><div><b>Failover armed, not firing</b><small>degraded candidates stay standby</small></div></div>
            <div className="lp-decision-foot"><span>STRUCTURED DECISION</span><b>factors + alternatives + reason →</b></div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-alt lp-reveal" id="console" aria-labelledby="console-h">
        <div className="lp-wrap">
          <p className="lp-kicker">THE ACTUAL PRODUCT</p>
          <h2 id="console-h">This is the console you&apos;ll use.</h2>
          <p className="lp-lede">Three panels — runs, workspace, runtime intelligence — with the journey strip, resource line and outcome-first evidence. Preview below mirrors the real layout; open it live.</p>
          <div className="lp-browser" aria-label="Illustrative preview of the OrchestraAI console">
            <div className="lp-browser-bar" aria-hidden="true"><i /><i /><i /><span>orchestra / console — illustrative preview</span><em>LIVE / DEMO BADGE</em></div>
            <div className="lp-browser-body">
              <div className="lp-b-side" aria-hidden="true"><i className="on" /><i /><i /><i /><i /></div>
              <div className="lp-b-main">
                <div className="lp-b-head"><div><small>EXAMPLE RUN · NO ACCOUNT DATA</small><strong>Refactor auth flow</strong></div><span className="lp-pill">OPTIMIZING</span></div>
                <ol className="lp-journey" aria-hidden="true"><li className="done">Task</li><li className="done">Context</li><li className="active">Model</li><li>Execute</li><li>Done</li></ol>
                <p className="lp-b-res" aria-hidden="true">cost $0.004 / $0.10 · 1.8s · 2 tools · 0 switches</p>
                <div className="lp-b-rows" aria-hidden="true">
                  <div><span className="lp-dot g" /><div><b>Route selected</b><small>quality floor satisfied · context fits</small></div></div>
                  <div><span className="lp-dot b" /><div><b>Tool completed · run_tests</b><small>2 failing assertions → evidence kept</small></div></div>
                  <div><span className="lp-dot v" /><div><b>Provider stream</b><small>usage captured · pricing snapshot attached</small></div></div>
                </div>
              </div>
              <aside className="lp-b-insp" aria-hidden="true"><b>Runtime inspector</b><span>model · factors</span><span>context · why-included</span><span>cost · canonical record</span><span>evidence · proof list</span></aside>
            </div>
            <div className="lp-browser-foot"><span>STRUCTURE ONLY · NO ACCOUNT DATA</span><a href="/console">Open the live console →</a></div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-reveal" id="pricing" aria-labelledby="pricing-h">
        <div className="lp-wrap lp-split">
          <div>
            <p className="lp-kicker">SIMPLE BUSINESS MODEL</p>
            <h2 id="pricing-h">Bring your keys. Pay providers directly.</h2>
            <p className="lp-lede">V1 is BYOK: provider inference is billed by your provider account, never marked up. The platform fee applies only to eligible modeled savings and stays visible beside provider cost — modeled numbers are never presented as invoices.</p>
            <div className="lp-cta"><a href="/auth" className="lp-btn primary">Create a workspace →</a><a href="#console" className="lp-btn secondary">See the console</a></div>
          </div>
          <div className="lp-price" aria-label="BYOK plan summary">
            <span className="lp-price-tag">BYOK PLAN</span>
            <p className="lp-price-num"><b>0%</b> provider markup</p>
            <ul>
              <li><i aria-hidden="true">✓</i> Provider usage paid directly by you</li>
              <li><i aria-hidden="true">✓</i> Fee only on eligible modeled savings</li>
              <li><i aria-hidden="true">✓</i> Demo mode labeled; LIVE needs a verified key</li>
              <li><i aria-hidden="true">✓</i> Savings estimates stay estimates — not billing</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="lp-final lp-reveal" aria-labelledby="final-h">
        <p className="lp-kicker light">GET STARTED</p>
        <h2 id="final-h">Route every request intelligently.</h2>
        <p>Open a workspace, stay in Demo or connect a provider key, and watch the first routing decision explain itself end to end.</p>
        <div className="lp-cta lp-center">
          <a href="/auth" className="lp-btn primary large white">Create your workspace →</a>
          <a href="/console" className="lp-btn ghost-light large">Open the console</a>
        </div>
      </section>
    </main>
    <footer className="lp-footer">
      <div className="lp-wrap lp-foot-grid">
        <div><a href="/" className="public-brand"><Mark />OrchestraAI</a><p>Adaptive agent runtime — quality, cost, latency and reliability on every request.</p></div>
        <nav aria-label="Product"><b>Product</b><a href="#how">How it works</a><a href="#models">Models</a><a href="#console">Console</a><a href="#pricing">Pricing</a></nav>
        <nav aria-label="Workspace"><b>Workspace</b><a href="/console">Open console</a><a href="/auth">Create workspace</a><a href="/auth">Sign in</a></nav>
      </div>
      <div className="lp-wrap lp-foot-base"><span>© 2026 OrchestraAI</span><span>Demo mode labeled · LIVE requires a verified provider key</span></div>
    </footer>
  </div>;
}

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('signup'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { if (mode === 'signup') await api.signup(email, password, name); else await api.login(email, password); window.location.assign('/console'); } catch (err) { setError(err instanceof Error ? err.message.replace(/^API \d+ [^:]+:?\s*/, '') : 'Unable to continue'); } finally { setBusy(false); } };
  return <div className="auth-page"><div className="auth-card"><a href="/" className="public-brand"><Mark />OrchestraAI</a><div className="auth-tabs"><button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Create workspace</button><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button></div><h1>{mode === 'signup' ? 'Start with a clean baseline.' : 'Welcome back.'}</h1><p>{mode === 'signup' ? 'Create your workspace. Connect provider keys after you enter the console.' : 'Continue to your OrchestraAI control center.'}</p><form onSubmit={submit}>{mode === 'signup' && <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}<label>Work email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label>Password<input required type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />{mode === 'signup' && <small>Use at least 12 characters.</small>}</label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="public-button full" disabled={busy}>{busy ? 'Working…' : mode === 'signup' ? 'Create workspace →' : 'Sign in →'}</button></form><a className="back-link" href="/">← Back to OrchestraAI</a></div></div>;
}
