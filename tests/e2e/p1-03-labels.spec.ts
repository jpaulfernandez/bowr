import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeGemini } from '../support/fake-gemini';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker (pinned models) and fake Gemini.
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function choose(page: Page, files: Array<{ name: string; buffer: Buffer }>) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: 'image/png' })));
}

test.describe('P1.03 demo: a mixed batch with care labels', () => {
  test.beforeEach(() => fakeGemini.reset());

  test('a shirt, its care label and trousers upload together; the label attaches, fills facts and can be removed', async ({ page }) => {
    const a = await createIdentity('labels-e2e');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    await choose(page, [
      { name: 'shirt.png', buffer: fixtures.garment },
      { name: 'shirt-label.png', buffer: fixtures.label },
      { name: 'trousers.png', buffer: fixtures.trousers },
    ]);
    // A label without its piece chosen is caught before anything uploads.
    await page.getByRole('radiogroup', { name: 'Photo 2 is' }).getByRole('radio', { name: 'A care label' }).click();
    await page.getByRole('button', { name: 'Upload 3 photos' }).click();
    await expect(page.getByText('Choose which piece each care label belongs to (photo 2).')).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Care label in photo 2 belongs to' }).getByRole('radio', { name: 'Photo 1' }).click();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Upload 3 photos' }).click();

    await expect(page).toHaveURL(/\/wardrobe\/uploads\//);
    const labelRow = page.getByRole('listitem').filter({ hasText: '(care label)' });
    await expect(labelRow).toContainText('Care label attached to its piece', { timeout: 45_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Ready' })).toHaveCount(2, { timeout: 45_000 });
    // One polite summary line, not one announcement per file.
    await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
    await expectAccessible(page);
    const [{ pieces }] = await sql()`select count(*)::int as pieces from public.items where user_id = ${a.id}`;
    expect(pieces).toBe(2);

    await page.getByRole('button', { name: 'View piece from photo 1' }).click();
    const labels = page.getByRole('list', { name: 'Care labels' });
    await expect(labels.getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Show purchase details' }).click();
    await expect(page.getByLabel('Brand')).toHaveValue('Uniqlo', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Remove care label 1' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove this care label?' });
    await expect(dialog).toContainText('Brand, size and material already on this piece stay as they are.');
    await dialog.getByRole('button', { name: 'Remove label' }).click();
    await expect(page.getByText('Label removed.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Care labels' })).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Show purchase details' }).click();
    await expect(page.getByLabel('Brand')).toHaveValue('Uniqlo');
  });

  test('a label added from a piece attaches to that piece, not a new one', async ({ page }) => {
    const a = await createIdentity('labels-add');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    await choose(page, [{ name: 'shirt.png', buffer: fixtures.garment }]);
    await page.getByRole('button', { name: 'Upload 1 photo' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });
    await page.getByRole('button', { name: 'View piece from photo 1' }).click();
    await page.getByRole('button', { name: 'Add care label' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add care label' })).toBeVisible();
    await choose(page, [{ name: 'label.png', buffer: fixtures.label }]);
    await page.getByRole('button', { name: 'Upload 1 photo' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('Care label attached to its piece', { timeout: 30_000 });
    const [{ pieces, labels }] = await sql()`select count(*)::int as pieces,
        (select count(*)::int from public.item_assets ia join public.items i on i.id = ia.item_id where i.user_id = ${a.id} and ia.role = 'label') as labels
      from public.items where user_id = ${a.id}`;
    expect({ pieces, labels }).toEqual({ pieces: 1, labels: 1 });
  });

  test('closing the tab mid-batch keeps finished uploads; the unsent label is identified and can be sent later', async ({ context }) => {
    const a = await createIdentity('labels-resume');
    const first = await context.newPage();
    await signIn(first, a.email);
    await first.goto('/wardrobe/gather');
    let puts = 0;
    await first.route('http://127.0.0.1:9000/**', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts += 1;
      if (puts === 1) return route.continue();
      // The label's upload never finishes before the tab closes.
    });
    await choose(first, [
      { name: 'shirt.png', buffer: fixtures.garment },
      { name: 'label.png', buffer: fixtures.label },
    ]);
    await first.getByRole('radiogroup', { name: 'Photo 2 is' }).getByRole('radio', { name: 'A care label' }).click();
    await first.getByRole('radiogroup', { name: 'Care label in photo 2 belongs to' }).getByRole('radio', { name: 'Photo 1' }).click();
    await first.getByRole('button', { name: 'Upload 2 photos' }).click();
    await expect(first.getByRole('listitem').filter({ hasText: 'shirt.png' })).toContainText(/checking photo|Ready/, { timeout: 30_000 });
    const batchId = first.url().split('/').pop()!;
    await first.close();

    const second = await context.newPage();
    await signIn(second, a.email);
    await second.goto(`/wardrobe/uploads/${batchId}`);
    await expect(second.getByRole('listitem').filter({ hasText: 'Ready' })).toHaveCount(1, { timeout: 30_000 });
    const unsent = second.getByRole('listitem').filter({ hasText: 'Not uploaded. Choose this photo again.' });
    await expect(unsent).toContainText('(care label)');
    // Only what needs attention can be shown on its own.
    await second.getByRole('button', { name: /Show only photos that need attention \(1\)/ }).click();
    await expect(second.getByRole('listitem')).toHaveCount(1);
    await second.getByRole('button', { name: 'Show all photos' }).click();

    const [{ jobs }] = await sql()`select count(*)::int as jobs from private.jobs j join public.upload_entries e on e.asset_id = j.target_id where e.batch_id = ${batchId}`;
    const reselect = second.waitForEvent('filechooser');
    await unsent.getByRole('button', { name: 'Choose photo 2 again' }).click();
    await (await reselect).setFiles([{ name: 'label.png', mimeType: 'image/png', buffer: fixtures.label }]);
    await expect(second.getByRole('listitem').filter({ hasText: 'Care label attached to its piece' })).toHaveCount(1, { timeout: 45_000 });
    const [after] = await sql()`select count(*)::int as jobs from private.jobs j join public.upload_entries e on e.asset_id = j.target_id where e.batch_id = ${batchId}`;
    expect(after!.jobs).toBe(jobs + 1);
    const [{ pieces }] = await sql()`select count(*)::int as pieces from public.items where user_id = ${a.id}`;
    expect(pieces).toBe(1);
  });

  test('twenty photos including labels fit; more are held back with a clear message; the guide is category-first @phone', async ({ page }) => {
    const a = await createIdentity('labels-limit');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    const files = Array.from({ length: 21 }, (_, i) => ({ name: `photo-${i + 1}.png`, buffer: fixtures.label }));
    // Keyboard-only: the file chooser opens from the focused button.
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose photos' }).focus();
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: 'image/png' })));
    await expect(page.getByText(/You can add up to 20 photos at a time, including care labels\. 1 photo wasn't added/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Selected photos' }).getByRole('listitem')).toHaveCount(20);
    await expect(page.getByRole('button', { name: 'Upload 20 photos' })).toBeEnabled();
    const kind = page.getByRole('radiogroup', { name: 'Photo 20 is' }).getByRole('radio', { name: 'A care label' });
    await kind.focus();
    await page.keyboard.press('Enter');
    await expect(kind).toHaveAttribute('aria-checked', 'true');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);

    await page.getByRole('link', { name: 'Full photo guide' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Photo guide' })).toBeVisible();
    await expectAccessible(page);
    await page.goto('/help/photos?category=shoes');
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Shoes');
    await page.goto('/more');
    await page.getByRole('link', { name: /Photo guides/ }).click();
    await expect(page).toHaveURL(/\/help\/photos$/);
  });
});
