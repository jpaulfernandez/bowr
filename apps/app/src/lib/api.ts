import type { z } from 'zod';
import { apiBaseUrl, env } from './env';
import { ApiError, StaleAccountError, apiErrorFromEnvelope, apiErrorFromRpc } from './errors';
import { getCurrentUserId } from './session';
import { supabase } from './supabase';

type RequestOptions<T extends z.ZodType> = {
  schema: T;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

async function captureAccount(): Promise<{ userId: string; token: string }> {
  const userId = getCurrentUserId();
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!userId || !session || session.user.id !== userId) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.', false);
  }
  return { userId, token: session.access_token };
}

function assertSameAccount(userId: string): void {
  if (getCurrentUserId() !== userId) throw new StaleAccountError();
}

/** Calls the public Edge API and returns its validated `data` field. */
export async function apiRequest<T extends z.ZodType>(
  path: string,
  { schema, method = 'GET', body, signal, idempotencyKey }: RequestOptions<T>,
): Promise<z.infer<T>> {
  const { userId, token } = await captureAccount();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    apikey: env.supabasePublishableKey,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers,
      signal: signal ?? null,
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch (error) {
    assertSameAccount(userId);
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'SERVICE_UNAVAILABLE', 'bowr could not be reached. Check your connection.', true);
  }
  const json: unknown = await response.json().catch(() => null);
  assertSameAccount(userId);
  if (!response.ok) throw apiErrorFromEnvelope(response.status, json);
  const envelope = (json ?? {}) as { data?: unknown };
  return schema.parse(envelope.data) as z.infer<T>;
}

/** Calls a transactional database RPC under the caller's JWT. */
export async function rpc<T extends z.ZodType>(
  name: string,
  args: Record<string, unknown>,
  schema: T,
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  const { userId } = await captureAccount();
  const query = supabase.rpc(name, args);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  assertSameAccount(userId);
  if (error) throw apiErrorFromRpc(error);
  return schema.parse(data) as z.infer<T>;
}

/** Runs an RLS read and discards the result if the account changed meanwhile. */
export async function guardedRead<T>(read: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  const { userId } = await captureAccount();
  const { data, error } = await read();
  assertSameAccount(userId);
  if (error) throw apiErrorFromRpc(error as { code?: string; message?: string });
  return data;
}
