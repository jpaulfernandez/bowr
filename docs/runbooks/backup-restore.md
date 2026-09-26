# Backup and deletion-aware restore

Status: the export, journal and restore rehearsal are implemented and rehearsed locally (P0.07). Daily staging and production exports and a staging restore rehearsal are gates (P0.07-A2).

## Targets and limits

| Target | Value |
| --- | --- |
| Recovery point (RPO) | 24 hours, from a daily export |
| Restoration (RTO) | Within one day, after a successful rehearsal |
| Retention | 7 days, rolling |

- Backups contain the `auth`, `public` and `private` schemas: accounts, settings, asset manifests and ledgers. They contain **no photos**.
- Retained photos in R2 have no independent backup in this low-cost baseline. If an original is lost, the member must reupload it; the restore report counts such cases.
- Deleted account details can remain in a backup until it expires (7 days). The privacy page says so.

## Daily encrypted export (staging and production gate)

Run once a day, from an operator-controlled scheduler, never from the app:

```sh
DATABASE_URL=postgresql://... BACKUP_ENCRYPTION_KEY=<base64 32 bytes> BACKUP_DIR=/secure/bowr-backups \
pnpm ops:backup-db
```

- The export uses pg_dump's custom format for the three schemas, then encrypts it with AES-256-GCM. The manifest records the time, checksum and size.
- Files older than 7 days in `BACKUP_DIR` are removed.
- Use PostgreSQL 17 client tools (locally, `PG_TOOLS_CONTAINER=supabase_db_bowr`).
- Keep `BACKUP_ENCRYPTION_KEY` in the operator's secret store, never with the backups.
- Copy each file and its manifest to a restricted location outside Supabase. Record where in this file when staging exists.
- Generate a key with `openssl rand -base64 32`. Rotating it does not re-encrypt old files: keep old keys until their files expire.

## Deletion journal

When an account deletion starts, the same database transaction writes a row to `private.deletion_journal`. The `account_deletion` task copies it to the `DELETION_JOURNAL_BUCKET` bucket as `deletions/<date>/<id>.json` (`kind`, `subject_id`, `recorded_at`, no personal data) **before** it removes the Auth identity.

The journal lives outside the database's backup timeline. A restore can therefore replay deletions made after the export was taken. Keep journal objects for at least 30 days: longer than the backup window, with a lifecycle rule on that bucket.

## Restore (rehearsal and real recovery)

Always restore into an **empty, isolated** database first. The script refuses a non-empty target and refuses to target `DATABASE_URL`.

```sh
BACKUP_MANIFEST=/secure/bowr-backups/bowr-<time>.json BACKUP_ENCRYPTION_KEY=... \
RESTORE_DATABASE_URL=postgresql://.../bowr_restore \
R2_PUBLIC_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... DELETION_JOURNAL_BUCKET=... \
pnpm ops:restore-rehearsal
```

The script runs these steps in order:

1. Verifies the checksum, decrypts the export and restores its schema and data.
2. `private.prepare_restored_database()`:
   - Revokes every Auth session, refresh token and pending sign-in. Members sign in again.
   - Discards unconsumed fresh-auth challenges.
   - Fails unfinished jobs with `RESTORED`, so members can retry deliberately.
   - Marks reserved or dispatching AI attempts `unknown`: never resent, still counted.
   - Pauses AI with the reason `restore`.
3. Replays every journal entry with `private.replay_account_deletion`. This is idempotent: a deletion already in progress is left alone.
4. Expires temporary uploads that are past their deadlines.
5. Checks every registered object in storage:
   - Missing quarantine bytes are marked deleted.
   - Missing originals that are not being deleted are counted for follow-up.
6. Prints a report: export age, whether RPO and RTO were met, restore time, and counts. It contains no names, emails or keys.

The restored database has no `pg_cron` schedules, so nothing dispatches during these steps.

### Before serving traffic from a restored database

1. Recreate the Vault secrets `bowr_maintenance_url` and `bowr_maintenance_secret` ([environments.md](environments.md)).
2. Check who the owner is. Ownership transfers are not journaled, and an owner who deleted their account leaves the installation locked. Use `pnpm ops:bootstrap-owner` if needed.
3. Point the Supabase project at the restored data. For a hosted project, restore into a new project whose migrations are applied, with schedules paused. Load the data with `pg_restore --data-only` under `session_replication_role = replica`, then repeat steps 2–5 through the script's SQL functions. This path is unrehearsed until the staging gate.
4. Enable schedules. Run `pnpm ops:recover-maintenance`, then confirm the health check returns 200.
5. Confirm that both Auth callbacks work and that a member can sign in again. Review AI usage, then resume AI deliberately (Admin → AI spend).

Record every rehearsal in the P0.07 evidence: date, export age, elapsed time and the report counts.
