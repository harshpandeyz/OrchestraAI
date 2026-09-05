import React from 'react';

/** Why was this context item included? Backend relevance + status only. */
export function WhyContextItem({ item }: { item: { title: string; relevance: number; kind: string; source: string; status: string } }) {
  const rel = Number(item.relevance);
  const strength = Number.isFinite(rel) ? (rel >= 0.8 ? 'High' : rel >= 0.5 ? 'Medium' : 'Low') : 'Unknown';
  return (
    <span className="oa-why" title={`Why included? ${strength} task relevance (${Number.isFinite(rel) ? rel.toFixed(2) : '—'}) · ${item.kind} · ${item.source} · ${item.status}`}>
      Why included? {strength} task relevance{Number.isFinite(rel) ? ` ${rel.toFixed(2)}` : ''} · {item.kind}
    </span>
  );
}

/** Why was this memory used? Backend confidence + importance only. */
export function WhyMemoryItem({ item }: { item: { title: string; confidence: number; importance: number; source: string } }) {
  const conf = Number(item.confidence);
  return (
    <span className="oa-why" title={`Why used? Relevant project memory from ${item.source || 'unknown source'} · confidence ${Number.isFinite(conf) ? conf.toFixed(2) : '—'} · importance ${Number(item.importance).toFixed(2)}`}>
      Why used? {item.source || 'project memory'} · confidence {Number.isFinite(conf) ? conf.toFixed(2) : '—'}
    </span>
  );
}

/** Why did the model switch? Backend reason + factors only. */
export function WhySwitch({ reason, factors }: { reason: string; factors: { label: string; status: string; detail?: string }[] }) {
  return (
    <span className="oa-why" title={`Why switch? ${reason}${factors.length ? ` · ${factors.map((f) => f.label).join('; ')}` : ''}`}>
      Why switch? {reason || 'Runtime optimization'}
    </span>
  );
}
