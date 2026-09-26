import { request as playwrightRequest, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Shared E2E fixtures/utilities. All fixtures exercise the REAL product: no
// auth bypass, no injected success. Credentials are deterministic test data.

export const PORT = Number(process.env.E2E_PORT || 8791);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const PASSWORD = 'qa test password 123';

export function uniqueEmail(prefix = 'qa'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

export interface SignedIn {
  email: string;
  context: BrowserContext;
  page: Page;
}

/**
 * Sign a user up through the real /api/auth/signup endpoint and return a
 * browser context carrying the HttpOnly session cookie (same credential the
 * real console uses — JavaScript never sees it).
 */
export async function signup(browser: Browser, name = 'QA User'): Promise<SignedIn> {
  const email = uniqueEmail();
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const res = await api.post('/api/auth/signup', {
    data: { email, password: PASSWORD, name },
  });
  const body = await res.text();
  if (res.status() !== 201) {
    throw new Error(`signup failed (${res.status()}): ${body}`);
  }
  const setCookie = res.headers()['set-cookie'] ?? '';
  await api.dispose();

  const context = await browser.newContext({ baseURL: BASE_URL });
  const m = setCookie.match(/(oa_session)=([^;]+)/);
  if (m) {
    await context.addCookies([
      { name: m[1], value: decodeURIComponent(m[2]), url: BASE_URL, httpOnly: true, sameSite: 'Lax' },
    ]);
  }
  const page = await context.newPage();
  return { email, context, page };
}

/** API helper using a pre-authenticated cookie, for deterministic fixtures. */
/** Header-serialized session credential for raw Node `fetch` (SSE streaming). */
export async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(BASE_URL);
  const c = cookies.find((x) => x.name === 'oa_session');
  // The browser stores the decoded token; re-encode so the server's
  // decodeURIComponent round-trips to the original token.
  return c ? `oa_session=${encodeURIComponent(c.value)}` : '';
}

/**
 * Authenticated API call bound to the browser context's cookie jar
 * (including HttpOnly session cookies) — the same credential the console uses.
 */
export async function apiRequest<T = unknown>(
  context: BrowserContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const req = context.request;
  const opts: Record<string, unknown> = {};
  if (body !== undefined) opts.data = body;
  const res = method === 'GET' ? await req.get(path) : await req.post(path, opts);
  let json: T | null = null;
  try { json = (await res.json()) as T; } catch { /* non-JSON */ }
  return { status: res.status(), json };
}