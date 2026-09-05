import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { useEffect } from 'react';
import { RuntimeInspector } from '../components/Inspector';
import { Composer } from '../components/Center';
import { api } from '../api/client';

const snap: any = {
  runId: 'run-1', lastSeq: 9, updatedAt: new Date().toISOString(), status: 'running', activeModelId: 'nemotron-x',
  context: { usedTokens: 42300, windowTokens: 128000, segments: [{ key: 'a', label: 'Conversation', tokensPct: 50 }, { key: 'b', label: 'Tools', tokensPct: 50 }], items: [{ id: 'c1', kind: 'file', title: 'auth/service.ts', source: 'read_file', tokens: 8000, relevance: 0.9, status: 'KEEP' }] },
  cache: { hitRate: 0.74, cachedTokens: 28300, uncachedTokens: 14000, savedUsd: 0.013, state: 'WARM', recent: [] },
  memory: { working: [{ id: 'w1', title: 'Auth bug', source: 'conv', importance: 0.9, confidence: 0.8, status: 'active' }], longterm: [] },
  tools: [{ name: 'run_tests', description: 't', status: 'enabled', calls: 2, avgLatencyMs: 2800, successRate: 0.9, lastStatus: 'running' }],
  cost: { spentUsd: 0.031, budgetUsd: 0.1, projectedUsd: 0.074, breakdown: [{ key: 'in', label: 'Model input', usd: 0.012 }] },
  latency: { currentStepMs: 1800, avgStepMs: 1600, modelMs: 1800, toolMs: 2800, totalMs: 21000, samples: [1, 2, 3] },
  routing: { currentId: 'nemotron-x', candidates: [{ modelId: 'nemotron-x', score: 0.91, costUsd: 0.021, latencyMs: 1800, factors: { quality: 0.91 } }], decision: { kind: 'model', decision: 'KEEP CURRENT MODEL', timestamp: new Date().toISOString(), factors: [{ key: 'a', label: 'Context fits', status: 'pass' }] } },
  trace: [{ seq: 1, ts: new Date().toISOString(), type: 'model.selected', label: 'Model selected', status: 'done' }],
  decisions: [], changes: [{ seq: 1, ts: new Date().toISOString(), kind: 'added', label: '+ New model detected' }],
  messages: [{ id: 'm1', role: 'user', content: 'hi', ts: new Date().toISOString() }],
};

function Seed({ children }: { children: React.ReactNode }) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    dispatch({ type: 'snap/set', snap });
    dispatch({ type: 'models/set', models: [{ id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, avgLatencyMs: 1800, reliability: 0.98, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0002, capabilities: ['coding'] }] });
    dispatch({ type: 'runs/active', id: 'run-1' });
  }, []);
  return <>{children}</>;
}

describe('inspector + layout', () => {
  it('renders tabbed inspector with live backend data', async () => {
    const { fireEvent: fire } = await import('@testing-library/react');
    render(<RuntimeProvider><Seed><RuntimeInspector /></Seed></RuntimeProvider>);
    expect(await screen.findByLabelText('Runtime inspector')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Inspector views' })).toBeInTheDocument();
    // Overview: outcome story first.
    expect(screen.getByLabelText('Current model')).toBeInTheDocument();
    expect(screen.getByLabelText('Approvals')).toBeInTheDocument();
    expect((await screen.findAllByText(/Nemotron X/)).length).toBeGreaterThan(0);
    // Decisions tab.
    fire.click(screen.getByRole('tab', { name: 'Decisions' }));
    expect(await screen.findByLabelText('Why this model?')).toBeInTheDocument();
    expect(screen.getByLabelText('Model routing')).toBeInTheDocument();
    expect(screen.getByLabelText('Model switches')).toBeInTheDocument();
    // Evidence tab.
    fire.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(await screen.findByRole('tabpanel')).toBeInTheDocument();
    expect(document.getElementById('sec-evidence')).not.toBeNull();
    expect(document.getElementById('sec-changes')).not.toBeNull();
    // Technical tab.
    fire.click(screen.getByRole('tab', { name: 'Technical' }));
    expect(await screen.findByLabelText('Execution trace')).toBeInTheDocument();
  });
  it('api client exposes typed surface (no scattered fetch)', () => {
    for (const k of ['getRuns', 'getRun', 'getModels', 'getTools', 'getMemory', 'getState', 'sendMessage', 'cancelRun', 'retryRun']) {
      expect(typeof (api as any)[k]).toBe('function');
    }
    expect(api.streamUrl('run-1')).toBe('/api/runs/run-1/events');
  });
  it('displaySnippet cleans legacy raw-JSON escapes without touching server data', async () => {
    const { displaySnippet } = await import('../components/ui');
    expect(displaySnippet('passed (session): line1\\nline2\\n  line3')).toBe('passed (session): line1 line2 line3');
    expect(displaySnippet('{"a":1}')).toBe('{"a":1}');
    expect(displaySnippet(null)).toBe('');
    expect(displaySnippet(undefined)).toBe('');
  });
  it('composer is keyboard accessible with labels', () => {
    render(<RuntimeProvider><Seed><Composer /></Seed></RuntimeProvider>);
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
  });
  it('renders markdown code and tables in assistant messages', async () => {
    const { render: r } = await import('@testing-library/react');
    const { MessageList } = await import('../components/Center');
    const msgs: any[] = [{ id: 'a1', role: 'assistant', content: '```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |', ts: new Date().toISOString() }];
    const { container } = r(<RuntimeProvider><MessageList messages={msgs} /></RuntimeProvider>);
    expect(container.querySelector('pre code')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });
  it('model switch banner renders from switch decisions', async () => {
    const { render: r, screen: scr, fireEvent } = await import('@testing-library/react');
    const { RuntimeProvider: P, useRuntime: useR } = await import('../state/store');
    const { useEffect: ue } = await import('react');
    const { RuntimeInspector: RI } = await import('../components/Inspector');
    const React = (await import('react')).default;
    const switched: any = { ...snap, decisions: [{ kind: 'model_switch', decision: 'SWITCH a → b — budget optimization (switch cost $0.0090)', timestamp: new Date().toISOString(), factors: [] }] };
    function Seed2({ children }: { children: React.ReactNode }) {
      const { dispatch } = useR();
      ue(() => { dispatch({ type: 'snap/set', snap: switched }); }, []);
      return <>{children}</>;
    }
    r(React.createElement(P, null, React.createElement(Seed2, null, React.createElement(RI, null))));
    // Switches live under the Decisions tab — select it, then expand.
    const tab = await scr.findByRole('tab', { name: 'Decisions' });
    fireEvent.click(tab);
    const toggle = await scr.findByRole('button', { name: /expand model switches/i });
    fireEvent.click(toggle);
    expect(await scr.findByText('MODEL SWITCH')).toBeInTheDocument();
  });
});
