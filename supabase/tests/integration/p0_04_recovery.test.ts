// P0.04 integration: durable jobs recover from lost dispatch, dead workers,
// duplicate deliveries and storage failure. The running local worker processes
// dispatched jobs; the test harness plays a second, failing worker where needed.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { createSlot, mediaFixtures, member, putSlot, sha256, type Member } from '../../../tests/support/media';
import { sql, stack } from '../../../tests/support/stack';

const CAPABILITY_SECRET = 'local-only-worker-capability-secret-0123456789';
let fixtures: ReturnType<typeof mediaFixtures>;
let owner: Member;
const cleanup: string[] = [];
const internal = (path: string) => `${stack().API_URL}/functions/v1/internal/v1${path}`;

async function entryState(entryId: string) {
  const [row] = await sql()`select e.state, e.failure_code, e.asset_id, j.id as job_id, j.state as job_state,
      j.attempt_count, j.lease_generation, j.manual_retries
    from public.upload_entries e join private.jobs j on j.target_id = e.asset_id where e.id = ${entryId}`;
  return row!;
}

async function waitFor(entryId: string, states: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await entryState(entryId);
    if (states.includes(row.state)) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`entry ${entryId} did not reach ${states.join('/')}`);
}

/** An uploaded entry whose validation job is committed but whose wake-up never happened. */
async function undispatchedJob(bytes = fixtures.png, type = 'image/png') {
  const { entry } = await createSlot(owner.token, bytes, type);
  cleanup.push(entry.entry_id);
  expect((await putSlot(entry, bytes)).status).toBe(200);
  const [row] = await sql()`select public.svc_complete_upload_entry(${owner.id}, ${randomUUID()}, ${entry.entry_id}, ${bytes.length}) as r`;
  return { entryId: entry.entry_id as string, assetId: entry.asset_id as string, jobId: row!.r.job_id as string };
}

/** The harness acts as a worker: issue a claim and exchange it. */
async function harnessClaim(jobId: string) {
  const token = randomBytes(32).toString('hex');
  const [{ issued }] = await sql()`select public.svc_issue_job_claim(${jobId}, ${sha256(Buffer.from(token))}) as issued`;
  expect(issued).toBe(true);
  const response = await fetch(internal('/jobs/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, claim_token: token }),
  });
  expect(response.status).toBe(200);
  return { token, job: ((await response.json()) as any).data };
}

async function internalCall(path: string, capability: string, body: unknown) {
  const response = await fetch(internal(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** Signs a capability with the local secret to prove the server checks its claims. */
function forgeCapability(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', CAPABILITY_SECRET).update(`bowr.job.v1.${body}`).digest('base64url');
  return `${body}.${signature}`;
}

async function expireLease(jobId: string) {
  await sql()`update private.jobs set lease_expires_at = now() - interval '1 second' where id = ${jobId}`;
}

async function runScheduler() {
  const response = await maintenance('dispatch_jobs');
  expect(response.status).toBe(200);
  return response.body.data;
}

beforeAll(async () => {
  fixtures = mediaFixtures();
  owner = await member(createIdentity, 'recovery');
});

afterEach(async () => {
  for (const entryId of cleanup.splice(0)) {
    await api(`/upload-entries/${entryId}/cancel`, { token: owner.token, method: 'POST' });
  }
});

afterAll(async () => {
  await sql().end();
});

describe('P0.04-A1: recovery from lost dispatch and dead workers', () => {
  it('a job whose initial dispatch was dropped is completed by scheduled reconciliation', async () => {
    const { entryId } = await undispatchedJob();
    expect((await entryState(entryId)).job_state).toBe('queued');
    const summary = await runScheduler();
    expect(summary.dispatched).toBeGreaterThanOrEqual(1);
    const done = await waitFor(entryId, ['ready']);
    expect(done).toMatchObject({ job_state: 'succeeded', attempt_count: 1 });
  });

  it('after a worker dies mid-stage, a new lease completes and the predecessor cannot overwrite it', async () => {
    const { entryId, assetId, jobId } = await undispatchedJob();
    const first = (await harnessClaim(jobId)).job;
    expect((await entryState(entryId)).state).toBe('validating');

    // The first worker dies: no heartbeat, no completion. Its lease expires.
    await expireLease(jobId);
    await runScheduler();
    const waiting = await entryState(entryId);
    expect(waiting).toMatchObject({ job_state: 'retry_wait', state: 'uploaded' });
    await sql()`update private.jobs set next_run_at = now() where id = ${jobId}`;
    await runScheduler();
    const done = await waitFor(entryId, ['ready']);
    expect(done).toMatchObject({ job_state: 'succeeded', lease_generation: 2, attempt_count: 2 });

    // The predecessor wakes up: its heartbeat and completion are fenced.
    await fetch(first.output.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: fixtures.webp });
    const heartbeat = await internalCall(`/jobs/${jobId}/heartbeat`, first.capability, { schema_version: 1, lease_generation: 1 });
    expect(heartbeat.body.data.status).toBe('stale');
    const late = await internalCall(`/jobs/${jobId}/complete`, first.capability, {
      schema_version: 1,
      lease_generation: 1,
      outcome: 'ready',
      output: { width: 400, height: 200, byte_size: fixtures.webp.length, sha256: sha256(fixtures.webp) },
    });
    expect(late.body.data.status).toBe('stale');
    const originals = await sql()`select object_key from private.media_objects where asset_id = ${assetId} and role = 'original'`;
    expect(originals).toHaveLength(1);
    expect(originals[0]!.object_key).toMatch(/original-g2\.webp$/);
    const [{ n }] = await sql()`select count(*)::int as n from private.deletion_tasks where reason = 'stale_output' and object_key like ${`%${assetId}%g1.webp`}`;
    expect(n).toBe(1);
  });

  it('heartbeats renew the lease with a fresh capability until the stage deadline', async () => {
    const { jobId } = await undispatchedJob();
    const { job } = await harnessClaim(jobId);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const renewed = await internalCall(`/jobs/${jobId}/heartbeat`, job.capability, { schema_version: 1, lease_generation: 1 });
    expect(renewed.body.data.status).toBe('renewed');
    expect(Date.parse(renewed.body.data.lease_expires_at)).toBeGreaterThan(Date.parse(job.lease_expires_at));
    expect(renewed.body.data.capability).not.toBe(job.capability);
    await sql()`update private.jobs set claimed_at = now() - interval '301 seconds' where id = ${jobId}`;
    const late = await internalCall(`/jobs/${jobId}/heartbeat`, renewed.body.data.capability, { schema_version: 1, lease_generation: 1 });
    expect(late.body.data.status).toBe('deadline_exceeded');
  });
});

describe('P0.04-A2: duplicate delivery and scoped internal authority', () => {
  it('a duplicate wake-up cannot claim twice and a duplicate callback is a no-op', async () => {
    const { entryId, assetId, jobId } = await undispatchedJob();
    const { token, job } = await harnessClaim(jobId);
    const duplicateWake = await fetch(internal('/jobs/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, claim_token: token }),
    });
    expect(duplicateWake.status).toBe(403);

    const normalized = fixtures.webp;
    await fetch(job.output.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: normalized });
    const body = {
      schema_version: 1,
      lease_generation: 1,
      outcome: 'ready',
      output: { width: 400, height: 200, byte_size: normalized.length, sha256: sha256(normalized) },
    };
    expect((await internalCall(`/jobs/${jobId}/complete`, job.capability, body)).body.data.status).toBe('applied');
    expect((await internalCall(`/jobs/${jobId}/complete`, job.capability, body)).body.data.status).toBe('already_applied');
    expect((await entryState(entryId)).state).toBe('ready');
    const originals = await sql()`select 1 from private.media_objects where asset_id = ${assetId} and role = 'original'`;
    expect(originals).toHaveLength(1);
  });

  it('wrong job, stage, asset, expired capabilities and user JWTs are rejected', async () => {
    const { jobId, assetId } = await undispatchedJob();
    const other = await undispatchedJob();
    const { job } = await harnessClaim(jobId);
    const base = {
      job_id: jobId,
      user_id: owner.id,
      asset_id: assetId,
      stage: 'validate_upload',
      lease_generation: 1,
      output_key: `users/${owner.id}/assets/${assetId}/1/original-g1.webp`,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const beat = { schema_version: 1, lease_generation: 1 };
    // Control: a correctly formed capability is accepted.
    expect((await internalCall(`/jobs/${jobId}/heartbeat`, forgeCapability(base), beat)).status).toBe(200);
    for (const capability of [
      forgeCapability({ ...base, job_id: other.jobId }),
      forgeCapability({ ...base, stage: 'tag_item' }),
      forgeCapability({ ...base, exp: Math.floor(Date.now() / 1000) - 1 }),
      owner.token,
      `${job.capability.slice(0, -2)}xx`,
    ]) {
      expect((await internalCall(`/jobs/${jobId}/heartbeat`, capability, beat)).status).toBe(403);
    }
    // A capability naming another asset's key cannot publish into this job.
    const wrongAsset = forgeCapability({ ...base, output_key: `users/${owner.id}/assets/${other.assetId}/1/original-g1.webp` });
    await fetch(job.output.url.replace(assetId, other.assetId), { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: fixtures.webp });
    const hijack = await internalCall(`/jobs/${jobId}/complete`, wrongAsset, {
      schema_version: 1,
      lease_generation: 1,
      outcome: 'ready',
      output: { width: 400, height: 200, byte_size: fixtures.webp.length, sha256: sha256(fixtures.webp) },
    });
    expect(hijack.status).toBe(422);
    expect((await internalCall(`/jobs/${jobId}/complete`, job.capability, { schema_version: 1, lease_generation: 2, outcome: 'rejected', failure_code: 'CORRUPT_IMAGE' })).status).toBe(403);
  });
});

describe('P0.04-A3: cancellation, finite retries and storage failure', () => {
  it('a canceled job is not revived by its old worker', async () => {
    const { entryId, assetId, jobId } = await undispatchedJob();
    const { job } = await harnessClaim(jobId);
    await api(`/upload-entries/${entryId}/cancel`, { token: owner.token, method: 'POST' });
    await fetch(job.output.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: fixtures.webp });
    const late = await internalCall(`/jobs/${jobId}/complete`, job.capability, {
      schema_version: 1,
      lease_generation: 1,
      outcome: 'ready',
      output: { width: 400, height: 200, byte_size: fixtures.webp.length, sha256: sha256(fixtures.webp) },
    });
    expect(late.body.data.status).toBe('stale');
    expect(await entryState(entryId)).toMatchObject({ state: 'canceled', job_state: 'canceled' });
    await expireLease(jobId);
    await runScheduler();
    expect((await entryState(entryId)).job_state).toBe('canceled');
    expect(await sql()`select 1 from private.media_objects where asset_id = ${assetId} and role = 'original'`).toHaveLength(0);
  });

  it('three failed attempts end in a safe failure; manual retry is finite', async () => {
    const { entryId, jobId } = await undispatchedJob();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { job } = await harnessClaim(jobId);
      const failed = await internalCall(`/jobs/${jobId}/fail`, job.capability, {
        schema_version: 1,
        lease_generation: job.lease_generation,
        failure_code: 'TRANSIENT_STORAGE',
      });
      expect(failed.body.data.status).toBe(attempt < 3 ? 'retry_wait' : 'failed');
      await sql()`update private.jobs set next_run_at = now() where id = ${jobId} and state = 'retry_wait'`;
      await sql()`update private.jobs set state = 'queued' where id = ${jobId} and state = 'retry_wait'`;
    }
    const failedState = await entryState(entryId);
    expect(failedState).toMatchObject({ state: 'failed', failure_code: 'PROCESSING_FAILED', job_state: 'failed', attempt_count: 3 });
    const [{ issued }] = await sql()`select public.svc_issue_job_claim(${jobId}, ${'a'.repeat(64)}) as issued`;
    expect(issued).toBe(false);

    const status = await api(`/upload-entries/${entryId}/status`, { token: owner.token });
    expect(status.body.data).toMatchObject({ entry_state: 'failed', failure_code: 'PROCESSING_FAILED', can_retry: true });
    expect(JSON.stringify(status.body)).not.toMatch(/stack|lease|capability|object_key/i);

    // Manual retry runs the job again with the real worker.
    const retried = await api(`/upload-entries/${entryId}/retry`, { token: owner.token, method: 'POST' });
    expect(retried.status).toBe(202);
    const done = await waitFor(entryId, ['ready']);
    expect(done.manual_retries).toBe(1);
    const again = await api(`/upload-entries/${entryId}/retry`, { token: owner.token, method: 'POST' });
    expect(again.body.error.code).toBe('RETRY_NOT_AVAILABLE');
    await sql()`update private.jobs set manual_retries = 2 where id = ${jobId}`;
    await sql()`update public.upload_entries set state = 'failed', failure_code = 'PROCESSING_FAILED' where id = ${entryId}`;
    const exhausted = await api(`/upload-entries/${entryId}/retry`, { token: owner.token, method: 'POST' });
    expect(exhausted.body.error.code).toBe('RETRY_LIMIT_REACHED');
  });

  it('a storage outage during processing keeps the upload safe and processing resumes afterwards', async () => {
    const { entryId } = await undispatchedJob();
    execFileSync('docker', ['stop', 'bowr_storage']);
    try {
      await runScheduler();
      // The worker could not read the upload: the attempt is transient, not a file rejection.
      let row = await entryState(entryId);
      for (let i = 0; i < 60 && row.job_state !== 'retry_wait'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        row = await entryState(entryId);
      }
      expect(row).toMatchObject({ job_state: 'retry_wait', state: 'uploaded', failure_code: null, attempt_count: 1 });
    } finally {
      execFileSync('docker', ['start', 'bowr_storage']);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await sql()`update private.jobs set next_run_at = now() where id = (select j.id from private.jobs j join public.upload_entries e on e.asset_id = j.target_id where e.id = ${entryId}) and state = 'retry_wait'`;
    await runScheduler();
    const done = await waitFor(entryId, ['ready']);
    expect(done.attempt_count).toBe(2);
  });
});

describe('P0.04-A4: reopening a receipt does not create work', () => {
  it('reading entries and job status repeatedly leaves exactly one job', async () => {
    const { entryId, assetId } = await undispatchedJob();
    for (let i = 0; i < 3; i += 1) {
      await api(`/upload-entries/${entryId}/status`, { token: owner.token });
      await fetch(`${stack().API_URL}/rest/v1/upload_entries?select=id,state&id=eq.${entryId}`, {
        headers: { apikey: stack().ANON_KEY, Authorization: `Bearer ${owner.token}` },
      });
    }
    const [{ jobs }] = await sql()`select count(*)::int as jobs from private.jobs where target_id = ${assetId}`;
    expect(jobs).toBe(1);
  });
});
