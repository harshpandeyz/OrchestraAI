import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { effectiveStatus, humanizeEvent, liveActivity, provenanceLabel, toMilestones } from '../lib/semantics';
import { ExecutionTimeline } from '../components/execution/ExecutionTimeline';
import { OutcomeCard } from '../components/outcome/OutcomeCard';
import { EvidencePanel } from '../components/outcome/EvidencePanel';
import { ApprovalCenter } from '../components/execution/ApprovalCenter';
import { ResourceBar } from '../components/execution/ResourceBar';
import { api } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function baseSnap(over: any = {}): any {
  return {
    runId: 'run-1', lastSeq: 9, updatedAt: new Date().toISOString(), status: 'completed', activeModelId: 'model-x',
    context: { usedTokens: 18400, windowTokens: 128000, segments: [], items: [] },
    cache: { hitRate: 0.5, cachedTokens: 100, uncachedTokens: 100, savedUsd: 0.01, state: 'WARM', recent: [] },
    memory: { working: [], longterm: [] },
    tools: [{ name: 'read', description: 't', status: 'enabled', calls: 3, avgLatencyMs: 100, successRate: 1 }],
    cost: { spentUsd: 0.18, budgetUsd: 0.5, projectedUsd: 0.18, breakdown: [], source: 'metered (usage × provider pricing)' },
    latency: { currentStepMs: 1, avgStepMs: 1, modelMs: 1, toolMs: 1, totalMs: 31400, samples: [1] },
    routing: { currentId: 'model-x', candidates: [], decision: null },
    trace: [
      { seq: 1, ts: new Date().toISOString(), type: 'planning', label: 'Planning', status: 'done' },
      { seq: 2, ts: new Date().toISOString(), type: 'context.built', label: 'Context built', status: 'done' },
      { seq: 3, ts: new Date().toISOString(), type: 'model.selected', label: 'Model selected: model-x', status: 'done' },
      { seq: 4, ts: new Date().toISOString(), type: 'tool.completed', label: 'read: SUCCESS', status: 'done' },
      { seq: 5, ts: new Date().toISOString(), type: 'run.completed', label: 'Task completed', status: 'done' },
    ],
    decisions: [], changes: [{ seq: 1, ts: new Date().toISOString(), kind: 'added', label: '+ Model selected' }],
    messages: [{ id: 'a1', role: 'assistant', content: 'Fixed the bug.', ts: new Date().toISOString() }],
    ...over,
  };
}

function Seed({ snap, children }: any) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    if (snap) dispatch({ type: 'snap/set', snap });
    dispatch({ type: 'runs/set', runs: [{ id: 'run-1', title: 'Fix auth bug', taskMode: 'debug', status: 'completed', createdAt: new Date(Date.now() - 31400).toISOString(), updatedAt: new Date().toISOString(), activeModelId: 'model-x', budget: 0.5, spent: 0.18 }] });
    dispatch({ type: 'runs/active', id: 'run-1' });
  }, []);
  return <>{children}</>;
}

describe('semantics: centralized event mapping', () => {
  it('translates technical codes to human copy without inventing success', () => {
    expect(humanizeEvent('tool.started', 'x').title).toMatch(/Running tool/);
    expect(humanizeEvent('model.switched', 'x').title).toMatch(/Switched models/);
    expect(humanizeEvent('budget.exceeded', 'x').tone).toBe('err');
    const unknown = humanizeEvent('future.magic', 'mystery');
    expect(unknown.tone).toBe('neutral');
    expect(unknown.title).toMatch(/future.magic/);
  });
  it('derives live activity from real snapshot state', () => {
    const snap = baseSnap({ status: 'running', tools: [{ name: 'read', lastStatus: 'running' }] });
    expect(liveActivity(snap)).toMatch(/Running read/);
    expect(liveActivity(baseSnap({ status: 'completed' }))).toBeNull();
  });
  it('groups trace noise into milestones with causality', () => {
    const ms = toMilestones(baseSnap().trace);
    expect(ms.map((m) => m.stage)).toEqual(['plan', 'context', 'model', 'action', 'result']);
    expect(ms.length).toBeGreaterThan(0);
  });
  it('labels provenance without mixing observed and estimated', () => {
    expect(provenanceLabel('observed', 'cost').text).toBe('OBSERVED');
    expect(provenanceLabel('metered (usage × provider pricing)', 'cost').text).toBe('OBSERVED');
    expect(provenanceLabel('demo', 'quality').text).toBe('DEMO');
    expect(provenanceLabel(undefined, 'cost').text).toBe('UNKNOWN');
  });
  it('never downgrades a terminal run record with a non-terminal snapshot', () => {
    expect(effectiveStatus('failed', 'failed')).toBe('failed');
    expect(effectiveStatus('idle', 'failed')).toBe('failed');
    expect(effectiveStatus('running', 'running')).toBe('running');
    expect(effectiveStatus('completed', 'running')).toBe('completed');
    expect(effectiveStatus(null, null)).toBe('idle');
  });
});

describe('outcome-first surfaces', () => {
  it('timeline renders human milestones, not raw codes', () => {
    render(<RuntimeProvider><ExecutionTimeline trace={baseSnap().trace} status="completed" /></RuntimeProvider>);
    expect(screen.getByLabelText('Execution timeline')).toBeInTheDocument();
    expect(screen.getByText('PLAN')).toBeInTheDocument();
    expect(screen.queryByText('MODEL_EXECUTION_STARTED')).toBeNull();
  });
  it('timeline has an honest empty state', () => {
    render(<RuntimeProvider><ExecutionTimeline trace={[]} status="idle" /></RuntimeProvider>);
    expect(screen.getByText('No execution steps yet.')).toBeInTheDocument();
  });
  it('outcome card dominates with proof and real numbers', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><OutcomeCard snap={baseSnap()} /></Seed></RuntimeProvider>);
    expect(screen.getByLabelText('Task completed')).toBeInTheDocument();
    expect(screen.getByText('TASK COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('Proof')).toBeInTheDocument();
    expect(screen.queryByText(/92% confident/)).toBeNull();
  });
  it('continue starts a linked follow-up run (completed stays read-only)', async () => {
    const create = vi.spyOn(api, 'createRun').mockResolvedValue({ run: { id: 'run-2' } } as any);
    vi.spyOn(api, 'getRuns').mockResolvedValue({ runs: [] } as any);
    render(<RuntimeProvider><Seed snap={baseSnap()}><OutcomeCard snap={baseSnap()} /></Seed></RuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(String(create.mock.calls[0][0])).toMatch(/Follow-up/);
  });
  it('evidence links every claim to a source, inventing nothing', () => {
    render(<RuntimeProvider><EvidencePanel snap={baseSnap()} /></RuntimeProvider>);
    expect(screen.getByText('Outcome')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getAllByText(/OBSERVED/).length).toBeGreaterThan(0);
  });
  it('approvals show an honest empty state with real tool permissions', () => {
    render(<RuntimeProvider><Seed snap={baseSnap()}><ApprovalCenter snap={baseSnap()} /></Seed></RuntimeProvider>);
    expect(screen.getByText(/No pending approvals/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tool permissions')).toBeInTheDocument();
  });
  it('resource bar stays secondary and real', () => {
    render(<RuntimeProvider><ResourceBar snap={baseSnap()} run={{ createdAt: new Date(Date.now() - 31400).toISOString() }} /></RuntimeProvider>);
    expect(screen.getByRole('status', { name: 'Run resources' })).toBeInTheDocument();
  });
});
