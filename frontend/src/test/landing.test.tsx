import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LandingPage } from '../pages/public';

describe('public landing page', () => {
  it('communicates adaptive routing without fake claims', () => {
    render(<LandingPage />);
    expect(screen.getByRole('heading', { name: /let every ai request choose.*own best path/i })).toBeInTheDocument();
    expect(screen.getByText(/intelligent execution layer/i)).toBeInTheDocument();
    expect(screen.getAllByText(/GET \/api\/models/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/bring your keys/i)).toBeInTheDocument();
    expect(screen.queryByText(/trusted by thousands|10x|guaranteed savings/i)).not.toBeInTheDocument();
  });

  it('walks the request → result pipeline and links to real destinations only', () => {
    render(<LandingPage />);
    expect(screen.getByRole('heading', { name: /request → understand → route → execute → evaluate/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /route every request intelligently/i })).toBeInTheDocument();
    const primary = screen.getAllByRole('link', { name: /start building|create your workspace|get started/i });
    expect(primary.length).toBeGreaterThan(0);
    for (const a of primary) expect(a.getAttribute('href')).toBe('/auth');
    const consoleLinks = screen.getAllByRole('link', { name: /open the console|open console/i });
    expect(consoleLinks.length).toBeGreaterThan(0);
    for (const a of consoleLinks) expect(a.getAttribute('href')).toBe('/console');
  });

  it('opens the mobile menu without overflow traps', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    expect(screen.getByRole('navigation', { name: /mobile/i })).toBeInTheDocument();
  });

  it('renders every narrative section with working anchor links', () => {
    render(<LandingPage />);
    for (const name of [
      /an execution layer that earns its keep/i,
      /watch work happen, step by step/i,
      /degraded is a signal, not a surprise/i,
      /this is the console you/i,
      /infrastructure you can hand to security review/i,
      /bring your keys\. pay providers directly/i,
      /every decision leaves a trail/i,
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    const nav = screen.getByRole('navigation', { name: /primary/i });
    for (const [label, href] of [
      ['Product', '#product'],
      ['How it works', '#how'],
      ['Models', '#models'],
      ['Console', '#console'],
      ['Pricing', '#pricing'],
    ] as const) {
      const link = within(nav).getByRole('link', { name: label });
      expect(link.getAttribute('href')).toBe(href);
      expect(document.querySelector(href)).not.toBeNull();
    }
  });

  it('shows a living decision engine with candidates and proof', () => {
    const { container } = render(<LandingPage />);
    const engine = container.querySelector('.lp-engine');
    expect(engine).not.toBeNull();
    expect(within(engine as HTMLElement).getByText(/refactor authentication and run the tests/i)).toBeInTheDocument();
    for (const name of ['GPT-class', 'Claude-class', 'Gemini-class']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/decision engine/i)).toBeInTheDocument();
    expect(screen.getByText(/TOOLS \+ TESTS/i)).toBeInTheDocument();
  });

  it('renders analytics graphs and labels illustrative data honestly', () => {
    const { container } = render(<LandingPage />);
    const charts = container.querySelectorAll('svg.lp-chart, svg.lp-graph, svg.lp-donut, svg.lp-spark');
    expect(charts.length).toBeGreaterThanOrEqual(5);
    for (const c of Array.from(charts)) {
      expect(c.getAttribute('aria-label')).toBeTruthy();
    }
    expect(screen.getAllByText(/illustrative (demo data|routing decision)/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/12,482/)).toBeInTheDocument();
    expect(screen.queryByText(/99\.9% uptime|10b requests|used by thousands|industry leading/i)).not.toBeInTheDocument();
  });

  it('explains failover and the execution trace with real statuses', () => {
    render(<LandingPage />);
    expect(screen.getByText(/standby promoted/i)).toBeInTheDocument();
    expect(screen.getByText(/no thrash/i)).toBeInTheDocument();
    expect(screen.getAllByText(/DONE/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/RUNNING/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/QUEUED/i).length).toBeGreaterThan(0);
  });

  it('closes the mobile menu on selection and keeps CTAs correct', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const mobile = screen.getByRole('navigation', { name: /mobile/i });
    fireEvent.click(within(mobile).getByRole('link', { name: 'Models' }));
    expect(screen.queryByRole('navigation', { name: /mobile/i })).not.toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('renders a meaningful static state when reduced motion is requested', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { container, unmount } = render(<LandingPage />);
      const engine = container.querySelector('.lp-engine') as HTMLElement;
      // Decided end-state is present without any cycling.
      expect(within(engine).getAllByText(/selected/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/claude-class selected/i)).toBeInTheDocument();
      unmount();
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
