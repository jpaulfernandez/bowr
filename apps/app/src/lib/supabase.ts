import { createClient } from '@supabase/supabase-js';
import { authStorage } from '../platform/auth-storage';
import { env } from './env';

export const AUTH_STORAGE_KEY = 'bowr-auth';

export const supabase = createClient(env.supabaseUrl, env.supabasePublishableKey, {
  auth: {
    storage: authStorage,
    storageKey: AUTH_STORAGE_KEY,
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    // The callback route exchanges the code explicitly so it can show recovery states.
    detectSessionInUrl: false,
  },
});
