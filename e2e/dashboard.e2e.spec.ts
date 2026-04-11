import { test, expect } from '@playwright/test';

test.describe('dashboard operator flow', () => {
  test('renders health and overview controls', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Operator Control Surface' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh now' })).toBeVisible();
    await expect(page.locator('#overview-metrics .metric')).toHaveCount(4);
  });

  test('queues refresh and updates status banner', async ({ page }) => {
    await page.goto('/');

    const refreshResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/api/v1/refresh') && response.request().method() === 'POST'
    );

    await page.getByRole('button', { name: 'Refresh now' }).click();

    const refreshResponse = await refreshResponsePromise;
    expect(refreshResponse.status()).toBe(202);
    const payload = (await refreshResponse.json()) as { queued: boolean; coalesced: boolean };
    expect(payload.queued).toBe(true);

    await expect(page.locator('#refresh-status')).toContainText(/Live|Refresh (queued|coalesced)/);
  });

  test('supports issue lookup and graceful unknown issue message', async ({ page }) => {
    await page.goto('/');

    await page.locator('#issue-input').fill('ABC-404');
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.locator('#issue-output')).toContainText('Issue load failed');
    await expect(page.locator('#issue-output')).toContainText('ABC-404');
  });

  test('supports quick keyboard filter focus', async ({ page }) => {
    await page.goto('/');

    await page.keyboard.press('/');
    await expect(page.locator('#running-filter')).toBeFocused();
  });
});
