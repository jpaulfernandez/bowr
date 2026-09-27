# Environments and secrets

Status: local environment implemented. Initial hosted Supabase project `bowr` (`vygtmevivuoeifikdild`, Tokyo) exists; Resend SMTP and email-only Auth were configured and read back on 27 September 2026. The staging backend, web app, buckets and worker were deployed on 27 September 2026 (see "Staging inventory" below). Auth callback configuration, storage and dispatch credentials, and delivery verification remain open. Production release is not approved. Deployment and rollback: [deploy.md](deploy.md). Health, alerts and recovery: [operations.md](operations.md). Backups: [backup-restore.md](backup-restore.md).

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

## Staging inventory (27 September 2026)

| Resource | Value |
| --- | --- |
| Supabase project | `bowr` (`vygtmevivuoeifikdild`), Tokyo |
| Web | Vercel project `bowr-staging`, `https://bowr-staging.vercel.app` |
| Private media bucket | R2 `bowr-staging-media`, location hint APAC |
| Deletion journal bucket | R2 `bowr-staging-journal`, location hint APAC, 30-day expiry |
| Worker | Modal app `bowr-worker`, `https://jpaul-fernandez18--bowr-worker-wake.modal.run` (proxy auth required). Region not pinned |
| Operator secrets | `.env.staging` in the repository root (gitignored, mode 600). Holds the generated staging secrets for `pnpm ops:*` commands and the GitHub `HEALTH_CHECK_TOKEN`. Move it to a password manager |

Location hints and regions are not guarantees of processing location.

Auth Site URL and redirect allowlist, the Modal proxy token and the bucket-scoped R2 token were set on 27 September 2026. The R2 token has object permissions only, so bucket CORS and lifecycle rules are managed with `wrangler`. Still open: the owner's first sign-in and `pnpm ops:bootstrap-owner`.

## Generating secrets

Use at least 32 random bytes for `INVITE_HMAC_SECRET` and `MAINTENANCE_SECRET`, for example `openssl rand -base64 48`. Set Edge secrets with `supabase secrets set --project-ref <ref> NAME=value`.

Rotating `INVITE_HMAC_SECRET` invalidates every unused invite code: revoke them and issue new ones. Rotate `MAINTENANCE_SECRET` in the Edge secrets and Vault together.

## Staging Auth configuration (P0.02-T3 gate, not yet done)

Owner decision (27 September 2026): launch staging with email magic links only. Google sign-in is deferred; keep the hosted Google provider disabled and `EXPO_PUBLIC_AUTH_GOOGLE_ENABLED=false`. Google acceptance checks remain deferred, not passed.

The initial web deployment will use a Vercel-generated hostname (owner decision, 27 September 2026). `janpaulfernandez.com` is the email sender domain; do not change its website routing. Set Auth callbacks and exact-origin CORS from the actual Vercel hostname after deployment.

1. Add exactly `https://<staging-host>/auth/callback` to Supabase Auth's redirect allowlist, and set the Site URL to `https://<staging-host>`.
2. Configure Resend custom SMTP with a verified sender domain (SPF/DKIM): host `smtp.resend.com`, port `465`, username `resend`, and the Resend API key as the password. Keep the key in hosted Auth configuration, never the web build. Configured sender: `bowr <bowr@janpaulfernandez.com>`, using the owner's supplied domain. Hosted settings readback passed; domain authorization and delivery still need an end-to-end test. See [Resend SMTP](https://resend.com/docs/send-with-smtp).
3. Verify that an invited address outside the project team receives a magic link. Check email sign-in, fresh authentication, expired-link and other-browser recovery on the deployed host. Record the result in `docs/implementation/evidence/P0.02.md`.

If Google is enabled later, its OAuth client's authorized redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`; the app callback above belongs in Supabase's redirect allowlist. Complete Google-specific checks before showing the sign-in button.

## Scheduled maintenance (staging and production)

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/maintenance', 'bowr_maintenance_url');
select vault.create_secret('<MAINTENANCE_SECRET value>', 'bowr_maintenance_secret');
```

Migrations schedule every `bowr-*` task ([operations.md](operations.md)). If either Vault secret is missing, the jobs log a warning and do nothing; the external heartbeat check reports it.

## Private media storage and worker (P0.03)

| Name | Where it lives | Used by |
| --- | --- | --- |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Edge Function secrets | Signing and object checks; scoped R2 API token for the bucket only |
| `R2_BUCKET` | Edge Function secrets | Private bucket name |
| `R2_PUBLIC_ENDPOINT` | Edge Function secrets | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_INTERNAL_ENDPOINT` | Edge Function secrets (optional) | Same as public for R2 |
| `EXPO_PUBLIC_MEDIA_ORIGIN` | Web build environment (public) | CSP `connect-src`/`img-src` for signed uploads and views |
| `UPLOAD_HEIC_ENABLED` | Edge Function secrets | Advertise HEIC only after the deployed worker passes the HEIC fixtures |
| `WORKER_DISPATCH_URL` | Edge Function secrets | The Modal `wake` endpoint URL |
| `WORKER_DISPATCH_KEY`, `WORKER_DISPATCH_SECRET` | Edge Function secrets | Modal proxy-auth token (sent as `Modal-Key`/`Modal-Secret`) |
| `WORKER_CAPABILITY_SECRET` | Edge Function secrets | Signs job-scoped worker capabilities |
| Modal secret `bowr-worker-config` | Modal | `BOWR_INTERNAL_API_URL=https://<project-ref>.supabase.co/functions/v1/internal` only |

### Staging setup (P0.03-T2 gate, not yet done)

1. Create a private R2 bucket with no public access and no custom domain. Create an R2 API token scoped to that bucket with object read/write.
2. Apply exact-origin CORS for the web origin with `node scripts/dev/setup-storage.mjs`, using the staging `R2_*` and `APP_ORIGINS` values. The rule allows only `PUT` and `GET` with the `content-type` header.
3. Deploy the worker with `cd services/worker && uv run --extra modal modal deploy modal_app.py`. Create a Modal proxy-auth token for the `wake` endpoint, then set `WORKER_DISPATCH_*` in the Edge secrets.
4. Upload each MEDIA fixture through the deployed path (JPEG with EXIF orientation and GPS, PNG, WebP, HEIC, spoofed MIME, animated, over-limit). Confirm the outcomes match `supabase/tests/integration/p0_03_uploads.test.ts`. Set `UPLOAD_HEIC_ENABLED=true` only after the HEIC case passes on Modal.
5. Record the R2 location hint and Modal region in this file. They are not guarantees of processing location.

## AI gateway (P0.05)

| Name | Where it lives | Used by |
| --- | --- | --- |
| `AI_ENABLED` | Edge Function secrets | Must stay `false` until the P0.05-T5 verification passes |
| `GEMINI_API_KEY` | Edge Function secrets | Dedicated bowr paid project only |
| `GEMINI_BASE_URL` | Edge Function secrets (local only) | Points the SDK at `scripts/dev/fake-gemini.mjs`; unset in staging/production |
| `AI_CALL_TIMEOUT_MS` | Edge Function secrets (optional) | Provider call timeout; defaults to 30 s |

Verification before enabling AI (P0.05-T5): confirm the model IDs and effective prices in `config/models.yaml` against Google's current pricing page. Set the Google project cap to $10 and disable automatic top-up where the billing account supports it. Run `SUPABASE_URL=... MAINTENANCE_SECRET=... pnpm ops:ai-smoke` once, then reconcile Google's usage report against `private.ai_usage`.

## Operations, journal, backups and analytics (P0.07)

| Name | Where it lives | Used by |
| --- | --- | --- |
| `HEALTH_CHECK_TOKEN` | Edge Function secrets, and the GitHub `staging`/`production` environment secret | Read-only `GET /maintenance/health` for the external heartbeat check |
| `HEALTH_URL` | GitHub environment secret | `.github/workflows/heartbeat.yml` |
| `HEALTH_CHECK_ENABLED` | GitHub repository variable | Turns the heartbeat workflow on once the environment exists |
| `DELETION_JOURNAL_BUCKET` | Edge Function secrets | Separate private bucket for the deletion journal; same scoped R2 token or its own write-only token; 30-day lifecycle rule |
| `BACKUP_ENCRYPTION_KEY` | Operator secret store only | `pnpm ops:backup-db` and `pnpm ops:restore-rehearsal`; never in Edge secrets or CI |
| `POSTHOG_HOST`, `POSTHOG_API_KEY` | Edge Function secrets | Server-side allowlisted events (`budget_mode_changed`); unset disables them |
| `EXPO_PUBLIC_POSTHOG_HOST`, `EXPO_PUBLIC_POSTHOG_KEY` | Web build environment (public project key) | Client allowlisted events; leave empty to send none. The host is added to the CSP `connect-src` |

PostHog project settings: autocapture, heatmaps, session recording and surveys off; "Discard client IP data" on. The web client sends explicit capture calls only (`apps/app/src/lib/analytics.ts`); no PostHog script runs in the page.
