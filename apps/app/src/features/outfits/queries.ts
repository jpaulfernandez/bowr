import { OUTFIT_SELECT, Outfit, OutfitMutationResult, ITEM_SELECT, Item, type OutfitPiece } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { guardedRead, rpc } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { itemKeys } from '../items/queries';

const Outfits = z.array(Outfit);
const Items = z.array(Item);
const keys = {
  all: (userId: string) => [...userKeys.all(userId), 'outfits'] as const,
  one: (userId: string, id: string) => [...userKeys.all(userId), 'outfits', id] as const,
};

export function useOutfits() {
  const { userId } = useSession();
  return useQuery({
    queryKey: keys.all(userId ?? 'none'),
    queryFn: async ({ signal }) => Outfits.parse(await guardedRead(() => supabase.from('outfits').select(OUTFIT_SELECT)
      .is('deleted_at', null).order('created_at', { ascending: false }).order('id').abortSignal(signal))),
    enabled: userId !== null,
  });
}

export function useOutfit(id: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: keys.one(userId ?? 'none', id ?? 'none'),
    queryFn: async ({ signal }) => {
      const rows = Outfits.parse(await guardedRead(() => supabase.from('outfits').select(OUTFIT_SELECT)
        .eq('id', id!).is('deleted_at', null).abortSignal(signal)));
      return rows[0] ?? null;
    },
    enabled: userId !== null && !!id,
  });
}

export function useOutfitPieces() {
  const { userId } = useSession();
  return useQuery({
    queryKey: [...itemKeys.all(userId ?? 'none'), 'outfit-picker'],
    queryFn: async ({ signal }) => Items.parse(await guardedRead(() => supabase.from('items').select(ITEM_SELECT)
      .neq('lifecycle', 'deleted').order('created_at', { ascending: false }).limit(1000).abortSignal(signal))),
    enabled: userId !== null,
  });
}

export function useSaveOutfit() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: string; id?: string; revision?: number; name: string | null; pieces: OutfitPiece[] }) =>
      rpc('save_outfit', { p_request_id: args.key, p_outfit_id: args.id ?? null,
        p_expected_revision: args.revision ?? null, p_name: args.name, p_pieces: args.pieces }, OutfitMutationResult),
    onSettled: () => { if (userId) void queryClient.invalidateQueries({ queryKey: keys.all(userId) }); },
  });
}

export function useLoveOutfit() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: string; id: string; revision: number; loved: boolean }) =>
      rpc('set_outfit_loved', { p_request_id: args.key, p_outfit_id: args.id,
        p_expected_revision: args.revision, p_loved: args.loved }, OutfitMutationResult),
    onSettled: () => { if (userId) void queryClient.invalidateQueries({ queryKey: keys.all(userId) }); },
  });
}

export function useDeleteOutfit() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { key: string; id: string; revision: number }) =>
      rpc('delete_outfit', { p_request_id: args.key, p_outfit_id: args.id,
        p_expected_revision: args.revision }, OutfitMutationResult),
    onSettled: () => { if (userId) void queryClient.invalidateQueries({ queryKey: keys.all(userId) }); },
  });
}
