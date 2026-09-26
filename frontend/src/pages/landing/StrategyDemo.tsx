// Interactive orchestration demo: change task / strategy / budget and watch
// the execution strategy change. Illustrative estimates, clearly labelled —
// production routing scores your live registry.
import React, { useState } from 'react';
import { Reveal } from './hooks';

type Strategy = 'fast' | 'balanced' | 'deep' | 'multi' | 'max';

const STRATEGIES: Record<Strategy, { label: string; steps: string[]; verification: string; cost: string; time: string }> = {
  fast: { label: 'Fast', steps: ['Plan (1 pass)', 'Single agent', 'Targeted tools', 'Smoke check'], verification: 'Claimed — smoke check only', cost: '$0.05–0.15', time: '~30s' },
  balanced: { label: 'Balanced', steps: ['Plan', 'Context build', 'Primary agent + tools', 'Tests + review'], verification: 'Partially verified — tests pass', cost: '$0.20–0.60', time: '~2min' },
  deep: { label: 'Deep', steps: ['Plan + revise', 'Full context', 'Primary + reviewer agents', 'Tests + security + browser'], verification: 'Verified — full evidence', cost: '$0.60–1.50', time: '~6min' },
  multi: { label: 'Multi-agent', steps: ['Decompose', 'Research ∥ Code ∥ Security', 'Merge + test', 'Review'], verification: 'Verified — parallel evidence', cost: '$0.80–2.00', time: '~5min' },
  max: { label: 'Max reliability', steps: ['Decompose', 'Redundant agents', 'Full verification suite', 'Human review gate'], verification: 'Verified with warnings surfaced', cost: '$1.50–4.00', time: '~12min' },
};

const TASKS = ['Fix auth race condition', 'Build onboarding flow', 'Audit API security', 'Optimize slow query'] as const;

export function StrategyDemo() {
  const [task, setTask] = useState<string>(TASKS[0]);
  const [strategy, setStrategy] = useState<Strategy>('balanced');
  const [budget, setBudget] = useState(1);
  const s = STRATEGIES[strategy];
  const overBudget = budget < (strategy === 'fast' ? 0.15 : strategy === 'balanced' ? 0.6 : strategy === 'deep' ? 1.5 : strategy === 'multi' ? 2 : 4);
  return (
    <section className="lp-section" id="strategy-demo" aria-labelledby="strategy-demo-h">
      <div className="lp-wrap lp-split">
        <Reveal>
          <p className="lp-kicker">LIVE ORCHESTRATION DEMO</p>
          <h2 id="strategy-demo-h">One goal in. Orchestra decides the path.</h2>
          <p className="lp-lede">Change the task, strategy, or budget and watch the execution plan respond. Estimates are illustrative — production routing scores your live registry.</p>
          <label className="lp-field">Task
            <select value={task} onChange={(e) => setTask(e.target.value)} aria-label="Demo task">
              {TASKS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="lp-field" role="group" aria-label="Demo strategy">
            <span>Strategy</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(Object.keys(STRATEGIES) as Strategy[]).map((k) => (
                <button key={k} type="button" className="chip" aria-pressed={strategy === k} onClick={() => setStrategy(k)}>{STRATEGIES[k].label}</button>
              ))}
            </div>
          </div>
          <label className="lp-field">Budget ${budget.toFixed(2)}
            <input type="range" min={0.1} max={4} step={0.1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} aria-label="Demo budget" />
          </label>
          {overBudget && <p role="alert" style={{ color: 'var(--warn, #b45309)' }}>Budget below this strategy's illustrative range — Orchestra would suggest Fast or request a higher budget.</p>}
        </Reveal>
        <Reveal>
          <div className="lp-decision" aria-live="polite" aria-label="Resulting execution plan">
            <b className="lp-decision-title">{task}</b>
            <span className="lp-demo-tag">{s.label} · {s.cost} · {s.time}</span>
            <ol>
              {s.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <p><b>{s.verification}</b></p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
