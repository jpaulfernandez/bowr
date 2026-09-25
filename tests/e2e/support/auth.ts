import { expect, type Page } from '@playwright/test';
import { stack } from './stack';

type MailpitSummary = { ID: string; Created: string };

async function latestMessageId(email: string, after: number): Promise<string | null> {
  const query = encodeURIComponent(`to:"${email}"`);
  const response = await fetch(`${stack().MAILPIT_URL}/api/v1/search?query=${query}`);
  const { messages } = (await response.json()) as { messages: MailpitSummary[] };
  const fresh = messages.filter((m) => Date.parse(m.Created) >= after - 1000);
  return fresh[0]?.ID ?? null;
}

/** Waits for the newest sign-in email to `email` and returns its link. */
export async function magicLinkFor(email: string, after: number): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(async () => (id = await latestMessageId(email, after)), { timeout: 15_000, message: `email for ${email}` })
    .not.toBeNull();
  const response = await fetch(`${stack().MAILPIT_URL}/api/v1/message/${id}`);
  const message = (await response.json()) as { HTML: string; Text: string };
  const link = /href="([^"]+\/auth\/v1\/verify[^"]+)"/.exec(message.HTML)?.[1] ?? /(http\S+\/auth\/v1\/verify\S+)/.exec(message.Text)?.[1];
  if (!link) throw new Error('No verify link in email');
  return link.replaceAll('&amp;', '&');
}

/** Requests a magic link through the UI and returns it without opening it. */
export async function requestLink(page: Page, email: string, path = '/auth'): Promise<string> {
  if (!page.url().includes('/auth')) await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  const startedAt = Date.now();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  return magicLinkFor(email, startedAt);
}

/** Full UI sign-in in the current tab. */
export async function signIn(page: Page, email: string, path = '/auth'): Promise<void> {
  const link = await requestLink(page, email, path);
  await page.goto(link);
  // Wait for the callback to exchange the code and the gate to route the identity.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth') && url.pathname !== '/', { timeout: 20_000 });
}
