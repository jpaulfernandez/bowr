import { safeReturnTo } from '@bowr/domain';
import { durableStorage } from '../platform/auth-storage';

// Non-sensitive values kept across the magic-link round trip. They hold a route
// path or an email address typed in this browser, never tokens or wardrobe data.
const RETURN_TO_KEY = 'bowr.returnTo';
const PENDING_EMAIL_KEY = 'bowr.pendingEmail';
const MAX_AGE_MS = 60 * 60 * 1000;

export function rememberReturnTo(raw: unknown): void {
  const path = safeReturnTo(raw);
  if (path) durableStorage.setItem(RETURN_TO_KEY, JSON.stringify({ path, at: Date.now() }));
  else durableStorage.removeItem(RETURN_TO_KEY);
}

export function takeReturnTo(): string | null {
  const raw = durableStorage.getItem(RETURN_TO_KEY);
  durableStorage.removeItem(RETURN_TO_KEY);
  if (!raw) return null;
  try {
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof at !== 'number' || Date.now() - at > MAX_AGE_MS) return null;
    return safeReturnTo(path);
  } catch {
    return null;
  }
}

export function rememberPendingEmail(email: string): void {
  durableStorage.setItem(PENDING_EMAIL_KEY, email);
}

export function readPendingEmail(): string | null {
  return durableStorage.getItem(PENDING_EMAIL_KEY);
}

export function clearAccountStorage(): void {
  durableStorage.removeItem(RETURN_TO_KEY);
  durableStorage.removeItem(PENDING_EMAIL_KEY);
}
