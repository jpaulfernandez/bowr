// P1.06 integration: owner-scoped search with synonyms, facets and stable
// cursors; all-or-nothing bulk changes; permanent deletion that ends access at
// once and proves the images are gone.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { autoSelectable, displayName } from '../../../packages/domain/src/items';
import { categoryNoun, categorySynonyms } from '../../../packages/domain/src/taxonomy';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { harnessRerun, internalPost, settledStage, userClient, waitUntil, wardrobeFixtures } from '../../../tests/support/items';
import { settleItemStages } from '../../../tests/support/jobs';
import { createSlot, member, putSlot, storageAdmin, type Member } from '../../../tests/support/media';
import { uniquePng } from '../../../tests/support/png';
import { sql } from '../../../tests/support/stack';
import { seedPieces, wardrobeSpecs, type SeedPiece } from '../../../tests/support/wardrobe';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let fixtures: ReturnType<typeof wardrobeFixtures>;
let a: Member;
let b: Member;
let pieces: SeedPiece[];

type Search = { ids: string[]; next_cursor: string | null; total: number; processing: number };

async function search(token: string, args: { q?: string; filters?: object; sort?: string; cursor?: string | null; limit?: number } = {}) {
  const { data, error } = await userClient(token).rpc('search_items', {
    p_query: args.q ?? null,
    p_filters: args.filters ?? {},
    p_sort: args.sort ?? 'recent',
    p_cursor: args.cursor ?? null,
    p_limit: args.limit ?? 50,
  });
  return { data: data as Search | null, error };
}

/** Walks every page of a search. */
async function allPages(token: string, args: { q?: string; filters?: object; sort?: string; limit: number }) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const { data, error } = await search(token, { ...args, cursor });
    expect(error).toBeNull();
    seen.push(...data!.ids);
    cursor = data!.next_cursor;
    if (!cursor) return seen;
  }
  throw new Error('too many pages');
}

function bulk(token: string, items: Array<{ id: string; expected_revision: number }>, operation: object, key = randomUUID()) {
  return userClient(token).rpc('bulk_update_items', { p_request_id: key, p_items: items, p_operation: operation });
}

const revisions = async (ids: string[]) =>
  (await sql()`select id, revision::int as revision from public.items where id in ${sql()(ids)}`).map((r) => ({
    id: r.id as string,
    expected_revision: r.revision as number,
  }));

beforeAll(async () => {
  fixtures = wardrobeFixtures();
  a = await member(createIdentity, 'find-a');
  b = await member(createIdentity, 'find-b');
  pieces = await seedPieces(a.id, wardrobeSpecs(50));
  // B owns shades too; they never appear in A's results.
  await seedPieces(b.id, wardrobeSpecs(10));
});

beforeEach(async () => {
  await settleItemStages();
});

describe('shared search rules', () => {
  it('the database copies of the synonyms and generated-name nouns match the domain', async () => {
    const [{ synonyms, nouns }] = await sql()`select private.category_synonyms() as synonyms, private.category_nouns() as nouns`;
    expect(synonyms).toEqual(categorySynonyms);
    expect(nouns).toEqual(categoryNoun);
  });
});

describe('P1.06-A1: search, facets and cursors', () => {
  it('"shades" finds eyewear and "pants" finds bottoms; every term must match', async () => {
    const ids = (filter: (p: SeedPiece) => boolean) => pieces.filter(filter).map((p) => p.id).sort();
    const shades = await search(a.token, { q: 'Shades' });
    expect([...shades.data!.ids].sort()).toEqual(ids((p) => p.category === 'eyewear'));
    const pants = await search(a.token, { q: 'pants' });
    expect([...pants.data!.ids].sort()).toEqual(ids((p) => p.category === 'bottoms'));
    // Terms combine with AND: navy tops only.
    const navyShirts = await search(a.token, { q: 'navy  shirt' });
    expect([...navyShirts.data!.ids].sort()).toEqual(ids((p) => p.category === 'tops' && p.colors[0]!.name === 'navy'));
    // Brand and material are searchable; names too.
    expect((await search(a.token, { q: 'uniqlo' })).data!.total).toBe(pieces.filter((p) => p.brand === 'Uniqlo').length);
    expect((await search(a.token, { q: 'aviators 17' })).data!.ids).toEqual([pieces[16]!.id]);
    expect((await search(a.token, { q: 'no such thing' })).data!.total).toBe(0);
  });

  it('OR within a facet and AND across facets give exactly the expected pieces', async () => {
    const { data } = await search(a.token, { filters: { categories: ['tops', 'bottoms'], colors: ['navy', 'olive'], seasons: ['hot'] }, limit: 100 });
    const expected = pieces
      .filter((p) => ['tops', 'bottoms'].includes(p.category) && ['navy', 'olive'].includes(p.colors[0]!.name) && p.seasons.includes('hot'))
      .map((p) => p.id)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect([...data!.ids].sort()).toEqual(expected);
    expect(data!.total).toBe(expected.length);
  });

  it('each sort pages without skipped or repeated pieces, in the documented order', async () => {
    const byRecent = [...pieces].sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? 1 : -1) : x.created_at < y.created_at ? 1 : -1));
    expect(await allPages(a.token, { sort: 'recent', limit: 7 })).toEqual(byRecent.map((p) => p.id));
    const nameOf = (p: SeedPiece) => displayName(p).toLowerCase();
    const byName = [...pieces].sort((x, y) => (nameOf(x) === nameOf(y) ? (x.id < y.id ? -1 : 1) : nameOf(x) < nameOf(y) ? -1 : 1));
    expect(await allPages(a.token, { sort: 'name', limit: 9 })).toEqual(byName.map((p) => p.id));
    for (const sort of ['category', 'color']) {
      const ids = await allPages(a.token, { sort, limit: 11 });
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
    }
    // The database's generated names match the app's.
    const names = await sql()`select id, private.display_name(i) as name from public.items i where user_id = ${a.id}`;
    for (const row of names) expect(row.name).toBe(displayName(pieces.find((p) => p.id === row.id)!));
  });

  it('malformed, tampered and sort-mismatched cursors and invalid filters fail', async () => {
    const first = await search(a.token, { sort: 'name', limit: 5 });
    const cursor = first.data!.next_cursor!;
    const cases: Array<[string, Parameters<typeof search>[1], string]> = [
      ['garbage', { cursor: '%%%not-a-cursor%%%' }, 'INVALID_CURSOR'],
      ['other sort', { sort: 'recent', cursor }, 'INVALID_CURSOR'],
      ['tampered', { sort: 'name', cursor: Buffer.from('{"s":"name","k":"a"}').toString('base64url') }, 'INVALID_CURSOR'],
      ['unknown sort', { sort: 'price' }, 'VALIDATION_FAILED'],
      ['unknown category', { filters: { categories: ['capes'] } }, 'VALIDATION_FAILED'],
      ['unknown facet', { filters: { owner: 'x' } }, 'VALIDATION_FAILED'],
      ['limit', { limit: 101 }, 'VALIDATION_FAILED'],
    ];
    for (const [label, args, code] of cases) {
      const { error } = await search(a.token, args);
      expect([label, error?.message]).toEqual([label, code]);
    }
  });

  it('search is owner-scoped: B never sees A’s pieces', async () => {
    const theirs = await search(b.token, { q: 'shades', limit: 100 });
    const aIds = new Set(pieces.map((p) => p.id));
    expect(theirs.data!.ids.some((id) => aIds.has(id))).toBe(false);
    expect(theirs.data!.total).toBe(2);
  });
});

describe('P1.06-A2: bulk changes are all or nothing', () => {
  it('archive and restore return the same pieces; archived pieces leave default results and automatic use', async () => {
    const chosen = pieces.slice(10, 13).map((p) => p.id);
    const before = await sql()`select id, name, category, colors from public.items where id in ${sql()(chosen)} order by id`;
    const archived = await bulk(a.token, await revisions(chosen), { kind: 'archive' });
    expect(archived.error).toBeNull();
    expect((archived.data as any).updated).toBe(3);
    const hidden = await search(a.token, { limit: 100 });
    expect(hidden.data!.total).toBe(47);
    expect(hidden.data!.ids.some((id) => chosen.includes(id))).toBe(false);
    const shelf = await search(a.token, { filters: { archived: true } });
    expect([...shelf.data!.ids].sort()).toEqual([...chosen].sort());
    const rows = await sql()`select lifecycle, category, category_review_required from public.items where id in ${sql()(chosen)}`;
    for (const row of rows) expect(autoSelectable(row as never)).toBe(false);

    const restored = await bulk(a.token, await revisions(chosen), { kind: 'restore' });
    expect(restored.error).toBeNull();
    expect(await sql()`select id, name, category, colors from public.items where id in ${sql()(chosen)} order by id`).toEqual(before);
    expect((await search(a.token)).data!.total).toBe(50);
  });

  it('a foreign ID or one stale revision changes nothing and names every stale row', async () => {
    const chosen = pieces.slice(20, 24).map((p) => p.id);
    const current = await revisions(chosen);
    const [bPiece] = await sql()`select id, revision::int as revision from public.items where user_id = ${b.id} limit 1`;
    const foreign = await bulk(a.token, [...current, { id: bPiece!.id, expected_revision: bPiece!.revision }], { kind: 'archive' });
    expect(foreign.error?.message).toBe('NOT_FOUND');

    const stale = current.map((r, i) => (i === 1 || i === 3 ? { ...r, expected_revision: r.expected_revision + 5 } : r));
    const conflict = await bulk(a.token, stale, { kind: 'category', category: 'outerwear' });
    expect(conflict.error?.message).toBe('REVISION_CONFLICT');
    const staleIds = stale.filter((r, i) => r.expected_revision !== current[i]!.expected_revision).map((r) => r.id);
    expect(JSON.parse(conflict.error!.details!).stale.map((s: any) => s.id).sort()).toEqual(staleIds.sort());
    const unchanged = await sql()`select count(*)::int as n from public.items where id in ${sql()(chosen)} and category = 'outerwear'`;
    expect(unchanged[0]!.n).toBe(0);

    const tooMany = await bulk(a.token, Array.from({ length: 101 }, () => ({ id: randomUUID(), expected_revision: 1 })), { kind: 'archive' });
    expect(tooMany.error?.message).toBe('VALIDATION_FAILED');
    const repeated = await bulk(a.token, [current[0]!, current[0]!], { kind: 'archive' });
    expect(repeated.error?.message).toBe('VALIDATION_FAILED');
  });

  it('a bulk category change is the member’s own value and resolves review', async () => {
    const chosen = pieces.slice(30, 33).map((p) => p.id);
    const result = await bulk(a.token, await revisions(chosen), { kind: 'category', category: 'outerwear' });
    expect(result.error).toBeNull();
    const rows = await sql()`select category, subcategory, category_review_required, field_meta -> 'category' as meta from public.items where id in ${sql()(chosen)}`;
    for (const row of rows) {
      expect(row).toMatchObject({ category: 'outerwear', category_review_required: false, meta: { source: 'user', locked: true } });
      // A subcategory from another category does not survive.
      expect([null, 'jacket']).toContain(row.subcategory);
    }
  });
});

describe('P1.06-A3: permanent deletion', () => {
  it('ends access at once, proves the images gone, and old work or a replayed upload cannot bring it back', async () => {
    const bytes = uniquePng(fixtures.garment);
    const slot = await createSlot(a.token, bytes, 'image/png');
    expect((await putSlot(slot.entry, bytes)).status).toBe(200);
    expect((await api(`/upload-entries/${slot.entry.entry_id}/complete`, { token: a.token, method: 'POST' })).status).toBe(202);
    const item = await waitUntil(async () => (await sql()`select * from public.items where source_entry_id = ${slot.entry.entry_id}`)[0], 'piece');
    await settleItemStages();
    const slow = await harnessRerun(item.id, 'colors');
    const assets = await sql()`select ia.asset_id, ia.role from public.item_assets ia where ia.item_id = ${item.id} and ia.detached_at is null`;
    expect(assets.map((r) => r.role).sort()).toEqual(['cutout', 'mask', 'original', 'thumbnail']);
    const { revision } = (await sql()`select revision::int from public.items where id = ${item.id}`)[0]!;

    expect((await api(`/items/${item.id}`, { token: b.token, method: 'DELETE', body: { expected_revision: revision } })).status).toBe(404);
    expect((await api(`/items/${item.id}`, { token: a.token, method: 'DELETE', body: { expected_revision: revision - 1 } })).status).toBe(409);
    // Storage is unreachable while the member deletes: the piece still leaves the
    // app at once, and its deletion reads as pending, not done.
    execFileSync('docker', ['stop', 'bowr_storage'], { stdio: 'ignore' });
    try {
      const deleted = await api(`/items/${item.id}`, { token: a.token, method: 'DELETE', body: { expected_revision: revision } });
      expect(deleted.status).toBe(200);
      const grants = await api('/media/access', {
        token: a.token,
        method: 'POST',
        body: { requests: assets.map((r) => ({ asset_id: r.asset_id, variant: r.role })) },
      });
      expect(grants.body.data.every((g: any) => g.status === 'not_found')).toBe(true);
      await maintenance('temporary_cleanup');
      expect((await api(`/items/${item.id}/deletion`, { token: a.token })).body.data.state).toBe('deletion_pending');
    } finally {
      execFileSync('docker', ['start', 'bowr_storage'], { stdio: 'ignore' });
    }
    await waitUntil(async () => fetch('http://127.0.0.1:9000/').then(() => true, () => false), 'storage back');
    // Clock control: the failed attempts' backoff is brought forward.
    await sql()`update private.deletion_tasks set not_before = now() where state = 'pending' and reason = 'item_deleted' and user_id = ${a.id}`;
    const tombstone = (await sql()`select lifecycle, name, category, colors, brand, (select count(*)::int from public.item_embeddings e where e.item_id = i.id) as vectors,
        (select count(*)::int from public.item_suggestions s where s.item_id = i.id) as suggestions from public.items i where id = ${item.id}`)[0];
    expect(tombstone).toEqual({ lifecycle: 'deleted', name: null, category: null, colors: [], brand: null, vectors: 0, suggestions: 0 });
    expect((await userClient(a.token).from('items').select('id').eq('id', item.id).neq('lifecycle', 'deleted')).data).toEqual([]);

    // The old worker's late result is fenced.
    const late = await internalPost(`/jobs/${slow.jobId}/complete`, slow.job.capability, {
      schema_version: 1,
      lease_generation: slow.job.lease_generation,
      outcome: 'ready',
      result: { suggested: { colors: [{ name: 'red', hex: '#CC0000', proportion: 1 }] } },
    });
    expect(late.body.data.status).toBe('stale');
    // A replayed upload of the same slot neither revives nor recreates it.
    await putSlot(slot.entry, bytes);
    const replay = await api(`/upload-entries/${slot.entry.entry_id}/complete`, { token: a.token, method: 'POST' });
    expect([202, 409]).toContain(replay.status);
    expect(await sql()`select 1 from public.items where source_entry_id = ${slot.entry.entry_id} and lifecycle <> 'deleted'`).toHaveLength(0);

    await waitUntil(async () => {
      await maintenance('temporary_cleanup');
      return (await api(`/items/${item.id}/deletion`, { token: a.token })).body.data.state === 'deleted';
    }, 'deletion confirmed');
    for (const { asset_id } of assets) {
      const keys = await sql()`select object_key from private.media_objects where asset_id = ${asset_id} and role <> 'quarantine'`;
      for (const { object_key } of keys) expect(await storageAdmin().exists(object_key)).toBe(false);
    }
    expect((await api(`/items/${item.id}/deletion`, { token: b.token })).status).toBe(404);
    expect((await sql()`select lifecycle from public.items where id = ${item.id}`)[0]!.lifecycle).toBe('deleted');
    await settledStage(item.id, 'colors');
  });
});
