// P0.02 integration: concurrent redemption, throttling and cleanup races against
// the real local database and Edge API. Each race uses independent connections.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, api, maintenance } from '../../../tests/support/api';
import { createIdentity, type Identity } from '../../../tests/support/identities';
import { connection, sql } from '../../../tests/support/stack';

let owner: Identity;
let ownerToken: string;

async function createInvite(note: string | null = null): Promise<{ id: string; code: string }> {
  const created = await api('/admin/invites', { token: ownerToken, method: 'POST', body: { note } });
  expect(created.status).toBe(201);
  return { id: created.body.data.invite_id, code: created.body.data.code };
}

async function pending(label: string, ageHours = 0): Promise<Identity & { token: string }> {
  const identity = await createIdentity(label, { state: 'pending' });
  if (ageHours > 0) {
    await sql()`update private.memberships set created_at = now() - make_interval(hours => ${ageHours}) where user_id = ${identity.id}`;
  }
  return { ...identity, token: await accessToken(identity.email) };
}

/** Waits until another backend is blocked on a lock held by an open transaction. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const [row] = await sql()`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock'`;
    if (row!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No backend reached a lock wait');
}

beforeAll(async () => {
  owner = await createIdentity('owner', { role: 'owner', displayName: 'Olive Owner' });
  ownerToken = await accessToken(owner.email);
});

// All local requests share one client IP; isolate cases from the per-IP throttle.
beforeEach(async () => {
  await sql()`delete from private.rate_limit_buckets where scope = 'invite_redeem_ip'`;
});

afterAll(async () => {
  await sql().end();
});

describe('P0.02-A1: one code admits exactly one account', () => {
  it('parallel HTTP redemptions by five accounts admit exactly one and use the code once', async () => {
    const invite = await createInvite();
    const accounts = await Promise.all([1, 2, 3, 4, 5].map((n) => pending(`race${n}`)));
    const results = await Promise.all(
      accounts.map((account) => api('/invites/redeem', { token: account.token, method: 'POST', body: { code: invite.code } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422, 422, 422]);
    const [{ uses }] = await sql()`select uses from private.invite_codes where id = ${invite.id}`;
    expect(uses).toBe(1);
    const [{ admitted }] = await sql()`
      select count(*)::int as admitted from private.memberships
      where user_id = any(${accounts.map((a) => a.id)}::uuid[]) and state = 'active'`;
    expect(admitted).toBe(1);

    // Retrying the winner's request returns the same membership without another use.
    const winner = accounts[results.findIndex((r) => r.status === 200)]!;
    const retry = await api('/invites/redeem', { token: winner.token, method: 'POST', body: { code: invite.code } });
    expect(retry.status).toBe(200);
    expect(retry.body.data.membership.joined_at).toBe(results.find((r) => r.status === 200)!.body.data.membership.joined_at);
    const [{ uses: after }] = await sql()`select uses from private.invite_codes where id = ${invite.id}`;
    expect(after).toBe(1);
  });

  it('a second redemption waits on the invite lock and then finds the code used', async () => {
    const invite = await createInvite();
    const digest = (await sql()`select code_digest from private.invite_codes where id = ${invite.id}`)[0]!.code_digest;
    const [first, second] = [await pending('lockA'), await pending('lockB')];
    const a = connection();
    const b = connection();
    try {
      let releaseFirst!: () => void;
      const firstCommitted = a.begin(async (tx) => {
        const [row] = await tx`select public.svc_redeem_invite(${first.id}, ${digest}, null) as r`;
        expect(row!.r.outcome).toBe('admitted');
        await new Promise<void>((resolve) => (releaseFirst = resolve));
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      // postgres.js queries are lazy; .then() starts this one now.
      const secondResult = b`select public.svc_redeem_invite(${second.id}, ${digest}, null) as r`.then((rows) => rows);
      await waitForLockWait();
      releaseFirst();
      await firstCommitted;
      const [row] = await secondResult;
      expect(row!.r).toEqual({ outcome: 'unavailable' });
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('expired, revoked and exhausted codes fail identically without disclosing notes', async () => {
    const account = await pending('generic');
    const exhausted = await createInvite('Exhausted note');
    const winner = await pending('winner');
    expect((await api('/invites/redeem', { token: winner.token, method: 'POST', body: { code: exhausted.code } })).status).toBe(200);
    const revoked = await createInvite('Revoked note');
    expect((await api(`/admin/invites/${revoked.id}/revoke`, { token: ownerToken, method: 'POST' })).status).toBe(200);
    const expired = await createInvite('Expired note');
    await sql()`update private.invite_codes set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = ${expired.id}`;

    const failures = [];
    for (const code of [exhausted.code, revoked.code, expired.code, 'NOT-A-REAL-CODE']) {
      failures.push(await api('/invites/redeem', { token: account.token, method: 'POST', body: { code } }));
    }
    for (const failure of failures) {
      expect(failure.status).toBe(422);
      expect(failure.body.error).toEqual(failures[0]!.body.error);
      expect(JSON.stringify(failure.body)).not.toMatch(/note/i);
    }
  });
});

describe('P0.02-A2: throttling and cleanup races', () => {
  it('the first five attempts are evaluated and the sixth is throttled with a retry time', async () => {
    const account = await pending('throttle');
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await api('/invites/redeem', { token: account.token, method: 'POST', body: { code: `WRONG-${i}` } })).status);
    }
    expect(statuses).toEqual([422, 422, 422, 422, 422]);
    const sixth = await api('/invites/redeem', { token: account.token, method: 'POST', body: { code: 'WRONG-6' } });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(sixth.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(3000);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    // A valid code is still refused inside the window.
    const invite = await createInvite();
    expect((await api('/invites/redeem', { token: account.token, method: 'POST', body: { code: invite.code } })).status).toBe(429);
  });

  it('parallel attempts cannot bypass the per-account counter', async () => {
    const account = await pending('parallel');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api('/invites/redeem', { token: account.token, method: 'POST', body: { code: `PARALLEL-${i}` } }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 422)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('the per-IP throttle applies across accounts and ignores client-supplied forwarding headers', async () => {
    const accounts = await Promise.all(Array.from({ length: 7 }, (_, n) => pending(`ip${n}`)));
    const statuses: number[] = [];
    for (const account of accounts) {
      for (let i = 0; i < 5; i += 1) {
        const spoofed = `203.0.113.${statuses.length}`;
        statuses.push(
          (await api('/invites/redeem', { token: account.token, method: 'POST', body: { code: `IP-${i}` }, headers: { 'X-Forwarded-For': spoofed } })).status,
        );
      }
    }
    expect(statuses.slice(0, 30).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429, 429, 429, 429]);
  });

  it('cleanup cannot remove an account whose redemption holds the membership lock', async () => {
    const invite = await createInvite();
    const digest = (await sql()`select code_digest from private.invite_codes where id = ${invite.id}`)[0]!.code_digest;
    const account = await pending('redeemFirst', 25);
    const a = connection();
    try {
      let release!: () => void;
      const redemption = a.begin(async (tx) => {
        await tx`select public.svc_redeem_invite(${account.id}, ${digest}, null)`;
        await new Promise<void>((resolve) => (release = resolve));
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const claimedDuring = await sql()`select user_id from public.svc_claim_pending_account_cleanup(500)`;
      expect(claimedDuring.map((r) => r.user_id)).not.toContain(account.id);
      release();
      await redemption;
    } finally {
      await a.end();
    }
    const claimedAfter = await sql()`select user_id from public.svc_claim_pending_account_cleanup(500)`;
    expect(claimedAfter.map((r) => r.user_id)).not.toContain(account.id);
    const [membership] = await sql()`select state from private.memberships where user_id = ${account.id}`;
    expect(membership!.state).toBe('active');
  });

  it('a redemption waiting behind a cleanup claim cannot admit a deleting account', async () => {
    const invite = await createInvite();
    const digest = (await sql()`select code_digest from private.invite_codes where id = ${invite.id}`)[0]!.code_digest;
    const account = await pending('cleanupFirst', 25);
    const a = connection();
    const b = connection();
    try {
      let release!: () => void;
      const cleanup = a.begin(async (tx) => {
        const rows = await tx`select user_id from public.svc_claim_pending_account_cleanup(500)`;
        expect(rows.map((r) => r.user_id)).toContain(account.id);
        await new Promise<void>((resolve) => (release = resolve));
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const redemption = b`select public.svc_redeem_invite(${account.id}, ${digest}, null)`.then(
        () => 'admitted',
        (error: Error) => error.message,
      );
      await waitForLockWait();
      release();
      await cleanup;
      expect(await redemption).toBe('MEMBERSHIP_INACTIVE');
    } finally {
      await a.end();
      await b.end();
    }
    const [{ uses }] = await sql()`select uses from private.invite_codes where id = ${invite.id}`;
    expect(uses).toBe(0);
  });

  it('the scheduled cleanup deletes expired pending accounts and keeps members', async () => {
    const expiredPending = await pending('expiredPending', 25);
    const freshPending = await pending('freshPending', 1);
    const response = await maintenance('pending_account_cleanup');
    expect(response.status).toBe(200);
    const remaining = await sql()`select id from auth.users where id = any(${[expiredPending.id, freshPending.id, owner.id]}::uuid[])`;
    expect(remaining.map((r) => r.id).sort()).toEqual([freshPending.id, owner.id].sort());
    const [{ audited }] = await sql()`
      select count(*)::int as audited from private.audit_events where action = 'pending_account_deleted' and created_at > now() - interval '1 minute'`;
    expect(audited).toBeGreaterThan(0);
  });

  it('a failed Auth deletion stays claimable for retry', async () => {
    const account = await pending('retryDelete', 25);
    const first = await sql()`select user_id from public.svc_claim_pending_account_cleanup(500)`;
    expect(first.map((r) => r.user_id)).toContain(account.id);
    // Simulated failure: the Auth user was not deleted. Before the retry delay the
    // claim is not repeated; afterwards it is returned again.
    const early = await sql()`select user_id from public.svc_claim_pending_account_cleanup(500)`;
    expect(early.map((r) => r.user_id)).not.toContain(account.id);
    await sql()`update private.memberships set deleting_at = now() - interval '6 minutes' where user_id = ${account.id}`;
    const retry = await sql()`select user_id from public.svc_claim_pending_account_cleanup(500)`;
    expect(retry.map((r) => r.user_id)).toContain(account.id);
  });

  it('maintenance rejects missing, wrong and user credentials', async () => {
    const member = await createIdentity('maint-member');
    expect((await maintenance('pending_account_cleanup', 'wrong-secret-wrong-secret-wrong-secret')).status).toBe(404);
    expect((await maintenance('pending_account_cleanup', await accessToken(member.email))).status).toBe(404);
  });
});

describe('P0.02-A4: owner-only administration over the API', () => {
  it('nonowners cannot use admin endpoints', async () => {
    const member = await createIdentity('nonowner');
    const memberToken = await accessToken(member.email);
    const pendingAccount = await pending('adminPending');
    const invite = await createInvite();
    for (const token of [memberToken, pendingAccount.token]) {
      expect((await api('/admin/overview', { token })).status).toBe(404);
      expect((await api('/admin/invites', { token, method: 'POST', body: {} })).status).toBe(404);
      expect((await api(`/admin/invites/${invite.id}/revoke`, { token, method: 'POST' })).status).toBe(404);
    }
    expect((await api('/admin/overview')).status).toBe(401);
  });

  it('owner overview shows safe membership and invite summaries only', async () => {
    const note = 'Private note for Rae';
    await createInvite(note);
    const overview = await api('/admin/overview', { token: ownerToken });
    expect(overview.status).toBe(200);
    expect(overview.body.data.invites.some((i: { note: string }) => i.note === note)).toBe(true);
    const text = JSON.stringify(overview.body);
    expect(text).not.toMatch(/code_digest|email|@example\.test/);
    expect(Object.keys(overview.body.data.members[0]).sort()).toEqual(
      ['display_name', 'invited_by_name', 'joined_at', 'last_sign_in_at', 'role', 'state', 'user_id'].sort(),
    );
  });

  it('create-invite retries return the same invite and never re-reveal the code', async () => {
    const key = crypto.randomUUID();
    const first = await api('/admin/invites', { token: ownerToken, method: 'POST', key, body: { note: 'Retry' } });
    const replay = await api('/admin/invites', { token: ownerToken, method: 'POST', key, body: { note: 'Retry' } });
    expect(first.status).toBe(201);
    expect(first.body.data.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(replay.status).toBe(200);
    expect(replay.body.data.invite_id).toBe(first.body.data.invite_id);
    expect(replay.body.data.code).toBeNull();
    const conflict = await api('/admin/invites', { token: ownerToken, method: 'POST', key, body: { note: 'Changed' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const missingKey = await api('/admin/invites', { token: ownerToken, method: 'POST', key: null, body: {} });
    expect(missingKey.status).toBe(422);
  });

  it('a pending identity can delete its own unredeemed account', async () => {
    const account = await pending('selfDelete');
    const deleted = await api('/account/pending', { token: account.token, method: 'DELETE' });
    expect(deleted.status).toBe(202);
    expect(deleted.body.data.status).toBe('deleted');
    expect(await sql()`select id from auth.users where id = ${account.id}`).toHaveLength(0);
    const member = await createIdentity('memberNoPendingDelete');
    const refused = await api('/account/pending', { token: await accessToken(member.email), method: 'DELETE' });
    expect(refused.status).toBe(409);
  });
});
