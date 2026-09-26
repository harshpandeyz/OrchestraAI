import { test, expect } from '@playwright/test';
import { signup } from './util';

// Accessibility smoke: landmark structure and keyboard operability of the
// console's core surfaces. Release-blocking criteria (minimal, as documented in
// qa/RELEASE.md): the workspace is a labelled region, navigation is a labelled
// landmark, and the primary dialogs can be operated without a mouse.

async function readyConsole(browser: import('@playwright/test').Browser) {
  const { page } = await signup(browser);
  await page.goto('/console');
  const onboarding = page.getByRole('dialog', { name: 'Welcome to OrchestraAI' });
  await onboarding.waitFor({ timeout: 30_000 });
  await onboarding.getByRole('button', { name: 'Continue in Demo mode' }).click();
  await expect(onboarding).toBeHidden();
  return page;
}

test('console exposes labelled landmarks', async ({ browser }) => {
  const page = await readyConsole(browser);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('new-run dialog can be opened and dismissed by keyboard only', async ({ browser }) => {
  const page = await readyConsole(browser);

  // Focus + Enter opens the New run dialog.
  await page.getByRole('button', { name: /^New run/i }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Start a new run' });
  await expect(dialog).toBeVisible();

  // The primary action is reachable and labelled.
  await expect(dialog.getByRole('button', { name: 'Run task' })).toBeVisible();

  // Escape closes the dialog without a mouse.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('navigation can be driven by keyboard', async ({ browser }) => {
  const page = await readyConsole(browser);
  await page.getByRole('button', { name: 'Models' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Model Intelligence', level: 2 }).first()).toBeVisible();
});

test('primary buttons have accessible names', async ({ browser }) => {
  const page = await readyConsole(browser);
  const buttons = page.locator('button');
  const count = await buttons.count();
  let unnamed = 0;
  for (let i = 0; i < count; i++) {
    const el = buttons.nth(i);
    const aria = (await el.getAttribute('aria-label')) ?? '';
    const text = ((await el.innerText()) ?? '').trim();
    if (!aria.trim() && !text) unnamed++;
  }
  expect(unnamed, `${unnamed} of ${count} buttons lack an accessible name`).toBe(0);
});