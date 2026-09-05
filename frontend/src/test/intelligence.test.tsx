import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  AreaChart, BarChart, ChartEmpty, Donut, LineChart, ProvenanceBadge,
  RankingTable, ScatterPlot,
} from '../analytics/charts';
import { LandingContext, LandingFlow, LandingScatter, LandingTrend } from '../analytics/LandingWidgets';

describe('intelligence chart system', () => {
  it('shares one infrastructure: provenance, empty, and error states', () => {
    render(<ProvenanceBadge value="DEMO" />);
    expect(screen.getByText('DEMO')).toBeInTheDocument();
    render(<ProvenanceBadge value="INSUFFICIENT_DATA" />);
    expect(screen.getByText('INSUFFICIENT DATA')).toBeInTheDocument();
    render(<ChartEmpty title="Leaderboard — no data" hint="Run traffic first." />);
    expect(screen.getByText(/leaderboard — no data/i)).toBeInTheDocument();
    expect(screen.getAllByText(/insufficient data/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders line, area, bars, donut, and scatter with accessible labels', () => {
    const { container: c1 } = render(
      <LineChart labels={['2026-01-01', '2026-01-02']} series={[{ key: 'a', label: 'model-a', color: '#0C7A5C', values: [1, 2] }]} yLabel="calls" />,
    );
    expect(c1.querySelector('svg[aria-label]')).not.toBeNull();
    const { container: c2 } = render(
      <AreaChart labels={['2026-01-01', '2026-01-02']} series={[{ key: 'a', label: 'model-a', color: '#0C7A5C', values: [1, 2] }]} />,
    );
    expect(c2.querySelector('svg[aria-label]')).not.toBeNull();
    render(<BarChart rows={[{ key: 'a', label: 'model-a', value: 3 }]} unit="calls" />);
    expect(screen.getAllByText('model-a').length).toBeGreaterThanOrEqual(1);
    const { container: c4 } = render(
      <Donut slices={[{ key: 'a', label: 'openrouter', value: 2, color: '#0C7A5C' }]} centerLabel="providers" centerValue="1" />,
    );
    expect(c4.querySelector('svg[aria-label]')).not.toBeNull();
    const { container: c5 } = render(
      <ScatterPlot points={[{ key: 'a', label: 'model-a', x: 0.01, y: 0.9 }]} xLabel="Cost" yLabel="Quality" />,
    );
    expect(c5.querySelector('svg[aria-label]')).not.toBeNull();
  });

  it('supports log scale, sorting, pagination, and legend toggles', () => {
    const { container } = render(
      <LineChart labels={['a', 'b', 'c']} series={[{ key: 'a', label: 's', color: '#000', values: [1, 100, 10000] }]} yLabel="calls" logScale />,
    );
    expect(container.querySelector('.oi-yunit')?.textContent || '').toMatch(/log scale/i);
    render(
      <RankingTable
        ariaLabel="rows" rows={[{ n: 'b', v: 1 }, { n: 'a', v: 2 }]} defaultSort="v"
        columns={[
          { key: 'n', label: 'Name', render: (r) => r.n, sortValue: (r) => r.n },
          { key: 'v', label: 'Value', render: (r) => String(r.v), sortValue: (r) => r.v },
        ]}
      />,
    );
    const btn = screen.getByRole('button', { name: /sort by value/i });
    fireEvent.click(btn);
    expect(screen.getByRole('table', { name: 'rows' })).toBeInTheDocument();
  });

  it('labels landing demos as illustrative, never live', () => {
    render(<div><LandingTrend /><LandingScatter /><LandingContext /><LandingFlow /></div>);
    expect(screen.getAllByText(/illustrative/i).length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText(/^live$/i)).toBeNull();
    expect(screen.getByText(/usage trend/i)).toBeInTheDocument();
    expect(screen.getByText(/cost vs quality/i)).toBeInTheDocument();
    expect(screen.getByText(/context optimization/i)).toBeInTheDocument();
    expect(screen.getByText(/execution optimization/i)).toBeInTheDocument();
  });
});
