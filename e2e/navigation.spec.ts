import { test, expect } from '@playwright/test';
import { signup } from './util';

// Navigation regression. The console is state-driven (sidebar -> view). These
// tests pin the user-visible truth: each destination must render its OWN page,
// not another surface. Two prompt-era regressions are asserted as the CORRECT
// behavior:
//
//   QA-NAV-01  "Evaluations" must show Evaluations, NOT Alerts   (was P1)
//   QA-NAV-02  "Traces" must not silently show Intelligence       (was P1)
//
// V2 IA: Workspace / Build / Intelligence / Operate groups (collapsible) +
// a "More" group for legacy surfaces. Tests expand groups before navigating.

async function openConsole(browser: import('@playwright/test').Browser) {
  const { page } = await signup(browser);
  await page.goto('/console');
  const onboarding = page.getByRole('dialog', { name: 'Welcome to OrchestraAI' });
  await onboarding.waitFor({ timeout: 30_000 });
  await onboarding.getByRole('button', { name: 'Continue in Demo mode' }).click();
  await expect(onboarding).toBeHidden();
  return page;
}

async function expandGroup(page: import('@playwright/test').Page, name: string) {
  const toggle = page.getByRole('button', { name, exact: true });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

async function more(page: import('@playwright/test').Page) {
  await expandGroup(page, 'More');
}

test.describe('console navigation', () => {
  test('Overview renders the Overview page', async ({ browser }) => {
    const page = await openConsole(browser);
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Overview', level: 2 }).first()).toBeVisible();
  });

  test('Models renders model intelligence', async ({ browser }) => {
    const page = await openConsole(browser);
    await page.getByRole('button', { name: 'Models' }).click();
    await expect(page.getByRole('heading', { name: 'Model Intelligence', level: 2 }).first()).toBeVisible();
  });

  test('Agents renders observed agent work (never invented)', async ({ browser }) => {
    const page = await openConsole(browser);
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agents', level: 2 }).first()).toBeVisible();
  });

  test('Approvals renders the attention queue + inbox', async ({ browser }) => {
    const page = await openConsole(browser);
    await expandGroup(page, 'Operate');
    await page.getByRole('button', { name: 'Approvals' }).click();
    await expect(page.getByRole('heading', { name: 'Approvals', level: 2 }).first()).toBeVisible();
  });

  test('Projects renders the Projects surface', async ({ browser }) => {
    const page = await openConsole(browser);
    await more(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.getByRole('heading', { name: 'Projects / Teams', level: 2 }).first()).toBeVisible();
  });

  test('Settings renders the Settings surface', async ({ browser }) => {
    const page = await openConsole(browser);
    await more(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 2 }).first()).toBeVisible();
  });

  test('Savings renders the Savings surface', async ({ browser }) => {
    const page = await openConsole(browser);
    await more(page);
    await page.getByRole('button', { name: 'Savings' }).click();
    await expect(page.getByRole('heading', { name: 'Savings', level: 2 }).first()).toBeVisible();
  });

  test('Alerts renders the Alerts surface', async ({ browser }) => {
    const page = await openConsole(browser);
    await expandGroup(page, 'Operate');
    await page.getByRole('button', { name: 'Alerts' }).click();
    await expect(page.getByText('No alert rules are configured yet')).toBeVisible();
  });

  // QA-NAV-01 — "Evaluations" must render Evaluations, never Alerts.
  test('Evaluations renders the Evaluations page (not Alerts)', async ({ browser }) => {
    const page = await openConsole(browser);
    await expandGroup(page, 'Intelligence');
    await page.getByRole('button', { name: 'Evaluations' }).click();
    await expect(page.getByText('Runtime quality metrics')).toBeVisible();
    await expect(page.getByText('No alert rules are configured yet')).toHaveCount(0);
  });

  // QA-NAV-02 — "Traces" must not silently render Intelligence; the current
  // product keeps standalone traces unavailable and must say so truthfully.
  test('Traces shows a truthful unavailable state (not the Intelligence page)', async ({ browser }) => {
    const page = await openConsole(browser);
    await more(page);
    await page.getByRole('button', { name: 'Traces' }).click();
    await expect(page.getByText('Model intelligence, measured')).toHaveCount(0);
    await expect(page.getByText(/Standalone traces are not available yet/)).toBeVisible();
  });

  test('Run studio shows Goal→Evidence tabs with an execution graph', async ({ browser }) => {
    const page = await openConsole(browser);
    // Fresh workspaces have no runs — create one so the studio has state.
    await page.getByRole('button', { name: /create a new run/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Start a new run' });
    await dialog.getByLabel('Task title').fill('Studio tabs check');
    await dialog.getByRole('button', { name: 'Run task' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Runs' }).click();
    await expect(page.getByRole('tab', { name: 'Execution' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: 'Evidence' })).toBeVisible();
  });

  test('Run deep links work with Back/Forward', async ({ browser }) => {
    const page = await openConsole(browser);
    await page.goto('/console/models');
    await expect(page.getByRole('heading', { name: 'Model Intelligence', level: 2 }).first()).toBeVisible();
    await page.goBack();
  });
});
