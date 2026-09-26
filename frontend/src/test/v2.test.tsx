// V2 behavior tests: routes, graph, verification states, cards, tables.
// Behavior over snapshots; unknown stays unknown.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseRoute, buildRoute } from '../lib/routes';
import { snapshotToGraph } from '../components/run/ExecutionGraph';
import { verificationState } from '../components/run/RunStudio';
import { DecisionCard, RiskCard, WhyPopover, Status } from '../components/v2/cards';
import { DataTable } from '../components/v2/table';
import { RuntimeProvider } from '../state/store';
import { ExecutionGraph } from '../components/run/ExecutionGraph';
import { RunStudio } from '../components/run/RunStudio';

const baseSnap: any = {
  runId: 'run-1', lastSeq: 5, updatedAt: new Date().toISOString(), status: 'running', activeModelId: 'm1',
  context: { usedTokens: 1000, windowTokens: 8000, segments: [{ key: 'a', label: 'Repo', tokensPct: 0.5 }], items: [] },
  cache: { hitRate: 0.5, cachedTokens: 10, uncachedTokens: 10, savedUsd: 0, state: 'WARM', recent: [] },
  memory: { working: [], longterm: [] },
  tools: [], cost: { spentUsd: 0.01, budgetUsd: 0.1, projectedUsd: 0.02, breakdown: [] },
  latency: { currentStepMs: 1, avgStepMs: 1, modelMs: 1, toolMs: 1, totalMs: 1, samples: [] },
  routing: { currentId: 'm1', candidates: [], decision: null },
  trace: [{ seq: 1, ts: new Date().toISOString(), type: 'task.created', label: 'Task', status: 'done' }],
  decisions: [], changes: [], messages: [{ id: 'u1', role: 'user', content: 'Fix bug', ts: new Date().toISOString() }],
  execution: null,
};

describe('v2 routes', () => {
  it('parses /console/runs/:id with deep link', () => {
    expect(parseRoute('/console/runs/abc', '')).toEqual({ view: 'run', runId: 'abc' });
  });
  it('parses canonical surfaces', () => {
    expect(parseRoute('/console/models', '').view).toBe('models');
    expect(parseRoute('/console/agents', '').view).toBe('agents');
    expect(parseRoute('/console/approvals', '').view).toBe('approvals');
  });
  it('falls back to legacy ?view=', () => {
    expect(parseRoute('/console', '?view=models').view).toBe('models');
  });
  it('builds run deep links', () => {
    expect(buildRoute('run', 'abc')).toBe('/console/runs/abc');
    expect(buildRoute('models')).toBe('/console/models');
  });
});

describe('v2 execution graph', () => {
  it('derives nodes from plan steps with deps', () => {
    const snap = { ...baseSnap, execution: { plan: { runId: 'run-1', version: 1, updatedAt: new Date().toISOString(), steps: [{ id: 'a', description: 'Plan', status: 'completed', dependencies: [] }, { id: 'b', description: 'Build', status: 'running', dependencies: ['a'] }] } } };
    const nodes = snapshotToGraph(snap);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].deps).toEqual(['a']);
    expect(nodes[0].status).toBe('verified');
  });
  it('falls back to observed trace stages without inventing parallelism', () => {
    const nodes = snapshotToGraph(baseSnap);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].deps).toEqual([]);
  });
  it('renders graph with keyboard controls', () => {
    render(<RuntimeProvider><ExecutionGraph snap={baseSnap} /></RuntimeProvider>);
    expect(screen.getByTestId('execution-graph')).toBeInTheDocument();
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });
});

describe('v2 verification states', () => {
  it('distinguishes claimed vs verified vs failed', () => {
    expect(verificationState({ ...baseSnap, status: 'completed' })).toBe('claimed');
    expect(verificationState({ ...baseSnap, status: 'failed' })).toBe('failed');
    const verified = { ...baseSnap, status: 'completed', execution: { verifications: [{ kind: 'tests', passed: true, summary: '184 tests' }] }, trace: [...baseSnap.trace, { seq: 2, ts: new Date().toISOString(), type: 'verification.passed', label: 'ok', status: 'done' }] };
    expect(verificationState(verified)).toBe('verified');
    expect(verificationState({ ...baseSnap, status: 'running' })).toBe('unknown');
  });
});

describe('v2 cards', () => {
  it('DecisionCard shows Unknown when no decision recorded', () => {
    render(<DecisionCard decision={null} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
  it('RiskCard shows Unknown without backend risk metadata', () => {
    render(<RiskCard />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
  it('WhyPopover reveals structured reasons on click', () => {
    render(<WhyPopover title="Why this model?" lines={['strong coding success']} />);
    fireEvent.click(screen.getByRole('button', { name: /Why\?/ }));
    expect(screen.getByText(/strong coding success/)).toBeInTheDocument();
  });
  it('Status maps execution states', () => {
    const { rerender } = render(<Status status="running" />);
    expect(screen.getByRole('status').textContent).toBe('RUNNING');
    rerender(<Status status={null} />);
    expect(screen.getByRole('status').textContent).toBe('UNKNOWN');
  });
});

describe('v2 data table', () => {
  const rows = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }];
  it('sorts, filters, and paginates', () => {
    render(
      <DataTable
        rows={rows}
        ariaLabel="T"
        searchKeys={(r) => r.name}
        pageSize={1}
        columns={[{ key: 'name', header: 'Name', render: (r) => <span>{r.name}</span>, sortValue: (r) => r.name }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Sort by Name/ }));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter table'), { target: { value: 'Beta' } });
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});

describe('v2 run studio', () => {
  it('renders Goal→Evidence tabs with honest empty states', () => {
    render(<RuntimeProvider><RunStudio snap={baseSnap} messages={baseSnap.messages} /></RuntimeProvider>);
    for (const label of ['Goal', 'Plan', 'Execution', 'Artifacts', 'Verification', 'Evidence', 'Activity']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Verification' }));
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });
});
