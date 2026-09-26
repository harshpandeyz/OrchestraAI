import { test, expect } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './util';

// Primary user journey: landing -> get started -> signup -> onboarding ->
// demo -> task -> run -> completion -> history. This proves the complete
// product loop end-to-end through the real console (no mocked success).

test('complete product loop from landing to a finished demo run', async ({ page }) => {
  // 1. Landing page.
  await page.goto('/');
  await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible();

  // 2. Get started -> auth (signup).
  await page.getByRole('link', { name: /get started/i }).first().click();
  await expect(page).toHaveURL(/\/auth/);

  // 3. Sign up.
  const email = uniqueEmail('journey');
  await page.getByLabel('Name').fill('Journey User');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create workspace →' }).click();

  // 4. Console appears (authenticated). Dismiss onboarding into demo mode.
  await expect(page).toHaveURL(/\/console/, { timeout: 30_000 });
  const onboarding = page.getByRole('dialog', { name: 'Welcome to OrchestraAI' });
  await onboarding.waitFor({ timeout: 30_000 });
  await onboarding.getByRole('button', { name: 'Continue in Demo mode' }).click();
  await expect(onboarding).toBeHidden();

  // 5. Create a run.
  await page.getByRole('button', { name: /create a new run/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a new run' });
  await dialog.getByLabel('Task title').fill('Say hello and finish');
  await dialog.getByRole('button', { name: 'Run task' }).click();
  await expect(dialog).toBeHidden();

  // 6. Run view + composer ready.
  const composer = page.getByLabel('Message the agent');
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // 7. Start the run.
  await composer.fill('Say hello and finish.');
  await page.getByRole('button', { name: 'Send message' }).click();

  // 8. Completion — the run reaches a truthful terminal state in the UI.
  await expect(page.getByRole('status', { name: /task complete/i })).toBeVisible({ timeout: 60_000 });

  // 9. History contains the run (sidebar reflects the completed run).
  await expect(
    page.getByRole('listbox', { name: 'Recent runs' }).getByRole('option').filter({ hasText: 'Say hello and finish' }).first(),
  ).toBeVisible();
});