import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeGemini } from '../support/fake-gemini';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker (pinned models) and fake Gemini: pnpm worker:serve, pnpm fake-ai:serve
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function gatherShirt(page: Page) {
  await page.goto('/wardrobe/gather');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([{ name: 'shirt.png', mimeType: 'image/png', buffer: fixtures.garment }]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });
  await page.getByRole('button', { name: 'View piece from photo 1' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/items\//);
  return page.url().split('/').pop()!;
}

test.describe('P1.02 demo: suggestions fill in without losing edits', () => {
  test.afterEach(async () => {
    await fakeGemini.reset();
    await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, paused_reason = null`;
  });

  test('change material while tagging runs; the correction survives and the rest fills in', async ({ page }) => {
    await fakeGemini.control({ delay_ms: 3000 });
    const a = await createIdentity('suggest-a');
    await signIn(page, a.email);
    const itemId = await gatherShirt(page);

    await expect(page.getByText('Tags: Suggesting tags.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Show details' }).click();
    await page.getByLabel('Material').fill('linen');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. Your edits take priority over suggestions.')).toBeVisible();

    // The late suggestion fills the untouched category and pattern only.
    await expect(page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Tops' })).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 30_000 },
    );
    await expect(page.getByLabel('Material')).toHaveValue('linen');
    await expect(page.getByText('Suggested material: cotton')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Navy linen shirt/, { timeout: 15_000 });
    await expectAccessible(page);

    // Reload: persisted, and the suggestion can still be chosen explicitly.
    await page.reload();
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByLabel('Material')).toHaveValue('linen');
    await page.getByRole('button', { name: 'Use suggested material' }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByLabel('Material')).toHaveValue('cotton');

    const [row] = await sql()`select material, category, field_meta -> 'material' ->> 'source' as source,
        (select count(*)::int from public.item_embeddings e where e.item_id = i.id and e.media_revision = i.media_revision) as vectors
      from public.items i where i.id = ${itemId}`;
    expect(row).toEqual({ material: 'cotton', category: 'tops', source: 'user', vectors: 1 });
  });

  test('at zero AI allowance the piece is still usable and says when tags resume @phone', async ({ page }) => {
    await sql()`update private.budget_settings set lighter_micros = 0, stop_micros = 0`;
    // Other spec files' calls may still be counted; this test measures only its own.
    await fakeGemini.reset();
    const a = await createIdentity('suggest-zero');
    await signIn(page, a.email);
    await gatherShirt(page);
    await expect(page.getByText(/Tag suggestions wait for the monthly AI allowance, which resets/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('radiogroup', { name: 'Show' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Tops' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry tags/ })).toHaveCount(0);
    await expectAccessible(page);
    expect((await fakeGemini.calls()).generate_content).toBe(0);
  });
});
