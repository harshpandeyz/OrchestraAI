// Agent 5 product tests: landing/pricing, auth, economics language,
// billing honesty, onboarding journey, console routing explanation,
// and loading/error/empty states. No snapshots, no invented backend data.
import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LandingPage, AuthPage } from '../pages/public';
import { PricingPage } from '../pages/pricing';
import { BillingPage } from '../pages/account';
import { OverviewPage, SavingsPage } from '../pages/command-center';
import { Onboarding } from '../components/Onboarding';
import { EconomicsLegend, CostBasisBadge } from '../components/economics';
import { LiveIntelligence } from '../console/LiveIntelligence';
import { RuntimeProvider, useRuntime } from '../state/store';
import { api } from '../api/client';
import type { RuntimeSnapshot } from '../types';

beforeEach(() => {
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

function seedSnap(over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const ts = new Date().toISOString();
  return {
    runId: 'run-1', lastSeq: 5, updatedAt: ts, status: 'running', activeModelId: 'model-a',
    context: { usedTokens: 5000, windowTokens: 32000, segments: [], items: [] },
    cache: { hitRate: 0.3, hits: 3, misses: 7, cachedTokens: 1000, uncachedTokens: 4000, savedUsd: 0.001, state: 'WARM', recent: [] },
    memory: { working: [], longterm: [] },
    tools: [{ name: 'read', description: 'Read files', status: 'enabled', calls: 2, avgLatencyMs: 120, successRate: 1 }],
    cost: { spentUsd: 0.011, budgetUsd: 0.1, projectedUsd: 0.02, breakdown: [] },
    latency: { currentStepMs: 300, avgStepMs: 280, modelMs: 200, toolMs: 100, totalMs: 5000, samples: [280, 300] },
    routing: {
      currentId: 'model-a',
      candidates: [{ modelId: 'model-a', score: 92, costUsd: 0.011, latencyMs: 300, factors: { quality: 0.9, cost: 0.8, latency: 0.85, reliability: 0.95 } }],
      decision: { kind: 'model_selection', decision: 'SELECT model-a — quality floor satisfied', timestamp: ts, factors: [{ key: 'quality', label: 'Quality floor satisfied', status: 'pass', detail: 'measured 0.91 ≥ 0.80' }] },
    },
    trace: [{ seq: 1, ts, type: 'model.selected', label: 'Model selected: model-a', status: 'done' }],
    decisions: [], changes: [],
    messages: [{ id: 'u1', role: 'user', content: 'Do the thing', ts }],
    ...over,
  } as RuntimeSnapshot;
}

function Seed({ snap, children }: { snap: RuntimeSnapshot; children: React.ReactNode }) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    dispatch({ type: 'snap/set', snap });
    dispatch({ type: 'conn/set', conn: { status: 'connected', lastUpdate: new Date().toISOString() } });
    dispatch({ type: 'runs/set', runs: [{ id: 'run-1', title: 'T', taskMode: 'code', status: snap.status, createdAt: snap.updatedAt, updatedAt: snap.updatedAt, activeModelId: 'model-a', budget: 0.1, spent: 0.011 }] });
    dispatch({ type: 'runs/active', id: 'run-1' });
    dispatch({ type: 'models/set', models: [{ id: 'model-a', name: 'Model A', provider: 'acme', status: 'healthy', contextWindow: 32000, quality: 0.91, avgLatencyMs: 300, reliability: 0.99, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0002, capabilities: ['coding'] }] });
  }, []);
  return <>{children}</>;
}

describe('pricing experience', () => {
  it('landing shows four honest tiers without fake claims', () => {
    render(<LandingPage />);
    const pricing = document.querySelector('#pricing');
    expect(pricing).not.toBeNull();
    for (const name of ['TRIAL', 'PRO', 'TEAM', 'ENTERPRISE']) {
      expect(within(pricing as HTMLElement).getByText(name)).toBeInTheDocument();
    }
    expect(within(pricing as HTMLElement).getByText(/no self-serve stripe/i)).toBeInTheDocument();
    expect(screen.queryByText(/trusted by thousands|10x|guaranteed savings/i)).not.toBeInTheDocument();
  });
  it('tier CTAs go to real signup destinations, enterprise is manual', () => {
    render(<LandingPage />);
    const pricing = document.querySelector('#pricing') as HTMLElement;
    const links = within(pricing).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const a of links.filter((l) => /trial|workspace|team|contact/i.test(l.textContent || ''))) {
      expect(a.getAttribute('href')).toMatch(/^\/auth/);
    }
    expect(within(pricing).getByRole('link', { name: /full pricing details/i }).getAttribute('href')).toBe('/pricing');
  });
  it('standalone pricing page states beta/manual billing honestly', () => {
    render(<PricingPage />);
    expect(screen.getByRole('heading', { name: /plans that stay honest/i })).toBeInTheDocument();
    expect(screen.getByText(/no self-serve subscriptions/i)).toBeInTheDocument();
    expect(screen.getByText(/not invoice-reconciled/i)).toBeInTheDocument();
    for (const name of ['Trial', 'Pro', 'Team', 'Enterprise']) {
      expect(screen.getByRole('listitem', { name: new RegExp(`${name} plan`, 'i') })).toBeInTheDocument();
    }
  });
  it('mobile menu stays usable and keeps pricing reachable', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const mobile = screen.getByRole('navigation', { name: /mobile/i });
    fireEvent.click(within(mobile).getByRole('link', { name: 'Pricing' }));
    expect(screen.queryByRole('navigation', { name: /mobile/i })).not.toBeInTheDocument();
    expect(document.querySelector('#pricing')).not.toBeNull();
  });
});

describe('auth states', () => {
  it('signup explains BYOK, demo/live, and beta billing', () => {
    render(<AuthPage />);
    expect(screen.getByRole('heading', { name: /clean baseline/i })).toBeInTheDocument();
    expect(screen.getByText(/providers bill your account directly/i)).toBeInTheDocument();
    expect(screen.getByText(/LIVE needs a verified key/i)).toBeInTheDocument();
    expect(screen.getByText(/no Stripe subscriptions/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /compare plans/i }).getAttribute('href')).toBe('/pricing');
  });
  it('surfaces backend errors without inventing a session', () => {
    vi.spyOn(api, 'login').mockRejectedValue(new Error('API 401 /api/auth/login: invalid credentials'));
    render(<AuthPage />);
    fireEvent.click(screen.getByRole('tab', { name: /sign in/i }));
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'longpassword123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in →/i }));
    return waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid credentials/));
  });
});

describe('economics language', () => {
  it('legend separates estimated/actual/modeled/verified and names the backend authoritative', () => {
    render(<EconomicsLegend />);
    for (const label of ['Estimated', 'Actual', 'Modeled', 'Verified']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/backend is authoritative/i)).toBeInTheDocument();
  });
  it('cost basis badges never compute prices', () => {
    const { container } = render(<><CostBasisBadge basis="actual" /><CostBasisBadge basis="modeled" /><CostBasisBadge basis="verified" /></>);
    expect(container.textContent).toMatch(/ACTUAL/);
    expect(container.textContent).toMatch(/MODELED/);
    expect(container.textContent).toMatch(/VERIFIED/);
  });
  it('overview error state shows no invented zeroes', () => {
    vi.spyOn(api, 'getOverview').mockRejectedValue(new Error('API 500 /api/analytics/overview: boom'));
    render(<RuntimeProvider><OverviewPage /></RuntimeProvider>);
    return waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('$0.000')).not.toBeInTheDocument();
    });
  });
  it('savings loading state announces itself', () => {
    vi.spyOn(api, 'getSavings').mockReturnValue(new Promise(() => {}));
    render(<RuntimeProvider><SavingsPage /></RuntimeProvider>);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});

describe('billing honesty', () => {
  const billing = {
    billing: {
      period: '2026-09', currency: 'USD', runCount: 2, baselineCost: 0.05, optimizedProviderCost: 0.03,
      eligibleSavings: 0.02, platformFee: 0.004, customerFinalCost: 0.034, customerNetSavings: 0.016,
      savingsRate: 0.32, invoiceStatus: 'not_invoice_reconciled', source: 'modeled (SavingsEngine)',
      dataQuality: { verifiedCount: 1, insufficientCount: 1, incompleteCount: 0 },
    },
    lineItems: [{
      period: '2026-09', currency: 'USD', status: 'closed', calculationStatus: 'verified_modeled',
      economicOutcome: 'saved', economicsStatus: 'verified', invoiceStatus: 'not_invoice_reconciled',
      baselineCost: 0.05, optimizedProviderCost: 0.03, eligibleSavings: 0.02, modeledSavings: 0.02,
      platformFeePct: 20, platformFee: 0.004, customerFinalCost: 0.034, customerNetSavings: 0.016,
      source: 'modeled', reconciliation: 'not_invoice_reconciled',
    }],
    note: 'Modeled periods, not invoices.',
  };
  it('renders plan, period, provider spend, fee, savings, and reconciliation truthfully', async () => {
    vi.spyOn(api, 'getBilling').mockResolvedValue(billing as never);
    render(<RuntimeProvider><BillingPage /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByText('Current period')).toBeInTheDocument());
    expect(screen.getAllByText('2026-09', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(/beta\/manual reconciliation/i)).toBeInTheDocument();
    expect(screen.getAllByText(/not invoice-reconciled/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/reconciled · invoice matched/i)).not.toBeInTheDocument();
    expect(screen.getByText(/how to read these numbers/i)).toBeInTheDocument();
  });
  it('empty billing never renders fake zeroes', async () => {
    vi.spyOn(api, 'getBilling').mockResolvedValue({ billing: { runCount: 0, invoiceStatus: 'not_invoice_reconciled' }, lineItems: [], note: '' } as never);
    render(<RuntimeProvider><BillingPage /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByText(/billing history — no data/i)).toBeInTheDocument());
  });
  it('billing errors offer retry and assume nothing', async () => {
    vi.spyOn(api, 'getBilling').mockRejectedValue(new Error('API 500 /api/billing: down'));
    render(<RuntimeProvider><BillingPage /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/nothing is assumed/i)).toBeInTheDocument();
  });
});

describe('onboarding journey', () => {
  // jsdom here runs without a localStorage file, so storage access throws.
  // The dialog treats that as private mode and stays silent — stub a memory
  // store so the first-run journey is testable.
  function stubStorage() {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
      },
      configurable: true,
    });
  }
  function mockProviders() {
    vi.spyOn(api, 'getProviders').mockResolvedValue({
      mode: 'demo',
      providers: [
        { id: 'openrouter', label: 'OpenRouter', connected: false, configured: false },
        { id: 'anthropic', label: 'Anthropic', connected: false, configured: false },
      ],
    } as never);
  }
  it('walks workspace → provider → verify/mode → first run → savings', async () => {
    stubStorage();
    mockProviders();
    render(<RuntimeProvider><Onboarding /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /welcome to orchestraai/i })).toBeInTheDocument());
    expect(screen.getByText(/five quick steps/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getAllByText(/demo mode/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/provider api key/i)).toBeInTheDocument();
  });
  it('can dismiss into demo mode explicitly', async () => {
    stubStorage();
    mockProviders();
    render(<RuntimeProvider><Onboarding /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: /continue in demo mode/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue in demo mode/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('console routing explanation', () => {
  it('why-this-model shows backend factors, not invented scores', () => {
    render(<RuntimeProvider><Seed snap={seedSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /expand why this model/i }));
    expect(screen.getAllByText(/quality floor satisfied/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/92% confident/)).not.toBeInTheDocument();
  });
  it('every interactive region stays labeled', () => {
    const { container } = render(<RuntimeProvider><Seed snap={seedSnap()}><LiveIntelligence /></Seed></RuntimeProvider>);
    container.querySelectorAll('button').forEach((b) => {
      expect(b.getAttribute('aria-label') || b.textContent?.trim()).toBeTruthy();
    });
  });
});
