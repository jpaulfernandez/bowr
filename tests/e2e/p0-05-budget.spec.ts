import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { fakeGemini } from '../support/fake-gemini';
import { createIdentity } from '../support/identities';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local fake provider: pnpm fake-ai:serve
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async () => {
  await fakeGemini.reset();
  await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, ceiling_micros = 10000000, paused_reason = null where id`;
});

test.afterAll(async () => {
  await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, ceiling_micros = 10000000, paused_reason = null where id`;
});

test('P0.05 demo: diagnostic settles, zero allowance refuses before the provider', async ({ page }) => {
  const owner = await createIdentity('spend-owner', { role: 'owner', displayName: 'Spend Owner' });
  await signIn(page, owner.email);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 2, name: 'AI spend' })).toBeVisible();
  await expect(page.getByText(/^Normal · resets/)).toBeVisible();

  await page.getByRole('button', { name: 'Run AI diagnostic' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Diagnostic completed in normal mode' })).toBeVisible();
  expect((await fakeGemini.calls()).generate_content).toBe(1);
  await expect(page.getByText('Month to date (actual)')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  await page.getByLabel('Lighter mode from (USD)').fill('0');
  await page.getByLabel('Pause AI at (USD)').fill('0');
  await page.getByRole('button', { name: 'Review new limits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the monthly AI limits?' });
  await expect(dialog).toContainText('All AI requests will be refused');
  await dialog.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByText(/^Paused · resets/)).toBeVisible();

  await fakeGemini.reset();
  await page.getByRole('button', { name: 'Run AI diagnostic' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'refused before reaching the provider' })).toBeVisible();
  expect(await fakeGemini.calls()).toMatchObject({ count_tokens: 0, generate_content: 0 });
});

for (const [timezoneId, expected] of [
  ['Asia/Manila', /resets Oct 1, 2026, 8:00\sAM \(Asia\/Manila\)/],
  ['America/New_York', /resets Sep 30, 2026, 8:00\sPM \(America\/New_York\)/],
] as const) {
  test(`the reset time is shown in the viewer's timezone (${timezoneId})`, async ({ browser }) => {
    const owner = await createIdentity('tz-owner', { role: 'owner' });
    const context = await browser.newContext({ timezoneId, locale: 'en-US' });
    const page = await context.newPage();
    await signIn(page, owner.email);
    await page.goto('/admin');
    await expect(page.getByText(expected)).toBeVisible();
    await context.close();
  });
}

test('a member sees no AI spend or admin controls', async ({ page }) => {
  const member = await createIdentity('spend-member');
  await signIn(page, member.email);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(page.getByText('AI spend')).toHaveCount(0);
});
