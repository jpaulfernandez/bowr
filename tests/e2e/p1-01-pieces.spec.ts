import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { wardrobeFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker with pinned models: pnpm worker:models && pnpm worker:serve
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function gather(page: Page, name: string, buffer: Buffer) {
  await page.goto('/wardrobe/gather');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([{ name, mimeType: 'image/png', buffer }]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/uploads\//);
  await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });
  await page.getByRole('button', { name: 'View piece from photo 1' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/items\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

async function pauseAi() {
  await sql()`update private.budget_settings set paused_reason = 'operator' where id`;
}
async function resumeAi() {
  await sql()`update private.budget_settings set paused_reason = null where id`;
}

test.describe('P1.01 demo: add one piece and correct it without AI', () => {
  test.beforeAll(pauseAi);
  test.afterAll(resumeAi);

  test('upload a shirt, see its cutout in Bower, edit category and name, and reopen it', async ({ page }) => {
    const a = await createIdentity('piece-a');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    // The brief guide opens on a first upload and stays one tap away.
    await expect(page.getByRole('region', { name: 'Photo tips' })).toContainText('One piece per photo');
    await expectAccessible(page);

    const itemId = await gather(page, 'shirt.png', fixtures.garment);
    await expect(page.getByRole('heading', { level: 1, name: 'Untitled piece' })).toBeVisible();
    await expect(page.getByText('Check category')).toBeVisible();
    // The cutout arrives and the Cutout/Original switch appears.
    const show = page.getByRole('radiogroup', { name: 'Show' });
    await expect(show).toBeVisible({ timeout: 30_000 });
    await expect(show.getByRole('radio', { name: 'Cutout' })).toHaveAttribute('aria-checked', 'true');
    const image = page.getByRole('img', { name: /Untitled piece, cutout/ });
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth || (el.querySelector('img')?.naturalWidth ?? 0))).toBe(1024);
    await expect(page.getByText(/privacy-sanitized copy of your photo/)).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Tops' }).click();
    await page.getByLabel('Name').fill('Blue Oxford');
    await page.getByRole('group', { name: 'Colors' }).getByRole('checkbox', { name: 'Navy' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved. Your edits take priority over suggestions.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Blue Oxford' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Tops' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('group', { name: 'Colors' }).getByRole('checkbox', { name: 'Navy' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Check category')).toHaveCount(0);

    await page.goto('/wardrobe');
    await expect(page.getByText('Your wardrobe · 1 piece')).toBeVisible();
    const tile = page.getByRole('link', { name: 'Blue Oxford, top' });
    await expect(tile).toBeVisible();
    await expectAccessible(page);
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`/wardrobe/items/${itemId}$`));

    const [row] = await sql()`select count(*)::int as n, max(revision)::int as revision, max(category) as category from public.items where user_id = ${a.id}`;
    expect(row).toEqual({ n: 1, revision: 2, category: 'tops' });
  });

  test('a failed cutout keeps the original viewable and the piece correctable', async ({ page }) => {
    const a = await createIdentity('piece-fail');
    await signIn(page, a.email);
    await gather(page, 'blank.png', fixtures.blank);
    const warning = page.getByRole('status').filter({ hasText: "couldn't find a single piece" });
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning).toContainText('Your original photo is saved');
    await expect(page.getByRole('button', { name: 'Retry cutout' })).toBeVisible();
    await page.getByRole('button', { name: 'Use original' }).click();
    await expect(page.getByText('shown for this piece')).toBeVisible();
    const original = page.getByRole('img', { name: /original photo/ });
    await expect.poll(() => original.evaluate((el) => (el as HTMLImageElement).naturalWidth || (el.querySelector('img')?.naturalWidth ?? 0))).toBe(640);
    await page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Bags' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.goto('/wardrobe');
    // Not mislabeled: a chosen original makes the piece ready, with its category.
    await expect(page.getByRole('link', { name: 'Untitled bag, bag' })).toBeVisible();
  });

  test('another member cannot open the piece by its link', async ({ page, browser }) => {
    const a = await createIdentity('piece-owner');
    await signIn(page, a.email);
    const itemId = await gather(page, 'mine.png', fixtures.garment);
    const b = await createIdentity('piece-other');
    const other = await (await browser.newContext()).newPage();
    await signIn(other, b.email);
    await other.goto(`/wardrobe/items/${itemId}`);
    await expect(other.getByRole('heading', { level: 1, name: 'Piece not available' })).toBeVisible();
    await expect(other.getByRole('img')).toHaveCount(0);
  });

  test('keyboard-only editing, named swatches and 320 px reflow @phone', async ({ page }) => {
    const a = await createIdentity('piece-phone');
    await signIn(page, a.email);
    await gather(page, 'phone.png', fixtures.garment);
    await expect(page.getByRole('radiogroup', { name: 'Show' })).toBeVisible({ timeout: 30_000 });

    // Keyboard: focus a category option, choose it, then save with Enter.
    const shoes = page.getByRole('radiogroup', { name: 'Category' }).getByRole('radio', { name: 'Shoes' });
    await shoes.focus();
    await page.keyboard.press('Enter');
    await expect(shoes).toHaveAttribute('aria-checked', 'true');
    const swatch = page.getByRole('group', { name: 'Colors' }).getByRole('checkbox', { name: 'Brown' });
    await swatch.focus();
    await page.keyboard.press('Enter');
    await expect(swatch).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Save changes' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved.')).toBeVisible();

    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    // 200% zoom at a 640 px viewport (the P0.01 method): detail and Bower still reflow.
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => document.documentElement.style.setProperty('zoom', '2'));
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto('/wardrobe');
    await page.evaluate(() => document.documentElement.style.setProperty('zoom', '2'));
    await expect(page.getByRole('link', { name: /Brown shoes, shoes/ })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
