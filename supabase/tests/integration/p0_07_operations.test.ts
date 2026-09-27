// P0.07 integration: missed-heartbeat detection and recovery, temporary cleanup,
// orphan reconciliation, the external deletion journal and budget-mode analytics.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { AwsClient } from 'aws4fetch';
import { afterAll, describe, expect, it } from 'vitest';
import { accessToken, api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { startDeletion } from '../../../tests/support/lifecycle';
import { createSlot, mediaFixtures, putSlot, storageAdmin } from '../../../tests/support/media';
import { sql, stack } from '../../../tests/support/stack';

const HEALTH_TOKEN = 'local-only-health-check-token-0123456789abcdef';
const MAINTENANCE_SECRET = 'local-only-maintenance-secret-0123456789abcdef';
const storage = storageAdmin();
const aws = new AwsClient({
  accessKeyId: 'local-storage-access-key',
  secretAccessKey: 'local-storage-secret-key-0123456789abcdef',
  service: 's3',
  region: 'auto',
});

const health = async (token = HEALTH_TOKEN) => {
  const response = await fetch(`${stack().API_URL}/functions/v1/maintenance/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as any };
};

const deletionStatus = async (token: string) =>
  (await fetch(`${stack().API_URL}/functions/v1/api/v1/account/deletion-status`, {
    headers: { 'X-Deletion-Status': token },
  }).then((r) => r.json())) as any;

async function uploadReady(token: string, bytes: Buffer) {
  const { entry } = await createSlot(token, bytes, 'image/png');
  await putSlot(entry, bytes);
  await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' });
  await maintenance('dispatch_jobs');
  for (let i = 0; i < 80; i += 1) {
    const [row] = await sql()`select state from public.upload_entries where id = ${entry.entry_id}`;
    if (row?.state === 'ready') return entry;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('upload did not become ready');
}

afterAll(async () => {
  await sql().end();
});

describe('P0.07-A1: missed heartbeat and recovery', () => {
  it('a stopped scheduler is detected by the health check; recovery drains deletions without claiming them early', async () => {
    // The integration harness pauses every bowr-* schedule, as a stopped scheduler would.
    const member = await createIdentity('ops-deleter');
    await uploadReady(await accessToken(member.email), mediaFixtures().png);
    const statusToken = await startDeletion(member.id);
    await sql()`update private.deletion_tasks set not_before = now() where user_id = ${member.id} and state = 'pending'`;
    await sql()`update private.maintenance_heartbeats set last_succeeded_at = now() - interval '1 hour'
                 where task in ('temporary_cleanup', 'account_deletion')`;

    const degraded = await health();
    expect(degraded.status).toBe(503);
    expect(degraded.body.data.stale_tasks).toEqual(expect.arrayContaining(['account_deletion', 'temporary_cleanup']));
    expect(degraded.body.data.accounts_deleting).toBeGreaterThan(0);
    expect(JSON.stringify(degraded.body)).not.toMatch(/@example|object_key|uploads\//);
    // The health check has its own token; neither the maintenance secret nor no token works.
    expect((await health(MAINTENANCE_SECRET)).status).toBe(404);
    expect((await fetch(`${stack().API_URL}/functions/v1/maintenance/health`)).status).toBe(404);
    // The outage does not claim the account is deleted.
    const pending = await deletionStatus(statusToken);
    expect(pending.data.state).toBe('objects_pending');

    try {
      execFileSync('node', ['scripts/ops/recover-maintenance.mjs'], {
        env: {
          ...process.env,
          FUNCTIONS_URL: `${stack().API_URL}/functions/v1`,
          MAINTENANCE_SECRET,
          HEALTH_CHECK_TOKEN: HEALTH_TOKEN,
          DATABASE_URL: stack().DB_URL,
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      // Exit 1 means other fixtures left the stack degraded; the assertions below decide.
      if ((error as { status?: number }).status !== 1) throw error;
    } finally {
      const [{ inactive }] = await sql()`select count(*)::int as inactive from cron.job where jobname like 'bowr-%' and not active`;
      expect(inactive).toBe(0);
      await sql()`select cron.alter_job(jobid, active := false) from cron.job where jobname like 'bowr-%'`;
    }

    const recovered = await health();
    expect(recovered.body.data.stale_tasks).toEqual([]);
    expect((await deletionStatus(statusToken)).data).toMatchObject({ state: 'complete', objects_remaining: 0 });
    expect(await sql()`select 1 from auth.users where id = ${member.id}`).toHaveLength(0);
  });

  it('only the owner can read the redacted operations summary', async () => {
    const owner = await createIdentity('ops-summary-owner', { role: 'owner' });
    const member = await createIdentity('ops-summary-member');
    const summary = await api('/admin/operations', { token: await accessToken(owner.email) });
    expect(summary.status).toBe(200);
    expect(summary.body.data.heartbeats).toHaveLength(6);
    expect((await api('/admin/operations', { token: await accessToken(member.email) })).status).toBe(404);
  });

  it('a failing task records its failure without refreshing its heartbeat', async () => {
    const [before] = await sql()`select last_succeeded_at from private.maintenance_heartbeats where task = 'temporary_cleanup'`;
    await sql()`select public.svc_record_maintenance_run('temporary_cleanup', now(), 'storage DELETE 503')`;
    const [after] = await sql()`select last_succeeded_at, last_error from private.maintenance_heartbeats where task = 'temporary_cleanup'`;
    expect(after!.last_succeeded_at).toEqual(before!.last_succeeded_at);
    expect(after!.last_error).toBe('storage DELETE 503');
  });
});

describe('P0.07-T2: temporary cleanup and reconciliation', () => {
  it('an abandoned upload is expired and its bytes deleted within the one-hour target', async () => {
    const member = await createIdentity('abandoner');
    const token = await accessToken(member.email);
    const bytes = mediaFixtures().png;
    const { entry } = await createSlot(token, bytes, 'image/png');
    expect((await putSlot(entry, bytes)).status).toBe(200);
    const [object] = await sql()`select object_key from private.media_objects where asset_id = ${entry.asset_id}`;
    expect(await storage.exists(object!.object_key)).toBe(true);

    // The signed PUT expired and the member never completed the upload.
    await sql()`update public.upload_entries set upload_expires_at = now() - interval '2 minutes' where id = ${entry.entry_id}`;
    const run = await maintenance('temporary_cleanup');
    expect(run.status).toBe(200);
    expect(run.body.data.uploads_expired).toBeGreaterThanOrEqual(1);
    // Each run deletes at most 100 due objects, oldest first; earlier suites can leave
    // a larger backlog, which later runs drain. The deadline check below still holds.
    for (let i = 0; i < 10 && (await storage.exists(object!.object_key)); i += 1) {
      expect((await maintenance('temporary_cleanup')).status).toBe(200);
    }

    const [row] = await sql()`select e.state, a.state as asset_state from public.upload_entries e
      join public.media_assets a on a.id = e.asset_id where e.id = ${entry.entry_id}`;
    expect(row).toMatchObject({ state: 'canceled', asset_state: 'deleted' });
    expect(await storage.exists(object!.object_key)).toBe(false);
    const [task] = await sql()`select completed_at <= deadline as on_time, round(extract(epoch from deadline - created_at))::int as target_seconds
      from private.deletion_tasks where object_key = ${object!.object_key} and reason = 'upload_expired'`;
    expect(task).toMatchObject({ on_time: true });
    expect(task!.target_seconds).toBe(3600);
    // A late completion cannot revive it.
    const late = await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' });
    expect(late.body.error.code).toBe('UPLOAD_CANCELED');
  });

  it('expiry is enforced at signing: an expired temporary asset cannot be renewed or read', async () => {
    const member = await createIdentity('expiry');
    const token = await accessToken(member.email);
    const { entry } = await createSlot(token, mediaFixtures().png, 'image/png');
    await sql()`update public.media_assets set expires_at = now() - interval '1 second' where id = ${entry.asset_id}`;
    const renew = await api(`/upload-entries/${entry.entry_id}/renew`, { token, method: 'POST' });
    expect(renew.status).toBe(409);
    expect(renew.body.error.code).toBe('UPLOAD_NOT_RENEWABLE');
    const read = await api('/media/access', { token, method: 'POST', body: { requests: [{ asset_id: entry.asset_id, variant: 'original' }] } });
    expect(read.body.data?.[0]?.url).toBeUndefined();
  });

  it('daily reconciliation deletes unregistered objects and reports missing originals', async () => {
    const orphanKey = `uploads/${randomUUID()}/orphan-${randomBytes(4).toString('hex')}`;
    const put = await aws.fetch(`http://127.0.0.1:9000/bowr-private/${orphanKey}`, { method: 'PUT', body: 'x' });
    expect(put.ok).toBe(true);
    const [live] = await sql()`select object_key from private.media_objects where deleted_at is null limit 1`;
    const missingKey = `media/${randomUUID()}/missing.webp`;
    await sql()`insert into private.media_objects (bucket, object_key, role, created_at)
      values ('bowr-private', ${missingKey}, 'original', now() - interval '2 hours')`;
    try {
      const [{ r }] = await sql()`select public.svc_reconcile_storage('bowr-private', ${[orphanKey, live!.object_key]}::text[],
        ${[orphanKey, live!.object_key]}::text[], now()) as r`;
      expect(r.orphans_queued).toBe(1);
      expect(r.originals_missing).toBeGreaterThanOrEqual(1);
      // At most 100 due objects per run, oldest first: drain any backlog ahead of the orphan.
      for (let i = 0; i < 10 && (await storage.exists(orphanKey)); i += 1) await maintenance('media_deletion');
      expect(await storage.exists(orphanKey)).toBe(false);
    } finally {
      await sql()`update private.media_objects set deleted_at = now() where object_key = ${missingKey}`;
    }
    // The scheduled task lists the real bucket (young keys are left alone).
    const run = await maintenance('orphan_reconciliation');
    expect(run.status).toBe(200);
    expect(run.body.data.listed).toBeGreaterThan(0);
  });
});

describe('P0.07-T3: external deletion journal', () => {
  it('an account deletion is journaled outside the database before the identity is removed', async () => {
    const member = await createIdentity('journaled');
    await startDeletion(member.id);
    const [entry] = await sql()`select id, recorded_at from private.deletion_journal where subject_id = ${member.id}`;
    expect(entry).toBeDefined();
    await maintenance('account_deletion');
    const key = `deletions/${new Date(entry!.recorded_at).toISOString().slice(0, 10)}/${String(entry!.id).padStart(12, '0')}.json`;
    const response = await aws.fetch(`http://127.0.0.1:9000/bowr-journal/${key}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['kind', 'recorded_at', 'subject_id']);
    expect(body).toMatchObject({ kind: 'account_deleted', subject_id: member.id });
    const [{ exported }] = await sql()`select exported_at is not null as exported from private.deletion_journal where id = ${entry!.id}`;
    expect(exported).toBe(true);
  });
});

describe('P0.07-T4: budget-mode analytics', () => {
  it('a mode transition is sent once with allowlisted fields; an analytics outage does not fail maintenance', async () => {
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ path: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"Ok"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(8792, '0.0.0.0', resolve));
    const reset = () =>
      sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, ceiling_micros = 10000000, paused_reason = null where id`;
    try {
      await sql()`delete from private.analytics_outbox where sent_at is null`;
      await sql()`select public.svc_ai_rollover()`;
      await reset();
      await maintenance('ai_rollover');
      received.length = 0;

      await sql()`update private.budget_settings set lighter_micros = 0, stop_micros = 0 where id`;
      expect((await maintenance('ai_rollover')).body.data.analytics_sent).toBe(1);
      expect((await maintenance('ai_rollover')).body.data.analytics_sent).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].path).toBe('/i/v0/e/');
      expect(received[0].body).toMatchObject({ event: 'budget_mode_changed', distinct_id: 'bowr-system' });
      expect(Object.keys(received[0].body).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'timestamp']);
      expect(received[0].body.properties).toEqual({ mode: 'paused', $process_person_profile: false });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // PostHog is down: maintenance still succeeds and the event waits for the next run.
    await reset();
    const outage = await maintenance('ai_rollover');
    expect(outage.status).toBe(200);
    expect(outage.body.data).toMatchObject({ analytics_sent: 0, analytics_failed: 1 });
    const [{ unsent }] = await sql()`select count(*)::int as unsent from private.analytics_outbox
      where sent_at is null and properties ->> 'mode' = 'normal'`;
    expect(unsent).toBe(1);
    await sql()`delete from private.analytics_outbox where sent_at is null`;
  });
});
