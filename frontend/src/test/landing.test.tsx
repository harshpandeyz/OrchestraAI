import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LandingPage } from '../pages/public';

describe('public landing page', () => {
  it('communicates adaptive routing without fake claims', () => {
    render(<LandingPage />);
    expect(screen.getByRole('heading', { name: /route every request to the right model/i })).toBeInTheDocument();
    expect(screen.getByText(/intelligent router/i)).toBeInTheDocument();
    expect(screen.getAllByText(/GET \/api\/models/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/bring your keys/i)).toBeInTheDocument();
    expect(screen.queryByText(/trusted by thousands|10x|guaranteed savings/i)).not.toBeInTheDocument();
  });

  it('walks the request → result pipeline and links to real destinations only', () => {
    render(<LandingPage />);
    expect(screen.getByRole('heading', { name: /request → understand → route → execute → evaluate/i })).toBeInTheDocument();
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
});
