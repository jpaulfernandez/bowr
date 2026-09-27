import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { storageAdmin, wardrobeFixtures } from '../support/media';
import { decodePng } from '../support/png';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker (pinned models) and fake Gemini.
const fixtures = wardrobeFixtures();
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function upload(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([{ name, mimeType: 'image/png', buffer }]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/uploads\//);
}

async function gatherShirt(page: Page) {
  await page.goto('/wardrobe/gather');
  await upload(page, 'shirt.png', fixtures.garment);
  await page.getByRole('button', { name: 'View piece from photo 1' }).click({ timeout: 45_000 });
  await expect(page.getByRole('radiogroup', { name: 'Show' })).toBeVisible({ timeout: 45_000 });
  return page.url().split('/').pop()!;
}

const stage = async (itemId: string, name: string) =>
  (await sql()`select state, model, media_revision from public.item_stages where item_id = ${itemId} and stage = ${name}`)[0];

async function storedMask(itemId: string) {
  const [{ object_key }] = await sql()`select o.object_key from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id
    where ia.item_id = ${itemId} and ia.role = 'mask' and ia.detached_at is null`;
  return decodePng(await storageAdmin().get(object_key));
}

test.describe('P1.05 demo: repair or replace a piece photo reversibly', () => {
  test('edges are erased, undone, reset and saved; only the edited mask changes and the original stays', async ({ page }) => {
    const a = await createIdentity('edges-e2e');
    await signIn(page, a.email);
    const itemId = await gatherShirt(page);
    const before = await storedMask(itemId);
    const [{ media_revision: revision, original }] = await sql()`select i.media_revision,
        (select asset_id from public.item_assets where item_id = i.id and role = 'original' and detached_at is null) as original
      from public.items i where i.id = ${itemId}`;

    await page.getByRole('button', { name: 'Fix edges' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Fix edges' })).toBeVisible();
    const canvas = page.getByRole('img', { name: /^Edge editing area/ });
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page);

    // Without drawing: erase the left third by area, from the keyboard.
    await page.getByLabel('From left (%)').fill('0');
    await page.getByLabel('From top (%)').fill('0');
    await page.getByLabel('Width (%)').fill('35');
    await page.getByLabel('Height (%)').fill('100');
    await page.getByRole('button', { name: 'Erase this area' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Erase this area' }).click();
    // With a pointer: a stroke inside the same third, at 200% zoom.
    await page.getByRole('radiogroup', { name: 'Zoom' }).getByRole('radio', { name: '200%' }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    // Reset returns to the saved edges; undo brings the edits back.
    await page.getByRole('button', { name: 'Reset edges' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Save edges' }).click();

    await expect(page).toHaveURL(new RegExp(`/wardrobe/items/${itemId}$`));
    await expect.poll(async () => stage(itemId, 'cutout'), { timeout: 45_000 }).toMatchObject({
      state: 'succeeded',
      model: 'manual',
      media_revision: revision + 1,
    });
    const after = await storedMask(itemId);
    // Everything left of 35% is erased; everything right of 45% is exactly as before.
    let notErased = 0;
    let changed = 0;
    for (let y = 0; y < after.height; y += 1) {
      for (let x = 0; x < after.width; x += 1) {
        const i = y * after.width + x;
        if (x < after.width * 0.35 && after.pixels[i] !== 0) notErased += 1;
        if (x > after.width * 0.45 && after.pixels[i] !== before.pixels[i]) changed += 1;
      }
    }
    expect({ notErased, changed }).toEqual({ notErased: 0, changed: 0 });
    const [{ current }] = await sql()`select asset_id as current from public.item_assets where item_id = ${itemId} and role = 'original' and detached_at is null`;
    expect(current).toBe(original);
    await page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: 'Original' }).click();
    await expect(page.getByRole('img', { name: /original photo/ })).toBeVisible();
  });

  test('a person who cannot draw can use the original, another model or a new photo; a reshoot keeps the piece @phone', async ({ page }) => {
    const a = await createIdentity('reshoot-e2e');
    await signIn(page, a.email);
    const itemId = await gatherShirt(page);
    await page.getByLabel('Name').fill('Work shirt');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Use original' }).click();
    await expect(page.getByText('Your Bower shows the original photo for this piece.')).toBeVisible();
    await page.getByRole('button', { name: 'Try the other cutout model' }).click();
    await expect.poll(async () => stage(itemId, 'cutout'), { timeout: 45_000 }).toMatchObject({ state: 'succeeded', model: 'u2netp' });
    await expectAccessible(page);

    // A broken replacement changes nothing.
    await page.getByRole('button', { name: 'Replace photo' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Replace photo' })).toBeVisible();
    await upload(page, 'broken.png', Buffer.from('<html>not an image</html>'));
    await expect(page.getByRole('listitem').first()).toContainText("This file isn't a supported photo.", { timeout: 45_000 });
    await page.goto(`/wardrobe/items/${itemId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Work shirt' })).toBeVisible();

    // A reshoot keeps the piece's identity and details.
    await page.getByRole('button', { name: 'Replace photo' }).click();
    await upload(page, 'new-photo.png', fixtures.trousers);
    await expect(page.getByRole('listitem').first()).toContainText('Photo replaced', { timeout: 45_000 });
    await page.getByRole('button', { name: 'View piece for photo 1' }).click();
    await expect(page).toHaveURL(new RegExp(`/wardrobe/items/${itemId}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Work shirt' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await sql()`select 1 from public.items where user_id = ${a.id}`).toHaveLength(1);
  });
});
