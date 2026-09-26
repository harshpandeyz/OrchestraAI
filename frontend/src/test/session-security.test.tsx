import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { api } from '../api/client';

// Session-cookie security: the browser must never store a privileged bearer
// token in localStorage. Authentication is an HttpOnly session cookie sent
// automatically via credentialed fetch. These checks pin that contract so a
// future edit cannot silently reintroduce a JS-readable credential.

describe('browser auth has no privileged token', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('does not expose a localStorage bearer-token API on the client', () => {
    expect('getApiToken' in api).toBe(false);
    expect('setApiToken' in api).toBe(false);
  });

  it('sends credentialed requests without a JS-read bearer header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await api.health();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/api/health');
      expect(init.credentials).toBe('include');
      const headers = (init.headers || {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports session status via /api/auth/me instead of a stored token', () => {
    expect(typeof api.me).toBe('function');
    expect(typeof api.logout).toBe('function');
    expect(typeof api.login).toBe('function');
    expect(typeof api.signup).toBe('function');
  });
});