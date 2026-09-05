import React from 'react';
import { Reveal, useCycle, useReducedMotion } from './hooks';

const FLOW = ['Request', 'Understand', 'Route', 'Execute', 'Evaluate', 'Learn'];

/** Thin animated lifecycle strip: the whole product story in six words. */
export function CapabilityStrip() {
  const reduced = useReducedMotion();
  const cycle = useCycle(FLOW.length, 1600);
  return (
    <div className="lp-strip" role="img" aria-label="Request flows to understand, route, execute, evaluate, then learn.">
      <div className="lp-strip-track" aria-hidden="true">
        {FLOW.map((s, i) => (
          <React.Fragment key={s}>
            <span className={`lp-strip-node${!reduced && i === cycle ? ' live' : ''}${!reduced && i < cycle ? ' done' : ''}`}>
              {s}
            </span>
            {i < FLOW.length - 1 && <i className="lp-strip-wire" />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

interface Story {
  kicker: string;
  title: string;
  body: string;
  points: string[];
  visual: React.ReactNode;
}

function RouteBars() {
  return (
    <div className="lp-mini" aria-hidden="true">
      <div className="lp-mini-row">
        <span>task-A</span>
        <i>
          <b style={{ width: '82%' }} />
        </i>
        <em>Claude-class</em>
      </div>
      <div className="lp-mini-row">
        <span>task-B</span>
        <i>
          <b className="alt" style={{ width: '64%' }} />
        </i>
        <em>GPT-class</em>
      </div>
      <div className="lp-mini-row">
        <span>task-C</span>
        <i>
          <b className="alt2" style={{ width: '48%' }} />
        </i>
        <em>Gemini-class</em>
      </div>
      <small>each task scored before a token is spent</small>
    </div>
  );
}

function ToolChips() {
  return (
    <div className="lp-mini" aria-hidden="true">
      <div className="lp-mini-chips">
        <span className="done">search ✓</span>
        <span className="done">read ✓</span>
        <span className="run">run_tests …</span>
        <span>patch</span>
      </div>
      <small>validated · budgeted · approval-gated</small>
    </div>
  );
}

function EventLines() {
  return (
    <div className="lp-mini lp-mini-events" aria-hidden="true">
      <p>
        <code>model.selected</code>
        <b>Claude-class · net benefit 96</b>
      </p>
      <p>
        <code>tool.completed</code>
        <b>run_tests · 1.8s</b>
      </p>
      <p>
        <code>cost.updated</code>
        <b>$0.009 / $0.10</b>
      </p>
      <small>structured events, never free-text guesses</small>
    </div>
  );
}

function TrendSpark() {
  return (
    <div className="lp-mini" aria-hidden="true">
      <svg viewBox="0 0 220 64" className="lp-spark" focusable="false" role="img" aria-label="Illustrative trend lines: quality rising while cost falls.">
        <path d="M4 52 C 40 50, 60 44, 84 40 S 140 30, 164 22 S 200 14, 216 10" fill="none" stroke="#0a85ff" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M4 20 C 50 24, 90 34, 130 40 S 190 50, 216 54" fill="none" stroke="#0e9f6e" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="5 5" />
        <circle cx="216" cy="10" r="3.5" fill="#0a85ff" />
      </svg>
      <div className="lp-mini-legend">
        <span>
          <i className="b" /> quality ↑
        </span>
        <span>
          <i className="g" /> cost ↓
        </span>
      </div>
      <small>illustrative demo data</small>
    </div>
  );
}

const STORIES: Story[] = [
  {
    kicker: 'INTELLIGENT ROUTING',
    title: 'Every task gets a model decision.',
    body: 'Candidates come from your live registry — capability, context window, observed latency, reliability, pricing. Each task is scored before a single token is spent, and the winner has to beat the cost of switching.',
    points: ['No hard-coded model list, ever', 'Quality floor held by policy', 'Switching cost with hysteresis'],
    visual: <RouteBars />,
  },
  {
    kicker: 'EXECUTION',
    title: 'The model is only the beginning.',
    body: 'Responses don\u2019t end the job — tools do. Search, read, test and patch run validated, budgeted and approval-gated, with provider streaming flowing back live until the outcome is verified.',
    points: ['Validated tool runs with budgets', 'Human approval where risk demands it', 'Live SSE, not polling'],
    visual: <ToolChips />,
  },
  {
    kicker: 'OBSERVABILITY',
    title: 'See why every decision happened.',
    body: 'Factors, alternatives, cost records and evidence stream as structured events. When a run surprises you, the reason is one click away — replayable, auditable, exportable.',
    points: ['Decision factors + alternatives', 'Canonical cost per model call', 'Replayable event history'],
    visual: <EventLines />,
  },
  {
    kicker: 'OPTIMIZATION',
    title: 'Quality, cost, latency and reliability move together.',
    body: 'Routing, context size, cache reuse, retries and failover are one optimization problem with total task cost as the target — learned only from proven results, never vibes.',
    points: ['Total task cost is the target', 'Learning updates on proof only', 'Cooldowns prevent thrash'],
    visual: <TrendSpark />,
  },
];

export function Why() {
  return (
    <section className="lp-section" id="product" aria-labelledby="product-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">WHY ORCHESTRAAI</p>
          <h2 id="product-h">An execution layer that earns its keep.</h2>
          <p className="lp-lede">
            Not a gateway with a new logo — a control plane that makes each request cheaper, faster or more reliable
            only when the evidence supports it.
          </p>
        </Reveal>
        <div className="lp-stories">
          {STORIES.map((s, i) => (
            <Reveal as="article" key={s.kicker} className={`lp-story${i % 2 ? ' flip' : ''}`}>
              <div className="lp-story-copy">
                <p className="lp-kicker sm">{s.kicker}</p>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <ul>
                  {s.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div className="lp-story-visual">{s.visual}</div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
