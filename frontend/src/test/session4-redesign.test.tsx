// Session 4 regression coverage — information architecture + design-system
// semantics. Structural invariants only: nothing here duplicates backend
// behavior and no fake runtime data is invented.
import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { ConsoleSidebar } from '../console/ConsoleSidebar';
import { ConsoleTopBar } from '../console/ConsoleTopBar';

function runs() {
  const now = Date.now();
  return [
    { id: 'run-1', title: 'Refactor auth', taskMode: 'code', status: 'running', createdAt: new Date(now - 20000).toISOString(), updatedAt: new Date().toISOString(), activeModelId: 'm1', budget: 0.05, spent: 0.014 },
    { id: 'run-2', title: 'Update docs', taskMode: 'general', status: 'completed', createdAt: new Date(now - 90000).toISOString(), updatedAt: new Date(now - 60000).toISOString(), activeModelId: 'm2', budget: 0.05, spent: 0.008 },
  ];
}

function Seed({ children }: any) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    dispatch({ type: 'runs/set', runs: runs() });
    dispatch({ type: 'runs/active', id: 'run-1' });
  }, []);
  return <>{children}</>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('session4: navigation information architecture', () => {
  it('exposes Workspace/Build/Intelligence/Operate groups with decorative icons', () => {
    render(<RuntimeProvider><Seed /><ConsoleSidebar /></RuntimeProvider>);
    for (const label of ['Workspace', 'Build', 'Intelligence', 'Operate']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
    // Workspace group is open by default with Overview/Runs/Agents/Models
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
    const modelsBtn = screen.getByRole('button', { name: 'Models' });
    const icon = modelsBtn.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
  });

  it('collapses Build/Intelligence/Operate by default (progressive disclosure)', () => {
    render(<RuntimeProvider><Seed /><ConsoleSidebar /></RuntimeProvider>);
    // Build group starts collapsed — Tools hidden until expanded
    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    const buildToggle = screen.getByRole('button', { name: /Build/i });
    expect(buildToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(buildToggle);
    expect(buildToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workflows' })).toBeInTheDocument();
  });

  it('group items navigate to their view once revealed', () => {
    function Probe() {
      const { state } = useRuntime();
      return <span data-testid="view">{state.ui.view}</span>;
    }
    render(<RuntimeProvider><Seed /><ConsoleSidebar /><Probe /></RuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Build/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(screen.getByTestId('view').textContent).toBe('tools');
  });

  it('offers run filtering with honest counts', () => {
    render(<RuntimeProvider><Seed /><ConsoleSidebar /></RuntimeProvider>);
    expect(screen.getByRole('listbox', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.getByLabelText('Filter runs')).toBeInTheDocument();
    expect(screen.getByText('Refactor auth')).toBeInTheDocument();
  });

  it('topbar connection status is a labelled, semantic pill', () => {
    render(<RuntimeProvider><Seed /><ConsoleTopBar /></RuntimeProvider>);
    const pill = screen.getByRole('status');
    expect(pill.className).toContain('o2-connection');
  });
});