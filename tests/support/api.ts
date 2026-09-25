import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { admin, stack } from './stack';

/** A real user access token via an admin-generated email link (no passwords). */
export async function accessToken(email: string): Promise<string> {
  const { data, error } = await admin().auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const anon = createClient(stack().API_URL, stack().ANON_KEY, { auth: { persistSession: false } });
  const verified = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: data.properties.verification_type as 'magiclink',
  });
  if (verified.error || !verified.data.session) throw verified.error ?? new Error('verifyOtp failed');
  return verified.data.session.access_token;
}

export type ApiResult = { status: number; headers: Headers; body: any };

/** Calls the public Edge API as a real client would. */
export async function api(
  path: string,
  { token, method = 'GET', body, key = randomUUID(), headers = {} }: {
    token?: string;
    method?: string;
    body?: unknown;
    key?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const response = await fetch(`${stack().API_URL}/functions/v1/api/v1${path}`, {
    method,
    headers: {
      apikey: stack().ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && key ? { 'Idempotency-Key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}

export async function maintenance(task: string, secret = process.env.MAINTENANCE_SECRET ?? 'local-only-maintenance-secret-0123456789abcdef') {
  const response = await fetch(`${stack().API_URL}/functions/v1/maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ task }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
