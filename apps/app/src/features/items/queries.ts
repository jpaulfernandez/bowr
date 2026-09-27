import { ITEM_SELECT, Item, ItemPatch, UpdatedItem } from '@bowr/contracts';
import { displayState, searchFilters, type BowerQuery, type Category, type DisplayState } from '@bowr/domain';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest, guardedRead, rpc } from '../../lib/api';
import { track } from '../../lib/analytics';
import { apiErrorFromRpc } from '../../lib/errors';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';

export const PAGE_SIZE = 50;

export const itemKeys = {
  all: (userId: string) => [...userKeys.all(userId), 'items'] as const,
  list: (userId: string) => [...userKeys.all(userId), 'items', 'list'] as const,
  count: (userId: string) => [...userKeys.all(userId), 'items', 'count'] as const,
  one: (userId: string, id: string) => [...userKeys.all(userId), 'items', 'one', id] as const,
};

/** Current (not detached) attachment for a role. */
export const assetFor = (item: Item, role: 'original' | 'cutout' | 'thumbnail' | 'mask') =>
  item.item_assets.find((a) => a.role === role && a.detached_at === null) ?? null;

export const stageFor = (item: Item, stage: 'crop' | 'cutout' | 'colors' | 'embedding' | 'tags') => item.item_stages.find((s) => s.stage === stage) ?? null;

export function itemState(item: Item): DisplayState {
  return displayState(item, item.item_stages, assetFor(item, 'cutout') !== null);
}

/** A stage the server is still working on keeps the view polling. */
export const isProcessing = (item: Item) =>
  item.item_stages.some((s) => ['queued', 'running', 'retry_wait'].includes(s.state));

const Page = z.array(Item);

const SearchPage = z.object({
  ids: z.array(z.string().uuid()),
  next_cursor: z.string().nullable(),
  total: z.number().int(),
  processing: z.number().int(),
});

/**
 * Bower pages for a search (text, facets, sort) with the server's opaque cursor.
 * The owner-scoped RPC returns ordered IDs; the pieces are then read through RLS.
 */
export function useSearchItems(query: BowerQuery) {
  const { userId } = useSession();
  return useInfiniteQuery({
    queryKey: [...itemKeys.list(userId ?? 'none'), query],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const page = await rpc(
        'search_items',
        { p_query: query.q.trim() || null, p_filters: searchFilters(query), p_sort: query.sort, p_cursor: pageParam, p_limit: PAGE_SIZE },
        SearchPage,
        signal,
      );
      const rows = page.ids.length
        ? Page.parse(await guardedRead(() => supabase.from('items').select(ITEM_SELECT).in('id', page.ids).abortSignal(signal)))
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return { ...page, items: page.ids.map((id) => byId.get(id)).filter((row): row is Item => row !== undefined) };
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: userId !== null,
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (q.state.data?.pages.some((page) => page.items.some(isProcessing)) ? 3000 : false),
    refetchIntervalInBackground: false,
  });
}

const BulkResult = z.object({ updated: z.number().int() });
export type BulkOperation = { kind: 'archive' } | { kind: 'restore' } | { kind: 'category'; category: Category };

/** Up to 100 pieces at the revisions shown; the server applies all or none. */
export function useBulkUpdate() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ items, operation, key }: { items: Array<Pick<Item, 'id' | 'revision'>>; operation: BulkOperation; key: string }) =>
      rpc(
        'bulk_update_items',
        { p_request_id: key, p_items: items.map((i) => ({ id: i.id, expected_revision: i.revision })), p_operation: operation },
        BulkResult,
      ),
    onSuccess: (_result, { operation }) => {
      if (operation.kind === 'category') track({ event: 'item_reviewed', properties: { category: operation.category } });
    },
    onSettled: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: itemKeys.all(userId) });
    },
  });
}

/** Permanent deletion at the revision shown. */
export function useDeleteItem(item: Item | null | undefined) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiRequest(`/items/${item!.id}`, { method: 'DELETE', idempotencyKey: key, body: { expected_revision: item!.revision }, schema: z.unknown() }),
    onSettled: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: itemKeys.all(userId) });
    },
  });
}

const DeletionStatus = z.object({ state: z.enum(['deletion_pending', 'deleted']) });

/** Polls until a deleted piece's images are confirmed gone. */
export function useDeletionStatus(itemId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: [...itemKeys.all(userId ?? 'none'), 'deletion', itemId],
    queryFn: ({ signal }) => apiRequest(`/items/${itemId}/deletion`, { schema: DeletionStatus, signal }),
    enabled: userId !== null && typeof itemId === 'string',
    refetchInterval: (q) => (q.state.data?.state === 'deleted' ? false : 3000),
  });
}

/** Active pieces only; archived and deleted pieces are not counted. */
export function useItemCount() {
  const { userId } = useSession();
  return useQuery({
    queryKey: itemKeys.count(userId ?? 'none'),
    queryFn: async ({ signal }) => {
      const { count, error } = await supabase
        .from('items')
        .select('id', { count: 'exact', head: true })
        .eq('lifecycle', 'active')
        .abortSignal(signal);
      if (error) throw apiErrorFromRpc(error);
      return count ?? 0;
    },
    enabled: userId !== null,
  });
}

export function useItem(id: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: itemKeys.one(userId ?? 'none', id ?? 'none'),
    queryFn: async ({ signal }) => {
      const rows = Page.parse(
        await guardedRead(() => supabase.from('items').select(ITEM_SELECT).eq('id', id!).neq('lifecycle', 'deleted').abortSignal(signal)),
      );
      return rows[0] ?? null;
    },
    enabled: userId !== null && typeof id === 'string',
    refetchInterval: (query) => (query.state.data && isProcessing(query.state.data) ? 2000 : false),
    refetchIntervalInBackground: false,
  });
}

/** Revisioned edit. The request identity is reused if the same edit is retried. */
export function useUpdateItem(item: Item | null | undefined) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, key }: { patch: ItemPatch; key: string }) =>
      rpc(
        'update_item',
        { p_request_id: key, p_item_id: item!.id, p_expected_revision: item!.revision, p_patch: ItemPatch.parse(patch) },
        UpdatedItem,
      ),
    onSuccess: (_result, { patch }) => {
      if (patch.category) track({ event: 'item_reviewed', properties: { category: patch.category } });
    },
    onSettled: () => {
      if (!userId || !item) return;
      void queryClient.invalidateQueries({ queryKey: itemKeys.all(userId) });
    },
  });
}

export function useRetryStage(item: Item | null | undefined) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stage: 'crop' | 'cutout' | 'colors' | 'embedding' | 'tags') =>
      apiRequest(`/items/${item!.id}/process`, {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: { stage, media_revision: item!.media_revision },
        schema: z.unknown(),
      }),
    onSettled: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: itemKeys.all(userId) });
    },
  });
}
