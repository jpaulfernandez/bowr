import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeGemini } from '../support/fake-gemini';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { uniquePng } from '../support/png';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker (pinned models) and fake Gemini.
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function gather(page: Page, files: Array<{ name: string; buffer: Buffer; group?: boolean }>) {
  await page.goto('/wardrobe/gather');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, buffer: f.buffer, mimeType: 'image/png' })));
  for (const [index, file] of files.entries()) {
    if (file.group) {
      await page.getByRole('radiogroup', { name: `Photo ${index + 1} is` }).getByRole('radio', { name: 'Several small pieces' }).click();
    }
  }
  await page.getByRole('button', { name: files.length === 1 ? 'Upload 1 photo' : `Upload ${files.length} photos` }).click();
  await expect(page).toHaveURL(/\/wardrobe\/uploads\//);
}

const pieceCount = async (userId: string) =>
  (await sql()`select count(*)::int as n from public.items where user_id = ${userId} and lifecycle = 'active'`)[0]!.n as number;

test.describe('P1.04 demo: split accessories and resolve probable duplicates', () => {
  test.beforeEach(() => fakeGemini.reset());

  test('earrings stay one set and a watch and bracelet become two pieces, only after confirmation', async ({ page }) => {
    const a = await createIdentity('parts-e2e');
    await signIn(page, a.email);
    await gather(page, [
      { name: 'earrings.png', buffer: fixtures.earrings, group: true },
      { name: 'watch-bracelet.png', buffer: fixtures.accessories, group: true },
    ]);
    const rows = page.getByRole('listitem').filter({ hasText: 'choose how to add them' });
    await expect(rows).toHaveCount(2, { timeout: 45_000 });
    expect(await pieceCount(a.id)).toBe(0);
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Choose pieces from photo 1' }).click();
    await page.getByRole('radiogroup', { name: 'How should this photo be added?' }).getByRole('radio', { name: 'Keep as one set' }).click();
    await page.getByRole('button', { name: 'Add as one piece' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: '1 piece added' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Choose pieces from photo 2' }).click();
    await page.getByRole('radiogroup', { name: 'How should this photo be added?' }).getByRole('radio', { name: 'Split into pieces' }).click();
    const pieces = page.getByRole('list', { name: 'Pieces to add' }).getByRole('listitem');
    await expect(pieces).toHaveCount(2);
    await expectAccessible(page);
    // Rectangles are edited with fields, not dragging; a typo is caught and nothing is lost.
    await page.getByLabel('Width (%), piece 1').fill('95');
    await page.getByRole('button', { name: 'Add 2 pieces' }).click();
    await expect(page.getByText('Check the numbers for piece 1: each must fit inside the photo.')).toBeVisible();
    await expect(page.getByLabel('Width (%), piece 1')).toHaveValue('95');
    await page.getByLabel('Width (%), piece 1').fill('20');
    // An extra piece can be added and removed from the keyboard.
    await page.getByRole('button', { name: 'Add a piece' }).focus();
    await page.keyboard.press('Enter');
    await expect(pieces).toHaveCount(3);
    await page.getByRole('button', { name: 'Remove piece 3' }).focus();
    await page.keyboard.press('Enter');
    await expect(pieces).toHaveCount(2);

    // A lost response keeps the draft; sending again uses the same request.
    let attempts = 0;
    const keys = new Set<string>();
    await page.route('**/v1/upload-entries/*/confirm-parts', async (route) => {
      attempts += 1;
      keys.add(route.request().headers()['idempotency-key'] ?? '');
      if (attempts === 1) return route.abort('connectionreset');
      return route.continue();
    });
    await page.getByRole('button', { name: 'Add 2 pieces' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Width (%), piece 1')).toHaveValue('20');
    await page.getByRole('button', { name: 'Add 2 pieces' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: '2 pieces added' })).toHaveCount(1);
    expect(keys.size).toBe(1);

    // Two photos became three pieces, each with its own photo once cropped.
    await expect.poll(() => pieceCount(a.id)).toBe(3);
    await page.getByRole('button', { name: 'View piece 1 from photo 2' }).click();
    await expect(page.getByRole('img', { name: /original photo|cutout/ })).toBeVisible({ timeout: 45_000 });
  });

  test('a repeated photo waits for Use existing, Add another or Decide later, and the choice survives a reload @phone', async ({ page }) => {
    const a = await createIdentity('dupes-e2e');
    await signIn(page, a.email);
    await gather(page, [{ name: 'shirt.png', buffer: fixtures.garment }]);
    await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 45_000 });

    await gather(page, [{ name: 'shirt-again.png', buffer: fixtures.garment }]);
    await expect(page.getByRole('listitem').first()).toContainText('Already in your Bower? Choose below.', { timeout: 45_000 });
    const question = page.getByRole('group', { name: 'Possible duplicate: photo 1' });
    await expect(question.getByRole('img', { name: 'Photo 1, just uploaded' })).toBeVisible();
    await expect(question.getByRole('img', { name: /Your existing piece/ })).toBeVisible();
    expect(await pieceCount(a.id)).toBe(1);
    await expectAccessible(page);
    await question.getByRole('button', { name: 'Decide later' }).click();
    await expect(page.getByText('You can decide later. This question stays here.')).toBeVisible();
    await page.reload();
    await expect(question.getByRole('button', { name: 'Add as another piece' })).toBeVisible({ timeout: 30_000 });
    await question.getByRole('button', { name: 'Add as another piece' }).click();
    await expect(page.getByRole('button', { name: 'View piece from photo 1' })).toBeVisible({ timeout: 30_000 });
    expect(await pieceCount(a.id)).toBe(2);

    await gather(page, [{ name: 'shirt-third.png', buffer: fixtures.garment }]);
    await page.getByRole('group', { name: 'Possible duplicate: photo 1' }).getByRole('button', { name: 'Use existing piece' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('Kept your existing piece; no new piece added');
    expect(await pieceCount(a.id)).toBe(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('a near match is flagged on the new piece; Use existing removes only that new piece after confirmation', async ({ page }) => {
    const a = await createIdentity('near-e2e');
    await signIn(page, a.email);
    await gather(page, [{ name: 'shirt.png', buffer: uniquePng(fixtures.garment) }]);
    await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 45_000 });
    const [older] = await sql()`select id from public.items where user_id = ${a.id}`;
    await expect.poll(async () => (await sql()`select 1 from public.item_embeddings where item_id = ${older!.id}`).length, { timeout: 45_000 }).toBe(1);

    await gather(page, [{ name: 'same-shirt-new-photo.png', buffer: uniquePng(fixtures.garment) }]);
    await page.getByRole('button', { name: 'View piece from photo 1' }).click({ timeout: 45_000 });
    const question = page.getByRole('group', { name: 'Possible duplicate: this piece' });
    await expect(question).toBeVisible({ timeout: 45_000 });
    await expectAccessible(page);
    await question.getByRole('button', { name: 'Use existing piece instead' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove this new piece?' });
    await expect(dialog).toContainText('Your existing piece stays as it is.');
    await dialog.getByRole('button', { name: 'Remove new piece' }).click();
    await expect(page).toHaveURL(new RegExp(`/wardrobe/items/${older!.id}$`));
    expect(await pieceCount(a.id)).toBe(1);
  });
});
