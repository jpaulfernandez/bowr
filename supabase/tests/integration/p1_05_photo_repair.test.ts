// P1.05 integration: edited masks, alternate-model cutouts and replacement
// photos advance the media revision; older results are fenced and a failed
// repair leaves a usable image.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { fakeGemini } from '../../../tests/support/fake-gemini';
import { createIdentity } from '../../../tests/support/identities';
import {
  currentAssets,
  gatherPiece,
  harnessRerun,
  internalPost,
  settledStage,
  userClient,
  waitUntil,
  wardrobeFixtures,
} from '../../../tests/support/items';
import { settleItemStages } from '../../../tests/support/jobs';
import { member, putSlot, storageAdmin, type Member } from '../../../tests/support/media';
import { decodePng, encodePng, uniquePng } from '../../../tests/support/png';
import { sql, stack } from '../../../tests/support/stack';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let fixtures: ReturnType<typeof wardrobeFixtures>;
let a: Member;
let b: Member;

async function postMask(token: string, itemId: string, revision: number, bytes: Buffer, contentType = 'image/png', key = randomUUID()) {
  const response = await fetch(`${stack().API_URL}/functions/v1/api/v1/items/${itemId}/mask?media_revision=${revision}`, {
    method: 'POST',
    headers: { apikey: stack().ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Idempotency-Key': key },
    body: bytes,
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

const itemRow = async (id: string) => (await sql()`select * from public.items where id = ${id}`)[0]!;
const role = async (itemId: string, name: string) => (await currentAssets(itemId)).find((r) => r.role === name);

/** The current mask of a piece, decoded. */
async function currentMask(itemId: string) {
  const [{ object_key }] = await sql()`select o.object_key from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id
    where ia.item_id = ${itemId} and ia.role = 'mask' and ia.detached_at is null and o.deleted_at is null`;
  return decodePng(await storageAdmin().get(object_key));
}

async function replace(token: string, itemId: string, bytes: Buffer) {
  const response = await api('/upload-batches', {
    token,
    method: 'POST',
    body: { files: [{ client_file_id: randomUUID(), purpose: 'replacement', content_type: 'image/png', byte_size: bytes.length, target_item_id: itemId }] },
  });
  expect(response.status).toBe(201);
  const entry = response.body.data.entries[0];
  expect((await putSlot(entry, bytes)).status).toBe(200);
  expect((await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' })).status).toBe(202);
  return waitUntil(async () => {
    const [row] = await sql()`select * from public.upload_entries where id = ${entry.entry_id}`;
    return ['ready', 'rejected', 'canceled'].includes(row!.state) ? row : null;
  }, 'replacement validated');
}

async function objectsGone(assetId: string) {
  const keys = await sql()`select object_key from private.media_objects where asset_id = ${assetId}`;
  await waitUntil(async () => {
    await maintenance('temporary_cleanup');
    for (const { object_key } of keys) if (await storageAdmin().exists(object_key)) return false;
    return true;
  }, `objects of ${assetId} deleted`);
}

beforeAll(async () => {
  fixtures = wardrobeFixtures();
  a = await member(createIdentity, 'repair-a');
  b = await member(createIdentity, 'repair-b');
});

beforeEach(async () => {
  await settleItemStages();
  await fakeGemini.reset();
});

afterAll(async () => {
  await fakeGemini.reset();
});

describe('P1.05-A1: an edited mask changes only what was edited; the original stays', () => {
  it('erasing an area produces a new cutout from that mask at the next media revision', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const before = await itemRow(piece.itemId);
    const original = await role(piece.itemId, 'original');
    const mask = await currentMask(piece.itemId);
    expect([mask.width, mask.height, mask.channels]).toEqual([800, 600, 1]);
    // Erase the left sleeve; everything else stays exactly as it was.
    const edited = Buffer.from(mask.pixels);
    for (let y = 0; y < 600; y += 1) edited.fill(0, y * 800, y * 800 + 280);
    const posted = await postMask(a.token, piece.itemId, before.media_revision, encodePng({ ...mask, pixels: edited }));
    expect(posted.status).toBe(202);
    expect(posted.body.data.media_revision).toBe(before.media_revision + 1);
    expect(await settledStage(piece.itemId, 'cutout')).toMatchObject({ state: 'succeeded', model: 'manual', media_revision: before.media_revision + 1 });

    const after = await currentMask(piece.itemId);
    expect(Buffer.compare(after.pixels, edited)).toBe(0);
    // The original is the same asset, still attached and viewable; details are untouched.
    expect((await role(piece.itemId, 'original'))!.asset_id).toBe(original!.asset_id);
    const grant = await api('/media/access', { token: a.token, method: 'POST', body: { requests: [{ asset_id: original!.asset_id, variant: 'original' }] } });
    expect(grant.body.data[0].status).toBe('ok');
    const row = await itemRow(piece.itemId);
    expect(row).toMatchObject({ id: piece.itemId, lifecycle: 'active', source_entry_id: piece.entryId });
    // Colors and matching are recomputed for the new cutout.
    expect(await settledStage(piece.itemId, 'colors')).toMatchObject({ state: 'succeeded', media_revision: row.media_revision });
    // The submitted mask was an input only: its bytes are deleted.
    const [input] = await sql()`select a.id from public.media_assets a join private.media_objects o on o.asset_id = a.id
      where a.user_id = ${a.id} and o.object_key like ${`users/${a.id}/items/${piece.itemId}/edits/%`}`;
    await objectsGone(input!.id);
  });

  it('a forged cutout, a mask of another size, a stale revision and another member are all refused', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const { media_revision: revision } = await itemRow(piece.itemId);
    const mask = await currentMask(piece.itemId);

    const cutoutBytes = await storageAdmin().get(
      (await sql()`select o.object_key from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id
        where ia.item_id = ${piece.itemId} and ia.role = 'cutout' and ia.detached_at is null`)[0]!.object_key,
    );
    const cases: Array<[string, Promise<{ status: number; body: any }>, number, string]> = [
      ['client cutout as webp', postMask(a.token, piece.itemId, revision, cutoutBytes, 'image/webp'), 422, 'MASK_REJECTED'],
      ['webp bytes labelled png', postMask(a.token, piece.itemId, revision, cutoutBytes), 422, 'MASK_REJECTED'],
      ['wrong size', postMask(a.token, piece.itemId, revision, encodePng({ width: 600, height: 800, channels: 1, pixels: Buffer.alloc(480000, 255) })), 422, 'MASK_REJECTED'],
      ['stale revision', postMask(a.token, piece.itemId, revision - 1, encodePng(mask)), 409, 'REVISION_CONFLICT'],
      ['another member', postMask(b.token, piece.itemId, revision, encodePng(mask)), 404, 'NOT_FOUND'],
    ];
    for (const [label, pending, status, code] of cases) {
      const response = await pending;
      expect([label, response.status, response.body?.error?.code]).toEqual([label, status, code]);
    }
    expect((await itemRow(piece.itemId)).media_revision).toBe(revision);
    // No refused mask is left behind in storage records.
    expect(await sql()`select 1 from private.media_objects where object_key like ${`users/%/items/${piece.itemId}/edits/%`}`).toHaveLength(0);
  });
});

describe('P1.05-A2: older results are fenced; simultaneous corrections conflict', () => {
  it('a replacement during slow old inference keeps the new colors and vector; the late result is fenced', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const before = await itemRow(piece.itemId);
    const slow = await harnessRerun(piece.itemId, 'colors');
    // The slow worker's lease lapses (it looks gone), so the member's replacement
    // can be processed; the old worker then reports late, as a zombie would.
    await sql()`update private.jobs set lease_expires_at = now() - interval '1 second' where id = ${slow.jobId}`;
    await maintenance('dispatch_jobs');
    const replaced = await replace(a.token, piece.itemId, uniquePng(fixtures.trousers));
    expect(replaced.state).toBe('ready');
    const current = await itemRow(piece.itemId);
    expect(current.media_revision).toBe(before.media_revision + 1);
    await settledStage(piece.itemId, 'cutout');
    expect(await settledStage(piece.itemId, 'colors')).toMatchObject({ state: 'succeeded', media_revision: current.media_revision });
    await settledStage(piece.itemId, 'embedding');
    const fresh = await itemRow(piece.itemId);
    const vectors = await sql()`select media_revision from public.item_embeddings where item_id = ${piece.itemId} order by media_revision`;

    const late = await internalPost(`/jobs/${slow.jobId}/complete`, slow.job.capability, {
      schema_version: 1,
      lease_generation: slow.job.lease_generation,
      outcome: 'ready',
      result: { suggested: { colors: [{ name: 'red', hex: '#CC0000', proportion: 1 }] } },
    });
    expect(late.body.data.status).toBe('stale');
    const after = await itemRow(piece.itemId);
    expect(after.colors).toEqual(fresh.colors);
    expect(after.colors[0].name).not.toBe('red');
    expect(await sql()`select media_revision from public.item_embeddings where item_id = ${piece.itemId} order by media_revision`).toEqual(vectors);
  });

  it('two corrections of the same revision: one applies, the other conflicts', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const { media_revision: revision } = await itemRow(piece.itemId);
    const mask = await currentMask(piece.itemId);
    const erasedTop = Buffer.from(mask.pixels).fill(0, 0, 800 * 200);
    const erasedBottom = Buffer.from(mask.pixels).fill(0, 800 * 400);
    const results = await Promise.all([
      postMask(a.token, piece.itemId, revision, encodePng({ ...mask, pixels: erasedTop })),
      postMask(a.token, piece.itemId, revision, encodePng({ ...mask, pixels: erasedBottom })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('REVISION_CONFLICT');
    expect((await itemRow(piece.itemId)).media_revision).toBe(revision + 1);
  });
});

describe('P1.05-A3: a reshoot keeps the piece; a failed replacement keeps the prior image', () => {
  it('replacing the photo keeps the ID and the member’s details; the old original is deleted only after it is detached', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const edit = await userClient(a.token).rpc('update_item', {
      p_request_id: randomUUID(), p_item_id: piece.itemId, p_expected_revision: Number((await itemRow(piece.itemId)).revision),
      p_patch: { name: 'Work shirt', brand: 'Kept' },
    });
    expect(edit.error).toBeNull();
    const before = await itemRow(piece.itemId);
    const oldOriginal = await role(piece.itemId, 'original');
    const oldCutout = await role(piece.itemId, 'cutout');

    // A corrupt replacement is rejected; nothing about the piece changes.
    const broken = await replace(a.token, piece.itemId, Buffer.from('<html>not an image</html>'));
    expect(broken.state).toBe('rejected');
    expect((await itemRow(piece.itemId)).media_revision).toBe(before.media_revision);
    expect((await role(piece.itemId, 'original'))!.asset_id).toBe(oldOriginal!.asset_id);
    expect((await role(piece.itemId, 'cutout'))!.asset_id).toBe(oldCutout!.asset_id);

    const replaced = await replace(a.token, piece.itemId, uniquePng(fixtures.garment));
    expect(replaced.state).toBe('ready');
    const after = await itemRow(piece.itemId);
    expect(after).toMatchObject({ id: piece.itemId, name: 'Work shirt', brand: 'Kept', source_entry_id: piece.entryId, media_revision: before.media_revision + 1 });
    expect(after.field_meta.brand).toMatchObject({ source: 'user', locked: true });
    const newOriginal = await role(piece.itemId, 'original');
    expect(newOriginal!.asset_id).toBe(replaced.asset_id);
    await settledStage(piece.itemId, 'cutout');
    expect((await role(piece.itemId, 'cutout'))!.asset_id).not.toBe(oldCutout!.asset_id);

    // Superseded bytes are queued only once their attachment is detached.
    for (const asset of [oldOriginal!, oldCutout!]) {
      const [link] = await sql()`select detached_at from public.item_assets where asset_id = ${asset.asset_id}`;
      expect(link!.detached_at).not.toBeNull();
      // (The upload's quarantine copy was deleted at validation, before any of this.)
      const tasks = await sql()`select t.created_at from private.deletion_tasks t join private.media_objects o on o.object_key = t.object_key
        where o.asset_id = ${asset.asset_id} and o.role <> 'quarantine'`;
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) expect(new Date(task.created_at).getTime()).toBeGreaterThanOrEqual(new Date(link!.detached_at).getTime());
      await objectsGone(asset.asset_id);
    }
  });

  it('only the member’s own piece can be replaced', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const foreign = await api('/upload-batches', {
      token: b.token,
      method: 'POST',
      body: { files: [{ client_file_id: randomUUID(), purpose: 'replacement', content_type: 'image/png', byte_size: 10, target_item_id: piece.itemId }] },
    });
    expect(foreign.status).toBe(404);
    const untargeted = await api('/upload-batches', {
      token: a.token,
      method: 'POST',
      body: { files: [{ client_file_id: randomUUID(), purpose: 'replacement', content_type: 'image/png', byte_size: 10 }] },
    });
    expect(untargeted.status).toBe(422);
  });
});

describe('P1.05-A4: alternate-model retries are explicit and bounded', () => {
  it('two model retries are allowed per original, a third is refused, and a failed cutout never switches models by itself', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    let revision = (await itemRow(piece.itemId)).media_revision;
    for (const model of ['u2netp', 'isnet_general_use']) {
      const recut = await api(`/items/${piece.itemId}/recut`, { token: a.token, method: 'POST', body: { media_revision: revision, model } });
      expect(recut.status).toBe(202);
      revision = recut.body.data.media_revision;
      expect(await settledStage(piece.itemId, 'cutout')).toMatchObject({ state: 'succeeded', model, media_revision: revision });
    }
    const third = await api(`/items/${piece.itemId}/recut`, { token: a.token, method: 'POST', body: { media_revision: revision, model: 'u2netp' } });
    expect(third.body.error.code).toBe('RETRY_LIMIT_REACHED');
    const unknown = await api(`/items/${piece.itemId}/recut`, { token: a.token, method: 'POST', body: { media_revision: revision, model: 'birefnet' } });
    expect(unknown.status).toBe(422);

    // A photo with no garment fails its cutout once; nothing tries another model.
    const blank = await gatherPiece(a.token, fixtures.blank, 'image/png', { exact: true });
    expect(await settledStage(blank.itemId, 'cutout')).toMatchObject({ state: 'failed', failure_code: 'NO_FOREGROUND' });
    await settleItemStages();
    const [{ cutouts }] = await sql()`select count(*)::int as cutouts from private.jobs where target_id = ${blank.itemId} and stage = 'cutout'`;
    expect(cutouts).toBe(1);
  });
});
