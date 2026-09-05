import React from 'react';
import { HERO_CANDIDATES, HERO_REQUEST } from './data';
import { useCycle, useReducedMotion } from './hooks';

const STAGE_LABELS = ['request', 'context', 'route', 'select', 'execute', 'result'] as const;

const STAGE_READOUT: Record<(typeof STAGE_LABELS)[number], string> = {
  request: 'request received · policy attached',
  context: 'context built · 3 files · 1 memory · bounded',
  route: 'scoring 3 candidates · quality · cost · latency · reliability',
  select: 'Claude-class selected · net benefit 96',
  execute: 'tools running · search → read → run_tests',
  result: 'done · cost $0.009 · 420ms · evidence kept',
};

/**
 * Living decision-engine visualization. A request flows through context,
 * orchestration, scored candidates, tools and result; the active stage is
 * driven by a slow cycle so the page demonstrates flow → decision → state
 * → evidence. Under reduced motion it renders the decided end-state once.
 */
function OrchestrationVisual() {
  const reduced = useReducedMotion();
  const cycle = useCycle(STAGE_LABELS.length, 2200);
  const stage = (reduced ? 3 : cycle) as number;
  const live = (i: number) => (reduced ? i <= 3 : i === stage);
  return (
    <div
      className="lp-engine"
      role="img"
      aria-label="Animated diagram: a user request flows through the context engine and orchestrator, three model candidates are scored on quality, cost, latency and reliability, the winner is selected, tools and tests run, and a verified result with cost and evidence is returned."
    >
      <div className="lp-eng-head" aria-hidden="true">
        <span className="lp-eng-live">
          <i />
          decision engine
        </span>
        <span className="lp-eng-readout">{STAGE_READOUT[STAGE_LABELS[stage]]}</span>
      </div>

      <div className={`lp-eng-stage${live(0) ? ' live' : ''}`} data-stage="request" aria-hidden="true">
        <span className="lp-node-tag">USER REQUEST</span>
        <b>“{HERO_REQUEST}”</b>
        <small>task + budget $0.10 + quality floor</small>
      </div>

      <div className="lp-eng-link" aria-hidden="true">
        <i className="lp-eng-pulse" />
      </div>

      <div className={`lp-eng-stage${live(1) ? ' live' : ''}`} data-stage="context" aria-hidden="true">
        <span className="lp-node-tag blue">CONTEXT ENGINE</span>
        <b>Bounded evidence, not dumps</b>
        <div className="lp-chips">
          <span>auth.ts</span>
          <span>tests/</span>
          <span>memory</span>
          <span>history</span>
        </div>
      </div>

      <div className="lp-eng-link" aria-hidden="true">
        <i className="lp-eng-pulse" />
      </div>

      <div className={`lp-eng-stage lp-eng-route${live(2) ? ' live' : ''}`} data-stage="route" aria-hidden="true">
        <span className="lp-node-tag blue">ORCHESTRATOR</span>
        <b>Scoring live candidates</b>
        <div className="lp-eng-factors">
          {['quality', 'cost', 'latency', 'reliability', 'context fit'].map((f, i) => (
            <span key={f} className={live(2) && i <= stage - 1 ? 'on' : live(2) ? 'tick' : ''}>
              {f}
            </span>
          ))}
        </div>
      </div>

      <div className="lp-eng-cands" aria-hidden="true">
        {HERO_CANDIDATES.map((c) => {
          const decided = reduced || stage >= 3;
          const hot = !!c.selected && decided;
          const dim = decided && !c.selected;
          return (
            <div key={c.id} className={`lp-eng-cand${c.selected ? ' sel' : ''}${dim ? ' dim' : ''}${hot ? ' hot' : ''}`}>
              <div className="lp-eng-cand-top">
                <i className={c.standby ? 'idle' : 'on'} />
                <b>{c.name}</b>
                <em>{c.tag}</em>
              </div>
              <div className="lp-eng-bar">
                <i style={{ width: `${c.decision}%` }} />
              </div>
              <div className="lp-eng-cand-meta">
                <span>
                  score <b>{c.decision}</b>
                </span>
                <span>
                  ${c.costUsd.toFixed(3)} · {c.latencyMs}ms
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="lp-eng-link" aria-hidden="true">
        <i className="lp-eng-pulse" />
      </div>

      <div className={`lp-eng-stage${live(4) ? ' live' : ''}`} data-stage="execute" aria-hidden="true">
        <span className="lp-node-tag violet">TOOLS + TESTS</span>
        <div className="lp-eng-tools">
          <span className={stage >= 4 || reduced ? 'done' : ''}>search ✓</span>
          <span className={stage >= 4 || reduced ? 'done' : ''}>read ✓</span>
          <span className={stage >= 4 && !reduced ? 'run' : reduced ? 'done' : ''}>
            run_tests {stage >= 4 || reduced ? '✓' : '…'}
          </span>
        </div>
        <small>validated · budgeted · observed</small>
      </div>

      <div className="lp-eng-link" aria-hidden="true">
        <i className="lp-eng-pulse" />
      </div>

      <div className={`lp-eng-stage lp-eng-result${live(5) ? ' live' : ''}`} data-stage="result" aria-hidden="true">
        <span className="lp-node-tag green">RESULT · VERIFIED</span>
        <b>Auth refactored · tests green ✓</b>
        <div className="lp-eng-proof">
          <span>$0.009</span>
          <span>420ms</span>
          <span>evidence ×4</span>
        </div>
      </div>

      <p className="lp-visual-cap">
        Models come from your connected providers (<code>GET /api/models</code>). Candidate names and scores shown are
        illustrative demo data.
      </p>
    </div>
  );
}

export function Hero() {
  return (
    <section className="lp-hero">
      <div className="lp-hero-inner">
        <div className="lp-hero-copy">
          <p className="lp-kicker">
            <span className="lp-kicker-pill">ADAPTIVE AGENT RUNTIME</span> BYOK · DEMO INCLUDED
          </p>
          <h1>
            Let every AI request choose <span className="lp-accent">its own best path.</span>
          </h1>
          <p className="lp-sub">
            OrchestraAI is the intelligent execution layer for AI applications: it understands each task, routes it to
            the right model, runs the work with validated tools, and proves what happened — balancing{' '}
            <b>quality, cost, latency and reliability</b> on every single request.
          </p>
          <div className="lp-cta">
            <a href="/auth" className="lp-btn primary large">
              Start building →
            </a>
            <a href="/console" className="lp-btn secondary large">
              Open the console
            </a>
          </div>
          <p className="lp-note">
            <span aria-hidden="true">✓</span> Demo mode included · Your provider keys stay yours · No fake metrics, ever
          </p>
        </div>
        <OrchestrationVisual />
      </div>
      <div className="lp-trust" aria-label="What the runtime connects to">
        <div>
          <b>OpenAI · Anthropic · OpenRouter</b>
          <span>BYOK adapters with native streaming</span>
        </div>
        <div>
          <b>Live model registry</b>
          <span>health, capability &amp; pricing metadata</span>
        </div>
        <div>
          <b>Validated tool runs</b>
          <span>search, read, test, patch — budgeted</span>
        </div>
        <div>
          <b>One event stream</b>
          <span>snapshots + replayable SSE</span>
        </div>
      </div>
    </section>
  );
}
