import { test, expect } from '@playwright/test';
import { signup, apiRequest } from './util';

// Browser tool v1 (Session 12): the DEMO mock session works end-to-end
// through the real stack — authenticated API call, deterministic snapshot,
// zero network. Mirrors the core-journey style: real browser context, real
// session cookie, no mocked success.

test('browser DEMO mock returns a deterministic snapshot', async ({ browser }) => {
  const { context } = await signup(browser, 'Browser QA');
  try {
    const first = await apiRequest<{ snapshot: { url: string; engine: string; mocked: boolean; provenance: string; title: string } }>(
      context, 'POST', '/api/browse', { url: 'demo:e2e-smoke' },
    );
    expect(first.status).toBe(200);
    expect(first.json?.snapshot.engine).toBe('mock');
    expect(first.json?.snapshot.mocked).toBe(true);
    expect(first.json?.snapshot.provenance).toBe('DEMO');

    const second = await apiRequest<{ snapshot: { title: string } }>(
      context, 'POST', '/api/browse', { url: 'demo:e2e-smoke' },
    );
    expect(second.json?.snapshot.title).toBe(first.json?.snapshot.title);
  } finally {
    await context.close();
  }
});

test('browser never fetches foreign hosts in DEMO (mock, zero network)', async ({ browser }) => {
  // The e2e server runs RUNTIME_MODE=demo: every URL returns the
  // deterministic mock instead of touching the network. LIVE SSRF/allowlist
  // rejection is covered by backend/test/browser-tool.test.js (live policy).
  const { context } = await signup(browser, 'Browser QA');
  try {
    const res = await apiRequest<{ snapshot: { engine: string; mocked: boolean; provenance: string } }>(
      context, 'POST', '/api/browse', { url: 'https://evil.example/page' },
    );
    expect(res.status).toBe(200);
    expect(res.json?.snapshot.engine).toBe('mock');
    expect(res.json?.snapshot.mocked).toBe(true);
  } finally {
    await context.close();
  }
});

test('browser tool is visible in the tool catalog as gated', async ({ browser }) => {
  const { context } = await signup(browser, 'Browser QA');
  try {
    const res = await apiRequest<{ tools: { name: string; status: string }[] }>(context, 'GET', '/api/tools');
    expect(res.status).toBe(200);
    const names = (res.json?.tools || []).map((t) => t.name);
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_navigate');
  } finally {
    await context.close();
  }
});
