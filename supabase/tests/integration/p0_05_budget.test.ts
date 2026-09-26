// P0.05 integration: the budget gateway against the real database, Edge API and a
// deterministic fake Gemini that counts every provider call.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, api, maintenance } from '../../../tests/support/api';
import { fakeGemini } from '../../../tests/support/fake-gemini';
import { createIdentity } from '../../../tests/support/identities';
import { createSlot, mediaFixtures, putSlot } from '../../../tests/support/media';
import { settleItemStages } from '../../../tests/support/jobs';
import { connection, sql } from '../../../tests/support/stack';

let ownerToken: string;
let memberToken: string;
let memberId: string;

const budget = async () => (await api('/admin/budget', { token: ownerToken })).body.data;
const diagnostic = (key = randomUUID()) => api('/admin/ai-diagnostic', { token: ownerToken, method: 'POST', key });

async function setThresholds(lighter: number, stop: number, ceiling = 10_000_000, clearPause = false) {
  const current = await budget();
  return api('/admin/budget', {
    token: ownerToken,
    method: 'PATCH',
    body: {
      expected_revision: current.settings.revision,
      lighter_micros: lighter,
      stop_micros: stop,
      ceiling_micros: ceiling,
      clear_pause: clearPause,
    },
  });
}

beforeAll(async () => {
  const owner = await createIdentity('budget-owner', { role: 'owner', displayName: 'Budget Owner' });
  ownerToken = await accessToken(owner.email);
  const member = await createIdentity('budget-member');
  memberId = member.id;
  memberToken = await accessToken(member.email);
});

beforeEach(async () => {
  // Tag stages queued by earlier uploads call the gateway in the background;
  // let them finish so this file's provider-call counts are its own.
  await settleItemStages();
  await fakeGemini.reset();
  await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, ceiling_micros = 10000000, paused_reason = null`;
});

afterAll(async () => {
  await sql()`update private.budget_settings set lighter_micros = 8000000, stop_micros = 9500000, ceiling_micros = 10000000, paused_reason = null`;
  await sql().end();
});

describe('P0.05 demo and A1: zero allowance never reaches the provider', () => {
  it('an owner diagnostic settles; at zero it is refused before any provider call', async () => {
    const before = await budget();
    const ran = await diagnostic();
    expect(ran.body.data).toMatchObject({ status: 'completed', mode: 'normal' });
    expect(ran.body.data.settled_micros).toBeGreaterThan(0);
    expect(ran.body.data.settled_micros).toBeLessThanOrEqual(ran.body.data.reserved_micros);
    const after = await budget();
    expect(after.period.settled_micros).toBe(before.period.settled_micros + ran.body.data.settled_micros);
    expect(after.by_task.find((t: { task: string }) => t.task === 'diagnostic').attempts).toBeGreaterThan(0);
    expect(await fakeGemini.calls()).toMatchObject({ count_tokens: 1, generate_content: 1 });

    expect((await setThresholds(0, 0)).status).toBe(200);
    await fakeGemini.reset();
    const refused = await diagnostic();
    expect(refused.body.data).toMatchObject({ status: 'refused', reason: 'budget_stop' });
    expect(await fakeGemini.calls()).toMatchObject({ count_tokens: 0, generate_content: 0 });
    const [{ refusals }] = await sql()`
      select count(*)::int as refusals from private.ai_usage where state = 'refused' and refusal_reason = 'budget_stop'
        and created_at > now() - interval '1 minute'`;
    expect(refusals).toBeGreaterThanOrEqual(1);
    const status = await api('/budget-status', { token: memberToken });
    expect(status.body.data.status).toBe('paused');
  });

  it('upload validation still completes at a zero allowance', async () => {
    await setThresholds(0, 0);
    const fixtures = mediaFixtures();
    const { entry } = await createSlot(memberToken, fixtures.png, 'image/png');
    await putSlot(entry, fixtures.png);
    await api(`/upload-entries/${entry.entry_id}/complete`, { token: memberToken, method: 'POST' });
    let state = '';
    for (let i = 0; i < 80 && state !== 'ready'; i += 1) {
      state = (await sql()`select state from public.upload_entries where id = ${entry.entry_id}`)[0]!.state;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(state).toBe('ready');
    // The piece's tag stage parks for the budget instead of calling the provider.
    await settleItemStages();
    const [tags] = await sql()`select s.state, s.failure_code from public.item_stages s join public.items i on i.id = s.item_id
      where i.source_entry_id = ${entry.entry_id} and s.stage = 'tags'`;
    expect(tags).toEqual({ state: 'blocked_budget', failure_code: 'AI_BUDGET_PAUSED' });
    expect((await fakeGemini.calls()).generate_content).toBe(0);
  });

  it('nonowners cannot run diagnostics or change thresholds; the ceiling cannot exceed $10', async () => {
    expect((await api('/admin/ai-diagnostic', { token: memberToken, method: 'POST' })).status).toBe(404);
    expect((await api('/admin/budget', { token: memberToken })).status).toBe(404);
    const current = await budget();
    const memberPatch = await api('/admin/budget', {
      token: memberToken,
      method: 'PATCH',
      body: { expected_revision: current.settings.revision, lighter_micros: 0, stop_micros: 0, ceiling_micros: 0 },
    });
    expect(memberPatch.status).toBe(404);
    const tooHigh = await setThresholds(8_000_000, 9_500_000, 10_000_001);
    expect(tooHigh.status).toBe(422);
    expect((await budget()).settings.ceiling_micros).toBe(10_000_000);
    expect((await fakeGemini.calls()).generate_content).toBe(0);
    const memberStatus = await api('/budget-status', { token: memberToken });
    expect(Object.keys(memberStatus.body.data).sort()).toEqual(['resets_at', 'status']);
    void memberId;
  });
});

describe('P0.05-A2: parallel reservations cannot oversubscribe', () => {
  async function parallelReserve(month: string, settled: number, count: number, normal: number, lighter: number) {
    const at = `${month}-10T12:00:00Z`;
    const start = `${month}-01T00:00:00Z`;
    await sql()`select private.budget_period_at(${at}::timestamptz)`;
    // The synthetic month is reset so repeated runs start from the same state.
    await sql()`delete from private.ai_usage where period_id = (select id from private.budget_periods where period_start = ${start}::timestamptz)`;
    await sql()`update private.budget_periods set settled_micros = ${settled}, reserved_micros = 0 where period_start = ${start}::timestamptz`;
    const connections = Array.from({ length: count }, () => connection());
    try {
      const results = await Promise.all(
        connections.map((db, i) =>
          db`select public.svc_ai_reserve(${`itest:${month}:${i}:${randomUUID()}`}, null, null, 'diagnostic', 'm', 'm-lite',
            'v', ${normal}, ${lighter}, 60, ${at}::timestamptz) as r`.then((rows) => rows[0]!.r),
        ),
      );
      const [period] = await sql()`select * from private.budget_periods where period_start = ${`${month}-01T00:00:00Z`}::timestamptz`;
      return { results, period: period! };
    } finally {
      await Promise.all(connections.map((db) => db.end()));
    }
  }

  it('at the $9.50 stop, exactly the remaining allowance is admitted', async () => {
    const { results, period } = await parallelReserve('2031-03', 9_400_000, 20, 20_000, 10_000);
    expect(results.filter((r) => r.state === 'reserved')).toHaveLength(10);
    expect(results.filter((r) => r.refusal_reason === 'budget_stop')).toHaveLength(10);
    expect(Number(period.settled_micros) + Number(period.reserved_micros)).toBeLessThanOrEqual(9_500_000);
  });

  it('at the $8 threshold, normal admissions stop exactly and the rest are repriced lighter', async () => {
    const { results, period } = await parallelReserve('2031-04', 7_950_000, 20, 10_000, 5_000);
    const normal = results.filter((r) => r.mode === 'normal');
    const lighterAdmitted = results.filter((r) => r.mode === 'lighter');
    expect(normal).toHaveLength(5);
    expect(lighterAdmitted).toHaveLength(15);
    expect(lighterAdmitted.every((r) => r.reserved_micros === 5_000)).toBe(true);
    expect(Number(period.settled_micros) + Number(period.reserved_micros)).toBe(7_950_000 + 50_000 + 75_000);
  });
});

describe('P0.05-A3: uncertain dispatch and known rejections', () => {
  it('a timeout after dispatch keeps the reservation; reload and reconciliation never re-send or free it', async () => {
    await fakeGemini.mode('timeout');
    const key = randomUUID();
    const before = await budget();
    const first = await diagnostic(key);
    expect(first.body.data.status).toBe('uncertain');
    const after = await budget();
    expect(after.period.unknown_micros).toBe(before.period.unknown_micros + first.body.data.reserved_micros);
    expect(after.period.reserved_micros).toBe(before.period.reserved_micros + first.body.data.reserved_micros);

    await maintenance('dispatch_jobs');
    const again = await diagnostic(key);
    expect(again.body.data.status).toBe('uncertain');
    expect((await fakeGemini.calls()).generate_content).toBe(1);
    expect((await budget()).period.unknown_micros).toBe(after.period.unknown_micros);
  });

  it.each(['reject_400', 'quota_429'] as const)('a known unbilled %s releases the reservation once', async (mode) => {
    await fakeGemini.mode(mode);
    const before = await budget();
    const rejected = await diagnostic();
    expect(rejected.body.data.status).toBe('provider_rejected');
    const after = await budget();
    expect(after.period.reserved_micros).toBe(before.period.reserved_micros);
    expect(after.period.settled_micros).toBe(before.period.settled_micros);
  });

  it('a server error after sending is treated as possibly billed', async () => {
    await fakeGemini.mode('server_500');
    expect((await diagnostic()).body.data.status).toBe('uncertain');
  });
});

describe('P0.05-A4: fail-closed accounting', () => {
  it('a charge above its reservation pauses AI until the owner deliberately resumes', async () => {
    await fakeGemini.mode('overcharge');
    const charged = await diagnostic();
    expect(charged.body.data.settled_micros).toBeGreaterThan(charged.body.data.reserved_micros);
    expect((await budget()).settings.paused_reason).toBe('over_reservation');

    await fakeGemini.reset();
    expect((await diagnostic()).body.data).toMatchObject({ status: 'refused', reason: 'paused' });
    expect((await fakeGemini.calls()).generate_content).toBe(0);
    const [alert] = await sql()`select action from private.audit_events where action = 'ai_charge_above_reservation' order by id desc limit 1`;
    expect(alert!.action).toBe('ai_charge_above_reservation');

    expect((await setThresholds(8_000_000, 9_500_000, 10_000_000, true)).status).toBe(200);
    expect((await diagnostic()).body.data.status).toBe('completed');
  });

  it('invalid model output is still accounted and never trusted', async () => {
    await fakeGemini.mode('invalid_output');
    const result = await diagnostic();
    expect(result.body.data.status).toBe('invalid_output');
    expect(result.body.data.settled_micros).toBeGreaterThan(0);
    expect(result.body.data).not.toHaveProperty('output');
  });
});
