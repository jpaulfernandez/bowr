import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.1';

let client: SupabaseClient | null = null;

/**
 * Service-role client for svc_* RPCs and Auth administration. Callers pass only a
 * user ID that requireCaller() verified; request bodies never supply identity.
 */
export function serviceClient(): SupabaseClient {
  if (client) return client;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Service configuration is missing');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
