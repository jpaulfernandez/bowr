# Operations: health, alerts and recovery

Status: implemented and verified locally (P0.07). The staging monitor and provider alerts are configured when staging is provisioned; until then, their configuration steps are recorded here as gates.

## Scheduled work

`pg_cron` calls the `maintenance` Edge Function through `pg_net` (Vault holds the URL and secret). Each run records a heartbeat in `private.maintenance_heartbeats`.

| Schedule | Task | Expected every | What it does |
| --- | --- | --- | --- |
| `bowr-job-dispatch` | `dispatch_jobs` | 1 minute | Recovers expired leases and due retries, then dispatches queued processing jobs |
| `bowr-temporary-cleanup` | `temporary_cleanup` | 5 minutes | Expires abandoned uploads (signed PUT expired and never completed) and failed uploads past their temporary deadline, purges expired payloads, challenges and rate-limit buckets, then deletes due objects |
| `bowr-account-deletion` | `account_deletion` | 5 minutes | Exports new deletion-journal entries, deletes manifest objects, then removes Auth identities whose objects are confirmed absent |
| `bowr-ai-rollover` | `ai_rollover` | 10 minutes | Carries uncertain AI charges into the next month, then records and sends budget-mode transitions |
| `bowr-pending-account-cleanup` | `pending_account_cleanup` | 1 hour | Deletes sign-ins that never redeemed an invite within 24 hours |
| `bowr-orphan-reconciliation` | `orphan_reconciliation` | daily, 03:17 UTC | Lists the private bucket, queues objects the registry does not know (older than 6 hours) for deletion, and reports registered originals missing from storage |

Deletion targets (ARCHITECTURE 12.1): each deletion task carries a `deadline`. Temporary objects are due within one hour of becoming deletable, and retained objects within 24 hours. `deletions_overdue` counts tasks past their deadline.

## Health check

`GET https://<ref>.supabase.co/functions/v1/maintenance/health`, with `Authorization: Bearer <HEALTH_CHECK_TOKEN>`.

- **200** means every scheduled task succeeded within two of its intervals plus 2 minutes, nothing is past its deletion deadline, no job is stuck, and the journal is exported.
- **503** means degraded. `stale_tasks` names the late tasks, and the counts show what is waiting.
- The token is read-only and separate from `MAINTENANCE_SECRET`, so it cannot start work. A request without it gets 404.

The report contains task names, times and counts only. The owner sees the same summary under **Admin → Background work**.

### External monitor (staging and production gate)

`.github/workflows/heartbeat.yml` checks health every 30 minutes from GitHub, outside Supabase. A paused project, a stopped scheduler or an unreachable function fails the run, and GitHub emails the repository's watchers. To enable it for an environment:

1. Generate a token: `openssl rand -base64 48`. Set it with `supabase secrets set --project-ref <ref> HEALTH_CHECK_TOKEN=...`.
2. In the repository's `staging` environment, add these secrets:
   - `HEALTH_URL`: the health URL above.
   - `HEALTH_CHECK_TOKEN`: the token from step 1.
3. Set the repository variable `HEALTH_CHECK_ENABLED=true`.
4. Make sure the people on call watch the repository with Actions notifications on.
5. Test detection. Pause a schedule with `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'bowr-temporary-cleanup'`. Wait about 15 minutes, run the workflow manually, and confirm it fails. Then run the recovery below. Record the result in the P0.07 evidence.

## Recovery after a missed heartbeat

```sh
FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 \
MAINTENANCE_SECRET=... HEALTH_CHECK_TOKEN=... \
DATABASE_URL=postgresql://... pnpm ops:recover-maintenance
```

The command does three things:

1. Re-enables any paused `bowr-*` schedule.
2. Runs every task once in dependency order. It repeats cleanup and account deletion until they stop making progress, so queued deletions drain.
3. Prints the health report, and exits 1 if the service is still degraded.

If it is still degraded, act on what the report shows:

- **`deletions_overdue`, with storage errors in the function logs:** storage is unavailable. Tasks back off and retry. Deletion status stays "pending" and never says "deleted" early.
- **`jobs_stuck`:** check the worker (Modal) and its dispatch credentials.
- **`journal_unexported`:** check `DELETION_JOURNAL_BUCKET` and its credentials. Account removal waits until the journal entry is exported.
- **`accounts_overdue`:** an Auth deletion keeps failing. Its `last_error` in `private.account_deletions` gives a status code, never personal data.
- **A single failing task:** `last_error` in `private.maintenance_heartbeats` holds a safe message of up to 80 characters.

If Vault secrets are missing, `private.invoke_maintenance` logs a warning and does nothing. Recreate them as described in [environments.md](environments.md).

## Provider resource alerts (staging and production gate)

bowr adds no monitoring platform. It uses each provider's own alerts, sent to the operator's email:

| Provider | Alert |
| --- | --- |
| Supabase | Usage and disk notifications on the project (Organization → Usage). Spend cap on. |
| Cloudflare R2 | Billing notification for R2 storage and Class A operations. The bucket stays private. |
| Modal | Workspace budget limit, with email at 80%. |
| Google AI (Gemini) | Project cap of $10 with automatic top-up off (P0.05-T5). The application limit stops earlier. |
| PostHog | Billing limit at the free tier. Autocapture, session recording and IP capture are off in project settings. |

Record the configured values in the P0.07 evidence when staging exists.

## Logs

Edge Function logs hold request IDs, task names, counts, status codes and `alert` lines: `stuck_jobs`, `originals_missing`, `analytics_flush_failed` and `heartbeat_not_recorded`. They never contain signed URLs, object keys, emails or file names. The Supabase log retention for the project's plan applies. Application summaries target 14 days (ARCHITECTURE 12.1).
