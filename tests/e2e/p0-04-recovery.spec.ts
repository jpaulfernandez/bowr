import { expect, test } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { mediaFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// Requires the local worker: pnpm worker:serve
const fixtures = mediaFixtures();

test('P0.04-A4: uploaded work survives tab closure; unsent files are identified for reselection', async ({ context }) => {
  const a = await createIdentity('tab-close');
  const first = await context.newPage();
  await signIn(first, a.email);
  await first.goto('/wardrobe/gather');

  // The second photo's upload never finishes before the tab closes.
  let puts = 0;
  await first.route('http://127.0.0.1:9000/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts += 1;
    if (puts === 1) return route.continue();
    // Leave the second upload hanging, as if the phone closed the tab mid-transfer.
  });
  const chooser = first.waitForEvent('filechooser');
  await first.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([
    { name: 'kept.png', mimeType: 'image/png', buffer: fixtures.png },
    { name: 'unsent.webp', mimeType: 'image/webp', buffer: fixtures.webp },
  ]);
  await first.getByRole('button', { name: 'Upload 2 photos' }).click();
  await expect(first.getByRole('listitem').filter({ hasText: 'kept.png' })).toContainText(/checking photo|Ready/, { timeout: 30_000 });
  await expect(first.getByRole('status')).toContainText('Keep this tab open until uploads finish');
  const batchId = first.url().split('/').pop()!;
  await first.close();

  // A new tab needs a new sign-in (tab-scoped session) and finds the receipt from Bower.
  const second = await context.newPage();
  await signIn(second, a.email);
  await second.getByRole('link', { name: /2 photos/ }).click();
  await expect(second).toHaveURL(new RegExp(`/wardrobe/uploads/${batchId}$`));
  const rows = second.getByRole('listitem');
  await expect(rows.filter({ hasText: 'Ready' })).toHaveCount(1, { timeout: 30_000 });
  const unsent = rows.filter({ hasText: 'Not uploaded. Choose this photo again.' });
  await expect(unsent).toHaveCount(1);

  // Reopening the receipt never creates another job.
  const jobCount = async () =>
    (await sql()`select count(*)::int as n from private.jobs j join public.upload_entries e on e.asset_id = j.target_id where e.batch_id = ${batchId}`)[0]!.n;
  expect(await jobCount()).toBe(1);
  for (let i = 0; i < 3; i += 1) {
    await second.reload();
    await expect(second.getByRole('listitem').filter({ hasText: 'Ready' })).toHaveCount(1);
  }
  expect(await jobCount()).toBe(1);

  // Choosing the photo again uploads into the same slot and completes it.
  const reselect = second.waitForEvent('filechooser');
  await unsent.getByRole('button', { name: /Choose photo \d again/ }).click();
  await (await reselect).setFiles([{ name: 'unsent.webp', mimeType: 'image/webp', buffer: fixtures.webp }]);
  await expect(second.getByRole('listitem').filter({ hasText: 'Ready' })).toHaveCount(2, { timeout: 30_000 });
  expect(await jobCount()).toBe(2);
  const [{ entries }] = await sql()`select count(*)::int as entries from public.upload_entries where batch_id = ${batchId}`;
  expect(entries).toBe(2);
});
