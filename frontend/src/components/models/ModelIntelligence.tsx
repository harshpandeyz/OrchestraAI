// Model intelligence: Pareto (quality vs cost) + lifecycle states.
// Only measured points render — unknowns are omitted, never zero-filled.
import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { WhyPopover } from '../v2/cards';
import type { ModelInfo } from '../../types';

export interface ModelProfile {
  modelId: string;
  strengths?: string[];
  taskPerformance?: Record<string, { successRate?: number | null; samples?: number }>;
  providerHealth?: { healthy?: boolean | null; lastError?: string | null };
}

export function useModelProfiles() {
  const [profiles, setProfiles] = useState<Record<string, ModelProfile>>({});
  useEffect(() => {
    let cancelled = false;
    api.getModelIntelligence().then(({ profiles: p }) => {
      if (cancelled) return;
      const map: Record<string, ModelProfile> = {};
      (p || []).forEach((x) => { map[x.modelId] = x; });
      setProfiles(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return profiles;
}

export function lifecycleOf(m: ModelInfo): { state: string; why: string[] } {
  const s = String(m.status || '').toLowerCase();
  if (s === 'healthy') return { state: 'Active', why: ['Provider reports healthy', m.observed?.samples ? `${m.observed.samples} observed runs` : 'No observed runs yet'] };
  if (s === 'degraded') return { state: 'Degraded', why: [m.observed?.lastErrorCode ? `Last error ${m.observed.lastErrorCode}` : 'Provider reports degraded'] };
  if (s === 'down' || s === 'unavailable') return { state: 'Retired', why: ['Provider reports unavailable — excluded from routing'] };
  return { state: 'Unknown', why: ['No lifecycle signal recorded'] };
}

export function ParetoChart({ models }: { models: ModelInfo[] }) {
  const pts = models
    .filter((m) => typeof m.quality === 'number' && typeof m.outputPer1k === 'number' && m.quality !== null && m.outputPer1k !== null)
    .map((m) => ({ id: m.id, name: m.name, q: m.quality as number, c: (m.outputPer1k as number) * 1000 }));
  if (pts.length < 2) {
    return <p className="v2-meta" role="status">Pareto needs at least 2 models with measured quality + pricing — unknowns are omitted, never estimated.</p>;
  }
  const W = 560; const H = 220; const P = 36;
  const maxC = Math.max(...pts.map((p) => p.c));
  const x = (c: number) => P + (c / maxC) * (W - P * 2);
  const y = (q: number) => H - P - q * (H - P * 2);
  // Pareto frontier: sort by cost asc, keep running max quality.
  const sorted = [...pts].sort((a, b) => a.c - b.c);
  const frontier: typeof pts = [];
  let best = -1;
  sorted.forEach((p) => { if (p.q > best) { frontier.push(p); best = p.q; } });
  const path = frontier.map((p, i) => `${i ? 'L' : 'M'} ${x(p.c).toFixed(1)} ${y(p.q).toFixed(1)}`).join(' ');
  return (
    <div role="img" aria-label={`Pareto frontier across ${pts.length} measured models. Cheaper models left, higher quality up.`}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border-soft)', borderRadius: 12 }}>
        <path d={path} fill="none" stroke="var(--selection)" strokeWidth={2} strokeDasharray="5 4" />
        {pts.map((p) => (
          <g key={p.id}>
            <title>{`${p.name} — quality ${p.q.toFixed(2)}, $${p.c.toFixed(2)}/1M out`}</title>
            <circle cx={x(p.c)} cy={y(p.q)} r={5} fill="var(--primary)" opacity={0.9} />
            <text x={x(p.c) + 8} y={y(p.q) + 4} fontSize={10} fill="var(--text-subtle)">{p.name.slice(0, 18)}</text>
          </g>
        ))}
        <text x={P} y={H - 8} fontSize={10} fill="var(--text-faint)">cheaper →</text>
        <text x={8} y={P - 8} fontSize={10} fill="var(--text-faint)">quality ↑</text>
      </svg>
      <p className="v2-meta">Frontier in violet — non-dominated trade-offs only. {pts.length} measured models; unmeasured omitted.</p>
    </div>
  );
}

export function ModelWhy({ model, profile }: { model: ModelInfo; profile?: ModelProfile }) {
  const lines = [
    ...((model.capabilities || []).length ? [`Capabilities: ${model.capabilities.join(', ')}`] : []),
    ...(profile?.strengths?.length ? profile.strengths.slice(0, 3) : []),
    ...(model.reliability != null ? [`${(model.reliability * 100).toFixed(0)}% observed reliability`] : []),
    ...(profile?.providerHealth?.lastError ? [`Provider note: ${profile.providerHealth.lastError}`] : []),
  ];
  const lc = lifecycleOf(model);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="pill sm neutral">{lc.state.toUpperCase()}</span>
      <WhyPopover title={`Why is ${model.name} ${lc.state}?`} lines={lc.why.concat(lines)} meta={profile ? 'Profile: measured where available' : 'Profile: not measured yet'} />
    </span>
  );
}
