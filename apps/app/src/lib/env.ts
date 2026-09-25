// Public build-time configuration. EXPO_PUBLIC_* values are embedded in the
// client bundle, so they must never contain secrets.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export const env = {
  supabaseUrl: required('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabasePublishableKey: required(
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  googleAuthEnabled: process.env.EXPO_PUBLIC_AUTH_GOOGLE_ENABLED === 'true',
};

export const apiBaseUrl = `${env.supabaseUrl}/functions/v1/api/v1`;
