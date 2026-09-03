import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { RuntimeProvider } from '../state/store';
import { CommandPalette } from '../components/CommandPalette';

describe('command palette', () => {
  it('opens on ctrl+k without hook errors (regression: no hooks after early return)', async () => {
    const err: any[] = [];
    const h = (e: any) => err.push(e);
    window.addEventListener('error', h);
    render(<RuntimeProvider><CommandPalette /></RuntimeProvider>);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelector('.palette')).not.toBeNull();
    window.removeEventListener('error', h);
    expect(err.length).toBe(0);
  });
});
