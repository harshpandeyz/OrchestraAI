import React, { useState } from 'react';
import { DECISION_FACTORS, HERO_CANDIDATES } from './data';
import { Reveal } from './hooks';

interface NodeProps {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  hot?: boolean;
  dim?: boolean;
  focusable?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

function GNode({ x, y, w, h, title, sub, hot, dim, focusable, onFocus, onBlur }: NodeProps) {
  const inner = (
    <g
      className={`lp-g-node${hot ? ' hot' : ''}${dim ? ' dim' : ''}`}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      onFocus={onFocus}
      onBlur={onBlur}
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? 'button' : undefined}
      aria-label={focusable ? `${title}: ${sub}` : undefined}
    >
      <rect x={x} y={y} width={w} height={h} rx={12} />
      <text x={x + 14} y={y + 25} className="lp-g-title">
        {title}
      </text>
      <text x={x + 14} y={y + 43} className="lp-g-sub">
        {sub}
      </text>
    </g>
  );
  return inner;
}

function Edge({ d, hot, dim }: { d: string; hot?: boolean; dim?: boolean }) {
  return <path d={d} className={`lp-g-edge${hot ? ' hot' : ''}${dim ? ' dim' : ''}`} />;
}

/**
 * Infrastructure-grade routing graph. Hovering a model (graph or panel)
 * spotlights it on both sides; the decided route stays illuminated.
 */
function RoutingGraph({ focus, setFocus }: { focus: string | null; setFocus: (id: string | null) => void }) {
  const dimFor = (id: string) => focus !== null && focus !== id;
  return (
    <svg
      viewBox="0 0 760 470"
      className="lp-graph"
      role="img"
      aria-label="Routing graph: a request passes context and the orchestrator, fans out to three scored model candidates, the selected model flows through tools to a verified result."
    >
      <defs>
        <linearGradient id="lpEdgeHot" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a85ff" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      {/* top spine */}
      <Edge d="M174 54 H 224" hot />
      <Edge d="M380 54 H 430" hot />
      {/* orchestrator fan-out */}
      <Edge d="M521 84 C 521 130, 140 130, 140 176" dim={dimFor('a')} />
      <Edge d="M521 84 C 521 140, 380 140, 380 176" hot={!dimFor('b')} dim={dimFor('b')} />
      <Edge d="M521 84 C 521 130, 620 130, 620 176" dim={dimFor('c')} />
      {/* models to tools */}
      <Edge d="M220 244 C 220 290, 220 290, 220 326" dim={dimFor('a')} />
      <Edge d="M380 244 C 380 290, 300 290, 300 326" hot={!dimFor('b')} dim={dimFor('b')} />
      <Edge d="M540 244 C 540 290, 380 290, 380 326" dim={dimFor('c')} />
      {/* tools to result */}
      <Edge d="M300 386 H 454" hot />

      <GNode x={24} y={24} w={150} h={60} title="Request" sub="task + policy" hot />
      <GNode x={230} y={24} w={150} h={60} title="Context" sub="bounded evidence" hot />
      <GNode x={436} y={24} w={170} h={60} title="Orchestrator" sub="scores candidates" hot />
      <GNode
        x={60}
        y={180}
        w={160}
        h={64}
        title="GPT-class"
        sub="score 82"
        dim={dimFor('a')}
        focusable
        onFocus={() => setFocus('a')}
        onBlur={() => setFocus(null)}
      />
      <GNode
        x={300}
        y={180}
        w={160}
        h={64}
        title="Claude-class"
        sub="score 96 · selected"
        hot={!dimFor('b')}
        dim={dimFor('b')}
        focusable
        onFocus={() => setFocus('b')}
        onBlur={() => setFocus(null)}
      />
      <GNode
        x={540}
        y={180}
        w={160}
        h={64}
        title="Gemini-class"
        sub="score 78 · standby"
        dim={dimFor('c')}
        focusable
        onFocus={() => setFocus('c')}
        onBlur={() => setFocus(null)}
      />
      <GNode x={140} y={326} w={160} h={60} title="Tools" sub="validated · budgeted" hot />
      <GNode x={460} y={326} w={160} h={60} title="Result" sub="$0.009 · evidence ×4" hot />
    </svg>
  );
}

function DecisionPanel({ focus, setFocus }: { focus: string | null; setFocus: (id: string | null) => void }) {
  const active = HERO_CANDIDATES.find((c) => c.id === focus) ?? HERO_CANDIDATES.find((c) => c.selected)!;
  return (
    <div className="lp-decision lp-decision-tall" id="models">
      <div className="lp-browser-bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>routing · decision factors</span>
      </div>
      <b className="lp-decision-title">Why this model?</b>
      <span className="lp-demo-tag">Illustrative routing decision</span>
      <div className="lp-cand-list" role="list">
        {HERO_CANDIDATES.map((c) => (
          <div
            key={c.id}
            role="listitem"
            tabIndex={0}
            className={`lp-cand${c.selected ? ' sel' : ''}${focus === c.id ? ' focus' : ''}`}
            onMouseEnter={() => setFocus(c.id)}
            onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(c.id)}
            onBlur={() => setFocus(null)}
            aria-label={`${c.name}: quality ${c.quality}, latency ${c.latencyMs} milliseconds, cost ${c.costUsd} dollars, reliability ${c.reliability}, decision score ${c.decision}`}
          >
            <div className="lp-cand-top">
              <b>{c.name}</b>
              {c.selected && <em>selected</em>}
              {c.standby && <em className="sb">standby</em>}
            </div>
            <div className="lp-cand-grid">
              <span>
                quality <b>{c.quality}</b>
              </span>
              <span>
                latency <b>{c.latencyMs}ms</b>
              </span>
              <span>
                cost <b>${c.costUsd.toFixed(3)}</b>
              </span>
              <span>
                reliability <b>{c.reliability}</b>
              </span>
            </div>
            <div className="lp-eng-bar">
              <i style={{ width: `${c.decision}%` }} />
            </div>
            <small>decision score {c.decision} · {c.note}</small>
          </div>
        ))}
      </div>
      <div className="lp-factor-row" aria-label="Decision factors">
        {DECISION_FACTORS.map((f) => (
          <span key={f.key} className={`lp-factor-chip${f.state === 'hold' ? ' hold' : ''}`} title={f.detail}>
            {f.label}
          </span>
        ))}
      </div>
      <p className="lp-active-note" aria-live="polite">
        Viewing <b>{active.name}</b> — {active.note}.
      </p>
    </div>
  );
}

export function Routing() {
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <section className="lp-section lp-alt" id="how" aria-labelledby="how-h">
      <div className="lp-wrap">
        <Reveal>
          <p className="lp-kicker">HOW IT WORKS</p>
          <h2 id="how-h">Request → understand → route → execute → evaluate.</h2>
          <p className="lp-lede">
            The same loop the console shows live: planning, context build, model select, execution, observation and
            re-optimization — until done. Hover a model to inspect it.
          </p>
        </Reveal>
        <Reveal className="lp-route-grid">
          <div className="lp-route-graph">
            <RoutingGraph focus={focus} setFocus={setFocus} />
            <p className="lp-visual-cap">
              Candidate names and scores shown are illustrative demo data. Production routing scores your live
              registry — never a hard-coded list.
            </p>
          </div>
          <DecisionPanel focus={focus} setFocus={setFocus} />
        </Reveal>
      </div>
    </section>
  );
}
