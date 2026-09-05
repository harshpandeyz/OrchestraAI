import React from 'react';
import { EXEC_STAGES } from './data';
import { Reveal, useCycle, useReducedMotion } from './hooks';

function ExecutionTrace() {
  const reduced = useReducedMotion();
  const progress = useCycle(EXEC_STAGES.length, 1800);
  const at = reduced ? 3 : progress;
  return (
    <div
      className="lp-trace"
      role="img"
      aria-label="Animated execution trace: task done, context done, model done, tools running, then test, result and evidence queued."
    >
      <div className="lp-trace-rail" aria-hidden="true">
        <i style={{ height: `${(at / (EXEC_STAGES.length - 1)) * 100}%` }} />
      </div>
      <ol aria-hidden="true">
        {EXEC_STAGES.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'run' : 'wait';
          return (
            <li key={s.id} className={`lp-tr-${state}`}>
              <span className="lp-tr-dot" />
              <div>
                <b>
                  {s.label} <em>{state === 'done' ? 'DONE' : state === 'run' ? 'RUNNING' : 'QUEUED'}</em>
                </b>
                <small>{s.detail}</small>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Execution() {
  return (
    <section className="lp-section lp-alt" id="execute" aria-labelledby="execute-h">
      <div className="lp-wrap lp-split">
        <Reveal>
          <p className="lp-kicker">AGENT EXECUTION</p>
          <h2 id="execute-h">Watch work happen, step by step.</h2>
          <p className="lp-lede">
            Task, context, model, tools, tests, result, evidence — a real trace, not a spinner. The evidence stage
            matters most: cost, latency and proof travel with the answer.
          </p>
          <ul className="lp-ticks">
            <li>Statuses you can poll: DONE · RUNNING · QUEUED · STANDBY</li>
            <li>Every tool call validated, budgeted and observed</li>
            <li>Failures recorded as evidence, never hidden</li>
          </ul>
        </Reveal>
        <Reveal>
          <ExecutionTrace />
        </Reveal>
      </div>
    </section>
  );
}

const FAILOVER_ROWS = [
  { from: 'PRIMARY MODEL', to: 'health check · p50 420ms', state: 'ok' },
  { from: 'HEALTH CHECK', to: 'degraded · errors rising', state: 'warn' },
  { from: 'COOLDOWN', to: 'armed · no thrash', state: 'warn' },
  { from: 'FAILOVER', to: 'standby promoted in 1.1s', state: 'fire' },
  { from: 'SECONDARY MODEL', to: 'execution continues', state: 'ok' },
] as const;

export function Reliability() {
  return (
    <section className="lp-section" id="reliability" aria-labelledby="reliability-h">
      <div className="lp-wrap lp-split flip">
        <Reveal>
          <div
            className="lp-failover"
            role="img"
            aria-label="Failover diagram: primary model degrades, cooldown arms, the standby is promoted, execution continues without losing state."
          >
            {FAILOVER_ROWS.map((r) => (
              <div key={r.from} className={`lp-fo-row lp-fo-${r.state}`} aria-hidden="true">
                <b>{r.from}</b>
                <i />
                <span>{r.to}</span>
              </div>
            ))}
            <small className="lp-visual-cap">Illustrative failover walkthrough, not a production incident.</small>
          </div>
        </Reveal>
        <Reveal>
          <p className="lp-kicker">RELIABILITY</p>
          <h2 id="reliability-h">Degraded is a signal, not a surprise.</h2>
          <p className="lp-lede">
            Health is observed per model — latency, errors, timeouts — and failover fires on evidence with cooldowns
            that prevent oscillation. Retries are bounded and idempotent; the run continues where it left off.
          </p>
          <ul className="lp-ticks">
            <li>Request-time availability, not cached optimism</li>
            <li>Cooldown + hysteresis: no A→B→A thrash</li>
            <li>Checkpoints make resume cheap after recovery</li>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
