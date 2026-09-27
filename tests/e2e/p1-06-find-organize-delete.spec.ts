import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { sql } from '../support/stack';
import { seedPieces, wardrobeSpecs } from '../support/wardrobe';
import { signIn } from './support/auth';

const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** PostHog capture requests the page sends (the export points at a local stand-in). */
function captureEvents(page: Page) {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  void page.route('http://127.0.0.1:8793/**', async (route) => {
    const body = route.request().postDataJSON() as { event: string; properties: Record<string, unknown> };
    events.push({ event: body.event, properties: body.properties });
    await route.fulfill({ status: 200, body: '{}' });
  });
  return events;
}

const pieceTiles = (page: Page) => page.getByRole('list', { name: 'Pieces' }).getByRole('listitem');

test.describe('P1.06 demo: find, organize, archive and permanently delete pieces', () => {
  test('find shades among 50 pieces, filter, sort, and keep the view when coming back', async ({ page }) => {
    const a = await createIdentity('find-e2e');
    const pieces = await seedPieces(a.id, wardrobeSpecs(50));
    await signIn(page, a.email);
    await page.goto('/wardrobe');
    await expect(page.getByText('50 pieces', { exact: true })).toBeVisible();
    await expect(pieceTiles(page)).toHaveCount(50);

    await page.getByLabel('Search pieces').fill('shades');
    const eyewear = pieces.filter((p) => p.category === 'eyewear').length;
    await expect(page.getByText(`${eyewear} pieces`, { exact: true })).toBeVisible();
    await expect(pieceTiles(page)).toHaveCount(eyewear);
    await expect(page).toHaveURL(/q=shades/);

    await page.getByLabel('Search pieces').fill('');
    await page.getByRole('button', { name: /^Filters/ }).click();
    const filters = page.getByRole('region', { name: 'Filters and sort' });
    await filters.getByRole('group', { name: 'Category' }).getByRole('checkbox', { name: 'Bottoms' }).click();
    await filters.getByRole('group', { name: 'Color' }).getByRole('checkbox', { name: 'Navy' }).click();
    await filters.getByRole('radiogroup', { name: 'Sort' }).getByRole('radio', { name: 'Name' }).click();
    const expected = pieces.filter((p) => p.category === 'bottoms' && p.colors[0]!.name === 'navy').length;
    await expect(page.getByText(`${expected} ${expected === 1 ? 'piece' : 'pieces'}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Active filters' }).getByRole('button', { name: 'Remove filter Navy' })).toBeVisible();
    await expectAccessible(page);

    // Open a piece and come back: filters and sort are kept.
    await pieceTiles(page).first().getByRole('link').click();
    await expect(page).toHaveURL(/\/wardrobe\/items\//);
    await page.goBack();
    await expect(page).toHaveURL(/category=bottoms/);
    await expect(page.getByText(`${expected} ${expected === 1 ? 'piece' : 'pieces'}`, { exact: true })).toBeVisible();

    // No results say which filters are active and offer to clear them.
    await page.getByLabel('Search pieces').fill('sequins');
    await expect(page.getByText('No pieces match "sequins" with 2 filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.getByText('50 pieces', { exact: true })).toBeVisible();
  });

  test('bulk-correct a category, archive and restore from the keyboard @phone', async ({ page }) => {
    const a = await createIdentity('bulk-e2e');
    const pieces = await seedPieces(a.id, wardrobeSpecs(14));
    await signIn(page, a.email);
    await page.goto('/wardrobe');
    await page.getByRole('button', { name: 'Select' }).click();
    // Two named pieces ("Linen trousers 13", "Oxford shirt 11").
    const first = pieces[12]!;
    const second = pieces[10]!;
    for (const piece of [first, second]) {
      const toggle = page.getByRole('checkbox', { name: `Select ${piece.name}` });
      await toggle.focus();
      await page.keyboard.press('Space');
    }
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Change category' }).click();
    await page.getByRole('radiogroup', { name: 'New category' }).getByRole('radio', { name: 'Outerwear' }).click();
    await page.getByRole('button', { name: 'Apply to 2 pieces' }).click();
    await expect(page.getByText('Category changed for 2 pieces.')).toBeVisible();
    expect(await sql()`select 1 from public.items where id in (${first.id}, ${second.id}) and category = 'outerwear'`).toHaveLength(2);

    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('checkbox', { name: `Select ${first.name}` }).click();
    await page.getByRole('button', { name: 'Archive 1 piece' }).click();
    await expect(page.getByText('1 piece archived.')).toBeVisible();
    await expect(page.getByText('13 pieces', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Archived pieces' }).click();
    await expect(pieceTiles(page)).toHaveCount(1);
    await pieceTiles(page).first().getByRole('link').click();
    await expect(page.getByText('This piece is archived.')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This piece is archived.')).toBeHidden();
    const [row] = await sql()`select id, lifecycle, name from public.items where id = ${first.id}`;
    expect(row).toEqual({ id: first.id, lifecycle: 'active', name: first.name });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('permanently delete a piece: consequences first, then its images are verifiably gone; events carry no private data', async ({ page }) => {
    const events = captureEvents(page);
    const a = await createIdentity('delete-e2e');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose photos' }).click();
    await (await chooser).setFiles([{ name: 'private-name.png', mimeType: 'image/png', buffer: fixtures.garment }]);
    await page.getByRole('button', { name: 'Upload 1 photo' }).click();
    await page.getByRole('button', { name: 'View piece from photo 1' }).click({ timeout: 45_000 });
    await expect(page.getByRole('radiogroup', { name: 'Show' })).toBeVisible({ timeout: 45_000 });
    const itemId = page.url().split('/').pop()!;
    // Tags suggested Tops; the member corrects it.
    await page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Outerwear' }).click();
    await page.getByLabel('Name').fill('My secret shirt');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Delete permanently' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this piece permanently?' });
    await expect(dialog).toContainText('Its photos, cutout and care labels will be deleted.');
    await expect(dialog).toContainText('This cannot be undone. To keep it out of sight instead, archive it.');
    await dialog.getByRole('button', { name: 'Delete piece' }).click();
    await expect(page).toHaveURL(/\/wardrobe(\?.*)?$/);
    await expect(page.getByRole('status').filter({ hasText: /Piece deleted|Deleting the piece/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Piece deleted. Its photos are gone.' })).toBeVisible({ timeout: 60_000 });
    const [tomb] = await sql()`select lifecycle, name from public.items where id = ${itemId}`;
    expect(tomb).toEqual({ lifecycle: 'deleted', name: null });

    // Events: item added and reviewed, with categorical fields only.
    const names = events.map((e) => e.event);
    expect(names).toContain('item_added');
    expect(names).toContain('item_reviewed');
    const serialized = JSON.stringify(events);
    for (const secret of ['My secret shirt', 'private-name', itemId, a.email, 'http://127.0.0.1:9000', 'X-Amz']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('a 300-piece Bower shows its first page and search results quickly', async ({ page }) => {
    const a = await createIdentity('scale-e2e');
    await seedPieces(a.id, wardrobeSpecs(300));
    await signIn(page, a.email);
    const started = Date.now();
    await page.goto('/wardrobe');
    await expect(pieceTiles(page)).toHaveCount(50);
    const firstPage = Date.now() - started;
    const searchStarted = Date.now();
    await page.getByLabel('Search pieces').fill('pants');
    await expect(page.getByText('60 pieces', { exact: true })).toBeVisible();
    const searched = Date.now() - searchStarted;
    test.info().annotations.push({ type: 'timing', description: `first page ${firstPage} ms; search ${searched} ms` });
    // DESIGN 12: metadata search or filter within 1.5 s end to end (local stack).
    expect(searched).toBeLessThan(1500);
    expect(firstPage).toBeLessThan(5000);
  });
});
