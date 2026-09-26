import { test, expect, request as playwrightRequest } from '@playwright/test';
import { BASE_URL, PASSWORD, signup, uniqueEmail, apiRequest } from './util';

// Authentication E2E — production fails closed (anonymous rejected), session
// flows work, invalid credentials are rejected, and logout truly invalidates.

test('anonymous access to protected API is rejected (401)', async () => {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const runs = await api.get('/api/runs');
  expect(runs.status()).toBe(401);
  const providers = await api.get('/api/providers');
  expect(providers.status()).toBe(401);
  await api.dispose();
});

test('signup establishes an authenticated session', async ({ browser }) => {
  const { page, context } = await signup(browser);
  const me = await apiRequest<{ authenticated: boolean }>(context, 'GET', '/api/auth/me');
  expect(me.status).toBe(200);
  expect(me.json?.authenticated).toBe(true);
  await page.goto('/console');
  await expect(page.getByRole('dialog', { name: 'Welcome to OrchestraAI' })).toBeVisible({ timeout: 30_000 });
});

test('login with invalid credentials is rejected with a visible error', async ({ page }) => {
  await page.goto('/auth?mode=login');
  await page.getByLabel('Work email').fill('nobody@test.local');
  await page.getByLabel('Password').fill('wrong password 123');
  await page.getByRole('button', { name: 'Sign in →' }).click();
  await expect(page.locator('[role="alert"]')).toBeVisible();
});

test('login with valid credentials succeeds (round-trip)', async ({ browser }) => {
  const email = uniqueEmail('login');
  const registry = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const signupRes = await registry.post('/api/auth/signup', {
    data: { email, password: PASSWORD, name: 'Login User' },
  });
  expect(signupRes.status()).toBe(201);
  await registry.dispose();

  const page = await browser.newPage({ baseURL: BASE_URL });
  await page.goto('/auth?mode=login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in →' }).click();
  await expect(page).toHaveURL(/\/console/, { timeout: 30_000 });
});

test('logout invalidates the session', async ({ browser }) => {
  const { context } = await signup(browser);
  await expect((await apiRequest<{ authenticated: boolean }>(context, 'GET', '/api/auth/me')).json?.authenticated).toBe(true);

  const out = await apiRequest<{ ok: boolean }>(context, 'POST', '/api/auth/logout');
  expect(out.status).toBe(200);

  const meAfter = await apiRequest<{ authenticated: boolean }>(context, 'GET', '/api/auth/me');
  expect(meAfter.json?.authenticated).toBe(false);
  const runsAfter = await apiRequest(context, 'GET', '/api/runs');
  expect(runsAfter.status).toBe(401);

  // A fresh bearer check in a new cookie jar is also denied (no leaked state).
  const fresh = await playwrightRequest.newContext({ baseURL: BASE_URL });
  expect((await fresh.get('/api/runs')).status()).toBe(401);
  await fresh.dispose();
});