# Environments and secrets

Status: local environment implemented; staging and production are not provisioned yet. This inventory grows with each slice; P0.07 completes it with deployment and rollback steps.

bowr uses separate **local**, **staging** and **production** environments (ARCHITECTURE section 14.1). Each has its own Supabase project, Auth callbacks, secrets and, in later slices, R2 bucket, Modal environment and Gemini project. Never copy a secret between environments, and never commit one.

## Inventory

| Name | Where it lives | Used by | Local value |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Web build environment (public) | Web client | From `pnpm exec supabase status` |
| `EXPO_PUBLIC_AUTH_GOOGLE_ENABLED` | Web build environment (public) | Shows Google sign-in | `false` |
| `APP_ORIGINS` | Edge Function secrets | Exact-origin CORS | `supabase/functions/.env.example` |
| `INVITE_HMAC_SECRET` | Edge Function secrets | Invite code digests, IP throttle hashes | `supabase/functions/.env.example` (local only) |
| `MAINTENANCE_SECRET` | Edge Function secrets, and Vault `bowr_maintenance_secret` | Scheduled maintenance calls | `supabase/seed.sql` (local only) |
| Vault `bowr_maintenance_url` | Supabase Vault | pg_cron → pg_net target | `supabase/seed.sql` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Provided by the Edge runtime | Edge Functions | Automatic |
| Google OAuth client ID and secret | Supabase Auth provider settings | Google sign-in | Not configured |
| SMTP host, user, password, sender | Supabase Auth SMTP settings | Magic-link email | Mailpit (local) |
| `DATABASE_URL` | Operator shell only | `pnpm ops:bootstrap-owner` | Local database URL |

## Generating secrets

Use at least 32 random bytes for `INVITE_HMAC_SECRET` and `MAINTENANCE_SECRET`, for example `openssl rand -base64 48`. Set Edge secrets with `supabase secrets set --project-ref <ref> NAME=value`.

Rotating `INVITE_HMAC_SECRET` invalidates every unused invite code: revoke them and issue new ones. Rotate `MAINTENANCE_SECRET` in the Edge secrets and Vault together.

## Staging Auth configuration (P0.02-T3 gate, not yet done)

1. Create a Google OAuth client for the staging web origin. Add exactly `https://<staging-host>/auth/callback` to Supabase Auth's redirect allowlist, and set the Site URL to `https://<staging-host>`.
2. Enable the Google provider with PKCE. Set `EXPO_PUBLIC_AUTH_GOOGLE_ENABLED=true` in the staging web build only after step 4 passes.
3. Configure custom SMTP with a verified sender domain (SPF/DKIM). The default Supabase mailer is for testing and restricts recipients.
4. Verify that an invited address outside the project team receives a magic link. Check that both Google and email sign-in complete on the deployed host, and that expired and other-browser links show the recovery screen. Record the result in `docs/implementation/evidence/P0.02.md`.

## Scheduled maintenance (staging and production)

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/maintenance', 'bowr_maintenance_url');
select vault.create_secret('<MAINTENANCE_SECRET value>', 'bowr_maintenance_secret');
```

The migration schedules `bowr-pending-account-cleanup` hourly. If either Vault secret is missing, the job logs a warning and does nothing. P0.07 adds an independent heartbeat alert for missed runs.
