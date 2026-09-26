// P0.03 integration: private upload, validation and signed access against the
// real local database, Edge API, object store and worker.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { createSlot, mediaFixtures, member, putSlot, sha256, storageAdmin, type Member } from '../../../tests/support/media';
import { sql, stack } from '../../../tests/support/stack';

let fixtures: ReturnType<typeof mediaFixtures>;
let a: Member;
let b: Member;
const storage = storageAdmin();
const internal = (path: string) => `${stack().API_URL}/functions/v1/internal/v1${path}`;

async function waitForEntry(entryId: string, states = ['ready', 'rejected']) {
  for (let i = 0; i < 60; i += 1) {
    const [row] = await sql()`select state, failure_code, asset_id from public.upload_entries where id = ${entryId}`;
    if (row && states.includes(row.state)) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`entry ${entryId} did not reach ${states.join('/')}`);
}

async function uploadAndValidate(owner: Member, bytes: Buffer, contentType: string) {
  const { entry } = await createSlot(owner.token, bytes, contentType);
  expect((await putSlot(entry, bytes)).status).toBe(200);
  const completed = await api(`/upload-entries/${entry.entry_id}/complete`, { token: owner.token, method: 'POST' });
  expect(completed.status).toBe(202);
  return { entry, completed, row: await waitForEntry(entry.entry_id) };
}

async function objectKeys(assetId: string) {
  return sql()`select object_key, role, deleted_at from private.media_objects where asset_id = ${assetId} order by id`;
}

async function access(owner: { token: string }, assetId: string, variant = 'original') {
  return api('/media/access', { token: owner.token, method: 'POST', body: { requests: [{ asset_id: assetId, variant }] } });
}

/** Makes these tasks due now and runs the deletion task, as the five-minute schedule would. */
async function runDeletionsFor(keys: string[], reasons?: string[]) {
  await sql()`
    update private.deletion_tasks set not_before = now()
     where object_key = any(${keys}) and state = 'pending'
       and (${reasons ?? null}::text[] is null or reason = any(${reasons ?? null}::text[]))`;
  expect((await maintenance('media_deletion')).status).toBe(200);
}

beforeAll(async () => {
  fixtures = mediaFixtures();
  a = await member(createIdentity, 'upload-a');
  b = await member(createIdentity, 'upload-b');
});

afterAll(async () => {
  await sql().end();
});

describe('P0.03-A1: formats through the deployed path', () => {
  it.each([
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['heic', 'image/heic'],
  ] as const)('%s becomes a sanitized WebP original', async (name, type) => {
    const { row } = await uploadAndValidate(a, fixtures[name], type);
    expect(row.state).toBe('ready');
    const [asset] = await sql()`select width, height, content_type, retention from public.media_assets where id = ${row.asset_id}`;
    expect(asset).toMatchObject({ width: 400, height: 200, content_type: 'image/webp', retention: 'retained' });
  });

  it('applies EXIF orientation and serves bytes without metadata', async () => {
    const { row } = await uploadAndValidate(a, fixtures.jpegOriented, 'image/jpeg');
    const [asset] = await sql()`select width, height, sha256 from public.media_assets where id = ${row.asset_id}`;
    expect([asset!.width, asset!.height]).toEqual([200, 400]);
    const grant = (await access(a, row.asset_id)).body.data[0];
    const response = await fetch(grant.url);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(sha256(bytes)).toBe(asset!.sha256);
    expect(bytes.includes(Buffer.from('FixtureCam'))).toBe(false);
    expect(bytes.includes(Buffer.from('EXIF'))).toBe(false);
  });

  it('rejects spoofed, animated and oversized uploads without publishing an asset', async () => {
    const spoofed = await uploadAndValidate(a, fixtures.png, 'image/jpeg');
    expect(spoofed.row).toMatchObject({ state: 'rejected', failure_code: 'MEDIA_TYPE_MISMATCH' });
    const moving = await uploadAndValidate(a, fixtures.animatedWebp, 'image/webp');
    expect(moving.row).toMatchObject({ state: 'rejected', failure_code: 'ANIMATED_IMAGE' });
    for (const rejected of [spoofed, moving]) {
      expect((await objectKeys(rejected.row.asset_id)).filter((o) => o.role === 'original')).toHaveLength(0);
      expect((await access(a, rejected.row.asset_id)).body.data[0].status).toBe('not_found');
    }

    const declaredTooLarge = await api('/upload-batches', {
      token: a.token,
      method: 'POST',
      body: { files: [{ client_file_id: randomUUID(), purpose: 'garment', content_type: 'image/png', byte_size: 20 * 1024 * 1024 + 1 }] },
    });
    expect(declaredTooLarge.status).toBe(413);

    // A slot declared small but uploaded large is rejected from the stored size.
    const big = randomBytes(20 * 1024 * 1024 + 1);
    const { entry } = await createSlot(a.token, fixtures.png, 'image/png');
    expect((await putSlot(entry, big)).status).toBe(200);
    const completed = await api(`/upload-entries/${entry.entry_id}/complete`, { token: a.token, method: 'POST' });
    expect(completed.body.data).toMatchObject({ state: 'rejected', failure_code: 'FILE_TOO_LARGE', job_id: null });
  });

  it('refuses unsupported declared types before signing', async () => {
    for (const type of ['image/svg+xml', 'image/gif', 'text/html']) {
      const response = await api('/upload-batches', {
        token: a.token,
        method: 'POST',
        body: { files: [{ client_file_id: randomUUID(), purpose: 'garment', content_type: type, byte_size: 100 }] },
      });
      expect(response.status).toBe(415);
    }
  });
});

describe('P0.03-A2: replay and cancellation', () => {
  it('replaying a still-valid PUT after normalization does not change the viewed bytes', async () => {
    const { entry, row } = await uploadAndValidate(a, fixtures.png, 'image/png');
    const [asset] = await sql()`select sha256 from public.media_assets where id = ${row.asset_id}`;
    const quarantine = (await objectKeys(row.asset_id)).find((o) => o.role === 'quarantine')!.object_key;

    // The signed PUT is still valid: an attacker or retry rewrites the quarantine key.
    expect((await putSlot(entry, fixtures.heic)).status).toBe(200);
    expect(await storage.exists(quarantine)).toBe(true);

    const grant = (await access(a, row.asset_id)).body.data[0];
    expect(sha256(Buffer.from(await (await fetch(grant.url)).arrayBuffer()))).toBe(asset!.sha256);

    // The post-expiry recheck removes the recreated quarantine object.
    await runDeletionsFor([quarantine]);
    expect(await storage.exists(quarantine)).toBe(false);
    const [task] = await sql()`select state from private.deletion_tasks where object_key = ${quarantine} and reason = 'quarantine_recheck'`;
    expect(task!.state).toBe('done');
  });

  it('cancel refuses access and removes a quarantine object recreated by replay', async () => {
    const { entry } = await createSlot(a.token, fixtures.png, 'image/png');
    expect((await putSlot(entry, fixtures.png)).status).toBe(200);
    const canceled = await api(`/upload-entries/${entry.entry_id}/cancel`, { token: a.token, method: 'POST' });
    expect(canceled.body.data.state).toBe('canceled');
    const completeAfter = await api(`/upload-entries/${entry.entry_id}/complete`, { token: a.token, method: 'POST' });
    expect(completeAfter.body.error.code).toBe('UPLOAD_CANCELED');
    expect((await access(a, entry.asset_id)).body.data[0].status).toBe('not_found');

    const quarantine = (await objectKeys(entry.asset_id))[0]!.object_key;
    await runDeletionsFor([quarantine], ['upload_canceled']);
    expect(await storage.exists(quarantine)).toBe(false);

    // Replay after cancel recreates the object until the URL expires ...
    expect((await putSlot(entry, fixtures.png)).status).toBe(200);
    expect(await storage.exists(quarantine)).toBe(true);
    // ... and the recheck scheduled after upload expiry removes it again.
    const [recheck] = await sql()`
      select state, not_before, (select upload_expires_at from public.upload_entries where id = ${entry.entry_id}) as expires
      from private.deletion_tasks where object_key = ${quarantine} and reason = 'quarantine_recheck'`;
    expect(recheck!.state).toBe('pending');
    expect(new Date(recheck!.not_before).getTime()).toBeGreaterThan(new Date(recheck!.expires).getTime());
    await runDeletionsFor([quarantine], ['quarantine_recheck']);
    expect(await storage.exists(quarantine)).toBe(false);
    const [asset] = await sql()`select state from public.media_assets where id = ${entry.asset_id}`;
    expect(asset!.state).toBe('deleted');
  });
});

describe('P0.03-A3: unauthorized identities cannot reach private media', () => {
  it('B, pending and suspended identities cannot sign or act on A’s asset', async () => {
    const { entry, row } = await uploadAndValidate(a, fixtures.png, 'image/png');
    expect((await access(b, row.asset_id)).body.data[0]).toEqual({ asset_id: row.asset_id, variant: 'original', status: 'not_found' });
    for (const path of ['complete', 'renew', 'cancel']) {
      const response = await api(`/upload-entries/${entry.entry_id}/${path}`, { token: b.token, method: 'POST' });
      expect(response.status).toBe(404);
    }
    const pending = await createIdentity('upload-pending', { state: 'pending' });
    const suspended = await createIdentity('upload-suspended', { state: 'suspended' });
    for (const identity of [pending, suspended]) {
      const token = (await member(async () => identity, 'x')).token;
      expect((await access({ token }, row.asset_id)).status).toBe(403);
      expect((await api('/upload-batches', { token, method: 'POST', body: { files: [] } })).status).toBeGreaterThanOrEqual(403);
    }
  });

  it('only the original variant of a ready asset can be signed, and keys never leave the server', async () => {
    const { row } = await uploadAndValidate(a, fixtures.png, 'image/png');
    for (const variant of ['cutout', 'thumbnail', 'quarantine', '../original', '']) {
      expect((await access(a, row.asset_id, variant)).body.data[0].status).toBe('not_found');
    }
    // Keys appear only inside signed URLs the server chose; no field names or accepts them.
    const batch = await createSlot(a.token, fixtures.png, 'image/png');
    expect(JSON.stringify(batch.raw.body)).not.toMatch(/object_key|"bucket"/);
    expect(new URL(batch.entry.upload.url).pathname).toMatch(new RegExp(`/uploads/${a.id}/${batch.entry.entry_id}/[0-9a-f]{32}$`));
    const withKey = await api('/upload-batches', {
      token: a.token,
      method: 'POST',
      body: { files: [{ client_file_id: randomUUID(), purpose: 'garment', content_type: 'image/png', byte_size: 10, object_key: 'users/x' }] },
    });
    expect(withKey.status).toBe(422);
    const grant = await access(a, row.asset_id);
    expect(JSON.stringify(grant.body.data[0])).not.toMatch(/object_key/);
    // Clients cannot read object keys or other members' media rows through the Data API.
    const rest = await fetch(`${stack().API_URL}/rest/v1/media_assets?select=id&id=eq.${row.asset_id}`, {
      headers: { apikey: stack().ANON_KEY, Authorization: `Bearer ${b.token}` },
    });
    expect(await rest.json()).toEqual([]);
  });

  it('expired or suspended access is refreshed only after fresh authorization', async () => {
    const owner = await member(createIdentity, 'expiring');
    const { row } = await uploadAndValidate(owner, fixtures.png, 'image/png');
    // A temporary asset clips its signed URL to its own expiry.
    await sql()`update public.media_assets set retention = 'temporary', expires_at = now() + interval '3 seconds' where id = ${row.asset_id}`;
    const grant = (await access(owner, row.asset_id)).body.data[0];
    expect(Date.parse(grant.expires_at) - Date.now()).toBeLessThan(4000);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect((await fetch(grant.url)).status).toBe(403);
    expect((await access(owner, row.asset_id)).body.data[0].status).toBe('not_found');

    await sql()`update public.media_assets set retention = 'retained', expires_at = null where id = ${row.asset_id}`;
    expect((await access(owner, row.asset_id)).body.data[0].status).toBe('ok');
    await sql()`update private.memberships set state = 'suspended', suspended_at = now() where user_id = ${owner.id}`;
    expect((await access(owner, row.asset_id)).status).toBe(403);
  });
});

describe('P0.03-A4: request identity and truthful status', () => {
  it('a repeated completion returns the same entry; changed input under the same key conflicts', async () => {
    const { entry } = await createSlot(a.token, fixtures.png, 'image/png');
    await putSlot(entry, fixtures.png);
    const key = randomUUID();
    const first = await api(`/upload-entries/${entry.entry_id}/complete`, { token: a.token, method: 'POST', key });
    const lostResponseRetry = await api(`/upload-entries/${entry.entry_id}/complete`, { token: a.token, method: 'POST', key });
    expect(lostResponseRetry.body.data).toEqual(first.body.data);
    const other = await createSlot(a.token, fixtures.png, 'image/png');
    const conflict = await api(`/upload-entries/${other.entry.entry_id}/complete`, { token: a.token, method: 'POST', key });
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const [{ jobs }] = await sql()`select count(*)::int as jobs from private.jobs where target_id = ${entry.asset_id}`;
    expect(jobs).toBe(1);
  });

  it('a repeated batch request returns the same batch; changed files conflict', async () => {
    const key = randomUUID();
    const files = [{ client_file_id: randomUUID(), purpose: 'garment', content_type: 'image/png', byte_size: 10 }];
    const first = await api('/upload-batches', { token: a.token, method: 'POST', key, body: { files } });
    const retry = await api('/upload-batches', { token: a.token, method: 'POST', key, body: { files } });
    expect(retry.status).toBe(200);
    expect(retry.body.data.batch_id).toBe(first.body.data.batch_id);
    expect(retry.body.data.entries[0].entry_id).toBe(first.body.data.entries[0].entry_id);
    const changed = await api('/upload-batches', {
      token: a.token,
      method: 'POST',
      key,
      body: { files: [{ ...files[0], byte_size: 11 }] },
    });
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('HTTP upload success alone is not validated or signable', async () => {
    const { entry } = await createSlot(a.token, fixtures.png, 'image/png');
    expect((await putSlot(entry, fixtures.png)).status).toBe(200);
    const [row] = await sql()`select state from public.upload_entries where id = ${entry.entry_id}`;
    expect(row!.state).toBe('awaiting_upload');
    expect((await access(a, entry.asset_id)).body.data[0].status).toBe('not_found');
    const completed = await api(`/upload-entries/${entry.entry_id}/complete`, { token: a.token, method: 'POST' });
    expect(completed.body.data.state).toBe('uploaded');
    expect(completed.body.data.job_id).toMatch(/^[0-9a-f-]{36}$/);
    // Without the object, completion is refused.
    const missing = await createSlot(a.token, fixtures.png, 'image/png');
    const refused = await api(`/upload-entries/${missing.entry.entry_id}/complete`, { token: a.token, method: 'POST' });
    expect(refused.body.error.code).toBe('UPLOAD_MISSING');
  });
});

describe('P0.03-T3: authenticated, scoped worker API', () => {
  const harnessEntries: string[] = [];
  // Jobs claimed by the test harness never finish; cancel them so they do not
  // hold processing slots for later tests.
  afterEach(async () => {
    for (const entryId of harnessEntries.splice(0)) {
      await api(`/upload-entries/${entryId}/cancel`, { token: a.token, method: 'POST' });
    }
  });

  /** Queues a validation job without dispatching the running worker. */
  async function queuedJob(owner: Member): Promise<{ jobId: string; entryId: string }> {
    const { entry } = await createSlot(owner.token, fixtures.png, 'image/png');
    harnessEntries.push(entry.entry_id);
    await putSlot(entry, fixtures.png);
    const [row] = await sql()`select public.svc_complete_upload_entry(${owner.id}, ${randomUUID()}, ${entry.entry_id}, ${fixtures.png.length}) as r`;
    return { jobId: row!.r.job_id, entryId: entry.entry_id };
  }

  async function claim(jobId: string, token?: string) {
    const claimToken = token ?? randomBytes(32).toString('hex');
    if (!token) await sql()`select public.svc_issue_job_claim(${jobId}, ${sha256(Buffer.from(claimToken))})`;
    const response = await fetch(internal('/jobs/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, claim_token: claimToken }),
    });
    return { status: response.status, body: (await response.json()) as any, claimToken };
  }

  it('a claim token works once; wrong tokens and user JWTs are refused', async () => {
    const { jobId } = await queuedJob(a);
    expect((await claim(jobId, 'f'.repeat(64))).status).toBe(403);
    const first = await claim(jobId);
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).not.toMatch(/"object_key"|"bucket"/);
    expect((await claim(jobId, first.claimToken)).status).toBe(403);

    const complete = (auth: string, id = jobId) =>
      fetch(internal(`/jobs/${id}/complete`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ schema_version: 1, lease_generation: 1, outcome: 'rejected', failure_code: 'CORRUPT_IMAGE' }),
      });
    expect((await complete(a.token)).status).toBe(403);
    const other = await queuedJob(a);
    expect((await complete(first.body.data.capability, other.jobId)).status).toBe(403);
    expect((await complete(`${first.body.data.capability}x`)).status).toBe(403);
  });

  it('a fabricated output that does not match the uploaded object is not published', async () => {
    const { jobId, entryId } = await queuedJob(a);
    const claimed = (await claim(jobId)).body.data;
    await fetch(claimed.output.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: fixtures.webp });
    const response = await fetch(internal(`/jobs/${jobId}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${claimed.capability}` },
      body: JSON.stringify({
        schema_version: 1,
        lease_generation: claimed.lease_generation,
        outcome: 'ready',
        output: { width: 400, height: 200, byte_size: fixtures.webp.length, sha256: '0'.repeat(64) },
      }),
    });
    expect(response.status).toBe(422);
    const [row] = await sql()`select state from public.upload_entries where id = ${entryId}`;
    expect(row!.state).toBe('validating');
  });

  it('a result for a canceled entry is fenced and its output queued for deletion', async () => {
    const { jobId, entryId } = await queuedJob(a);
    const claimed = (await claim(jobId)).body.data;
    await api(`/upload-entries/${entryId}/cancel`, { token: a.token, method: 'POST' });
    await fetch(claimed.output.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: fixtures.webp });
    const response = await fetch(internal(`/jobs/${jobId}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${claimed.capability}` },
      body: JSON.stringify({
        schema_version: 1,
        lease_generation: claimed.lease_generation,
        outcome: 'ready',
        output: { width: 400, height: 200, byte_size: fixtures.webp.length, sha256: sha256(fixtures.webp) },
      }),
    });
    expect((await response.json()).data.status).toBe('stale');
    const [entry] = await sql()`select state, asset_id from public.upload_entries where id = ${entryId}`;
    expect(entry!.state).toBe('canceled');
    expect((await objectKeys(entry!.asset_id)).filter((o) => o.role === 'original')).toHaveLength(0);
    const [task] = await sql()`select count(*)::int as n from private.deletion_tasks where reason = 'stale_output' and object_key like ${`%${entry!.asset_id}%`}`;
    expect(task!.n).toBeGreaterThan(0);
  });
});
