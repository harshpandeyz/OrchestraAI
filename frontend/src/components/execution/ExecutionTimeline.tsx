import React, { useMemo } from 'react';
import { humanizeEvent, stageLabel, toMilestones } from '../../lib/semantics';
import { fmtTime } from '../ui';
import { IconCheck, IconX } from '../icons';

/**
 * Execution timeline: transforms raw SSE/trace noise into understandable
 * milestones with causality (PLAN → CONTEXT → MODEL → ACTION → VERIFY →
 * RESULT). Groups repeats; technical codes stay in the Technical tab.
 */
export function ExecutionTimeline({ trace, status }: {
  trace: { seq: number; ts: string; type: string; label: string; status: string }[];
  status: string;
}) {
  const milestones = useMemo(() => toMilestones(trace || []), [trace]);
  const busy = status === 'running' || status === 'planning' || status === 'waiting';
  if (!milestones.length) {
    return (
      <div className="oa-timeline-empty" role="status">
        <b>No execution steps yet.</b>
        <span>Milestones appear here as the run progresses — plan, context, model, actions, verification, result.</span>
      </div>
    );
  }
  const shown = milestones.slice(-16);
  return (
    <ol className="oa-timeline" aria-label="Execution timeline">
      {shown.map((m, i) => {
        const last = i === shown.length - 1;
        const state = m.status === 'failed' ? 'failed' : last && busy ? 'active' : 'done';
        const h = humanizeEvent(m.eventType, m.detail);
        return (
          <li key={m.id} className={`oa-tl-row ${state}`}>
            <div className="oa-tl-rail" aria-hidden="true">
              <span className="oa-tl-dot">
                {state === 'done' ? <IconCheck size={11} /> : state === 'failed' ? <IconX size={11} /> : <span className="oa-tl-pulse" />}
              </span>
              {i < shown.length - 1 && <span className="oa-tl-line" />}
            </div>
            <div className="oa-tl-body">
              <div className="oa-tl-top">
                <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
                <span className="oa-tl-stage">{stageLabel(m.stage)}</span>
              </div>
              <div className="oa-tl-title">{h.title}</div>
              {m.detail && m.detail !== h.title && <div className="oa-tl-detail">{m.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
