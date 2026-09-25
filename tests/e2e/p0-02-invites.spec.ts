import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function createInviteAsOwner(page: Page, note: string): Promise<string> {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
  await page.getByLabel('Private note (optional)').fill(note);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const code = await page.getByLabel('Invite code', { exact: true }).last().innerText();
  expect(code).toMatch(/^[0-9A-Z]{6}(-[0-9A-Z]{5}){4}$/);
  return code;
}

test.beforeEach(async () => {
  // All local browsers share one IP; keep cases independent of the per-IP throttle.
  await sql()`delete from private.rate_limit_buckets where scope = 'invite_redeem_ip'`;
});

test.describe('P0.02 demo: owner invites a friend who redeems once', () => {
  test('owner creates an invite; the invited email signs in, redeems and reaches onboarding', async ({ browser }) => {
    const owner = await createIdentity('owner', { role: 'owner', displayName: 'Olive Owner' });
    const ownerPage = await (await browser.newContext()).newPage();
    await signIn(ownerPage, owner.email);
    await ownerPage.getByRole('link', { name: 'More' }).click();
    await ownerPage.getByRole('link', { name: /Admin/ }).click();
    const note = `For Fern ${Date.now()}`;
    const code = await createInviteAsOwner(ownerPage, note);
    await expect(ownerPage.getByText('The code is shown only now.', { exact: false })).toBeVisible();
    await expectAccessible(ownerPage);

    const friendEmail = `fern-${Date.now()}@example.test`;
    const friendPage = await (await browser.newContext()).newPage();
    await signIn(friendPage, friendEmail);
    await expect(friendPage).toHaveURL(/\/invite$/);
    await expect(friendPage.getByText(/deleted after 24 hours/)).toBeVisible();
    await friendPage.getByLabel('Invite code').fill(code.toLowerCase().replaceAll('-', ' '));
    await friendPage.getByRole('button', { name: 'Unlock my Bower' }).click();
    await expect(friendPage).toHaveURL(/\/onboarding$/);
    await expect(friendPage.getByRole('heading', { level: 1, name: 'Welcome to bowr' })).toBeVisible();
    await expectAccessible(friendPage);

    // Onboarding is skippable without measurements, photos or notification permission.
    await friendPage.getByRole('button', { name: 'Go to my Bower' }).click();
    await expect(friendPage).toHaveURL(/\/wardrobe$/);
    const [profile] = await sql()`
      select p.onboarding_completed_at, m.invited_by from public.profiles p
      join private.memberships m on m.user_id = p.id
      join auth.users u on u.id = p.id where u.email = ${friendEmail}`;
    expect(profile!.onboarding_completed_at).not.toBeNull();
    expect(profile!.invited_by).toBe(owner.id);

    // The owner sees the redemption; the code cannot be used again.
    await ownerPage.reload();
    await expect(ownerPage.getByRole('listitem').filter({ hasText: note })).toContainText('Used');
    const second = await (await browser.newContext()).newPage();
    await signIn(second, `late-${Date.now()}@example.test`);
    await second.getByLabel('Invite code').fill(code);
    await second.getByRole('button', { name: 'Unlock my Bower' }).click();
    await expect(second.getByRole('alert')).toContainText("isn't available");
    await expect(second).toHaveURL(/\/invite$/);
  });

  test('revoking an unused invite blocks it and says members keep access', async ({ page }) => {
    const owner = await createIdentity('revoker', { role: 'owner' });
    await signIn(page, owner.email);
    const note = `Revoke me ${Date.now()}`;
    await createInviteAsOwner(page, note);
    const row = page.getByRole('listitem').filter({ hasText: note });
    await row.getByRole('button', { name: 'Revoke invite' }).click();
    const dialog = page.getByRole('dialog', { name: 'Revoke this invite?' });
    await expect(dialog).toContainText('does not remove a member');
    await dialog.getByRole('button', { name: 'Revoke invite' }).click();
    await expect(row).toContainText('Revoked');
  });
});

test.describe('P0.02 pending gate', () => {
  test('shows the retry time after too many attempts', async ({ page }) => {
    const pending = await createIdentity('gate', { state: 'pending' });
    await signIn(page, pending.email);
    for (let i = 0; i < 5; i += 1) {
      await page.getByLabel('Invite code').fill(`WRONG-${i}`);
      await page.getByRole('button', { name: 'Unlock my Bower' }).click();
      await expect(page.getByRole('alert')).toContainText("isn't available");
    }
    await page.getByLabel('Invite code').fill('WRONG-6');
    await page.getByRole('button', { name: 'Unlock my Bower' }).click();
    await expect(page.getByRole('alert')).toContainText('Too many attempts. You can try again after');
  });

  test('a pending identity can delete its account after confirming', async ({ page }) => {
    const pending = await createIdentity('delete-me', { state: 'pending' });
    await signIn(page, pending.email);
    await page.getByRole('button', { name: 'Delete this account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this account?' });
    await dialog.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'bowr', exact: true })).toBeVisible();
    expect(await sql()`select id from auth.users where id = ${pending.id}`).toHaveLength(0);
  });
});

test.describe('P0.02-A4: nonowners', () => {
  test('a member cannot open /admin and sees no admin navigation', async ({ page }) => {
    const member = await createIdentity('not-owner');
    await signIn(page, member.email);
    await page.goto('/more');
    await expect(page.getByRole('link', { name: /Admin/ })).toHaveCount(0);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/wardrobe$/);
  });
});
