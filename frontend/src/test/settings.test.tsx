import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('Settings: providers & runtime', () => {
  it('shows LIVE + configured state from real backend data, never secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ ok: true, mode: 'live', provider: 'openrouter', providerConfigured: true, discovery: { enabled: true } }) } as any;
      }
      return { ok: true, json: async () => ({ mode: 'live', provider: 'openrouter', maxSteps: 12, runTimeoutMs: 300000, defaultBudgetUsd: 0.5, discoveryEnabled: true }) } as any;
    }));
    renderSettings();
    await waitFor(() => expect(screen.getByText('LIVE')).toBeInTheDocument());
    expect(screen.getByText('CONFIGURED')).toBeInTheDocument();
    expect(screen.getByText('openrouter')).toBeInTheDocument();
    // Only presence is ever shown — no key material anywhere.
    expect(document.body.textContent).not.toMatch(/sk-|sk_or|api[_-]?key\s*[:=]\s*\S{6,}/i);
  });

  it('labels DEMO mode honestly when no provider is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/health')) {
        return { ok: true, json: async () => ({ ok: true, mode: 'demo', provider: 'openrouter', providerConfigured: false, discovery: { enabled: false } }) } as any;
      }
      return { ok: true, json: async () => ({ mode: 'demo', provider: 'openrouter', maxSteps: 12, runTimeoutMs: 300000, defaultBudgetUsd: 0.5, discoveryEnabled: false }) } as any;
    }));
    renderSettings();
    await waitFor(() => expect(screen.getByText('DEMO')).toBeInTheDocument());
    expect(screen.getByText('MISSING')).toBeInTheDocument();
  });

  it('reports unknown instead of assuming when the backend is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    renderSettings();
    await waitFor(() => expect(screen.getByText('UNKNOWN')).toBeInTheDocument());
    expect(screen.getByText(/never assumed/i)).toBeInTheDocument();
  });
});
