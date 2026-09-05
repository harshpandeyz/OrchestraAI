// Illustrative demo datasets for Orchestra Intelligence landing demos ONLY.
// Hand-written story props, not measurements. Every visual that renders them
// carries a visible "Illustrative demo data" label. Never import from console
// (product) code paths that render backend data.

export const DEMO_TREND = {
  provenance: 'ILLUSTRATIVE' as const,
  granularity: 'daily' as const,
  periods: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  series: [
    { model: 'orchestra-reasoner', color: '#0C7A5C', values: [12, 18, 15, 24, 28, 26, 34] },
    { model: 'orchestra-coder', color: '#2F7AC2', values: [8, 11, 14, 13, 19, 22, 25] },
    { model: 'orchestra-efficient', color: '#8A5A00', values: [20, 22, 25, 23, 27, 29, 31] },
  ],
};

export const DEMO_SCATTER = {
  provenance: 'ILLUSTRATIVE' as const,
  points: [
    { model: 'reasoner', quality: 0.92, cost: 0.018, latencyMs: 2400, runs: 41 },
    { model: 'coder', quality: 0.89, cost: 0.011, latencyMs: 1400, runs: 88 },
    { model: 'efficient', quality: 0.78, cost: 0.003, latencyMs: 700, runs: 152 },
    { model: 'balanced', quality: 0.85, cost: 0.007, latencyMs: 1100, runs: 120 },
    { model: 'xl-context', quality: 0.83, cost: 0.009, latencyMs: 1900, runs: 35 },
  ],
};

export const DEMO_CONTEXT = {
  provenance: 'ILLUSTRATIVE' as const,
  rawTokens: 18400,
  optimizedTokens: 6200,
  cachedTokens: 2100,
  savedUsd: 0.021,
  latencyBeforeMs: 2400,
  latencyAfterMs: 1100,
};

export const DEMO_FLOW = {
  provenance: 'ILLUSTRATIVE' as const,
  stages: [
    { key: 'incoming', label: 'Incoming Task', detail: '142 observed tasks', value: 142 },
    { key: 'context', label: 'Context Analysis', detail: 'avg 9.4k tokens scoped', value: 9400 },
    { key: 'candidates', label: 'Candidate Models', detail: 'avg 4.2 evaluated', value: 4.2 },
    { key: 'analysis', label: 'Cost / Quality / Latency Analysis', detail: 'switching cost is first-class', value: null },
    { key: 'execution', label: 'Optimal Execution Path', detail: 'checkpoints + failover', value: null },
    { key: 'verification', label: 'Verification', detail: '118/142 verified modeled', value: 118 },
    { key: 'cost', label: 'Actual Cost', detail: '$4.82 metered', value: 4.82 },
    { key: 'savings', label: 'Verified Savings', detail: '$1.96 modeled savings', value: 1.96 },
  ],
};
