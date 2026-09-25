import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { mediaFixtures } from '../support/media';
import { maintenance } from '../support/api';
import { sql } from '../support/stack';
import { magicLinkFor, signIn } from './support/auth';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** Opens the fresh-auth link in a new tab of the same browser, as a person would. */
async function openConfirmationLink(context: BrowserContext, email: string, since: number) {
  const link = await magicLinkFor(email, since);
  const tab = await context.newPage();
  await tab.goto(link);
  await tab.waitForURL(/\/settings\/confirm$/);
  return tab;
}

test('settings save the date format and show the sign-in method', async ({ page }) => {
  const member = await createIdentity('settings-locale');
  await signIn(page, member.email);
  await page.goto('/settings');
  await expect(page.getByText(`Signed in with Email link as ${member.email}`)).toBeVisible();
  await page.getByRole('radio', { name: 'English (Philippines)' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
  const [{ locale }] = await sql()`select locale from public.profiles where id = ${member.id}`;
  expect(locale).toBe('en-PH');
  await expectAccessible(page);
  await page.getByRole('link', { name: 'How bowr handles your data' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Leaving bowr' })).toBeVisible();
});

test('P0.06 demo: a member deletes their account after a fresh sign-in', async ({ context }) => {
  const member = await createIdentity('delete-e2e', { displayName: 'Del Member' });
  const page = await context.newPage();
  await signIn(page, member.email);
  // A stored photo that must be deleted with the account.
  const fixtures = mediaFixtures();
  await page.goto('/wardrobe/gather');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([{ name: 'keep.png', mimeType: 'image/png', buffer: fixtures.png }]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  const since = Date.now();
  await page.getByRole('dialog', { name: 'Delete your account?' }).getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(page.getByText(/We sent a confirmation link to/)).toBeVisible();
  // Nothing is deleted before the fresh sign-in completes.
  expect((await sql()`select state from private.memberships where user_id = ${member.id}`)[0]!.state).toBe('active');

  const confirmTab = await openConfirmationLink(context, member.email, since);
  await expect(confirmTab.getByRole('heading', { level: 1, name: 'Delete your account' })).toBeVisible();
  await expectAccessible(confirmTab);
  await confirmTab.getByRole('button', { name: 'Delete my account permanently' }).click();
  await expect(confirmTab).toHaveURL(/\/account-deleted$/);
  // Stored photos wait for the quarantine recheck after upload capabilities expire (ARCHITECTURE 12.2).
  await expect(confirmTab.getByRole('heading', { level: 1, name: 'Deleting your account' })).toBeVisible();
  await expectAccessible(confirmTab);
  await sql()`update private.deletion_tasks set not_before = now() where user_id = ${member.id} and state = 'pending'`;
  await expect(async () => {
    await maintenance('account_deletion');
    await confirmTab.reload();
    await expect(confirmTab.getByRole('heading', { level: 1, name: 'Account deleted' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  expect(await sql()`select 1 from auth.users where id = ${member.id}`).toHaveLength(0);

  // The original tab's session no longer works.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(bowr|Sign in)$/);
  await expect(page).not.toHaveURL(/\/wardrobe/);
});

test('an owner transfers ownership after a fresh sign-in and suspends a member', async ({ context }) => {
  const owner = await createIdentity('xfer-e2e-owner', { role: 'owner', displayName: 'Owen Owner' });
  const heir = await createIdentity('xfer-e2e-heir', { displayName: `Heir ${Date.now()}` });
  const other = await createIdentity('xfer-e2e-other', { displayName: `Other ${Date.now()}` });
  const page = await context.newPage();
  await signIn(page, owner.email);
  await page.goto('/admin');

  const otherRow = page.getByRole('listitem').filter({ hasText: (await sql()`select display_name from public.profiles where id = ${other.id}`)[0]!.display_name });
  await otherRow.getByRole('button', { name: /^Suspend / }).click();
  const suspendDialog = page.getByRole('dialog', { name: /^Suspend / });
  await expect(suspendDialog).toContainText('cannot be recalled');
  await suspendDialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(otherRow).toContainText('Suspended');
  expect((await sql()`select state from private.memberships where user_id = ${other.id}`)[0]!.state).toBe('suspended');

  const heirName = (await sql()`select display_name from public.profiles where id = ${heir.id}`)[0]!.display_name;
  await page.getByRole('listitem').filter({ hasText: heirName }).getByRole('button', { name: /the owner$/ }).click();
  const since = Date.now();
  await page.getByRole('dialog', { name: /the owner\?$/ }).getByRole('button', { name: 'Send confirmation link' }).click();
  const confirmTab = await openConfirmationLink(context, owner.email, since);
  await confirmTab.getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(confirmTab).toHaveURL(/\/more$/);
  await expect(confirmTab.getByRole('link', { name: /Admin/ })).toHaveCount(0);
  const owners = await sql()`select user_id from private.memberships where role = 'owner'`;
  expect(owners.map((o) => o.user_id)).toEqual([heir.id]);
  await sql()`update private.memberships set state = 'active', suspended_at = null where user_id = ${other.id}`;
});
