import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end suite for OrchestraAI.
//
// A single webServer boots the real backend (production demo mode, auth
// fails closed) on a throwaway data directory. Tests exercise the actual
// product: no hidden auth bypass, no mocked success.
//
// Local:        npm run test:e2e            (builds dist if needed, boots server)
// CI:           same command; reuse disabled and artifacts retained on failure.

const PORT = Number(process.env.E2E_PORT || 8791);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.artifacts/report' }]]
    : [['list']],
  outputDir: 'e2e/.artifacts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${baseURL}/api/health`,
    // Always boot a fresh, correctly-configured server: reuse (against a
    // stray dev-open process) would silently relax the auth boundary.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});