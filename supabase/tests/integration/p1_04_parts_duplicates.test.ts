// P1.04 integration: grouped photos become pieces only when the member confirms
// them, and a repeated photo waits for Use existing / Add another / Decide later.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { fakeGemini } from '../../../tests/support/fake-gemini';
import { createIdentity } from '../../../tests/support/identities';
import { harnessRerun, internalPost, settledStage, userClient, waitUntil, wardrobeFixtures } from '../../../tests/support/items';
import { settleItemStages } from '../../../tests/support/jobs';
import { member, putSlot, sha256, storageAdmin, type Member } from '../../../tests/support/media';
import { uniquePng } from '../../../tests/support/png';
import { sql } from '../../../tests/support/stack';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let fixtures: ReturnType<typeof wardrobeFixtures>;
let a: Member;
let b: Member;

type FileSpec = { name: string; bytes: Buffer; purpose?: 'garment' | 'care_label' | 'grouped'; labelFor?: string };

async function batch(token: string, files: FileSpec[]) {
  const ids = new Map(files.map((f) => [f.name, randomUUID()]));
  const response = await api('/upload-batches', {
    token,
    method: 'POST',
    body: {
      files: files.map((f) => ({
        client_file_id: ids.get(f.name),
        purpose: f.purpose ?? 'garment',
        content_type: 'image/png',
        byte_size: f.bytes.length,
        ...(f.labelFor ? { label_for: ids.get(f.labelFor) } : {}),
      })),
    },
  });
  expect(response.status).toBe(201);
  const entries = new Map<string, any>();
  for (const f of files) entries.set(f.name, response.body.data.entries.find((e: any) => e.client_file_id === ids.get(f.name)));
  return entries;
}

async function send(token: string, entry: any, bytes: Buffer) {
  expect((await putSlot(entry, bytes)).status).toBe(200);
  expect((await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' })).status).toBe(202);
}

/** Uploads one photo and waits until validation has finished. */
async function uploaded(token: string, bytes: Buffer, purpose: FileSpec['purpose'] = 'garment') {
  const entry = (await batch(token, [{ name: 'photo', bytes, purpose }])).get('photo');
  await send(token, entry, bytes);
  const row = await waitUntil(async () => {
    const [e] = await sql()`select * from public.upload_entries where id = ${entry.entry_id}`;
    return ['ready', 'rejected'].includes(e!.state) ? e : null;
  }, `entry ${entry.entry_id}`);
  expect(row.state).toBe('ready');
  return row as { id: string; asset_id: string; proposed_parts: Array<{ x: number; y: number; w: number; h: number }> };
}

const itemsOf = (entryId: string) =>
  sql()`select * from public.items where source_entry_id = ${entryId} order by created_at, id`;
const pieceOf = (entryId: string) =>
  waitUntil(async () => (await itemsOf(entryId))[0], `piece for ${entryId}`);
const imageOf = async (entry: { asset_id: string }) =>
  (await sql()`select width, height from public.media_assets where id = ${entry.asset_id}`)[0] as { width: number; height: number };

function confirm(token: string, entryId: string, body: Record<string, unknown>, key = randomUUID()) {
  return api(`/upload-entries/${entryId}/confirm-parts`, { token, method: 'POST', body, key });
}

const parts = (boxes: Array<{ x: number; y: number; w: number; h: number }>) =>
  boxes.map((box) => ({ part_id: randomUUID(), box }));

async function objectsGone(assetId: string) {
  const keys = await sql()`select object_key from private.media_objects where asset_id = ${assetId}`;
  expect(keys.length).toBeGreaterThan(0);
  await waitUntil(async () => {
    await maintenance('temporary_cleanup');
    for (const { object_key } of keys) if (await storageAdmin().exists(object_key)) return false;
    return true;
  }, `objects of ${assetId} deleted`);
}

const reviewFor = (column: 'entry_id' | 'item_id', id: string) =>
  waitUntil(async () => (await sql()`select * from public.duplicate_reviews where ${sql()(column)} = ${id}`)[0], `review for ${id}`);

function resolve(token: string, reviewId: string, decision: string, key = randomUUID()) {
  return api(`/duplicate-reviews/${reviewId}/resolve`, { token, method: 'POST', body: { decision }, key });
}

beforeAll(async () => {
  fixtures = wardrobeFixtures();
  a = await member(createIdentity, 'parts-a');
  b = await member(createIdentity, 'parts-b');
});

beforeEach(async () => {
  await settleItemStages();
  await fakeGemini.reset();
});

afterAll(async () => {
  await fakeGemini.reset();
});

describe('P1.04-A1: a grouped photo creates pieces only when confirmed', () => {
  it('parts are proposed, nothing is created before confirmation, and confirming two parts twice creates exactly two pieces', async () => {
    const group = await uploaded(a.token, fixtures.accessories, 'grouped');
    // The watch and the bracelet are proposed; neither is a piece yet.
    expect(group.proposed_parts).toHaveLength(2);
    expect(await itemsOf(group.id)).toHaveLength(0);
    const [source] = await sql()`select retention, width, height from public.media_assets where id = ${group.asset_id}`;
    expect(source!.retention).toBe('temporary');
    // Grouped photos keep more pixels so small pieces stay sharp.
    expect(Math.max(source!.width, source!.height)).toBe(800);

    const body = { mode: 'split', image: await imageOf(group), parts: parts(group.proposed_parts) };
    const key = randomUUID();
    const first = await confirm(a.token, group.id, body, key);
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(2);
    const replay = await confirm(a.token, group.id, body, key);
    expect(replay.body.data.items.map((i: any) => i.item_id)).toEqual(first.body.data.items.map((i: any) => i.item_id));
    const again = await confirm(a.token, group.id, body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CONFIRMED');
    const foreign = await confirm(b.token, group.id, body);
    expect(foreign.status).toBe(404);

    const pieces = await itemsOf(group.id);
    expect(pieces).toHaveLength(2);
    expect(new Set(pieces.map((p) => p.source_part_id)).size).toBe(2);
    // Each part is cropped into its own retained original, then processed as usual.
    const originals = [];
    for (const piece of pieces) {
      expect(await settledStage(piece.id, 'crop')).toMatchObject({ state: 'succeeded' });
      expect(await settledStage(piece.id, 'cutout')).toMatchObject({ state: 'succeeded' });
      const [original] = await sql()`select a.id, a.purpose, a.retention, a.width, a.height from public.item_assets ia
        join public.media_assets a on a.id = ia.asset_id where ia.item_id = ${piece.id} and ia.role = 'original' and ia.detached_at is null`;
      expect(original).toMatchObject({ purpose: 'item_original', retention: 'retained' });
      expect(original!.width).toBeLessThan(800);
      originals.push(original!.id);
    }
    expect(new Set([...originals, group.asset_id]).size).toBe(3);
    // The shared grouped source is not kept once every part has its own original.
    await objectsGone(group.asset_id);
  });

  it('a pair of earrings kept as one set is one piece; two photos can make three pieces', async () => {
    const bytes = { 'watch-and-bracelet': uniquePng(fixtures.accessories), earrings: fixtures.earrings };
    const fresh = await batch(a.token, [
      { name: 'watch-and-bracelet', bytes: bytes['watch-and-bracelet'], purpose: 'grouped' },
      { name: 'earrings', bytes: bytes.earrings, purpose: 'grouped' },
    ]);
    await send(a.token, fresh.get('watch-and-bracelet'), bytes['watch-and-bracelet']);
    await send(a.token, fresh.get('earrings'), bytes.earrings);
    const [group, pair] = await Promise.all(['watch-and-bracelet', 'earrings'].map((name) =>
      waitUntil(async () => {
        const [e] = await sql()`select * from public.upload_entries where id = ${fresh.get(name).entry_id}`;
        return e!.state === 'ready' ? e : null;
      }, name)
    ));

    const kept = await confirm(a.token, pair!.id, { mode: 'keep_one', image: await imageOf(pair!) });
    expect(kept.status).toBe(200);
    expect(kept.body.data.items).toHaveLength(1);
    const split = await confirm(a.token, group!.id, { mode: 'split', image: await imageOf(group!), parts: parts(group!.proposed_parts) });
    expect(split.status).toBe(200);
    const [{ pieces }] = await sql()`select count(*)::int as pieces from public.items i join public.upload_entries e on e.id = i.source_entry_id
      where e.batch_id = ${group!.batch_id}`;
    expect(pieces).toBe(3);
    const [earrings] = await itemsOf(pair!.id);
    expect(earrings!.source_part_id).toBeNull();
    expect(await settledStage(earrings!.id, 'crop')).toMatchObject({ state: 'succeeded' });
  });
});

describe('P1.04-A2: invalid parts fail safely and keep the draft', () => {
  it('out-of-bounds, tiny, mismatched-orientation, duplicate and more than 20 parts are refused with nothing created', async () => {
    const group = await uploaded(a.token, uniquePng(fixtures.accessories), 'grouped');
    const image = await imageOf(group);
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ['out of bounds', { mode: 'split', image, parts: parts([{ x: 0.9, y: 0.1, w: 0.2, h: 0.2 }]) }, 422, 'VALIDATION_FAILED'],
      ['tiny', { mode: 'split', image, parts: parts([{ x: 0.1, y: 0.1, w: 0.01, h: 0.01 }]) }, 422, 'VALIDATION_FAILED'],
      ['negative', { mode: 'split', image, parts: parts([{ x: -0.1, y: 0.1, w: 0.3, h: 0.3 }]) }, 422, 'VALIDATION_FAILED'],
      ['rotated view', { mode: 'split', image: { width: image.height, height: image.width }, parts: parts([{ x: 0, y: 0, w: 0.5, h: 0.5 }]) }, 422, 'ORIENTATION_MISMATCH'],
      ['21 parts', { mode: 'split', image, parts: parts(Array.from({ length: 21 }, (_, i) => ({ x: (i % 7) * 0.14, y: Math.floor(i / 7) * 0.3, w: 0.12, h: 0.25 }))) }, 422, 'VALIDATION_FAILED'],
      ['repeated part id', { mode: 'split', image, parts: [{ part_id: '11111111-1111-4111-8111-111111111111', box: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { part_id: '11111111-1111-4111-8111-111111111111', box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }] }, 422, 'VALIDATION_FAILED'],
      ['keep one with parts', { mode: 'keep_one', image, parts: parts([{ x: 0, y: 0, w: 0.5, h: 0.5 }]) }, 422, 'VALIDATION_FAILED'],
      ['unknown mode', { mode: 'merge', image }, 422, 'VALIDATION_FAILED'],
      ['extra box field', { mode: 'split', image, parts: [{ part_id: randomUUID(), box: { x: 0, y: 0, w: 0.5, h: 0.5, owner: 'x' } }] }, 422, 'VALIDATION_FAILED'],
    ];
    for (const [label, body, status, code] of cases) {
      const response = await confirm(a.token, group.id, body);
      expect([label, response.status, response.body.error?.code]).toEqual([label, status, code]);
    }
    const [after] = await sql()`select split, split_confirmed_at, proposed_parts from public.upload_entries where id = ${group.id}`;
    expect(after).toMatchObject({ split: null, split_confirmed_at: null });
    expect(after!.proposed_parts).toEqual(group.proposed_parts);
    expect(await itemsOf(group.id)).toHaveLength(0);

    // Overlap alone is not a duplicate: two overlapping parts are two pieces, never merged.
    const overlapping = await confirm(a.token, group.id, {
      mode: 'split',
      image,
      parts: parts([{ x: 0.1, y: 0.15, w: 0.3, h: 0.7 }, { x: 0.12, y: 0.17, w: 0.3, h: 0.7 }]),
    });
    expect(overlapping.status).toBe(200);
    const pieces = await itemsOf(group.id);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      await settledStage(piece.id, 'embedding');
      await settledStage(piece.id, 'tags');
    }
    const ids = pieces.map((p) => p.id);
    // Siblings from one photo are never compared with each other (a match with an
    // earlier photo of the same watch is a fair question, not a merge).
    expect(await sql()`select 1 from public.duplicate_reviews where item_id in ${sql()(ids)} and existing_item_id in ${sql()(ids)}`)
      .toHaveLength(0);
    expect((await sql()`select lifecycle from public.items where id in ${sql()(pieces.map((p) => p.id))}`).map((r) => r.lifecycle))
      .toEqual(['active', 'active']);
  });
});

describe('P1.04-A3: a repeated photo waits for the member’s decision', () => {
  it('Use existing creates no second piece and moves its care label; B’s identical photo stays B’s own piece', async () => {
    const shirt = uniquePng(fixtures.garment);
    const original = await uploaded(a.token, shirt);
    const existing = await pieceOf(original.id);

    const entries = await batch(a.token, [
      { name: 'again', bytes: shirt },
      { name: 'label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'again' },
    ]);
    await send(a.token, entries.get('again'), shirt);
    await send(a.token, entries.get('label'), fixtures.label);
    const review = await reviewFor('entry_id', entries.get('again').entry_id);
    expect(review).toMatchObject({ basis: 'hash', state: 'pending', existing_item_id: existing!.id, user_id: a.id });
    expect(await itemsOf(entries.get('again').entry_id)).toHaveLength(0);

    // B's identical bytes are simply B's piece: no review, nothing about A.
    const theirs = await uploaded(b.token, shirt);
    await waitUntil(async () => (await itemsOf(theirs.id)).length === 1, 'B piece');
    expect(await sql()`select 1 from public.duplicate_reviews where user_id = ${b.id}`).toHaveLength(0);
    const peek = await userClient(b.token).from('duplicate_reviews').select('id');
    expect(peek.data).toEqual([]);
    expect((await resolve(b.token, review.id, 'use_existing')).status).toBe(404);

    const key = randomUUID();
    const used = await resolve(a.token, review.id, 'use_existing', key);
    expect(used.status).toBe(200);
    expect(used.body.data).toMatchObject({ state: 'use_existing', item_id: existing!.id });
    expect((await resolve(a.token, review.id, 'use_existing', key)).body.data).toEqual(used.body.data);
    expect(await itemsOf(entries.get('again').entry_id)).toHaveLength(0);
    // The label follows to the piece the member already has.
    await waitUntil(async () => (await sql()`select 1 from public.item_assets where item_id = ${existing!.id} and role = 'label'
      and asset_id = ${entries.get('label').asset_id}`).length === 1, 'label moved');
    await objectsGone(entries.get('again').asset_id);
  });

  it('Add another creates a separate piece with its own assets; Decide later survives reopening', async () => {
    const shirt = uniquePng(fixtures.garment);
    const original = await uploaded(a.token, shirt);
    const existing = await pieceOf(original.id);
    const repeat = await uploaded(a.token, shirt);
    const review = await reviewFor('entry_id', repeat.id);

    // Decide later: nothing is called; a new session still sees the pending choice.
    const reopened = await userClient(a.token).from('duplicate_reviews').select('id, state, entry_id, existing_item_id').eq('id', review.id);
    expect(reopened.data).toEqual([{ id: review.id, state: 'pending', entry_id: repeat.id, existing_item_id: existing!.id }]);
    expect(await itemsOf(repeat.id)).toHaveLength(0);

    const added = await resolve(a.token, review.id, 'add_another');
    expect(added.status).toBe(200);
    const [second] = await itemsOf(repeat.id);
    expect(added.body.data.item_id).toBe(second!.id);
    expect(second!.id).not.toBe(existing!.id);
    const originals = await sql()`select ia.item_id, ia.asset_id from public.item_assets ia
      where ia.item_id in (${existing!.id}, ${second!.id}) and ia.role = 'original' and ia.detached_at is null`;
    expect(new Set(originals.map((o) => o.asset_id)).size).toBe(2);
    expect((await resolve(a.token, review.id, 'use_existing')).body.error.code).toBe('ALREADY_DECIDED');
    // Identical garments stay distinct: the decided piece is not flagged again.
    await settledStage(second!.id, 'embedding');
    await settledStage(second!.id, 'tags');
    expect(await sql()`select 1 from public.duplicate_reviews where item_id = ${second!.id}`).toHaveLength(0);
  });

  it('a near match flags the newer piece; Use existing discards it and Keep both keeps it; a different garment is not flagged', async () => {
    const first = await uploaded(a.token, uniquePng(fixtures.garment));
    const older = await pieceOf(first.id);
    await settledStage(older!.id, 'embedding');

    const near = await uploaded(a.token, uniquePng(fixtures.garment));
    const newer = await pieceOf(near.id);
    const flagged = await reviewFor('item_id', newer!.id);
    expect(flagged).toMatchObject({ basis: 'vector', state: 'pending' });
    expect(flagged.similarity).toBeGreaterThanOrEqual(0.92);
    const [{ lifecycle }] = await sql()`select lifecycle from public.items where id = ${newer!.id}`;
    expect(lifecycle).toBe('active');

    const assets = await sql()`select asset_id from public.item_assets where item_id = ${newer!.id} and detached_at is null`;
    const used = await resolve(a.token, flagged.id, 'use_existing');
    expect(used.status).toBe(200);
    const [gone] = await sql()`select lifecycle, name, brand, (select count(*)::int from public.item_embeddings e where e.item_id = i.id) as vectors
      from public.items i where i.id = ${newer!.id}`;
    expect(gone).toEqual({ lifecycle: 'deleted', name: null, brand: null, vectors: 0 });
    for (const { asset_id } of assets) await objectsGone(asset_id);

    const kept = await uploaded(a.token, uniquePng(fixtures.garment));
    const keptPiece = await pieceOf(kept.id);
    const keepReview = await reviewFor('item_id', keptPiece!.id);
    expect((await resolve(a.token, keepReview.id, 'add_another')).status).toBe(200);
    expect((await sql()`select lifecycle from public.items where id = ${keptPiece!.id}`)[0]!.lifecycle).toBe('active');

    const trousers = await uploaded(a.token, uniquePng(fixtures.trousers));
    const other = await pieceOf(trousers.id);
    await settledStage(other!.id, 'embedding');
    await settledStage(other!.id, 'tags');
    expect(await sql()`select 1 from public.duplicate_reviews where item_id = ${other!.id}`).toHaveLength(0);
  });
});

describe('P1.04-A4: canceling, removing a part and cleaning the source', () => {
  it('canceling an unconfirmed group deletes its photo; a removed part is never recreated while the other stays viewable', async () => {
    const abandoned = await uploaded(a.token, uniquePng(fixtures.accessories), 'grouped');
    expect((await api(`/upload-entries/${abandoned.id}/cancel`, { token: a.token, method: 'POST' })).status).toBe(200);
    await objectsGone(abandoned.asset_id);
    const late = await confirm(a.token, abandoned.id, { mode: 'keep_one', image: await imageOf(abandoned) });
    expect(late.body.error.code).toBe('PARTS_NOT_AVAILABLE');

    // Confirmed without the API's dispatch, so the harness can hold one crop open
    // as a slow worker would while the member removes that part.
    const group = await uploaded(a.token, uniquePng(fixtures.accessories), 'grouped');
    await settleItemStages();
    const [{ result }] = await sql()`select public.svc_confirm_parts(${a.id}, ${randomUUID()}, ${group.id}, 'split',
      ${sql().json(await imageOf(group))}, ${sql().json(parts(group.proposed_parts))}) as result`;
    const [removed, remaining] = result.items as Array<{ item_id: string; job_id: string }>;
    const slow = await harnessRerun(removed!.item_id, 'crop', { settle: false });

    await sql()`select private.discard_item(${removed!.item_id}, 'duplicate_discarded')`;
    // The slow worker's crop arrives after the part was removed: it is fenced.
    const bytes = Buffer.from(await (await fetch(slow.job.sources.source.url)).arrayBuffer());
    expect((await fetch(slow.job.outputs.original.url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: bytes })).status).toBe(200);
    const late2 = await internalPost(`/jobs/${slow.jobId}/complete`, slow.job.capability, {
      schema_version: 1,
      lease_generation: slow.job.lease_generation,
      outcome: 'ready',
      outputs: { original: { width: 800, height: 600, byte_size: bytes.length, sha256: sha256(bytes) } },
    });
    expect(late2).toMatchObject({ status: 200, body: { data: { status: 'stale' } } });
    await maintenance('dispatch_jobs');
    expect(await settledStage(remaining!.item_id, 'crop')).toMatchObject({ state: 'succeeded' });
    const [part] = await sql()`select lifecycle, (select count(*)::int from public.item_assets ia where ia.item_id = i.id and ia.detached_at is null) as attached
      from public.items i where i.id = ${removed!.item_id}`;
    expect(part).toEqual({ lifecycle: 'deleted', attached: 0 });
    const lateKey = decodeURIComponent(new URL(slow.job.outputs.original.url).pathname.replace(/^\/bowr-private\//, ''));
    await waitUntil(async () => !(await storageAdmin().exists(lateKey)), 'fenced crop output deleted');
    // Confirming again cannot bring the removed part back.
    expect((await confirm(a.token, group.id, { mode: 'split', image: await imageOf(group), parts: parts(group.proposed_parts) })).body.error.code)
      .toBe('ALREADY_CONFIRMED');
    expect((await itemsOf(group.id)).filter((i) => i.lifecycle === 'active')).toHaveLength(1);

    // The other part keeps its own original after the grouped source is cleaned.
    await objectsGone(group.asset_id);
    const [kept] = await sql()`select asset_id from public.item_assets where item_id = ${remaining!.item_id} and role = 'original' and detached_at is null`;
    const grant = await api('/media/access', { token: a.token, method: 'POST', body: { requests: [{ asset_id: kept!.asset_id, variant: 'original' }] } });
    expect(grant.body.data[0].status).toBe('ok');
    expect((await fetch(grant.body.data[0].url)).status).toBe(200);
  });
});

describe('P1.04-T4: manual rectangles and keep-one work with AI paused', () => {
  it('pieces are cropped and made without any provider call while AI is paused', async () => {
    await sql()`update private.budget_settings set paused_reason = 'operator' where id`;
    try {
      const group = await uploaded(a.token, uniquePng(fixtures.accessories), 'grouped');
      const pair = await uploaded(a.token, uniquePng(fixtures.earrings), 'grouped');
      // Rectangles typed by the member, ignoring the proposals.
      const manual = await confirm(a.token, group.id, {
        mode: 'split',
        image: await imageOf(group),
        parts: parts([{ x: 0.1, y: 0.15, w: 0.25, h: 0.7 }, { x: 0.55, y: 0.25, w: 0.35, h: 0.5 }]),
      });
      expect(manual.status).toBe(200);
      expect((await confirm(a.token, pair.id, { mode: 'keep_one', image: await imageOf(pair) })).status).toBe(200);
      const pieces = [...(await itemsOf(group.id)), ...(await itemsOf(pair.id))];
      expect(pieces).toHaveLength(3);
      for (const piece of pieces) {
        expect(await settledStage(piece.id, 'crop')).toMatchObject({ state: 'succeeded' });
        expect(await settledStage(piece.id, 'cutout')).toMatchObject({ state: 'succeeded' });
        expect((await settledStage(piece.id, 'tags')).state).not.toBe('succeeded');
      }
      expect((await fakeGemini.calls()).generate_content).toBe(0);
    } finally {
      await sql()`update private.budget_settings set paused_reason = null where id`;
    }
  });
});
