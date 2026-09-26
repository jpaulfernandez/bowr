// P0.06 integration: suspension, fresh authentication, ownership transfer and
// recoverable account deletion against the real stack.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { accessToken, api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { createSlot, mediaFixtures, putSlot, sha256, storageAdmin } from '../../../tests/support/media';
import { admin, sql, stack } from '../../../tests/support/stack';

const storage = storageAdmin();

/** A fresh sign-in: a new Auth session whose authentication time is now. */
async function freshSession(email: string) {
  const { data } = await admin().auth.admin.generateLink({ type: 'magiclink', email });
  const client = createClient(stack().API_URL, stack().ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await client.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: data.properties.verification_type as 'magiclink',
  });
  return { client, token: verified.data.session!.access_token };
}

async function challenge(token: string, action: 'delete_account' | 'transfer_ownership') {
  const created = await api('/account/reauth-challenges', { token, method: 'POST', body: { action } });
  expect(created.status).toBe(201);
  return created.body.data.challenge_id as string;
}

const verify = (token: string, id: string) => api(`/account/reauth-challenges/${id}/verify`, { token, method: 'POST' });

/** Challenge in the current session, prove it with a new sign-in. */
async function proofFor(email: string, token: string, action: 'delete_account' | 'transfer_ownership') {
  const id = await challenge(token, action);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const fresh = await freshSession(email);
  const verified = await verify(fresh.token, id);
  expect(verified.status).toBe(200);
  return { proof: verified.body.data.proof as string, freshToken: fresh.token };
}

async function waitForReady(entryId: string) {
  for (let i = 0; i < 80; i += 1) {
    const [row] = await sql()`select state from public.upload_entries where id = ${entryId}`;
    if (row?.state === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('upload did not become ready');
}

afterAll(async () => {
  await sql().end();
});

describe('P0.06-A1: suspension and authority', () => {
  it('suspension blocks new table, API and media access immediately; restore brings it back', async () => {
    const owner = await createIdentity('susp-owner', { role: 'owner' });
    const ownerToken = await accessToken(owner.email);
    const member = await createIdentity('susp-member', { displayName: 'Sam Suspended' });
    const token = await accessToken(member.email);
    const fixtures = mediaFixtures();
    const { entry } = await createSlot(token, fixtures.png, 'image/png');
    await putSlot(entry, fixtures.png);
    await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' });
    await waitForReady(entry.entry_id);
    const grant = (await api('/media/access', { token, method: 'POST', body: { requests: [{ asset_id: entry.asset_id, variant: 'original' }] } })).body.data[0];

    const readOwn = async () =>
      (await fetch(`${stack().API_URL}/rest/v1/profiles?select=display_name`, {
        headers: { apikey: stack().ANON_KEY, Authorization: `Bearer ${token}` },
      }).then((r) => r.json())) as unknown[];
    expect(await readOwn()).toHaveLength(1);

    expect((await api(`/admin/members/${member.id}/suspend`, { token: ownerToken, method: 'POST' })).body.data.state).toBe('suspended');
    expect(await readOwn()).toHaveLength(0);
    expect((await api('/media/access', { token, method: 'POST', body: { requests: [{ asset_id: entry.asset_id, variant: 'original' }] } })).status).toBe(403);
    expect((await api('/bootstrap', { token })).body.data.membership.state).toBe('suspended');
    // An already issued link is not recalled; it only lasts until its short expiry.
    expect((await fetch(grant.url)).status).toBe(200);
    expect(Date.parse(grant.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);

    expect((await api(`/admin/members/${owner.id}/suspend`, { token: ownerToken, method: 'POST' })).body.error.code).toBe('CANNOT_SUSPEND_OWNER');
    // A nonowner gets the same response as for an absent object.
    expect((await api(`/admin/members/${owner.id}/suspend`, { token, method: 'POST' })).status).toBe(404);
    expect((await api(`/admin/members/${member.id}/restore`, { token: ownerToken, method: 'POST' })).body.data.state).toBe('active');
    expect(await readOwn()).toHaveLength(1);
  });

  it('the owner overview exposes aggregates only, and profile edits cannot change authority', async () => {
    const owner = await createIdentity('agg-owner', { role: 'owner' });
    const overview = await api('/admin/overview', { token: await accessToken(owner.email) });
    const text = JSON.stringify(overview.body.data);
    expect(text).not.toMatch(/asset|upload|object_key|email|city|timezone/i);
    const member = await createIdentity('authority');
    const token = await accessToken(member.email);
    const { error } = await createClient(stack().API_URL, stack().ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    }).rpc('update_profile', { p_request_id: randomUUID(), p_expected_revision: 1, p_patch: { role: 'owner' } });
    expect(error?.message).toBe('VALIDATION_FAILED');
  });
});

describe('P0.06-A2: fresh authentication proofs', () => {
  it('only a new sign-in after the challenge proves fresh authentication; proofs are single-use and bound', async () => {
    const member = await createIdentity('reauth');
    const first = await freshSession(member.email);
    const id = await challenge(first.token, 'delete_account');

    // The same session, even with a refreshed access token, cannot verify it.
    expect((await verify(first.token, id)).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const refreshed = await first.client.auth.refreshSession();
    expect((await verify(refreshed.data.session!.access_token, id)).status).toBe(403);
    // A sign-in that happened before the challenge cannot verify it either.
    const earlier = await freshSession(member.email);
    const lateChallenge = await challenge(first.token, 'delete_account');
    expect((await verify(earlier.token, lateChallenge)).status).toBe(403);

    // A new sign-in after the challenge can, once.
    const fresh = await freshSession(member.email);
    const ok = await verify(fresh.token, id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.proof).toMatch(/^[0-9a-f]{64}$/);
    expect((await verify(fresh.token, id)).status).toBe(403);

    // Wrong user and wrong action are refused; the proof is not consumed by them.
    const other = await createIdentity('reauth-other');
    const otherToken = await accessToken(other.email);
    expect((await api('/account', { token: otherToken, method: 'DELETE', body: { proof: ok.body.data.proof } })).status).toBe(403);
    const owner = await createIdentity('reauth-owner', { role: 'owner' });
    expect((await api('/admin/ownership-transfer', {
      token: await accessToken(owner.email),
      method: 'POST',
      body: { recipient_user_id: member.id, proof: ok.body.data.proof },
    })).status).toBe(403);

    // An expired proof fails; a guessed proof fails.
    await sql()`update private.reauth_challenges set expires_at = now() - interval '1 second' where id = ${id}`;
    expect((await api('/account', { token: fresh.token, method: 'DELETE', body: { proof: ok.body.data.proof } })).status).toBe(403);
    expect((await api('/account', { token: fresh.token, method: 'DELETE', body: { proof: randomBytes(32).toString('hex') } })).status).toBe(403);
    const [{ state }] = await sql()`select state from private.memberships where user_id = ${member.id}`;
    expect(state).toBe('active');
  });

  it('ownership transfer is atomic and concurrent transfers cannot create two owners', async () => {
    const owner = await createIdentity('xfer-owner', { role: 'owner' });
    const ownerToken = await accessToken(owner.email);
    const [x, y] = [await createIdentity('xfer-x'), await createIdentity('xfer-y')];
    const proofX = await proofFor(owner.email, ownerToken, 'transfer_ownership');
    const proofY = await proofFor(owner.email, ownerToken, 'transfer_ownership');
    const results = await Promise.all([
      api('/admin/ownership-transfer', { token: proofX.freshToken, method: 'POST', body: { recipient_user_id: x.id, proof: proofX.proof } }),
      api('/admin/ownership-transfer', { token: proofY.freshToken, method: 'POST', body: { recipient_user_id: y.id, proof: proofY.proof } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const owners = await sql()`select user_id from private.memberships where role = 'owner'`;
    expect(owners).toHaveLength(1);
    expect([x.id, y.id]).toContain(owners[0]!.user_id);
    const [{ role }] = await sql()`select role from private.memberships where user_id = ${owner.id}`;
    expect(role).toBe('member');
    const [{ audited }] = await sql()`select count(*)::int as audited from private.audit_events where action = 'ownership_transferred' and actor_id = ${owner.id}`;
    expect(audited).toBe(1);
  });
});

describe('P0.06-A3: owner deletion rules', () => {
  it('the sole owner with active friends must transfer first; without them the owner can delete', async () => {
    const owner = await createIdentity('last-owner', { role: 'owner' });
    const token = await accessToken(owner.email);
    const friend = await createIdentity('friend-survives', { displayName: 'Faye Friend' });
    const blocked = await proofFor(owner.email, token, 'delete_account');
    const refused = await api('/account', { token: blocked.freshToken, method: 'DELETE', body: { proof: blocked.proof } });
    expect(refused.body.error.code).toBe('OWNER_TRANSFER_REQUIRED');

    // Without other active members the owner may delete; everyone else is kept.
    const others = await sql()`update private.memberships set state = 'suspended', suspended_at = now()
      where state = 'active' and user_id <> ${owner.id} returning user_id`;
    try {
      const allowed = await proofFor(owner.email, token, 'delete_account');
      const deleted = await api('/account', { token: allowed.freshToken, method: 'DELETE', body: { proof: allowed.proof } });
      expect(deleted.status).toBe(202);
      expect(await sql()`select 1 from private.memberships where role = 'owner' and state = 'active'`).toHaveLength(0);
    } finally {
      await sql()`update private.memberships set state = 'active', suspended_at = null where user_id = any(${others.map((o) => o.user_id)}::uuid[])`;
    }
    await maintenance('account_deletion');
    for (let i = 0; i < 40 && (await sql()`select 1 from auth.users where id = ${owner.id}`).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await sql()`select 1 from auth.users where id = ${owner.id}`).toHaveLength(0);
    expect(await sql()`select 1 from auth.users where id = ${friend.id}`).toHaveLength(1);
    // The installation now needs an explicit operator bootstrap.
    const [{ r }] = await sql()`select private.bootstrap_owner(${friend.id}) as r`;
    expect(r.role).toBe('owner');
  });
});

describe('P0.06-A4: recoverable deletion', () => {
  it('a storage failure halfway keeps access denied and the manifest; retry completes; late jobs cannot recreate data', async () => {
    const member = await createIdentity('deleting', { displayName: 'Dee Leting' });
    const token = await accessToken(member.email);
    const fixtures = mediaFixtures();
    const { entry } = await createSlot(token, fixtures.png, 'image/png');
    await putSlot(entry, fixtures.png);
    await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' });
    await waitForReady(entry.entry_id);
    const objects = await sql()`select object_key from private.media_objects where asset_id = ${entry.asset_id} and deleted_at is null`;
    expect(objects.length).toBeGreaterThan(0);

    // A second upload is mid-processing under a harness "worker" when deletion starts.
    const late = await createSlot(token, fixtures.png, 'image/png');
    await putSlot(late.entry, fixtures.png);
    const [queued] = await sql()`select public.svc_complete_upload_entry(${member.id}, ${randomUUID()}, ${late.entry.entry_id}, ${fixtures.png.length}) as r`;
    const claimToken = randomBytes(32).toString('hex');
    await sql()`select public.svc_issue_job_claim(${queued!.r.job_id}, ${sha256(Buffer.from(claimToken))})`;
    const claimed = await fetch(`${stack().API_URL}/functions/v1/internal/v1/jobs/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: queued!.r.job_id, claim_token: claimToken }),
    }).then((r) => r.json() as Promise<any>);

    execFileSync('docker', ['stop', 'bowr_storage']);
    let statusToken = '';
    try {
      const { proof, freshToken } = await proofFor(member.email, token, 'delete_account');
      const started = await api('/account', { token: freshToken, method: 'DELETE', body: { proof } });
      expect(started.status).toBe(202);
      statusToken = started.body.data.status_token;
      await maintenance('account_deletion');

      const status = await fetch(`${stack().API_URL}/functions/v1/api/v1/account/deletion-status`, {
        headers: { 'X-Deletion-Status': statusToken },
      }).then((r) => r.json() as Promise<any>);
      expect(status.data.state).toBe('objects_pending');
      expect(status.data.objects_remaining).toBeGreaterThan(0);
      expect(Object.keys(status.data).sort()).toEqual(['completed_at', 'objects_remaining', 'started_at', 'state']);
      expect(JSON.stringify(status)).not.toMatch(/Dee|deleting-|@example|user_id|object_key|upload/);
      // Access is denied for every session of the account.
      expect((await api('/bootstrap', { token })).status).not.toBe(200);
      expect((await api('/bootstrap', { token: freshToken })).status).not.toBe(200);
      expect(await sql()`select 1 from auth.users where id = ${member.id}`).toHaveLength(1);
      expect(await sql()`select 1 from public.media_assets where user_id = ${member.id}`).toHaveLength(0);

      // The old worker finishes: nothing is attached for a deleting account.
      const lateResult = await fetch(`${stack().API_URL}/functions/v1/internal/v1/jobs/${queued!.r.job_id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${claimed.data.capability}` },
        body: JSON.stringify({ schema_version: 1, lease_generation: 1, outcome: 'rejected', failure_code: 'CORRUPT_IMAGE' }),
      }).then((r) => r.json() as Promise<any>);
      expect(lateResult.data?.status ?? lateResult.error?.code).not.toBe('applied');
    } finally {
      execFileSync('docker', ['start', 'bowr_storage']);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Retry: the manifest survived, so the retry deletes every object, then the identity.
    await sql()`update private.deletion_tasks set not_before = now() where user_id = ${member.id} and state = 'pending'`;
    const retry = await maintenance('account_deletion');
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    for (const object of objects) expect(await storage.exists(object.object_key)).toBe(false);
    expect(await sql()`select 1 from auth.users where id = ${member.id}`).toHaveLength(0);
    const done = await fetch(`${stack().API_URL}/functions/v1/api/v1/account/deletion-status`, {
      headers: { 'X-Deletion-Status': statusToken },
    }).then((r) => r.json() as Promise<any>);
    expect(done.data).toMatchObject({ state: 'complete', objects_remaining: 0 });
    expect((await fetch(`${stack().API_URL}/functions/v1/api/v1/account/deletion-status`, {
      headers: { 'X-Deletion-Status': randomBytes(32).toString('hex') },
    })).status).toBe(404);
  });
});
