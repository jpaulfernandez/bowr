import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.1';
import { appError } from './http.ts';

export type Caller = {
  userId: string;
  db: SupabaseClient;
  /** Auth session of this token, and when that session last authenticated (amr). */
  sessionId: string | null;
  authenticatedAt: Date | null;
};

type Claims = { session_id?: string; amr?: Array<{ method?: string; timestamp?: number }> };

/** Reads claims from a token that Supabase Auth has already verified. */
function claims(token: string): Claims {
  try {
    const payload = token.split('.')[1] ?? '';
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Claims;
  } catch {
    return {};
  }
}

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
  // A refreshed token keeps its original authentication time; only a new sign-in
  // advances it. Fresh-authentication checks rely on this.
  const { session_id, amr } = claims(token);
  const latest = Math.max(0, ...(amr ?? []).map((entry) => entry.timestamp ?? 0));
  return {
    userId: data.user.id,
    db,
    sessionId: session_id ?? null,
    authenticatedAt: latest > 0 ? new Date(latest * 1000) : null,
  };
}
