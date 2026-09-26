import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { rememberPendingEmail, rememberReturnTo } from '../../lib/account-storage';
import { supabase } from '../../lib/supabase';

/** The exact callback registered in the Auth redirect allowlist for this origin. */
export function callbackUrl(): string {
  return Platform.OS === 'web' ? `${window.location.origin}/auth/callback` : Linking.createURL('/auth/callback');
}

export type SignInResult = { ok: true } | { ok: false; message: string };

export async function sendEmailLink(email: string, returnTo: unknown): Promise<SignInResult> {
  rememberReturnTo(returnTo);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl(), shouldCreateUser: true },
  });
  if (error) {
    if (error.status === 429) return { ok: false, message: 'Too many sign-in emails. Wait a minute, then try again.' };
    if (error.status === 400 || error.status === 422) return { ok: false, message: 'Enter a valid email address.' };
    return { ok: false, message: "bowr couldn't send the email. Try again." };
  }
  rememberPendingEmail(email);
  return { ok: true };
}

export async function startGoogleSignIn(returnTo: unknown): Promise<SignInResult> {
  rememberReturnTo(returnTo);
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callbackUrl() } });
  return error ? { ok: false, message: "Google sign-in couldn't start. Try again." } : { ok: true };
}
