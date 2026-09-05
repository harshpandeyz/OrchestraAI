import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { RuntimeProvider } from '../state/store';
import { SettingsPage } from '../pages/pages';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings() {
  return render(
    <RuntimeProvider>
      <SettingsPage />
    </RuntimeProvider>
  );
}

const PROVIDERS_LIVE = {
  mode: 'live',
  providers: [
    { id: 'openrouter', label: 'OpenRouter', supported: true, configured: true, source: 'stored', keyMasked: '••••7890', updatedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), connected: true, healthy: true, lastCheckedAt: new Date().toISOString(), lastError: null, lastLatencyMs: 420, modelCount: 12 },
    { id: 'openai', label: 'OpenAI', supported: true, configured: false, source: null, keyMasked: null, updatedAt: null, lastVerifiedAt: null, connected: false, healthy: null, lastCheckedAt: null, lastError: null, lastLatencyMs: null, modelCount: null },
    { id: 'anthropic', label: 'Anthropic', supported: true, configured: false, source: null, keyMasked: null, updatedAt: null, lastVerifiedAt: null, connected: false, healthy: null, lastCheckedAt: null, lastError: null, lastLatencyMs: null, modelCount: null },
  ],
};

function stubFetchLive() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/providers')) {
      return { ok: true, json: async () => PROVIDERS_LIVE } as any;
    }
    if (String(url).includes('/api/runtime/settings')) {
      return { ok: true, json: async () => ({ settings: { defaultPreset: 'balanced', defaultBudgetUsd: 0.5, maxSteps: 12, allowSwitching: true, allowCompaction: true, toolPolicy: 'auto' }, presets: [] }) } as any;
    }
    if (String(url).includes('/api/health')) {
      return { ok: true, json: async () => ({ ok: true, mode: 'live', provider: 'openrouter', providerConfigured: true, discovery: { enabled: true } }) } as any;
    }
    return { ok: true, json: async () => ({ mode: 'live', provider: 'openrouter', maxSteps: 12, runTimeoutMs: 300000, defaultBudgetUsd: 0.5, discoveryEnabled: true }) } as any;
  }));
}

describe('Settings: providers & runtime', () => {
  it('shows LIVE state from real backend data, never secrets', async () => {
    stubFetchLive();
    renderSettings();
    await waitFor(() => expect(screen.getByText('LIVE')).toBeInTheDocument());
    expect(screen.getByText('openrouter')).toBeInTheDocument();
    // Only presence is ever shown — no key material anywhere.
    expect(document.body.textContent).not.toMatch(/sk-|sk_or|api[_-]?key\s*[:=]\s*\S{6,}/i);
  });

  it('providers tab shows connected state with masked key only', async () => {
    stubFetchLive();
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    await waitFor(() => expect(screen.getByText('CONNECTED')).toBeInTheDocument());
    expect(screen.getAllByText('NOT CONNECTED')).toHaveLength(2);
    // Masked suffix is fine; the full key is never rendered.
    expect(screen.getByText(/••••7890/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sk-/i);
  });

  it('connect flow verifies before saving and never renders the key', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url: String(url), body });
      if (String(url).includes('/api/providers/openai/test')) {
        return { ok: true, json: async () => ({ ok: true, latencyMs: 300, modelCount: 5, provider: PROVIDERS_LIVE.providers[1] }) } as any;
      }
      if (String(url).includes('/api/providers')) {
        return { ok: true, json: async () => PROVIDERS_LIVE } as any;
      }
      if (String(url).includes('/api/runtime/settings')) {
        return { ok: true, json: async () => ({ settings: { defaultPreset: 'balanced', defaultBudgetUsd: 0.5, maxSteps: 12, allowSwitching: true, allowCompaction: true, toolPolicy: 'auto' }, presets: [] }) } as any;
      }
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ ok: true, mode: 'demo', provider: 'openrouter' }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    await waitFor(() => expect(screen.getByLabelText('OpenAI provider')).toBeInTheDocument());
    const openaiCard = screen.getByLabelText('OpenAI provider');
    const card = within(openaiCard);
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    const input = card.getByLabelText('OpenAI API key');
    fireEvent.change(input, { target: { value: 'sk-test-secret-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(/Key works/)).toBeInTheDocument());
    // The typed key never appears as rendered text.
    expect(document.body.textContent).not.toContain('sk-test-secret-key-1234567890');
    expect(calls.some((c) => c.url.includes('/test'))).toBe(true);
  });

  it('reports unknown instead of assuming when the backend is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    await waitFor(() => expect(screen.getByText('Backend unavailable')).toBeInTheDocument());
    expect(screen.getByText(/never assumed/i)).toBeInTheDocument();
  });

  it('runtime tab shows presets with consequences', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/runtime/settings')) {
        return {
          ok: true,
          json: async () => ({
            settings: { defaultPreset: 'fast', defaultBudgetUsd: 0.5, maxSteps: 12, allowSwitching: true, allowCompaction: true, toolPolicy: 'auto' },
            presets: [
              { id: 'balanced', label: 'Balanced', blurb: 'Best overall trade-off.', consequence: 'Even weights.' },
              { id: 'fast', label: 'Fast', blurb: 'Prefer lower latency.', consequence: 'Prefer lower-latency models.' },
            ],
          }),
        } as any;
      }
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ ok: true, mode: 'demo', provider: 'openrouter' }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    await waitFor(() => expect(screen.getByText('Fast')).toBeInTheDocument());
    expect(screen.getByText(/Prefer lower-latency models/)).toBeInTheDocument();
  });
});
