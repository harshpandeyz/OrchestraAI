import { test, expect } from '@playwright/test';
import { signup } from './util';

// Responsive sanity: the console must not overflow horizontally and the
// primary action (top-bar New run / sidebar toggle) must stay reachable.

const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 320, height: 800 },
  { width: 375, height: 812 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

test('no horizontal overflow and a reachable primary action at key viewports', async ({ browser }) => {
  const { page } = await signup(browser);
  await page.goto('/console');
  const onboarding = page.getByRole('dialog', { name: 'Welcome to OrchestraAI' });
  await onboarding.waitFor({ timeout: 30_000 });
  await onboarding.getByRole('button', { name: 'Continue in Demo mode' }).click();
  await expect(onboarding).toBeHidden();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(150);

    await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();

    // Primary action: either the top-bar New run button or the sidebar toggle.
    const reachable =
      (await page.getByRole('button', { name: /^New run/i }).count()) > 0 ||
      (await page.getByRole('button', { name: 'Open sidebar' }).count()) > 0;
    expect(reachable, `no primary action at ${vp.width}x${vp.height}`).toBe(true);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow, `horizontal overflow (${overflow}px) at ${vp.width}x${vp.height}`).toBeLessThanOrEqual(1);
  }
});