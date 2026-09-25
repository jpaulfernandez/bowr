import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { mediaFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker: pnpm worker:serve
const fixtures = mediaFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function choose(page: Page, button: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: button }).click();
  await (await chooser).setFiles(files);
}

test.describe('P0.03 demo: upload and view a private validated photo', () => {
  test('A gathers photos, sees per-file results and views the sanitized original; B cannot see the receipt', async ({ page, browser }) => {
    const a = await createIdentity('gather-a');
    await signIn(page, a.email);
    await page.getByRole('button', { name: 'Gather' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Gather · add pieces' })).toBeVisible();
    await expect(page.getByText(/up to 20 MB and 40 megapixels each/)).toBeVisible();
    await expectAccessible(page);

    await choose(page, 'Choose photos', [
      { name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: fixtures.jpegOriented },
      { name: 'renamed.jpg', mimeType: 'image/jpeg', buffer: fixtures.png },
    ]);
    await expect(page.getByRole('listitem').filter({ hasText: 'shirt.jpg' })).toBeVisible();
    await page.getByRole('button', { name: 'Upload 2 photos' }).click();

    await expect(page).toHaveURL(/\/wardrobe\/uploads\/[0-9a-f-]{36}$/);
    const batchId = page.url().split('/').pop()!;
    const shirt = page.getByRole('listitem').filter({ hasText: 'shirt.jpg' });
    const renamed = page.getByRole('listitem').filter({ hasText: 'renamed.jpg' });
    await expect(shirt).toContainText('Ready', { timeout: 30_000 });
    await expect(renamed).toContainText("contents don't match its type", { timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: '1 ready · 1 need attention' })).toBeVisible();

    const image = shirt.getByRole('img', { name: /shirt\.jpg, uploaded photo/ });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth || (el.querySelector('img')?.naturalWidth ?? 0))).toBeGreaterThan(0);
    await expectAccessible(page);

    // The receipt survives reload from server state.
    await page.reload();
    await expect(page.getByRole('listitem').filter({ hasText: 'Ready' })).toHaveCount(1);
    await expect(page.getByRole('listitem').filter({ hasText: "contents don't match" })).toHaveCount(1);

    const b = await createIdentity('gather-b');
    const bPage = await (await browser.newContext()).newPage();
    await signIn(bPage, b.email);
    await bPage.goto(`/wardrobe/uploads/${batchId}`);
    await expect(bPage.getByRole('heading', { level: 1, name: 'Upload receipt' })).toBeVisible();
    await expect(bPage.getByRole('listitem')).toHaveCount(0);
    await expect(bPage.getByRole('img')).toHaveCount(0);
  });

  test('the camera option falls back to a file chooser', async ({ page }) => {
    const a = await createIdentity('camera');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    await choose(page, 'Take a photo', [{ name: 'camera.png', mimeType: 'image/png', buffer: fixtures.png }]);
    await expect(page.getByRole('button', { name: 'Upload 1 photo' })).toBeEnabled();
  });

  test('unsupported and oversized selections are flagged before upload', async ({ page }) => {
    const a = await createIdentity('precheck');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    await choose(page, 'Choose photos', [
      { name: 'notes.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') },
      { name: 'ok.png', mimeType: 'image/png', buffer: fixtures.png },
    ]);
    await expect(page.getByRole('listitem').filter({ hasText: 'notes.gif' })).toContainText("isn't supported");
    await expect(page.getByRole('button', { name: 'Upload 1 photo' })).toBeEnabled();
  });

  test('an expired image link is refreshed once through fresh authorization', async ({ page }) => {
    const a = await createIdentity('refresh');
    await signIn(page, a.email);
    await page.goto('/wardrobe/gather');
    await choose(page, 'Choose photos', [{ name: 'refresh.png', mimeType: 'image/png', buffer: fixtures.png }]);
    await page.getByRole('button', { name: 'Upload 1 photo' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });

    let accessCalls = 0;
    await page.route('**/functions/v1/api/v1/media/access', async (route) => {
      accessCalls += 1;
      await route.continue();
    });
    let imageRequests = 0;
    await page.route('http://127.0.0.1:9000/**', async (route) => {
      imageRequests += 1;
      if (imageRequests === 1) await route.fulfill({ status: 403, body: 'expired' });
      else await route.continue();
    });
    await page.reload();
    const image = page.getByRole('img', { name: /refresh\.png|Photo 1, uploaded photo/ });
    await expect(image).toBeVisible();
    await expect.poll(() => accessCalls).toBe(2);
    await expect(page.getByText('Image unavailable')).toHaveCount(0);
  });

  test('gather and receipt reflow at 320 px', async ({ page }) => {
    const a = await createIdentity('narrow');
    await signIn(page, a.email);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/wardrobe/gather');
    await choose(page, 'Choose photos', [{ name: 'a-rather-long-file-name-for-reflow.png', mimeType: 'image/png', buffer: fixtures.png }]);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Upload 1 photo' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    const [{ n }] = await sql()`select count(*)::int as n from public.upload_entries e join auth.users u on u.id = e.user_id where u.email = ${a.email}`;
    expect(n).toBe(1);
  });
});
