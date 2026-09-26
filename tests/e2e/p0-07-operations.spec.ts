import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createIdentity } from '../support/identities';
import { mediaFixtures } from '../support/media';
import { sql } from '../support/stack';
import { signIn } from './support/auth';

// The exported bundle is built with EXPO_PUBLIC_POSTHOG_HOST=http://127.0.0.1:8793
// (apps/app/.env.example); these tests intercept that host.
const ANALYTICS = 'http://127.0.0.1:8793/**';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALLOWED: Record<string, string[]> = {
  screen_viewed: ['route'],
  invite_redeemed: [],
  upload_started: ['files'],
  upload_failed: ['code', 'format'],
  client_error: ['code', 'route'],
};

type Captured = { api_key: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> };

async function captureAnalytics(page: Page): Promise<Captured[]> {
  const events: Captured[] = [];
  await page.route(ANALYTICS, async (route) => {
    events.push(route.request().postDataJSON() as Captured);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"Ok"}' });
  });
  return events;
}

async function uploadOne(page: Page) {
  await page.goto('/wardrobe/gather');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose photos' }).click();
  await (await chooser).setFiles([{ name: 'my-jacket.png', mimeType: 'image/png', buffer: mediaFixtures().png }]);
  await page.getByRole('button', { name: 'Upload 1 photo' }).click();
  await expect(page.getByRole('listitem').first()).toContainText('Ready', { timeout: 30_000 });
}

test('P0.07-A3: analytics carry only allowlisted fields and reset on sign-out', async ({ page }) => {
  const events = await captureAnalytics(page);
  const member = await createIdentity('analytics', { displayName: 'Ana Lytics' });
  await signIn(page, member.email);
  await uploadOne(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

  await expect.poll(() => events.some((e) => e.event === 'upload_started')).toBe(true);
  for (const event of events) {
    expect(Object.keys(event).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'timestamp']);
    expect(Object.keys(ALLOWED)).toContain(event.event);
    const { $process_person_profile, ...properties } = event.properties;
    expect($process_person_profile).toBe(false);
    expect(Object.keys(properties).sort()).toEqual([...ALLOWED[event.event]!].sort());
  }
  const text = JSON.stringify(events);
  expect(text).not.toContain(member.email);
  expect(text).not.toMatch(/@|https?:\/\/|my-jacket|Ana Lytics|\?|blob:/);
  const [entry] = await sql()`select e.id from public.upload_entries e where e.user_id = ${member.id}`;
  expect(text).not.toContain(entry!.id);
  expect(events.filter((e) => e.event === 'screen_viewed').map((e) => e.properties.route)).toEqual(
    expect.arrayContaining(['/wardrobe/gather', '/settings']),
  );
  expect(events.find((e) => e.event === 'upload_started')).toMatchObject({ distinct_id: member.id, properties: { files: 1 } });

  // Sign-out resets the analytics identity.
  const before = events.length;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => events.length).toBeGreaterThan(before);
  for (const event of events.slice(before)) {
    expect(event.distinct_id).not.toBe(member.id);
    expect(event.distinct_id).toMatch(/^anon-/);
  }
});

test('P0.07-A3: an analytics outage does not interrupt uploads or settings', async ({ page }) => {
  let attempts = 0;
  await page.route(ANALYTICS, async (route) => {
    attempts += 1;
    await route.abort('connectionrefused');
  });
  const member = await createIdentity('analytics-outage');
  await signIn(page, member.email);
  await uploadOne(page);
  await page.goto('/settings');
  await page.getByLabel('City (optional)').fill('Quezon City');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
  expect(attempts).toBeGreaterThan(0);
});

test('the owner sees redacted background-work health', async ({ page }) => {
  await captureAnalytics(page);
  const owner = await createIdentity('ops-owner', { role: 'owner' });
  await signIn(page, owner.email);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 2, name: 'Background work' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Scheduled tasks' }).getByRole('listitem')).toHaveCount(6);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
