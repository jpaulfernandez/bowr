// P0.07-A2 (local part): an encrypted export restored into an isolated database
// does not revive a deletion made after the export, keeps old sessions, jobs and
// paid work from resuming, and records its timings against the targets.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, expect, it } from 'vitest';
import { accessToken, api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { startDeletion } from '../../../tests/support/lifecycle';
import { createSlot, mediaFixtures, putSlot } from '../../../tests/support/media';
import { sql, stack } from '../../../tests/support/stack';

afterAll(async () => {
  await sql().end();
});

it('P0.07 demo: a deletion-aware restore into isolation', async () => {
  const fixtures = mediaFixtures();
  const keeper = await createIdentity('restore-keeper', { displayName: 'Kept Member' });
  const keeperToken = await accessToken(keeper.email);
  const leaver = await createIdentity('restore-leaver', { displayName: 'Left Member' });
  const leaverToken = await accessToken(leaver.email);

  // The leaver has a stored photo; the keeper has an upload waiting for processing.
  const done = await createSlot(leaverToken, fixtures.png, 'image/png');
  await putSlot(done.entry, fixtures.png);
  await api(`/upload-entries/${done.entry.entry_id}/complete`, { token: leaverToken, method: 'POST' });
  await maintenance('dispatch_jobs');
  await expect.poll(async () => (await sql()`select state from public.upload_entries where id = ${done.entry.entry_id}`)[0]!.state,
    { timeout: 20_000 }).toBe('ready');
  const waiting = await createSlot(keeperToken, fixtures.png, 'image/png');
  await putSlot(waiting.entry, fixtures.png);
  await sql()`select public.svc_complete_upload_entry(${keeper.id}, ${randomUUID()}, ${waiting.entry.entry_id}, ${fixtures.png.length})`;
  // An AI attempt reserved but not yet settled when the export is taken.
  const attemptKey = `restore:${randomUUID()}`;
  await sql()`select public.svc_ai_reserve(${attemptKey}, null, null, 'diagnostic', 'model-normal', 'model-lighter',
    'price-v1', 1000, 500, 60)`;

  const dir = mkdtempSync(join(tmpdir(), 'bowr-backup-'));
  const key = randomBytes(32).toString('base64');
  const restoreDb = `bowr_restore_${randomBytes(4).toString('hex')}`;
  const restoreUrl = stack().DB_URL.replace(/\/postgres$/, `/${restoreDb}`);
  const env = {
    ...process.env,
    DATABASE_URL: stack().DB_URL,
    BACKUP_ENCRYPTION_KEY: key,
    BACKUP_DIR: dir,
    PG_TOOLS_CONTAINER: 'supabase_db_bowr',
  };
  try {
    execFileSync('node', ['scripts/ops/backup-db.mjs'], { env, stdio: 'pipe' });
    const manifest = readdirSync(dir).find((f) => f.endsWith('.json'))!;

    // After the export: the leaver deletes their account and it completes.
    await startDeletion(leaver.id);
    await sql()`update private.deletion_tasks set not_before = now() where user_id = ${leaver.id} and state = 'pending'`;
    await maintenance('account_deletion');
    await expect.poll(async () => (await sql()`select 1 from auth.users where id = ${leaver.id}`).length, { timeout: 20_000 }).toBe(0);

    await sql()`create database ${sql()(restoreDb)}`;
    const output = execFileSync('node', ['scripts/ops/restore-rehearsal.mjs'], {
      env: {
        ...env,
        BACKUP_MANIFEST: join(dir, manifest),
        RESTORE_DATABASE_URL: restoreUrl,
        R2_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
        R2_ACCESS_KEY_ID: 'local-storage-access-key',
        R2_SECRET_ACCESS_KEY: 'local-storage-secret-key-0123456789abcdef',
        R2_BUCKET: 'bowr-private',
        DELETION_JOURNAL_BUCKET: 'bowr-journal',
      },
      encoding: 'utf8',
    });
    const report = JSON.parse(output.trim().split('\n').pop()!);
    expect(report).toMatchObject({ rpo_met: true, rto_met: true });
    expect(report.journal.replayed).toBeGreaterThanOrEqual(1);
    expect(report.prepared.sessions_revoked).toBeGreaterThanOrEqual(2);
    expect(output).not.toMatch(/@example|Left Member|Kept Member|uploads\//);

    const restored = postgres(restoreUrl, { max: 1, onnotice: () => {} });
    try {
      // The deletion is replayed: no access, no details, every object queued again.
      const [leaverRow] = await restored`select m.state, p.display_name from private.memberships m
        join public.profiles p on p.id = m.user_id where m.user_id = ${leaver.id}`;
      expect(leaverRow).toEqual({ state: 'deleting', display_name: null });
      expect(await restored`select 1 from public.media_assets where user_id = ${leaver.id}`).toHaveLength(0);
      expect(await restored`select 1 from private.account_deletions where user_id = ${leaver.id} and state <> 'complete'`).toHaveLength(1);
      // Others survive, but every session must sign in again.
      const [keeperRow] = await restored`select m.state, p.display_name from private.memberships m
        join public.profiles p on p.id = m.user_id where m.user_id = ${keeper.id}`;
      expect(keeperRow).toEqual({ state: 'active', display_name: 'Kept Member' });
      expect(await restored`select 1 from auth.sessions`).toHaveLength(0);
      expect(await restored`select 1 from auth.refresh_tokens`).toHaveLength(0);
      // Old work cannot dispatch; the member sees a retryable failure.
      expect(await restored`select 1 from private.jobs where state in ('queued', 'running', 'retry_wait')`).toHaveLength(0);
      const [entry] = await restored`select state, failure_code from public.upload_entries where id = ${waiting.entry.entry_id}`;
      expect(entry).toEqual({ state: 'failed', failure_code: 'RESTORED' });
      // Paid work from the old timeline is never resent, stays counted, and AI waits for the owner.
      const [usage] = await restored`select state from private.ai_usage where attempt_key = ${attemptKey}`;
      expect(usage!.state).toBe('unknown');
      const [settings] = await restored`select paused_reason from private.budget_settings`;
      expect(settings!.paused_reason).toBe('restore');
    } finally {
      await restored.end();
    }
  } finally {
    await sql()`drop database if exists ${sql()(restoreDb)} with (force)`;
    rmSync(dir, { recursive: true, force: true });
    await sql()`select public.svc_ai_release(id) from private.ai_usage where attempt_key = ${attemptKey}`;
  }
});
