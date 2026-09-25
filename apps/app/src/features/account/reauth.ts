// Fresh authentication for consequential actions (ARCHITECTURE 12.3). The server
// accepts a challenge only from a session that signed in after the challenge was
// created, so this flow always ends with a new sign-in link or Google sign-in.
import { ReauthChallenge, type ReauthAction } from '@bowr/contracts';
import { durableStorage } from '../../platform/auth-storage';
import { apiRequest } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { callbackUrl } from '../auth/sign-in';

const PENDING_KEY = 'bowr.reauth';
const DELETION_STATUS_KEY = 'bowr.deletionStatus';

export type PendingReauth = { challengeId: string; action: ReauthAction; recipientId?: string; expiresAt: string };

export async function startReauth(action: ReauthAction, recipientId?: string): Promise<{ via: 'email' | 'google'; email: string }> {
  const challenge = await apiRequest('/account/reauth-challenges', {
    method: 'POST',
    idempotencyKey: crypto.randomUUID(),
    body: { action },
    schema: ReauthChallenge,
  });
  const pending: PendingReauth = { challengeId: challenge.challenge_id, action, recipientId, expiresAt: challenge.expires_at };
  durableStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const { data } = await supabase.auth.getUser();
  const email = data.user?.email ?? '';
  if (data.user?.app_metadata.provider === 'google') {
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callbackUrl() } });
    return { via: 'google', email };
  }
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: callbackUrl(), shouldCreateUser: false } });
  if (error) throw new Error('reauth_email_failed');
  return { via: 'email', email };
}

export function readPendingReauth(): PendingReauth | null {
  const raw = durableStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingReauth;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      durableStorage.removeItem(PENDING_KEY);
      return null;
    }
    return pending;
  } catch {
    durableStorage.removeItem(PENDING_KEY);
    return null;
  }
}

export function clearPendingReauth(): void {
  durableStorage.removeItem(PENDING_KEY);
}

/** The status capability survives sign-out in this tab only; it grants no access. */
export function rememberDeletionStatus(token: string): void {
  try {
    window.sessionStorage.setItem(DELETION_STATUS_KEY, token);
  } catch {
    // Without storage the status page explains that deletion continues regardless.
  }
}

export function readDeletionStatus(): string | null {
  try {
    return window.sessionStorage.getItem(DELETION_STATUS_KEY);
  } catch {
    return null;
  }
}
