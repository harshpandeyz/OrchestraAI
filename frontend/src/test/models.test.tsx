import React, { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from '../state/store';
import { ModelsPage } from '../pages/pages';
import type { ModelInfo } from '../types';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MODELS = [
  { id: 'new-z', name: 'New Z', provider: 'openrouter', status: 'unknown', contextWindow: 128000, quality: null, avgLatencyMs: null, reliability: null, inputPer1k: 0.001, outputPer1k: 0.002, cachedPer1k: 0.0005, capabilities: ['text', 'tools'], qualitySource: 'unknown', latencySource: 'unknown', reliabilitySource: 'unknown', pricingSource: 'provider', contextSource: 'provider', healthSource: 'unlisted', observed: null },
  { id: 'workhorse', name: 'Workhorse', provider: 'openai', status: 'healthy', contextWindow: 64000, quality: 0.85, avgLatencyMs: 900, reliability: 0.98, inputPer1k: 0.0005, outputPer1k: 0.001, cachedPer1k: 0.0002, capabilities: ['text'], qualitySource: 'observed', latencySource: 'observed', reliabilitySource: 'observed', pricingSource: 'provider', contextSource: 'provider', healthSource: 'observed', observed: { samples: 12, lastObservedAt: new Date().toISOString(), lastErrorCode: null } },
] as unknown as ModelInfo[];

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/models/changes')) return { ok: true, json: async () => ({ changes: [] }) } as any;
    if (String(url).includes('/api/models')) return { ok: true, json: async () => ({ models: [], meta: { updatedAt: null, discoveryEnabled: false, mode: 'demo' } }) } as any;
    return { ok: true, json: async () => ({}) } as any;
  }));
}

function Seed({ models }: { models: ModelInfo[] }) {
  const { dispatch } = useRuntime();
  useEffect(() => {
    dispatch({ type: 'models/set', models });
  }, [dispatch, models]);
  return null;
}

function renderModels() {
  return render(
    <RuntimeProvider>
      <Seed models={MODELS} />
      <ModelsPage />
    </RuntimeProvider>
  );
}

describe('Models: honest provenance', () => {
  it('renders NOT MEASURED for unknown telemetry, never fabricated numbers', async () => {
    stub();
    renderModels();
    await waitFor(() => expect(screen.getByLabelText('New Z model card')).toBeInTheDocument());
    const card = screen.getByLabelText('New Z model card');
    expect(within(card).getAllByText('not measured').length).toBeGreaterThan(0);
    expect(within(card).getByText('UNKNOWN')).toBeInTheDocument();
    // No invented quality/latency figures on the unmeasured card.
    expect(within(card).queryByText(/q 0\./)).not.toBeInTheDocument();
  });

  it('observed models show measured values with OBSERVED provenance', async () => {
    stub();
    renderModels();
    await waitFor(() => expect(screen.getByLabelText('Workhorse model card')).toBeInTheDocument());
    const card = screen.getByLabelText('Workhorse model card');
    expect(within(card).getByText(/q 0\.85/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /Expand details for Workhorse/ }));
    await waitFor(() => expect(within(card).getAllByText('OBSERVED').length).toBeGreaterThan(0));
    expect(within(card).getByText(/12 runs/)).toBeInTheDocument();
  });

  it('comparison highlights real trade-offs without inventing data', async () => {
    stub();
    renderModels();
    await waitFor(() => expect(screen.getByLabelText('New Z model card')).toBeInTheDocument());
    for (const name of ['New Z', 'Workhorse']) {
      const card = screen.getByLabelText(`${name} model card`);
      fireEvent.click(within(card).getByRole('button', { name: new RegExp(`Expand details for ${name}`) }));
    }
    const cardZ = screen.getByLabelText('New Z model card');
    fireEvent.click(within(cardZ).getByRole('button', { name: 'Compare' }));
    const cardW = screen.getByLabelText('Workhorse model card');
    fireEvent.click(within(cardW).getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Model comparison' })).toBeInTheDocument());
    const table = screen.getByRole('region', { name: 'Model comparison' });
    // Cheapest output is knowable (provider pricing); fastest is not (one side unmeasured).
    expect(within(table).getByText('$2.00 / 1M')).toBeInTheDocument();
    expect(within(table).getAllByText('Not measured').length).toBeGreaterThan(0);
  });
});
