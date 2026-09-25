import { expect, test } from '@playwright/test';
import { requestLink, signIn } from './support/auth';
import { createIdentity } from '../support/identities';

test.describe('P0.01 demo: members and a pending identity see only their gate and own settings', () => {
  test('members see their own settings; pending sees the gate', async ({ browser }) => {
    const a = await createIdentity('a', { displayName: 'Ana Alpha' });
    const b = await createIdentity('b', { displayName: 'Ben Beta' });
    const pending = await createIdentity('pending', { state: 'pending' });

    for (const [identity, own, other] of [
      [a, 'Ana Alpha', 'Ben Beta'],
      [b, 'Ben Beta', 'Ana Alpha'],
    ] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, identity.email);
      await expect(page).toHaveURL(/\/wardrobe$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Bower' })).toBeVisible();
      await page.getByRole('link', { name: 'More' }).click();
      await page.getByRole('link', { name: /Settings/ }).click();
      await expect(page.getByLabel('Display name')).toHaveValue(own);
      await expect(page.getByText(other)).toHaveCount(0);
      await expect(page.getByRole('link', { name: /admin/i })).toHaveCount(0);
      await context.close();
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, pending.email);
    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Enter bowr' })).toBeVisible();
    for (const path of ['/settings', '/wardrobe', '/more', '/']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/invite$/);
    }
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await context.close();
  });

  test('suspended and deleting identities reach only their status gate', async ({ page, context }) => {
    for (const [state, heading] of [
      ['suspended', 'Access paused'],
      ['deleting', 'Account deletion in progress'],
    ] as const) {
      const identity = await createIdentity(state, { state });
      await signIn(page, identity.email);
      await expect(page).toHaveURL(/\/invite$/);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.goto('/settings');
      await expect(page).toHaveURL(/\/invite$/);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'bowr', exact: true })).toBeVisible();
      await context.clearCookies();
    }
  });
});

test.describe('P0.01-A2: return destinations', () => {
  test('reload /settings, sign in, and return there', async ({ page }) => {
    const a = await createIdentity('a2');
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/auth\?returnTo=%2Fsettings$/);
    const link = await requestLink(page, a.email);
    await page.goto(link);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  for (const forged of ['https://evil.example/settings', '//evil.example', '/%2F%2Fevil.example', '/\\evil.example', '/invite']) {
    test(`forged returnTo ${forged} lands on Bower`, async ({ page }) => {
      const a = await createIdentity('forged');
      await page.goto(`/auth?returnTo=${encodeURIComponent(forged)}`);
      const link = await requestLink(page, a.email);
      await page.goto(link);
      await expect(page).toHaveURL(/^http:\/\/localhost:4173\/wardrobe$/);
    });
  }

  test('a member opening / reaches Bower; pending reaches invite', async ({ browser }) => {
    const member = await createIdentity('home-member');
    const pending = await createIdentity('home-pending', { state: 'pending' });
    for (const [identity, expected] of [
      [member, /\/wardrobe$/],
      [pending, /\/invite$/],
    ] as const) {
      const page = await (await browser.newContext()).newPage();
      await signIn(page, identity.email);
      await page.goto('/');
      await expect(page).toHaveURL(expected);
      await page.context().close();
    }
  });

  test('a link opened in another browser shows a recovery route', async ({ browser }) => {
    const a = await createIdentity('other-browser');
    const requester = await (await browser.newContext()).newPage();
    const link = await requestLink(requester, a.email);
    const otherBrowser = await (await browser.newContext()).newPage();
    await otherBrowser.goto(link);
    await expect(otherBrowser.getByText(/same browser where you asked for it/)).toBeVisible();
    await otherBrowser.getByRole('button', { name: 'Send a new link' }).click();
    await expect(otherBrowser.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('an expired or reused link shows a recovery route', async ({ page }) => {
    const a = await createIdentity('reused');
    const link = await requestLink(page, a.email);
    await page.goto(link);
    await expect(page).toHaveURL(/\/wardrobe$/);
    await page.getByRole('link', { name: 'More' }).click();
    await page.getByRole('link', { name: /Settings/ }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'bowr', exact: true })).toBeVisible();
    await page.goto(link);
    await expect(page.getByText(/expired or was already used/)).toBeVisible();
  });
});

test.describe('P0.01-A3: account change and tab session', () => {
  test('a late A response after sign-out is never rendered, and B sees none of A', async ({ page }) => {
    const a = await createIdentity('late-a', { displayName: 'Ana Late' });
    const b = await createIdentity('late-b', { displayName: 'Ben Next' });
    await signIn(page, a.email);
    await page.goto('/settings');
    await expect(page.getByLabel('Display name')).toHaveValue('Ana Late');

    // Unsaved draft under A.
    await page.getByLabel('Display name').fill('Draft only A should see');

    // Hold A's next profile read in flight, then sign out before it resolves.
    const held: Array<() => Promise<void>> = [];
    await page.route('**/rest/v1/profiles**', async (route) => {
      held.push(() => route.continue().catch(() => undefined));
    });
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'bowr', exact: true })).toBeVisible();
    for (const release of held.splice(0)) await release();
    await page.waitForTimeout(1000);
    await expect(page.getByText('Ana Late')).toHaveCount(0);
    await expect(page.getByText('Draft only A should see')).toHaveCount(0);
    const storage = await page.evaluate(() => ({ ...sessionStorage }));
    expect(Object.keys(storage).filter((key) => key.startsWith('bowr-auth'))).toEqual([]);
    await page.unroute('**/rest/v1/profiles**');

    // B signs in on the same tab and sees only B.
    await signIn(page, b.email);
    await page.goto('/settings');
    await expect(page.getByLabel('Display name')).toHaveValue('Ben Next');
    await expect(page.getByText('Ana Late')).toHaveCount(0);
    await expect(page.getByText('Draft only A should see')).toHaveCount(0);
  });

  test('closing the tab ends the session; another tab must sign in', async ({ context }) => {
    const a = await createIdentity('tab');
    const first = await context.newPage();
    await signIn(first, a.email);
    await expect(first).toHaveURL(/\/wardrobe$/);

    const second = await context.newPage();
    await second.goto('/settings');
    await expect(second).toHaveURL(/\/auth\?returnTo=%2Fsettings$/);

    await first.close();
    const third = await context.newPage();
    await third.goto('/wardrobe');
    await expect(third).toHaveURL(/\/auth\?returnTo=%2Fwardrobe$/);
  });
});
