import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

type StackEnv = { API_URL: string; DB_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string; MAILPIT_URL: string };

let cached: StackEnv | null = null;

/** Local Supabase connection details from the CLI; never hard-coded in tests. */
export function stack(): StackEnv {
  if (cached) return cached;
  const output = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], { encoding: 'utf8' });
  const parsed = JSON.parse(output.slice(output.indexOf('{'))) as Record<string, string>;
  cached = {
    API_URL: parsed.API_URL!,
    DB_URL: parsed.DB_URL!,
    ANON_KEY: parsed.ANON_KEY!,
    SERVICE_ROLE_KEY: parsed.SERVICE_ROLE_KEY!,
    MAILPIT_URL: parsed.MAILPIT_URL ?? parsed.INBUCKET_URL!,
  };
  return cached;
}

export const admin = () =>
  createClient(stack().API_URL, stack().SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let sqlClient: ReturnType<typeof postgres> | null = null;
/** Test-fixture database access. Application code never connects this way. */
export const sql = () => (sqlClient ??= postgres(stack().DB_URL, { max: 12, onnotice: () => {} }));

/** A separate connection pool, for tests that need independent transactions. */
export const connection = () => postgres(stack().DB_URL, { max: 1, onnotice: () => {} });
