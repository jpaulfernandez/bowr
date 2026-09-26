import { ITEM_SELECT, Item, ItemPatch, UpdatedItem } from '@bowr/contracts';
import { displayState, type DisplayState } from '@bowr/domain';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest, guardedRead, rpc } from '../../lib/api';
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

export const stageFor = (item: Item, stage: 'cutout' | 'colors' | 'embedding' | 'tags') => item.item_stages.find((s) => s.stage === stage) ?? null;

export function itemState(item: Item): DisplayState {
  return displayState(item, item.item_stages, assetFor(item, 'cutout') !== null);
}

/** A stage the server is still working on keeps the view polling. */
export const isProcessing = (item: Item) =>
  item.item_stages.some((s) => ['queued', 'running', 'retry_wait'].includes(s.state));

const Page = z.array(Item);

/** Bower pages, newest first, with a stable keyset cursor (created_at, id). */
export function useBowerItems() {
  const { userId } = useSession();
  return useInfiniteQuery({
    queryKey: itemKeys.list(userId ?? 'none'),
    initialPageParam: null as { created_at: string; id: string } | null,
    queryFn: async ({ pageParam, signal }) => {
      let query = supabase
        .from('items')
        .select(ITEM_SELECT)
        .eq('lifecycle', 'active')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE);
      if (pageParam) {
        query = query.or(`created_at.lt.${pageParam.created_at},and(created_at.eq.${pageParam.created_at},id.lt.${pageParam.id})`);
      }
      return Page.parse(await guardedRead(() => query.abortSignal(signal)));
    },
    getNextPageParam: (page) =>
      page.length === PAGE_SIZE ? { created_at: page[page.length - 1]!.created_at, id: page[page.length - 1]!.id } : undefined,
    enabled: userId !== null,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.some(isProcessing)) ? 3000 : false),
    refetchIntervalInBackground: false,
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
    mutationFn: (stage: 'cutout' | 'colors' | 'embedding' | 'tags') =>
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
