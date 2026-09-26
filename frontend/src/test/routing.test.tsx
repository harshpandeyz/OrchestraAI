import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../App';
import { api } from '../api/client';

// Regression coverage for console view routing. These tests render the real
// <App/> shell (not a mocked router) and assert the actual page/component that
// a navigation destination reaches — the bug was `Evaluations → Alerts` and
// `Traces → Intelligence` inside the view branch of App.tsx.

function mockBootApis() {
  vi.spyOn(api, 'getRuns').mockResolvedValue({ runs: [] });
  vi.spyOn(api, 'getModels').mockResolvedValue({ models: [] });
  vi.spyOn(api, 'getTools').mockResolvedValue({ tools: [] });
  vi.spyOn(api, 'getMemory').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'getEvaluations').mockResolvedValue({ evaluations: [], note: '' });
  // A connected provider keeps the FirstRunBanner and Onboarding silent.
  vi.spyOn(api, 'getProviders').mockResolvedValue({
    mode: 'live',
    providers: [{ id: 'acme', label: 'Acme', connected: true }],
  } as never);
  vi.spyOn(api, 'getOverview').mockResolvedValue({
    analytics: {
      summary: { runCount: 0, baselineCost: 0, optimizedProviderCost: 0, eligibleSavings: 0, platformFee: 0, customerFinalCost: 0, customerNetSavings: null, savingsRate: 0, invoiceStatus: 'not_invoice_reconciled' },
      spendTrend: [], savingsTrend: [], modelBreakdown: [], providerBreakdown: [], tokenComposition: {}, cacheImpact: { hits: 0, misses: 0, hitRate: 0 }, recentRuns: [],
      dataQuality: { verifiedCount: 0, insufficientCount: 0, incompleteCount: 0, noSavingsCount: 0, costIncreaseCount: 0, coverageRate: 0, label: 'no data' },
    },
  } as never);
}

function renderConsole(view?: string) {
  window.history.pushState({}, '', view ? `/console?view=${view}` : '/console');
  return render(<App />);
}

beforeEach(() => {
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ }
  mockBootApis();
});
afterEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('console view routing', () => {
  it('renders EvalsPage for the Evaluations destination, never the Alerts surface', async () => {
    renderConsole('evals');
    // EvalsPage leads with "Runtime quality metrics."; OperationsPage kind=alerts
    // would lead with "RELIABILITY CONTROL".
    expect(await screen.findByText(/Runtime quality metrics/)).toBeInTheDocument();
    expect(screen.queryByText(/RELIABILITY CONTROL/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No alert rules are configured yet/)).not.toBeInTheDocument();
  });

  it('sidebar Evaluations navigation renders EvalsPage (not Alerts)', async () => {
    renderConsole();
    // Evaluations lives in the Intelligence group (collapsed by default).
    const toggles = await screen.findAllByRole('button', { name: 'Intelligence' });
    fireEvent.click(toggles[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Evaluations' }));
    expect(await screen.findByText(/Runtime quality metrics/)).toBeInTheDocument();
    expect(screen.queryByText(/RELIABILITY CONTROL/)).not.toBeInTheDocument();
  });

  it('renders a truthful unavailable state for Traces, never Intelligence', async () => {
    renderConsole('traces');
    expect(await screen.findByText(/Standalone traces are not available yet/)).toBeInTheDocument();
    // IntelligencePage would render "Model intelligence, measured".
    expect(screen.queryByText(/Model intelligence, measured/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ORCHESTRA INTELLIGENCE/)).not.toBeInTheDocument();
  });

  it('renders the overview surface by default without a ?view deep link', async () => {
    renderConsole();
    expect(await screen.findByText(/Money first/)).toBeInTheDocument();
  });

  it('renders ModelsPage for the Models destination', async () => {
    renderConsole('models');
    expect(await screen.findByText(/how it performs in this workspace/)).toBeInTheDocument();
  });

  it('renders ToolsPage for the Tools destination', async () => {
    renderConsole('tools');
    expect(await screen.findByText(/Tool registry and execution capabilities/)).toBeInTheDocument();
  });

  it('renders MemoryPage for the Memory destination', async () => {
    renderConsole('memory');
    expect(await screen.findByText(/Working and long-term agent knowledge/)).toBeInTheDocument();
  });
});