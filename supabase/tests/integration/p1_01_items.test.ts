// P1.01 integration: one upload becomes exactly one piece with its renditions;
// manual correction works without AI; foreign identities cannot reach it.
import { randomUUID } from 'node:crypto';
import { taxonomyDocument } from '../../../packages/domain/src/taxonomy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import {
  currentAssets,
  gatherPiece,
  harnessRerun,
  settledStage,
  userClient,
  wardrobeFixtures,
} from '../../../tests/support/items';
import { settleItemStages } from '../../../tests/support/jobs';
import { member, sha256, storageAdmin, type Member } from '../../../tests/support/media';
import { connection, sql, stack } from '../../../tests/support/stack';

let fixtures: ReturnType<typeof wardrobeFixtures>;
let a: Member;
let b: Member;

const internal = (path: string) => `${stack().API_URL}/functions/v1/internal/v1${path}`;

async function updateItem(token: string, itemId: string, revision: number, patch: Record<string, unknown>, key = randomUUID()) {
  return userClient(token).rpc('update_item', {
    p_request_id: key,
    p_item_id: itemId,
    p_expected_revision: revision,
    p_patch: patch,
  });
}

/** The item's revision once background stages (computed colors) have finished. */
async function settledRevision(itemId: string): Promise<number> {
  await settleItemStages();
  const [{ revision }] = await sql()`select revision from public.items where id = ${itemId}`;
  return Number(revision);
}

async function access(token: string, assetId: string, variant: string) {
  const response = await api('/media/access', { token, method: 'POST', body: { requests: [{ asset_id: assetId, variant }] } });
  return response.body.data[0];
}

// P1.01 is the manual path: AI stays paused for this file (tag stages park).
beforeAll(async () => {
  await sql()`update private.budget_settings set paused_reason = 'operator' where id`;
  fixtures = wardrobeFixtures();
  a = await member(createIdentity, 'pieces-a');
  b = await member(createIdentity, 'pieces-b');
});

afterAll(async () => {
  await sql()`update private.budget_settings set paused_reason = null where id`;
});

describe('taxonomy', () => {
  it('the database copy matches the shared domain taxonomy', async () => {
    const [{ t }] = await sql()`select private.taxonomy() as t`;
    expect(t).toEqual(taxonomyDocument());
  });
});

describe('P1.01-A1: upload → cutout → edit → reload yields one persistent piece', () => {
  it('a garment upload becomes one visible piece with original, cutout, thumbnail and mask', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const stage = await settledStage(piece.itemId, 'cutout');
    expect(stage).toMatchObject({ state: 'succeeded', model: 'isnet_general_use', media_revision: 1 });

    const assets = await currentAssets(piece.itemId);
    expect(assets.map((row) => row.role)).toEqual(['cutout', 'mask', 'original', 'thumbnail']);
    const byRole = Object.fromEntries(assets.map((row) => [row.role, row]));
    expect(byRole.original).toMatchObject({ asset_id: piece.assetId, state: 'ready', width: 800, height: 600 });
    expect(byRole.cutout).toMatchObject({ state: 'ready', width: 1024, height: 1024, content_type: 'image/webp' });
    expect(byRole.thumbnail).toMatchObject({ width: 256, height: 256, content_type: 'image/webp' });
    expect(byRole.mask).toMatchObject({ width: 800, height: 600, content_type: 'image/png' });

    // The member can view each rendition by its own variant, and the bytes match.
    for (const role of ['cutout', 'thumbnail', 'mask', 'original']) {
      const grant = await access(a.token, byRole[role]!.asset_id, role);
      expect(grant.status).toBe('ok');
      const bytes = Buffer.from(await (await fetch(grant.url)).arrayBuffer());
      expect(sha256(bytes)).toBe(byRole[role]!.sha256);
    }
    // A variant is only the asset's own role: no cross-signing, no quarantine.
    expect((await access(a.token, byRole.cutout!.asset_id, 'original')).status).toBe('not_found');
    expect((await access(a.token, piece.assetId, 'quarantine')).status).toBe('not_found');

    // Optional details stay optional; the category waits for the member (AI is
    // paused, so only computed colors may have been filled in).
    await settleItemStages();
    const { data: rows } = await userClient(a.token).from('items').select('*').eq('id', piece.itemId);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      lifecycle: 'active',
      category: null,
      category_review_required: true,
      brand: null,
      price_minor: null,
      purchased_on: null,
      media_revision: 1,
    });
    const revision = rows![0].revision as number;

    // Manual correction, then a fresh read shows the persisted values.
    const edited = await updateItem(a.token, piece.itemId, revision, { category: 'tops', subcategory: 'shirt', name: 'Navy Oxford' });
    expect(edited.error).toBeNull();
    expect(edited.data).toMatchObject({ category: 'tops', name: 'Navy Oxford', category_review_required: false, revision: revision + 1 });
    expect(edited.data.field_meta.category).toMatchObject({ v: 1, source: 'user', locked: true });
    const { data: reread } = await userClient(a.token).from('items').select('name, category, subcategory, revision').eq('id', piece.itemId).single();
    expect(reread).toEqual({ name: 'Navy Oxford', category: 'tops', subcategory: 'shirt', revision: revision + 1 });
  });

  it('repeated completion and repeated item creation cannot create another piece', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settledStage(piece.itemId, 'cutout');
    for (const key of [randomUUID(), randomUUID()]) {
      const again = await api(`/upload-entries/${piece.entryId}/complete`, { token: a.token, method: 'POST', key });
      expect(again.status).toBe(202);
    }
    await sql()`select private.create_gather_item(e) from public.upload_entries e where e.id = ${piece.entryId}`;
    const [{ n, jobs, stages }] = await sql()`select count(*)::int as n,
        (select count(*)::int from private.jobs j where j.target_id = ${piece.itemId}) as jobs,
        (select count(distinct j.stage)::int from private.jobs j where j.target_id = ${piece.itemId}) as stages
      from public.items where source_entry_id = ${piece.entryId}`;
    expect(n).toBe(1);
    // One job per stage, however often completion or item creation repeats.
    expect(jobs).toBe(stages);
  });

  it('an edit request replayed with the same key returns the same result; a changed body conflicts', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const r = await settledRevision(piece.itemId);
    const key = randomUUID();
    const first = await updateItem(a.token, piece.itemId, r, { category: 'bottoms' }, key);
    const replay = await updateItem(a.token, piece.itemId, r, { category: 'bottoms' }, key);
    expect(replay.data).toEqual(first.data);
    const changed = await updateItem(a.token, piece.itemId, r, { category: 'shoes' }, key);
    expect(changed.error?.message).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('P1.01-A2: failure keeps a viewable original and manual correction', () => {
  it('a photo without a garment fails the cutout honestly, keeps its original, and allows manual edits and bounded retry', async () => {
    const piece = await gatherPiece(a.token, fixtures.blank);
    const stage = await settledStage(piece.itemId, 'cutout');
    expect(stage).toMatchObject({ state: 'failed', failure_code: 'NO_FOREGROUND', can_retry: true });
    expect((await currentAssets(piece.itemId)).map((row) => row.role)).toEqual(['original']);
    expect((await access(a.token, piece.assetId, 'original')).status).toBe('ok');

    // Manual identification needs no AI and no cutout.
    const edited = await updateItem(a.token, piece.itemId, await settledRevision(piece.itemId), { category: 'bags', display_image: 'original' });
    expect(edited.error).toBeNull();
    expect(edited.data).toMatchObject({ category: 'bags', display_image: 'original', category_review_required: false });

    // Retry runs the same stage again; two manual retries, then a clear limit.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retried = await api(`/items/${piece.itemId}/process`, {
        token: a.token,
        method: 'POST',
        body: { stage: 'cutout', media_revision: 1 },
      });
      expect(retried.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await settledStage(piece.itemId, 'cutout')).toMatchObject({ state: 'failed', failure_code: 'NO_FOREGROUND' });
    }
    const limited = await api(`/items/${piece.itemId}/process`, { token: a.token, method: 'POST', body: { stage: 'cutout', media_revision: 1 } });
    expect(limited.status).toBe(409);
    expect(limited.body.error.code).toBe('RETRY_LIMIT_REACHED');
    expect((await settledStage(piece.itemId, 'cutout')).can_retry).toBe(false);
    // A stale media revision is a conflict, not a retry of the current photo.
    const stale = await api(`/items/${piece.itemId}/process`, { token: a.token, method: 'POST', body: { stage: 'cutout', media_revision: 7 } });
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('a result for an older media revision is fenced and its renditions are discarded', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settledStage(piece.itemId, 'cutout');
    // The harness re-runs the finished job as an old worker would.
    const { jobId, job } = await harnessRerun(piece.itemId, 'cutout');
    expect(job).toMatchObject({ kind: 'item_stage', stage: 'cutout', lease_generation: 2 });
    const before = await currentAssets(piece.itemId);
    // The photo is replaced (media revision advances) while the old attempt runs.
    await sql()`update public.items set media_revision = media_revision + 1 where id = ${piece.itemId}`;
    const outputs: Record<string, unknown> = {};
    for (const role of ['cutout', 'thumbnail', 'mask'] as const) {
      const original = before.find((row) => row.role === role)!;
      const grant = await access(a.token, original.asset_id, role);
      const bytes = Buffer.from(await (await fetch(grant.url)).arrayBuffer());
      expect((await fetch(job.outputs[role].url, { method: 'PUT', headers: { 'Content-Type': job.outputs[role].content_type }, body: bytes })).status).toBe(200);
      outputs[role] = { width: original.width, height: original.height, byte_size: bytes.length, sha256: sha256(bytes) };
    }
    const completed = await fetch(internal(`/jobs/${jobId}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.capability}` },
      body: JSON.stringify({ schema_version: 1, lease_generation: 2, outcome: 'ready', outputs, result: { foreground_ratio: 0.2 } }),
    });
    expect(((await completed.json()) as any).data.status).toBe('stale');
    expect(await currentAssets(piece.itemId)).toEqual(before);
    const discarded = await sql()`select object_key from private.deletion_tasks where reason = 'stale_output' and object_key like ${`users/${a.id}/items/${piece.itemId}/%-g2.%`}`;
    expect(discarded).toHaveLength(3);
    const [stage] = await sql()`select state, failure_code from public.item_stages where item_id = ${piece.itemId} and stage = 'cutout'`;
    expect(stage).toEqual({ state: 'canceled', failure_code: 'SUPERSEDED' });
  });

  it('forged renditions are refused: wrong dimensions or bytes never publish', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settledStage(piece.itemId, 'cutout');
    const { jobId, job } = await harnessRerun(piece.itemId, 'cutout');
    const before = await currentAssets(piece.itemId);
    // The original's bytes are uploaded as if they were a 1024 px cutout.
    const original = before.find((row) => row.role === 'original')!;
    const originalBytes = Buffer.from(await (await fetch((await access(a.token, original.asset_id, 'original')).url)).arrayBuffer());
    const outputs: Record<string, unknown> = {};
    for (const role of ['cutout', 'thumbnail', 'mask'] as const) {
      await fetch(job.outputs[role].url, { method: 'PUT', headers: { 'Content-Type': job.outputs[role].content_type }, body: originalBytes });
      outputs[role] = { width: role === 'thumbnail' ? 256 : 1024, height: role === 'thumbnail' ? 256 : 1024, byte_size: originalBytes.length, sha256: sha256(originalBytes) };
    }
    const completed = await fetch(internal(`/jobs/${jobId}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.capability}` },
      body: JSON.stringify({ schema_version: 1, lease_generation: 2, outcome: 'ready', outputs, result: { foreground_ratio: 0.2 } }),
    });
    expect(completed.status).toBe(422);
    expect(await currentAssets(piece.itemId)).toEqual(before);
    // The harness worker gives up its lease so the member's next job can run.
    await sql()`update private.jobs set state = 'succeeded', lease_expires_at = null where id = ${jobId}`;
  });
});

describe('P1.01-A3: ownership and revisions', () => {
  it('B cannot read, edit, retry, sign or attach A’s piece and its assets', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settledStage(piece.itemId, 'cutout');
    const cutout = (await currentAssets(piece.itemId)).find((row) => row.role === 'cutout')!;

    const bClient = userClient(b.token);
    for (const table of ['items', 'item_assets', 'item_stages']) {
      const { data, error } = await bClient.from(table).select('*').eq(table === 'items' ? 'id' : 'item_id', piece.itemId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    const edit = await updateItem(b.token, piece.itemId, 1, { category: 'tops' });
    expect(edit.error?.message).toBe('NOT_FOUND');
    const retry = await api(`/items/${piece.itemId}/process`, { token: b.token, method: 'POST', body: { stage: 'cutout', media_revision: 1 } });
    expect(retry.status).toBe(404);
    expect((await access(b.token, cutout.asset_id, 'cutout')).status).toBe('not_found');

    // No client write path exists for items or attachments.
    const [{ id: bAsset }] = await sql()`insert into public.media_assets (user_id, purpose) values (${b.id}, 'gather_original') returning id`;
    const attach = await bClient.from('item_assets').insert({ user_id: b.id, item_id: piece.itemId, asset_id: bAsset, role: 'label', media_revision: 1 });
    expect(attach.error?.code).toBe('42501');
    const direct = await userClient(a.token).from('items').update({ category: 'tops' }).eq('id', piece.itemId);
    expect(direct.error?.code).toBe('42501');
    // The database refuses an attachment whose asset belongs to someone else.
    await expect(sql()`insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
      values (${a.id}, ${piece.itemId}, ${bAsset}, 'label', 1)`).rejects.toThrow(/foreign key/);
  });

  it('simultaneous edits at the same revision: one applies, the other gets a conflict', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const r = await settledRevision(piece.itemId);
    // Hold the row so both requests are in flight together, then release.
    const holder = connection();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locked = holder.begin(async (tx) => {
      await tx`select id from public.items where id = ${piece.itemId} for update`;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const racing = Promise.all([
      updateItem(a.token, piece.itemId, r, { material: 'linen' }),
      updateItem(a.token, piece.itemId, r, { material: 'cotton' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await locked;
    await holder.end();
    const results = await racing;
    const codes = results.map((r) => r.error?.message ?? 'ok').sort();
    expect(codes).toEqual(['REVISION_CONFLICT', 'ok']);
    const conflict = results.find((r) => r.error)!;
    expect(JSON.parse(conflict.error!.details!)).toEqual({ current_revision: r + 1 });
    const [{ revision }] = await sql()`select revision from public.items where id = ${piece.itemId}`;
    expect(Number(revision)).toBe(r + 1);
  });

  it('taxonomy and field rules are enforced by the database', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const r = await settledRevision(piece.itemId);
    const invalid: Array<Record<string, unknown>> = [
      { category: 'accessories' },
      { category: 'tops', subcategory: 'loafers' },
      { formality: 6 },
      { colors: [{ name: 'chartreuse-ish', hex: '#00FF00' }] },
      { colors: Array.from({ length: 6 }, () => ({ name: 'black', hex: '#000000' })) },
      { seasons: ['summer'] },
      { style_tags: ['<script>'] },
      { attributes: { frame_shape: 'round' } },
      { price_minor: 1200 },
      { purchased_on: '2999-01-01' },
      { owner: a.id },
      { lifecycle: 'archived' },
    ];
    for (const patch of invalid) {
      const result = await updateItem(a.token, piece.itemId, r, patch);
      expect(result.error?.message, JSON.stringify(patch)).toBe('VALIDATION_FAILED');
    }
    // Accessory attributes apply to their categories; changing category prunes them.
    const eyewear = await updateItem(a.token, piece.itemId, r, {
      category: 'eyewear',
      subcategory: 'shades',
      attributes: { frame_shape: 'round', lens_tint: 'dark' },
      colors: [{ name: 'black', hex: '#1C1C1E', proportion: 1 }],
      price_minor: 125000,
      currency: 'PHP',
    });
    expect(eyewear.error).toBeNull();
    const moved = await updateItem(a.token, piece.itemId, r + 1, { category: 'bags' });
    expect(moved.data).toMatchObject({ category: 'bags', subcategory: null, attributes: {} });
    // Clearing a value is a locked edit too.
    const cleared = await updateItem(a.token, piece.itemId, r + 2, { colors: [] });
    expect(cleared.data.colors).toEqual([]);
    expect(cleared.data.field_meta.colors).toMatchObject({ source: 'user', locked: true });
  });
});

describe('storage renditions', () => {
  it('rendition objects live under the item prefix and exist in storage', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settledStage(piece.itemId, 'cutout');
    const keys = await sql()`select o.object_key from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id
      where ia.item_id = ${piece.itemId} and ia.role <> 'original'`;
    expect(keys).toHaveLength(3);
    for (const { object_key } of keys) {
      expect(object_key).toMatch(new RegExp(`^users/${a.id}/items/${piece.itemId}/1/(cutout|thumbnail|mask)-`));
      expect(await storageAdmin().exists(object_key)).toBe(true);
    }
  });
});
