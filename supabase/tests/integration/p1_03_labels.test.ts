// P1.03 integration: a mixed batch with care labels. Labels attach to one
// garment, never create pieces, fill only unlocked facts, and can be removed.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { fakeGemini } from '../../../tests/support/fake-gemini';
import { createIdentity } from '../../../tests/support/identities';
import { gatherPiece, settledStage, userClient, waitUntil, wardrobeFixtures } from '../../../tests/support/items';
import { settleItemStages } from '../../../tests/support/jobs';
import { member, mediaFixtures, putSlot, storageAdmin, type Member } from '../../../tests/support/media';
import { uniquePng } from '../../../tests/support/png';
import { sql } from '../../../tests/support/stack';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let fixtures: ReturnType<typeof wardrobeFixtures>;
let media: ReturnType<typeof mediaFixtures>;
let a: Member;
let b: Member;

type FileSpec = { name: string; bytes: Buffer; purpose?: 'garment' | 'care_label'; labelFor?: string; targetItem?: string };

/** Creates one batch through the public API; returns entries keyed by name. */
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
        ...(f.targetItem ? { target_item_id: f.targetItem } : {}),
      })),
    },
  });
  if (response.status !== 201) return { response, entries: new Map<string, any>() };
  const entries = new Map<string, any>();
  for (const f of files) entries.set(f.name, response.body.data.entries.find((e: any) => e.client_file_id === ids.get(f.name)));
  return { response, entries };
}

async function send(token: string, entry: any, bytes: Buffer) {
  expect((await putSlot(entry, bytes)).status).toBe(200);
  expect((await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST' })).status).toBe(202);
}

const entryState = async (entryId: string) =>
  waitUntil(async () => {
    const [row] = await sql()`select state from public.upload_entries where id = ${entryId}`;
    return ['ready', 'rejected', 'failed'].includes(row!.state) ? row!.state : null;
  }, `entry ${entryId}`);

const itemOf = async (entryId: string) => (await sql()`select * from public.items where source_entry_id = ${entryId}`)[0];
const labels = (itemId: string) =>
  sql()`select ia.asset_id, ia.detached_at, a.state, a.retention from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
    where ia.item_id = ${itemId} and ia.role = 'label' order by ia.id`;

beforeAll(async () => {
  fixtures = wardrobeFixtures();
  media = mediaFixtures();
  a = await member(createIdentity, 'labels-a');
  b = await member(createIdentity, 'labels-b');
});

beforeEach(async () => {
  await settleItemStages();
  await fakeGemini.reset();
});

afterAll(async () => {
  await fakeGemini.reset();
});

describe('P1.03-A1: twenty source photos including labels; mixed outcomes keep what succeeded', () => {
  it('exactly 20 files including labels are accepted; a twenty-first is refused before any slot is signed', async () => {
    const twenty: FileSpec[] = [
      ...Array.from({ length: 17 }, (_, i) => ({ name: `g${i}`, bytes: fixtures.garment })),
      ...Array.from({ length: 3 }, (_, i) => ({ name: `l${i}`, bytes: fixtures.label, purpose: 'care_label' as const, labelFor: `g${i}` })),
    ];
    const accepted = await batch(a.token, twenty);
    expect(accepted.response.status).toBe(201);
    expect(accepted.response.body.data.entries).toHaveLength(20);
    expect(accepted.response.body.data.entries.every((e: any) => e.upload?.url)).toBe(true);
    const [{ labelled }] = await sql()`select count(*)::int as labelled from public.upload_entries
      where batch_id = ${accepted.response.body.data.batch_id} and purpose = 'care_label' and parent_entry_id is not null`;
    expect(labelled).toBe(3);

    const [{ before }] = await sql()`select count(*)::int as before from public.upload_batches where user_id = ${a.id}`;
    const tooMany = await batch(a.token, [...twenty, { name: 'extra', bytes: fixtures.label, purpose: 'care_label', labelFor: 'g4' }]);
    expect(tooMany.response.status).toBe(422);
    expect(tooMany.response.body.error.code).toBe('VALIDATION_FAILED');
    const [{ after }] = await sql()`select count(*)::int as after from public.upload_batches where user_id = ${a.id}`;
    expect(after).toBe(before);
  });

  it('a corrupt file and an unsent file do not undo the good garment or its label; labels never become pieces', async () => {
    const corrupt = Buffer.from('<html>not an image</html>');
    const { entries } = await batch(a.token, [
      { name: 'shirt', bytes: fixtures.garment },
      { name: 'shirt-label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'shirt' },
      { name: 'broken', bytes: corrupt },
      { name: 'broken-label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'broken' },
      { name: 'unsent', bytes: fixtures.trousers },
    ]);
    // The label arrives first; it attaches once its garment becomes a piece.
    await send(a.token, entries.get('shirt-label'), fixtures.label);
    await send(a.token, entries.get('broken'), corrupt);
    await send(a.token, entries.get('broken-label'), fixtures.label);
    await send(a.token, entries.get('shirt'), fixtures.garment);
    expect(await entryState(entries.get('shirt').entry_id)).toBe('ready');
    expect(await entryState(entries.get('broken').entry_id)).toBe('rejected');
    expect(await entryState(entries.get('shirt-label').entry_id)).toBe('ready');
    expect(await entryState(entries.get('broken-label').entry_id)).toBe('ready');

    const shirt = await waitUntil(() => itemOf(entries.get('shirt').entry_id), 'shirt piece');
    await waitUntil(async () => (await labels(shirt.id)).length === 1, 'label attached');
    const [attached] = await labels(shirt.id);
    expect(attached).toMatchObject({ asset_id: entries.get('shirt-label').asset_id, detached_at: null, retention: 'retained' });
    // Only the one garment that succeeded became a piece.
    const [{ pieces }] = await sql()`select count(*)::int as pieces from public.items i
      join public.upload_entries e on e.id = i.source_entry_id where e.batch_id = (select batch_id from public.upload_entries where id = ${entries.get('shirt').entry_id})`;
    expect(pieces).toBe(1);
    expect(await sql()`select 1 from public.items where source_entry_id = ${entries.get('shirt-label').entry_id}`).toHaveLength(0);
    const [unsent] = await sql()`select state from public.upload_entries where id = ${entries.get('unsent').entry_id}`;
    expect(unsent!.state).toBe('awaiting_upload');

    // The label for the unusable garment stays temporary and is deleted when its
    // temporary window ends; it is never kept unattached.
    const brokenLabel = entries.get('broken-label');
    const [asset] = await sql()`select retention from public.media_assets where id = ${brokenLabel.asset_id}`;
    expect(asset!.retention).toBe('temporary');
    await sql()`update public.media_assets set expires_at = now() - interval '1 second' where id = ${brokenLabel.asset_id}`;
    const cleanup = await maintenance('temporary_cleanup');
    expect(cleanup.body.data.labels_expired).toBeGreaterThanOrEqual(1);
    const objects = await sql()`select object_key, deleted_at from private.media_objects where asset_id = ${brokenLabel.asset_id} and role = 'original'`;
    await waitUntil(async () => {
      await maintenance('temporary_cleanup');
      return !(await storageAdmin().exists(objects[0]!.object_key));
    }, 'expired label deleted');
    const [entry] = await sql()`select state from public.upload_entries where id = ${brokenLabel.entry_id}`;
    expect(entry!.state).toBe('canceled');
  });
});

describe('P1.03-A3: label facts fill unlocked fields; removal keeps them', () => {
  it('a readable label fills brand, size and material; a vision guess never replaces the printed material', async () => {
    const shirtPhoto = uniquePng(fixtures.garment);
    const { entries } = await batch(a.token, [
      { name: 'shirt', bytes: shirtPhoto },
      { name: 'label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'shirt' },
    ]);
    await send(a.token, entries.get('shirt'), shirtPhoto);
    await send(a.token, entries.get('label'), fixtures.label);
    const shirt = await waitUntil(() => itemOf(entries.get('shirt').entry_id), 'piece');
    await settledStage(shirt.id, 'label');
    await settledStage(shirt.id, 'tags');
    const [after] = await sql()`select brand, size_label, material, field_meta from public.items where id = ${shirt.id}`;
    expect(after).toMatchObject({ brand: 'Uniqlo', size_label: 'M', material: '100% cotton', });
    expect(after!.field_meta.brand).toMatchObject({ source: 'label', locked: false });
    expect(after!.field_meta.material).toMatchObject({ source: 'label' });
    // The provider saw a label photo; the gateway sent one image per call.
    expect((await fakeGemini.calls()).last_had_image).toBe(true);
  });

  it('a label added to an existing piece fills only unlocked fields and leaves the member’s brand', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    await settleItemStages();
    const [{ revision }] = await sql()`select revision from public.items where id = ${piece.itemId}`;
    const locked = await userClient(a.token).rpc('update_item', {
      p_request_id: randomUUID(), p_item_id: piece.itemId, p_expected_revision: Number(revision), p_patch: { brand: 'Thrifted' },
    });
    expect(locked.error).toBeNull();
    const { entries } = await batch(a.token, [{ name: 'label', bytes: fixtures.label, purpose: 'care_label', targetItem: piece.itemId }]);
    await send(a.token, entries.get('label'), fixtures.label);
    await waitUntil(async () => (await labels(piece.itemId)).length === 1, 'label attached');
    await settledStage(piece.itemId, 'label');
    const [after] = await sql()`select brand, size_label from public.items where id = ${piece.itemId}`;
    expect(after).toEqual({ brand: 'Thrifted', size_label: 'M' });
    const [{ pieces }] = await sql()`select count(*)::int as pieces from public.items where user_id = ${a.id} and source_entry_id = ${entries.get('label').entry_id}`;
    expect(pieces).toBe(0);
  });

  it('an unreadable label leaves the garment usable; invalid label text is rejected safely', async () => {
    const shirtPhoto = uniquePng(fixtures.garment);
    const otherShirt = uniquePng(fixtures.garment);
    await fakeGemini.control({ label: {} });
    const unreadable = await batch(a.token, [
      { name: 'shirt', bytes: shirtPhoto },
      { name: 'label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'shirt' },
    ]);
    await send(a.token, unreadable.entries.get('shirt'), shirtPhoto);
    await send(a.token, unreadable.entries.get('label'), fixtures.label);
    const first = await waitUntil(() => itemOf(unreadable.entries.get('shirt').entry_id), 'piece');
    expect(await settledStage(first.id, 'label')).toMatchObject({ state: 'succeeded' });
    const [plain] = await sql()`select brand, size_label, lifecycle from public.items where id = ${first.id}`;
    expect(plain).toEqual({ brand: null, size_label: null, lifecycle: 'active' });

    await fakeGemini.control({ label: { brand: 'Visit https://example.test to claim', size_label: 'M' } });
    const invalid = await batch(a.token, [
      { name: 'shirt', bytes: otherShirt },
      { name: 'label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'shirt' },
    ]);
    await send(a.token, invalid.entries.get('shirt'), otherShirt);
    await send(a.token, invalid.entries.get('label'), fixtures.label);
    const second = await waitUntil(() => itemOf(invalid.entries.get('shirt').entry_id), 'piece');
    expect(await settledStage(second.id, 'label')).toMatchObject({ state: 'failed', failure_code: 'AI_INVALID_OUTPUT' });
    const [kept] = await sql()`select brand, size_label from public.items where id = ${second.id}`;
    expect(kept).toEqual({ brand: null, size_label: null });
  });

  it('removing the label deletes its image while the values it filled remain; B cannot remove it', async () => {
    const shirtPhoto = uniquePng(fixtures.garment);
    const { entries } = await batch(a.token, [
      { name: 'shirt', bytes: shirtPhoto },
      { name: 'label', bytes: fixtures.label, purpose: 'care_label', labelFor: 'shirt' },
    ]);
    await send(a.token, entries.get('shirt'), shirtPhoto);
    await send(a.token, entries.get('label'), fixtures.label);
    const shirt = await waitUntil(() => itemOf(entries.get('shirt').entry_id), 'piece');
    await settledStage(shirt.id, 'label');
    const labelAsset = entries.get('label').asset_id as string;
    const keys = await sql()`select object_key from private.media_objects where asset_id = ${labelAsset} and deleted_at is null`;
    expect(keys.length).toBeGreaterThan(0);

    const foreign = await api(`/media/${labelAsset}`, { token: b.token, method: 'DELETE' });
    expect(foreign.status).toBe(404);
    const removed = await api(`/media/${labelAsset}`, { token: a.token, method: 'DELETE' });
    expect(removed.status).toBe(200);
    // Access ends at once; bytes are deleted and confirmed absent.
    const grant = await api('/media/access', { token: a.token, method: 'POST', body: { requests: [{ asset_id: labelAsset, variant: 'original' }] } });
    expect(grant.body.data[0].status).toBe('not_found');
    await waitUntil(async () => {
      await maintenance('temporary_cleanup');
      for (const { object_key } of keys) if (await storageAdmin().exists(object_key)) return false;
      return true;
    }, 'label bytes deleted');
    const [after] = await sql()`select brand, size_label, material, lifecycle from public.items where id = ${shirt.id}`;
    expect(after).toMatchObject({ brand: 'Uniqlo', size_label: 'M', lifecycle: 'active' });
    // The asset reads "deleted" only after its raw upload key's post-expiry recheck
    // also completes; until then it is truthfully pending, never viewable.
    expect(['deletion_pending', 'deleted']).toContain((await labels(shirt.id))[0]!.state);
    expect((await api(`/media/${labelAsset}`, { token: a.token, method: 'DELETE' })).status).toBe(404);
  });
});

describe('P1.03 authority: a label names one of the member’s own garments', () => {
  it('labels must name a garment in the batch or an owned piece; garments cannot carry label targets', async () => {
    const piece = await gatherPiece(a.token, fixtures.garment);
    const cases: FileSpec[][] = [
      [{ name: 'l', bytes: fixtures.label, purpose: 'care_label' }],
      [{ name: 'l', bytes: fixtures.label, purpose: 'care_label', labelFor: 'nope' }],
      [
        { name: 'other-label', bytes: fixtures.label, purpose: 'care_label' },
        { name: 'l', bytes: fixtures.label, purpose: 'care_label', labelFor: 'other-label' },
      ],
      [{ name: 'g', bytes: fixtures.garment, targetItem: piece.itemId }],
    ];
    for (const files of cases) {
      const result = await batch(a.token, files);
      expect(result.response.status, JSON.stringify(files.map((f) => f.name))).toBe(422);
    }
    // B cannot attach a label to A's piece, and learns only "not found".
    const foreign = await batch(b.token, [{ name: 'l', bytes: fixtures.label, purpose: 'care_label', targetItem: piece.itemId }]);
    expect(foreign.response.status).toBe(404);
    // Labels keep the 2048 px care-label size limit; garments keep 1024 px.
    const big = await batch(a.token, [{ name: 'l', bytes: media.png, purpose: 'care_label', targetItem: piece.itemId }]);
    expect(big.response.status).toBe(201);
    const [asset] = await sql()`select purpose from public.media_assets where id = ${big.entries.get('l').asset_id}`;
    expect(asset!.purpose).toBe('care_label');
  });
});
