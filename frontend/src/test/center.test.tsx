import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { Composer, MessageList, RunHeader, journeySteps, renderMarkdown } from '../components/Center';
import { api } from '../api/client';

function baseSnap(over: any = {}): any {
  return {
    runId: 'run-1', lastSeq: 9, updatedAt: new Date().toISOString(), status: 'running', activeModelId: 'nemotron-x',
    context: { usedTokens: 42300, windowTokens: 128000, segments: [], items: [] },
    cache: { hitRate: 0.74, cachedTokens: 1, uncachedTokens: 1, savedUsd: 0.01, state: 'WARM', recent: [] },
    memory: { working: [], longterm: [] },
    tools: [{ name: 'search', description: 't', status: 'enabled', calls: 1, avgLatencyMs: 100, successRate: 1 }],
    cost: { spentUsd: 0.034, budgetUsd: 0.5, projectedUsd: 0.07, breakdown: [] },
    latency: { currentStepMs: 1, avgStepMs: 1, modelMs: 1, toolMs: 1, totalMs: 1, samples: [1] },
    routing: { currentId: 'nemotron-x', candidates: [], decision: null },
    trace: [], decisions: [], changes: [], messages: [],
    ...over,
  };
}
const modelList: any[] = [
  { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.9, avgLatencyMs: 100, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0002, capabilities: ['coding'] },
];
const runList: any[] = [
  { id: 'run-1', title: 'Fix authentication issue', taskMode: 'debug', status: 'running', createdAt: new Date(Date.now() - 12400).toISOString(), updatedAt: new Date().toISOString(), activeModelId: 'nemotron-x', budget: 0.5, spent: 0.034 },
];

function Seed({ snap, children, models = modelList, runs = runList }: any) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    if (snap) dispatch({ type: 'snap/set', snap });
    dispatch({ type: 'models/set', models });
    dispatch({ type: 'runs/set', runs });
    dispatch({ type: 'runs/active', id: 'run-1' });
  }, []);
  return <>{children}</>;
}
function renderWith(snap: any, ui: React.ReactNode, opts: any = {}) {
  return render(
    <RuntimeProvider>
      <Seed snap={snap} models={opts.models ?? modelList} runs={opts.runs ?? runList}>{ui}</Seed>
    </RuntimeProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('Center: renderMarkdown (safe, no raw HTML)', () => {
  it('renders headings, lists, tables, code, quotes, links, hr', () => {
    const md = `# T\n\n## Sub\n\npara with \`inline\` and **bold** and *ital* and [link](https://example.com)\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n---\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    const html = renderMarkdown(md);
    expect(html).toContain('<h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('<table>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('class="inline"');
    expect(html).not.toContain('<script');
  });
  it('escapes raw HTML instead of executing it', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('Center: message display', () => {
  it('renders user, assistant, tool, system roles distinctly', () => {
    const ts = new Date().toISOString();
    const msgs: any[] = [
      { id: 'u1', role: 'user', content: 'Fix the login bug', ts },
      { id: 'a1', role: 'assistant', content: 'On it.', ts },
      { id: 't1', role: 'tool', content: 'search: SUCCESS (1.2s)', ts },
      { id: 's1', role: 'system', content: 'Model switched', ts },
    ];
    const { container } = render(<RuntimeProvider><MessageList messages={msgs} /></RuntimeProvider>);
    expect(container.querySelector('.oa-user')).not.toBeNull();
    expect(container.querySelector('.oa-assistant')).not.toBeNull();
    expect(container.querySelector('.oa-tool')).not.toBeNull();
    expect(container.querySelector('.oa-system')).not.toBeNull();
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
  });
  it('renders markdown code + table + heading + list + quote + link without page overflow', () => {
    const ts = new Date().toISOString();
    const src = `## Plan\n\n- step one\n- step two\n\n> note here\n\n[docs](https://example.com)\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    const { container } = render(<RuntimeProvider><MessageList messages={[{ id: 'a1', role: 'assistant', content: src, ts } as any]} /></RuntimeProvider>);
    expect(container.querySelector('pre code')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('h3')).not.toBeNull();
    expect(container.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('blockquote')).not.toBeNull();
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });
  it('shows compact tool states with duration, and collapses long output', () => {
    const ts = new Date().toISOString();
    const { container } = render(
      <RuntimeProvider><MessageList messages={[
        { id: 't1', role: 'tool', content: 'search: RUNNING — scanning repo', ts } as any,
        { id: 't2', role: 'tool', content: `deploy: FAILED — timeout ${'x'.repeat(300)}`, ts } as any,
      ]} /></RuntimeProvider>
    );
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(container.querySelector('details summary')).not.toBeNull();
  });
  it('shows subtle message metadata without clutter', () => {
    const ts = new Date().toISOString();
    render(<RuntimeProvider><MessageList messages={[{ id: 'a1', role: 'assistant', content: 'hi', ts, meta: { model: 'prov/nemotron-x', durationMs: 2100 } } as any]} /></RuntimeProvider>);
    expect(screen.getByTitle('Model prov/nemotron-x')).toBeInTheDocument();
  });
});

describe('Center: code copy', () => {
  it('copies code blocks with COPY -> COPIED feedback and labels', async () => {
    const ts = new Date().toISOString();
    render(<RuntimeProvider><MessageList messages={[{ id: 'a1', role: 'assistant', content: '```ts\nconst x = 1;\n```', ts } as any]} /></RuntimeProvider>);
    const btn = screen.getByRole('button', { name: /copy .* block/i });
    expect(btn).toHaveTextContent('COPY');
    fireEvent.click(btn);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1;'));
    await waitFor(() => expect(btn).toHaveTextContent('COPIED'));
    expect(btn).toHaveAttribute('aria-label', expect.stringMatching(/copied/i));
  });
});

describe('Center: streaming', () => {
  it('shows live state + cursor while streaming, removes cursor after completion, no duplication', () => {
    const ts = new Date().toISOString();
    const { container, rerender } = render(<RuntimeProvider><MessageList messages={[{ id: 's1', role: 'assistant', content: 'Fixing auth', ts, meta: { streaming: true } } as any]} /></RuntimeProvider>);
    expect(container.querySelector('.oa-cursor')).not.toBeNull();
    expect(screen.getByText('STREAMING')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="msg-s1"]').length).toBe(1);
    rerender(<RuntimeProvider><MessageList messages={[{ id: 's1', role: 'assistant', content: 'Fixing auth done', ts, meta: {} } as any]} /></RuntimeProvider>);
    expect(container.querySelector('.oa-cursor')).toBeNull();
    expect(container.textContent).not.toMatch(/Fixing authFixing auth/);
  });
  it('shows execution activity while generating / running tool', () => {
    const ts = new Date().toISOString();
    render(<RuntimeProvider><MessageList messages={[
      { id: 't1', role: 'tool', content: 'search: RUNNING — scanning', ts } as any,
      { id: 's1', role: 'assistant', content: 'partial', ts, meta: { streaming: true } } as any,
    ]} /></RuntimeProvider>);
    expect(screen.getByTestId('execution-activity')).toHaveTextContent(/Running search/);
  });
});

describe('Center: auto-scroll + jump to latest', () => {
  it('follows stream when pinned and offers jump control when scrolled up', () => {
    const ts = new Date().toISOString();
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}`, ts } as any));
    const { container } = render(<RuntimeProvider><MessageList messages={msgs} /></RuntimeProvider>);
    const feed = container.querySelector('.oa-feed') as HTMLElement;
    expect(feed).not.toBeNull();
    expect(feed.getAttribute('role')).toBe('log');
    Object.defineProperty(feed, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(feed, 'scrollTop', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(feed);
    const jump = screen.getByRole('button', { name: /jump to latest/i });
    expect(jump).toBeInTheDocument();
    fireEvent.click(jump);
    expect(feed.scrollTop).toBe(2000);
  });
  it('stays usable with 100 messages (caps DOM)', () => {
    const ts = new Date().toISOString();
    const msgs = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: `answer ${i}`, ts } as any));
    const { container } = render(<RuntimeProvider><MessageList messages={msgs} /></RuntimeProvider>);
    expect(screen.getByText(/Showing latest 150 of 200/)).toBeInTheDocument();
    expect(container.querySelectorAll('.oa-assistant').length).toBeLessThanOrEqual(150);
  });
});

describe('Center: run header + states', () => {
  const cases: Array<[string, string]> = [
    ['idle', 'READY'], ['running', 'RUNNING'], ['planning', 'RUNNING'], ['waiting', 'RUNNING'],
    ['completed', 'COMPLETED'], ['failed', 'FAILED'], ['cancelled', 'CANCELLED'],
  ];
  it.each(cases)('maps backend status %s to %s with icon + label', (raw, label) => {
    renderWith(baseSnap({ status: raw }), <RunHeader />);
    const pill = screen.getByRole('status', { name: `Run status ${label}` });
    expect(pill).toHaveTextContent(label);
  });
  it('shows run title + status + journey with a secondary resource line (detail stays in inspector)', () => {
    renderWith(baseSnap(), <RunHeader />);
    expect(screen.getByTitle('Fix authentication issue')).toHaveTextContent('Fix authentication issue');
    expect(screen.getByRole('status', { name: 'Run status RUNNING' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Runtime progress' })).toBeInTheDocument();
    // Hierarchy: a subtle secondary resource summary is allowed in the
    // header; full model/budget/token/latency detail lives in the inspector.
    expect(screen.getByRole('status', { name: 'Run resources' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Active model/)).toBeNull();
  });
  it('exposes Stop only while running and disables duplicate stops', async () => {
    const spy = vi.spyOn(api, 'cancelRun').mockResolvedValue({ run: {} } as any);
    renderWith(baseSnap({ status: 'running' }), <RunHeader />);
    const stop = screen.getByRole('button', { name: 'Stop run' });
    fireEvent.click(stop);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByRole('button', { name: 'Stopping run' })).toBeDisabled();
  });
  it('exposes Retry only for terminal states', () => {
    const spy = vi.spyOn(api, 'retryRun').mockResolvedValue({ accepted: true } as any);
    const { unmount } = renderWith(baseSnap({ status: 'failed' }), <RunHeader />);
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeInTheDocument();
    unmount();
    renderWith(baseSnap({ status: 'running' }), <RunHeader />);
    expect(screen.queryByRole('button', { name: 'Retry run' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps the header focused: no budget bars or model pills in the center', () => {
    const { unmount } = renderWith(baseSnap({ cost: { spentUsd: 0.45, budgetUsd: 0.5, projectedUsd: 0.5, breakdown: [] } }), <RunHeader />);
    // Budget urgency belongs to the inspector cost panel — the header shows
    // status + progress only.
    expect(screen.queryByText('90% USED')).toBeNull();
    unmount();
    const r2 = renderWith(baseSnap({ cost: { spentUsd: 0.6, budgetUsd: 0.5, projectedUsd: 0.6, breakdown: [] } }), <RunHeader />);
    expect(r2.queryByText('EXHAUSTED')).toBeNull();
    r2.unmount();
  });
  it('shows a concise outcome summary on completion with real numbers only', async () => {
    const { RunOutcome } = await import('../components/Center');
    const snap = baseSnap({
      status: 'completed',
      cost: { spentUsd: 0.014, budgetUsd: 0.05, projectedUsd: 0.014, breakdown: [] },
      tools: [{ name: 'search', description: 't', status: 'enabled', calls: 2, avgLatencyMs: 100, successRate: 1 }],
      decisions: [{ kind: 'model_switch', decision: 'SWITCH a → b', timestamp: new Date().toISOString(), factors: [] }],
    });
    const run = { createdAt: new Date(Date.now() - 18400).toISOString() } as any;
    const { container } = render(<RuntimeProvider><RunOutcome snap={snap} run={run} /></RuntimeProvider>);
    expect(container.textContent).toMatch(/Completed/);
    expect(container.textContent).toMatch(/\$0\.014/);
    expect(container.textContent).toMatch(/2 tools/);
    expect(container.textContent).toMatch(/1 model switch/);
  });
  it('renders UNKNOWN quietly when snapshot is missing', () => {
    render(<RuntimeProvider><RunHeader /></RuntimeProvider>);
    expect(screen.getByLabelText('No runtime state')).toBeInTheDocument();
  });
});

describe('Center: error / cancel behavior', () => {
  it('keeps conversation visible on failure and offers retry with details', () => {
    const ts = new Date().toISOString();
    vi.spyOn(api, 'retryRun').mockResolvedValue({ accepted: true } as any);
    const snap = baseSnap({ status: 'failed', messages: [{ id: 'a1', role: 'assistant', content: 'partial answer', ts }] });
    renderWith(snap, <MessageList messages={snap.messages} />);
    expect(screen.getByText('partial answer')).toBeInTheDocument();
    const card = screen.getByTestId('run-error-card');
    expect(card).toHaveTextContent('Provider unavailable');
    expect(card).toHaveTextContent('Retry');
  });
  it('shows quiet cancelled notice without error styling takeover', () => {
    const ts = new Date().toISOString();
    const snap = baseSnap({ status: 'cancelled', messages: [{ id: 'a1', role: 'assistant', content: 'kept answer', ts }] });
    renderWith(snap, <MessageList messages={snap.messages} />);
    expect(screen.getByText('kept answer')).toBeInTheDocument();
    expect(screen.getByTestId('run-cancelled-card')).toBeInTheDocument();
    expect(screen.queryByTestId('run-error-card')).toBeNull();
  });
});

describe('Center: composer', () => {
  it('stays simple: task input + task mode + primary action only', () => {
    renderWith(baseSnap({ status: 'idle' }), <Composer />);
    expect(screen.getByPlaceholderText('What do you want OrchestraAI to do?')).toBeInTheDocument();
    expect(screen.getByLabelText('Task mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
    // Model, cost and status readouts belong to the inspector — not the composer.
    expect(screen.queryByLabelText(/Active model/)).toBeNull();
    expect(screen.queryByRole('status', { name: /Composer/ })).toBeNull();
  });
  it('Enter sends, Shift+Enter creates newline', async () => {
    const spy = vi.spyOn(api, 'sendMessage').mockResolvedValue({ accepted: true } as any);
    renderWith(baseSnap({ status: 'idle' }), <Composer />);
    const ta = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'investigate auth' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false, keyCode: 13 });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('run-1', 'investigate auth'));
    fireEvent.change(ta, { target: { value: 'line one' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true, keyCode: 13 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ta.value).toContain('line one');
  });
  it('shows Stop while running, Retry when failed — contextual actions only', () => {
    vi.spyOn(api, 'cancelRun').mockResolvedValue({ run: {} } as any);
    const { unmount } = renderWith(baseSnap({ status: 'running' }), <Composer />);
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry run' })).toBeNull();
    unmount();
    renderWith(baseSnap({ status: 'failed' }), <Composer />);
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
  });
  it('disables input while running and surfaces send errors with retry', async () => {
    vi.spyOn(api, 'sendMessage').mockRejectedValueOnce(new Error('backend unavailable'));
    renderWith(baseSnap({ status: 'idle' }), <Composer />);
    const ta = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false, keyCode: 13 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Send failed/);
  });
  it('Escape blurs the input without touching palette shortcuts', () => {
    renderWith(baseSnap({ status: 'idle' }), <Composer />);
    const ta = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
    ta.focus();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(document.activeElement).not.toBe(ta);
  });
  it('disables the composer on terminal runs with an honest hint (no fake send)', () => {
    const spy = vi.spyOn(api, 'sendMessage').mockResolvedValue({ accepted: true } as any);
    renderWith(baseSnap({ status: 'completed' }), <Composer />);
    const ta = screen.getByLabelText('Message the agent') as HTMLTextAreaElement;
    expect(ta).toBeDisabled();
    expect(ta.placeholder).toMatch(/complete/i);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Center: runtime journey', () => {
  const ts = new Date().toISOString();
  it('marks every milestone done for a completed run', () => {
    const snap = baseSnap({
      status: 'completed', activeModelId: 'nemotron-x',
      context: { usedTokens: 1200, windowTokens: 64000, segments: [], items: [] },
      messages: [
        { id: 'u1', role: 'user', content: 'hi', ts },
        { id: 'a1', role: 'assistant', content: 'done', ts },
      ],
    });
    expect(journeySteps(snap).map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
  it('activates the first incomplete milestone while running, fails honestly on failure', () => {
    const running = baseSnap({
      status: 'running', activeModelId: 'nemotron-x',
      context: { usedTokens: 1200, windowTokens: 64000, segments: [], items: [] },
      messages: [{ id: 'u1', role: 'user', content: 'hi', ts }],
    });
    expect(journeySteps(running).map(s => `${s.label}:${s.state}`).join(' ')).toContain('Execute:active');
    const failed = baseSnap({ status: 'failed', messages: [] });
    const states = journeySteps(failed);
    expect(states[4].state).toBe('failed');
  });
  it('renders the journey strip in the run header', () => {
    const snap = baseSnap({ status: 'running' });
    renderWith(snap, <RunHeader />);
    expect(screen.getByRole('list', { name: 'Runtime progress' })).toBeInTheDocument();
  });
});
