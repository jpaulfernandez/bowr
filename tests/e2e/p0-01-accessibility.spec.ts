import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/auth';
import { createIdentity } from './support/identities';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

function trackCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

const publicPages = [
  ['/', 'bowr'],
  ['/auth', 'Sign in'],
  ['/privacy', 'Privacy'],
] as const;
const memberPages = [
  ['/wardrobe', 'Bower'],
  ['/more', 'More'],
  ['/settings', 'Settings'],
] as const;

test.describe('P0.01-A4: accessible, reflowing shell', () => {
  test('public and gate screens pass axe, reflow at 320 px and 200% zoom, with no CSP violations', async ({ page }) => {
    const csp = trackCspViolations(page);
    for (const [path, heading] of publicPages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectNoAxeViolations(page);
    }
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [path] of publicPages) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
    const pending = await createIdentity('a11y-pending', { state: 'pending' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, pending.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Enter bowr' })).toBeVisible();
    await expectNoAxeViolations(page);
    expect(csp).toEqual([]);
  });

  test('member screens pass axe and reflow at 320 px and 200% zoom', async ({ page }) => {
    const csp = trackCspViolations(page);
    const member = await createIdentity('a11y-member', { displayName: 'Keyboard Kim' });
    await signIn(page, member.email);
    for (const [path, heading] of memberPages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectNoAxeViolations(page);
    }
    for (const viewport of [
      { width: 320, height: 640, zoom: '1' },
      { width: 640, height: 800, zoom: '2' },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const [path, heading] of memberPages) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await page.evaluate((zoom) => {
          document.documentElement.style.setProperty('zoom', zoom);
        }, viewport.zoom);
        await expectNoHorizontalScroll(page);
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      }
    }
    expect(csp).toEqual([]);
  });

  test('settings can be edited and saved with the keyboard alone', async ({ page }) => {
    const member = await createIdentity('keyboard', { displayName: 'Before Keys' });
    await signIn(page, member.email);
    await page.goto('/settings');
    await expect(page.getByLabel('Display name')).toHaveValue('Before Keys');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

    const nameField = page.getByLabel('Display name');
    for (let i = 0; i < 12 && !(await nameField.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(nameField).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('After Keys');

    const save = page.getByRole('button', { name: 'Save settings' });
    for (let i = 0; i < 20 && !(await save.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(save).toBeFocused();
    const outline = await save.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Display name')).toHaveValue('After Keys');
  });

  test('phone browser can sign in and use the bottom navigation @phone', async ({ page }) => {
    const member = await createIdentity('phone');
    await signIn(page, member.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Bower' })).toBeVisible();
    await page.getByRole('link', { name: 'More' }).tap();
    await expect(page.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('P0.01-A4: web export delivery', () => {
  test('deep links serve the app shell with restrictive headers and no service worker', async ({ page, request }) => {
    for (const path of ['/', '/settings', '/wardrobe/items/00000000-0000-0000-0000-000000000000', '/auth/callback']) {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/html');
      const headers = response.headers();
      expect(headers['content-security-policy']).toContain("default-src 'self'");
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['content-security-policy']).not.toContain('unsafe-eval');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
    }
    expect((await request.get('/_expo/static/js/web/missing.js')).status()).toBe(404);

    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).start_url).toBe('/');

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'bowr' })).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });
});
