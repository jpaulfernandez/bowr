import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.1';
import { appError } from './http.ts';

export type Caller = { userId: string; db: SupabaseClient };

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/**
 * Verifies the bearer token with Supabase Auth (a revoked or deleted session
 * fails) and returns a database client that acts under the caller's JWT, so
 * RLS and RPC checks apply. The user ID is never taken from the request body.
 */
export async function requireCaller(req: Request): Promise<Caller> {
  const header = req.headers.get('Authorization') ?? '';
  const token = /^Bearer (.+)$/.exec(header)?.[1];
  if (!token) throw appError(401, 'AUTH_REQUIRED');

  const db = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw appError(401, 'AUTH_REQUIRED');
  return { userId: data.user.id, db };
}
