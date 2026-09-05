// OrchestraAI console redesign: telemetry, charts, journey, shell states.
// All values derive from real snapshot fixtures — no fake runtime data.
import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { deriveTelemetry } from '../console/telemetry';
import { LineChart, BarMeter, MetricCard } from '../console/charts';
import { missionStages } from '../components/Center';
import { ConsoleSidebar } from '../console/ConsoleSidebar';
import { ConsoleTopBar } from '../console/ConsoleTopBar';
import { LiveIntelligence } from '../console/LiveIntelligence';
import type { RuntimeSnapshot } from '../types';

function baseSnap(over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const ts = new Date().toISOString();
  return {
    runId: 'run-1', lastSeq: 12, updatedAt: ts, status: 'running', activeModelId: 'claude-sonnet',
    context: { usedTokens: 18200, windowTokens: 32000, segments: [{ key: 'a', label: 'Task', tokensPct: 60 }, { key: 'b', label: 'Tools', tokensPct: 40 }], items: [] },
    cache: { hitRate: 0.42, hits: 5, misses: 7, cachedTokens: 8000, uncachedTokens: 10000, savedUsd: 0.004, state: 'WARM', recent: [{ type: 'cache.hit', ts, detail: 'Cache hit' }] },
    memory: { working: [], longterm: [] },
    tools: [
      { name: 'read_files', description: 'Read repo files', status: 'enabled', calls: 3, avgLatencyMs: 420, successRate: 1, lastStatus: 'success' },
      { name: 'run_tests', description: 'Run test suite', status: 'enabled', calls: 1, avgLatencyMs: 1800, successRate: 1, lastStatus: 'running' },
    ],
    cost: { spentUsd: 0.014, budgetUsd: 0.05, projectedUsd: 0.02, breakdown: [{ key: 'model', label: 'Model', usd: 0.014 }] },
    latency: { currentStepMs: 420, avgStepMs: 390, modelMs: 300, toolMs: 420, totalMs: 14200, samples: [380, 410, 420, 390] },
    routing: {
      currentId: 'claude-sonnet',
      candidates: [
        { modelId: 'claude-sonnet', score: 94, costUsd: 0.014, latencyMs: 420, factors: { quality: 0.95, cost: 0.8, latency: 0.9, reliability: 1 } },
        { modelId: 'gpt-5', score: 91, costUsd: 0.02, latencyMs: 500, factors: { quality: 0.93, cost: 0.7, latency: 0.85, reliability: 0.95 } },
      ],
      decision: { kind: 'model_selection', decision: 'SELECT claude-sonnet — best quality per cost', timestamp: ts, factors: [{ key: 'q', label: 'Quality fits', status: 'pass' }] },
    },
    trace: [
      { seq: 1, ts, type: 'task.created', label: 'Task: refactor auth', status: 'done' },
      { seq: 2, ts, type: 'model.selected', label: 'Model selected: claude-sonnet', status: 'done' },
    ],
    decisions: [], changes: [],
    messages: [
      { id: 'u1', role: 'user', content: 'Refactor auth', ts },
      { id: 'a1', role: 'assistant', content: 'On it.', ts },
    ],
    series: Array.from({ length: 10 }, (_, i) => ({
      t: ts, step: i + 1, inputTokens: 1000 + i * 100, outputTokens: 200 + i * 20,
      cachedTokens: 300, cost: 0.001 * (i + 1), latencyMs: 380 + i * 5,
      cacheHitRate: 0.4, contextUtil: 0.4 + i * 0.02, model: 'claude-sonnet',
    })),
    ...over,
  } as RuntimeSnapshot;
}

function Seed({ snap, children, runs }: any) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    if (snap) dispatch({ type: 'snap/set', snap });
    // Live connection: the stream hook owns this in production; fixtures
    // set it explicitly so LIVE/STALE/DISCONNECTED render truthfully.
    dispatch({ type: 'conn/set', conn: { status: 'connected', lastUpdate: new Date().toISOString() } });
    dispatch({ type: 'runs/set', runs: runs || [
      { id: 'run-1', title: 'Refactor auth', taskMode: 'code', status: snap?.status || 'running', createdAt: new Date(Date.now() - 14200).toISOString(), updatedAt: new Date().toISOString(), activeModelId: 'claude-sonnet', budget: 0.05, spent: 0.014 },
      { id: 'run-2', title: 'Update docs', taskMode: 'general', status: 'completed', createdAt: new Date(Date.now() - 90000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString(), activeModelId: 'gpt-5', budget: 0.05, spent: 0.008 },
    ] });
    dispatch({ type: 'runs/active', id: 'run-1' });
    dispatch({ type: 'models/set', models: [{ id: 'claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic', status: 'healthy', contextWindow: 200000, quality: 0.94, avgLatencyMs: 420, reliability: 0.98, inputPer1k: 0.003, outputPer1k: 0.015, cachedPer1k: 0.0003, capabilities: ['coding'] }] });
  }, []);
  return <>{children}</>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('console telemetry view-model', () => {
  it('derives latency/cost/context/routing/tools from the snapshot, never invented', () => {
    const t = deriveTelemetry(baseSnap());
    expect(t).not.toBeNull();
    expect(t!.latency.current).toBe(420);
    expect(t!.latency.average).toBe(390);
    expect(t!.cost.spent).toBe(0.014);
    expect(t!.cost.remaining).toBeCloseTo(0.036);
    expect(t!.context.utilization).toBeCloseTo(18200 / 32000);
    expect(t!.routing.selectedId).toBe('claude-sonnet');
    expect(t!.routing.candidates.length).toBe(2);
    expect(t!.tools.active.map((x) => x.name)).toEqual(['run_tests']);
    expect(t!.tools.totalCalls).toBe(4);
    expect(t!.currentModel).toBe('claude-sonnet');
  });
  it('returns null without a snapshot and unknown for missing fields', () => {
    expect(deriveTelemetry(null)).toBeNull();
    const t = deriveTelemetry(baseSnap({ latency: { currentStepMs: NaN, avgStepMs: NaN, modelMs: NaN, toolMs: NaN, totalMs: NaN, samples: [] } as any, series: [] }));
    expect(t!.latency.current).toBeNull();
    expect(t!.latency.series).toEqual([]);
  });
  it('bounds series to the last 60 points', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ t: new Date().toISOString(), step: i, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0.001, latencyMs: 100 + i, cacheHitRate: 0.5, contextUtil: 0.5, model: 'm' }));
    const t = deriveTelemetry(baseSnap({ series: big }));
    expect(t!.latency.series.length).toBeLessThanOrEqual(60);
    expect(t!.cost.series.length).toBeLessThanOrEqual(60);
  });
  it('marks terminal vs live vs busy truthfully', () => {
    expect(deriveTelemetry(baseSnap({ status: 'running' }))!.live).toBe(true);
    expect(deriveTelemetry(baseSnap({ status: 'completed' }))!.terminal).toBe(true);
    expect(deriveTelemetry(baseSnap({ status: 'failed' }))!.terminal).toBe(true);
    expect(deriveTelemetry(baseSnap({ status: 'idle' }))!.busy).toBe(false);
  });
});

describe('console charts', () => {
  it('renders a live line chart with accessible summary', () => {
    const { container } = render(<LineChart values={[380, 410, 420, 390]} height={64} format={(v) => `${v}ms`} label="Latency" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.cx-line')).not.toBeNull();
    expect(screen.getByRole('img', { name: /Latency chart/ })).toBeInTheDocument();
  });
  it('shows a waiting state when telemetry is insufficient', () => {
    render(<LineChart values={[]} height={64} format={(v) => `${v}`} label="Cost" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Waiting for telemetry/);
    render(<LineChart values={[5]} height={64} format={(v) => `${v}`} label="Latency" />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });
  it('renders budget meter with accessible label', () => {
    render(<BarMeter value={0.014} max={0.05} label="Budget" format={(v) => `$${v}`} />);
    expect(screen.getByRole('img', { name: /Budget/ })).toBeInTheDocument();
  });
  it('renders metric cards with live pulse', () => {
    render(<MetricCard label="Cost" value="$0.014" sub="of $0.050 budget" live spark={[1, 2, 3]} sparkLabel="Cost trend" />);
    expect(screen.getByRole('status', { name: /Cost: \$0\.014/ })).toBeInTheDocument();
  });
});

describe('console mission journey', () => {
  it('covers all seven truthful stages for a running task', () => {
    const stages = missionStages(baseSnap());
    expect(stages.map((s) => s.label)).toEqual(['Task', 'Understand', 'Context', 'Choose', 'Execute', 'Verify', 'Result']);
    expect(stages[0].state).toBe('done');
    expect(stages.find((s) => s.state === 'active')).toBeTruthy();
  });
  it('completes every stage on success and fails honestly', () => {
    expect(missionStages(baseSnap({ status: 'completed' })).every((s) => s.state === 'done')).toBe(true);
    const failed = missionStages(baseSnap({ status: 'failed' }));
    expect(failed[failed.length - 1].state).toBe('failed');
  });
  it('never invents context or model stages', () => {
    const empty = missionStages(baseSnap({ context: { usedTokens: 0, windowTokens: 128000, segments: [], items: [] }, activeModelId: null, messages: [] }));
    expect(empty.find((s) => s.id === 'context')!.state).not.toBe('done');
    expect(empty.find((s) => s.id === 'choose')!.state).not.toBe('done');
  });
  it('treats execution as proof of a task even before the user message lands', () => {
    const ts = new Date().toISOString();
    const mid = missionStages(baseSnap({
      status: 'running',
      messages: [{ id: 'a1', role: 'assistant', content: 'Working on it', ts }],
    }));
    expect(mid.find((s) => s.id === 'task')!.state).toBe('done');
    expect(mid.find((s) => s.id === 'task')!.desc).toBe('Request captured');
  });
});

describe('console shell', () => {
  it('renders topbar with brand, live status, command entry, and new run', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><ConsoleTopBar /></Seed></RuntimeProvider>);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByText('OrchestraAI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new run/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
  });
  it('shows live state while running and completion for terminal runs', () => {
    const { unmount } = render(<RuntimeProvider><Seed snap={baseSnap({ status: 'running' })}><ConsoleTopBar /></Seed></RuntimeProvider>);
    expect(screen.getByRole('status').textContent).toMatch(/live/i);
    unmount();
    render(<RuntimeProvider><Seed snap={baseSnap({ status: 'completed' })}><ConsoleTopBar /></Seed></RuntimeProvider>);
    expect(screen.getByRole('status').textContent).toMatch(/complete/i);
  });
  it('navigation changes view when a journey item is picked', () => {
    function Probe() {
      const { state } = useRuntime();
      return <span data-testid="view">{state.ui.view}</span>;
    }
    render(<RuntimeProvider><Seed snap={baseSnap()}><ConsoleSidebar /><Probe /></Seed></RuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /^models/i }));
    expect(screen.getByTestId('view').textContent).toBe('models');
  });
  it('run list selects the active run with recognizable status', () => {
    function Probe() {
      const { state } = useRuntime();
      return <span data-testid="active">{state.server.activeRunId}</span>;
    }
    render(<RuntimeProvider><Seed snap={baseSnap()}><ConsoleSidebar /><Probe /></Seed></RuntimeProvider>);
    expect(screen.getByRole('listbox', { name: /recent runs/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /update docs/i }));
    expect(screen.getByTestId('active').textContent).toBe('run-2');
  });
  it('filters runs by search without losing the list', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><ConsoleSidebar /></Seed></RuntimeProvider>);
    fireEvent.change(screen.getByLabelText('Filter runs'), { target: { value: 'docs' } });
    expect(screen.queryByRole('option', { name: /refactor auth/i })).toBeNull();
    expect(screen.getByRole('option', { name: /update docs/i })).toBeInTheDocument();
  });
  it('sidebar collapse control is labeled and reachable', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><ConsoleSidebar /></Seed></RuntimeProvider>);
    expect(screen.getByRole('button', { name: /collapse navigation sidebar/i })).toBeInTheDocument();
  });
});

describe('console live intelligence states', () => {
  it('shows one canvas: model, big numerals, routing context, tools, approvals', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    expect(screen.getByLabelText('Current model')).toBeInTheDocument();
    expect(screen.getAllByText('Claude Sonnet').length).toBeGreaterThan(0);
    // Large numerals carry the story, not metric tiles.
    expect(screen.getByLabelText('Latency')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost')).toBeInTheDocument();
    expect(screen.getByLabelText('Context')).toBeInTheDocument();
    expect(screen.getByLabelText('Tools')).toBeInTheDocument();
    expect(screen.getByLabelText('Approvals')).toBeInTheDocument();
  });
  it('renders routing candidates with the selected route highlighted', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /expand model routing/i }));
    expect(screen.getByLabelText(/claude sonnet, score 94/i)).toBeInTheDocument();
    expect(screen.getByText(/selected/i)).toBeInTheDocument();
  });
  it('renders tool health with the active tool pulsing', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    expect(screen.getByRole('status', { name: /tool run_tests running/i })).toBeInTheDocument();
  });
  it('renders completion and failure states distinctly', () => {
    const { unmount } = render(<RuntimeProvider><Seed snap={baseSnap({ status: 'completed' })}><LiveIntelligence /></Seed></RuntimeProvider>);
    expect(screen.getByRole('status', { name: /intelligence final/i })).toBeInTheDocument();
    expect(screen.getByText(/final state/i)).toBeInTheDocument();
    unmount();
    render(<RuntimeProvider><Seed snap={baseSnap({ status: 'failed' })}><LiveIntelligence /></Seed></RuntimeProvider>);
    expect(screen.getByRole('status', { name: /runtime health: needs attention/i })).toBeInTheDocument();
  });
  it('shows approval decision points with approve/deny actions', () => {
    const ts = new Date().toISOString();
    const withApproval = baseSnap({
      execution: {
        pendingApprovals: [{ id: 'ap-1', actionType: 'shell', title: 'Run shell command', description: 'npm test', riskLevel: 'medium', reason: 'Verify deps', status: 'pending' }],
        waitingForApproval: true,
      } as any,
    });
    void ts;
    render(<RuntimeProvider><Seed snap={withApproval}><LiveIntelligence /></Seed></RuntimeProvider>);
    expect(screen.getByLabelText(/approval required: run shell command/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve this change/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
  });
  it('keeps an accessible label on every interactive region', () => {
    const { container } = render(<RuntimeProvider><Seed snap={baseSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    const buttons = container.querySelectorAll('button');
    buttons.forEach((b) => {
      expect(b.getAttribute('aria-label') || b.textContent?.trim()).toBeTruthy();
    });
  });
});
