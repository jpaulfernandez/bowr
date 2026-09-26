import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeGemini } from '../support/fake-gemini';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// P1.07-A4: the whole phase-1 journey works with no AI allowance, and a second
// member signing in on the same browser sees none of the first member's pieces.
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('P1.07-A4: add → correct → find → archive/restore at zero AI allowance', () => {
  test.afterEach(async () => {
    await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, paused_reason = null where id`;
  });

  test('the Bower works end to end with AI paused, and another member sees none of it', async ({ page }) => {
    await sql()`update private.budget_settings set lighter_micros = 0, stop_micros = 0 where id`;
    await fakeGemini.reset();
    const a = await createIdentity('journey-a');
    const b = await createIdentity('journey-b');
    await signIn(page, a.email);

    // Add: a garment and its care label, with no AI.
    await page.goto('/wardrobe/gather');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose photos' }).click();
    await (await chooser).setFiles([
      { name: 'shirt.png', mimeType: 'image/png', buffer: fixtures.garment },
      { name: 'label.png', mimeType: 'image/png', buffer: fixtures.label },
    ]);
    await page.getByRole('radiogroup', { name: 'Photo 2 is' }).getByRole('radio', { name: 'A care label' }).click();
    await page.getByRole('radiogroup', { name: 'Care label in photo 2 belongs to' }).getByRole('radio', { name: 'Photo 1' }).click();
    await page.getByRole('button', { name: 'Upload 2 photos' }).click();
    await page.getByRole('button', { name: 'View piece from photo 1' }).click({ timeout: 45_000 });
    const itemId = page.url().split('/').pop()!;

    // Correct: category, name and brand by hand; tags wait for the allowance.
    await expect(page.getByText(/Tag suggestions wait for the monthly AI allowance/)).toBeVisible({ timeout: 45_000 });
    await page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Tops' }).click();
    await page.getByLabel('Name').fill('Weekend shirt');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expectAccessible(page);

    // Find it.
    await page.goto('/wardrobe');
    await page.getByLabel('Search pieces').fill('weekend');
    await expect(page.getByText('1 piece', { exact: true })).toBeVisible();
    await page.getByRole('list', { name: 'Pieces' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Weekend shirt' })).toBeVisible();

    // Archive and restore.
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('This piece is archived.')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This piece is archived.')).toBeHidden();

    // Nothing reached the provider; the tags stage is parked, not failed.
    expect(await fakeGemini.calls()).toMatchObject({ count_tokens: 0, generate_content: 0 });
    const [stages] = await sql()`select (select state from public.item_stages where item_id = ${itemId} and stage = 'tags') as tags,
        (select state from public.item_stages where item_id = ${itemId} and stage = 'cutout') as cutout,
        lifecycle, name from public.items where id = ${itemId}`;
    expect(stages).toEqual({ tags: 'blocked_budget', cutout: 'succeeded', lifecycle: 'active', name: 'Weekend shirt' });

    // Account switch on the same browser: B sees none of A's pieces, search or photos.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'bowr', exact: true })).toBeVisible();
    await signIn(page, b.email);
    await page.goto('/wardrobe?q=weekend');
    await expect(page.getByText('No pieces match "weekend".')).toBeVisible();
    await expect(page.getByText('Weekend shirt')).toHaveCount(0);
    await page.goto(`/wardrobe/items/${itemId}`);
    await expect(page.getByText("This piece isn't in your Bower.")).toBeVisible();
    await page.goto(`/wardrobe/edges/${itemId}`);
    await expect(page.getByText("This piece isn't in your Bower.")).toBeVisible();
  });
});
