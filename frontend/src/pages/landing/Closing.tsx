import React from 'react';
import { Mark } from './Nav';
import { Reveal } from './hooks';

export function FinalCTA() {
  return (
    <section className="lp-final-wrap">
      <Reveal className="lp-final" labelledBy="final-h">
        <p className="lp-kicker light">GET STARTED</p>
        <h2 id="final-h">Route every request intelligently.</h2>
        <p>
          Open a workspace, stay in Demo or connect a provider key, and watch the first routing decision explain
          itself end to end.
        </p>
        <div className="lp-cta lp-center">
          <a href="/auth" className="lp-btn primary large white">
            Create your workspace →
          </a>
          <a href="/console" className="lp-btn ghost-light large">
            Open the console
          </a>
        </div>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-foot-grid">
        <div>
          <a href="/" className="public-brand">
            <Mark />
            OrchestraAI
          </a>
          <p>Adaptive agent runtime — quality, cost, latency and reliability on every request.</p>
        </div>
        <nav aria-label="Product">
          <b>Product</b>
          <a href="#how">How it works</a>
          <a href="#models">Models</a>
          <a href="#console">Console</a>
          <a href="/pricing">Pricing</a>
        </nav>
        <nav aria-label="Workspace">
          <b>Workspace</b>
          <a href="/console">Open console</a>
          <a href="/auth">Create workspace</a>
          <a href="/auth">Sign in</a>
        </nav>
      </div>
      <div className="lp-wrap lp-foot-base">
        <span>© 2026 OrchestraAI</span>
        <span>Demo mode labeled · LIVE requires a verified provider key</span>
      </div>
    </footer>
  );
}
