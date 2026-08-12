import { expect, test } from '@playwright/test';

/**
 * Accounts plan Phase 1 degradation check: with no worker URL configured
 * (VITE_SYNC_API_URL unset — the default, and the deployed static site until
 * go-live), no account/sync UI exists anywhere and the app is the unchanged
 * zero-backend product.
 */
test('sync UI is absent when no worker URL is configured', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /teach it your sounds/i }).click();
  await expect(page.locator('.teach')).toBeVisible();
  // Backup buttons (Phase 0, purely local) are present…
  await expect(page.getByRole('button', { name: 'import profile' })).toBeVisible();
  // …but nothing account/sync-related is rendered.
  await expect(page.locator('.account')).toHaveCount(0);
  await expect(page.getByText(/sign in with/i)).toHaveCount(0);
  await expect(page.getByText(/Sync your profile/)).toHaveCount(0);
});
