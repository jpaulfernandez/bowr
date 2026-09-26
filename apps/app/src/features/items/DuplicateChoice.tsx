import { DUPLICATE_REVIEW_SELECT, DuplicateReview } from '@bowr/contracts';
import { displayName } from '@bowr/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Heading, Text } from '../../components/Text';
import { apiRequest, guardedRead } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { PieceImage } from './PieceImage';
import { useItem } from './queries';

const reviewKeys = (userId: string) => [...userKeys.all(userId), 'duplicate-reviews'] as const;

/**
 * Possible duplicates for these upload entries or pieces (owner only, RLS).
 * `refreshKey` changes when the subjects' processing does: a near match is
 * found only once tags and matching finish, so the question can appear late.
 */
export function useDuplicateReviews(column: 'entry_id' | 'item_id', ids: string[], refreshKey = '') {
  const { userId } = useSession();
  return useQuery({
    queryKey: [...reviewKeys(userId ?? 'none'), column, ids.join(','), refreshKey],
    queryFn: async ({ signal }) =>
      z.array(DuplicateReview).parse(
        await guardedRead(() => supabase.from('duplicate_reviews').select(DUPLICATE_REVIEW_SELECT).in(column, ids).abortSignal(signal)),
      ),
    enabled: userId !== null && ids.length > 0,
  });
}

const Resolved = z.object({ review_id: z.string().uuid(), state: z.string(), item_id: z.string().uuid().nullable() });

/**
 * Use existing / Add another / Decide later, with both images visible (DESIGN
 * 6.4). Identical garments can be real separate pieces, so nothing is merged
 * automatically and "Decide later" keeps the question for next time.
 */
export function DuplicateChoice({ review, photo, label }: { review: DuplicateReview; photo: ReactNode; label: string }) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const existing = useItem(review.existing_item_id ?? undefined);
  const [later, setLater] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; decision: string } | null>(null);
  const exact = review.basis === 'hash';

  const resolve = useMutation({
    mutationFn: (decision: 'use_existing' | 'add_another') => {
      if (!request.current || request.current.decision !== decision) request.current = { key: crypto.randomUUID(), decision };
      return apiRequest(`/duplicate-reviews/${review.id}/resolve`, {
        method: 'POST',
        idempotencyKey: request.current.key,
        body: { decision },
        schema: Resolved,
      });
    },
    onSuccess: (result) => {
      setConfirming(false);
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.all(userId) });
      // A new piece that was discarded has nothing left to show: go to the one kept.
      if (!exact && result.state === 'use_existing' && result.item_id) router.replace(`/wardrobe/items/${result.item_id}`);
    },
    onError: (err) => {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : "That choice wasn't saved. Try again.");
    },
  });

  if (later) {
    return (
      <View className="gap-2">
        <Text variant="secondary">You can decide later. This question stays here.</Text>
        <Button label={`Decide now for ${label}`} variant="quiet" className="self-start" onPress={() => setLater(false)} />
      </View>
    );
  }

  const existingName = existing.data ? displayName(existing.data) : null;
  return (
    <View role="group" aria-label={`Possible duplicate: ${label}`} className="gap-3 rounded-control border border-divider bg-surface-subtle p-3">
      <Heading level={3}>{exact ? 'This photo is already in your Bower' : 'This looks like a piece you already have'}</Heading>
      <View className="flex-row flex-wrap gap-4">
        <View className="gap-1">
          {photo}
          <Text variant="secondary">{exact ? 'This photo' : 'This new piece'}</Text>
        </View>
        <View className="gap-1">
          {existing.data ? (
            <PieceImage item={existing.data} size={120} label={`Your existing piece: ${existingName}`} />
          ) : (
            <View aria-hidden style={{ width: 120, height: 120 }} className="rounded-image bg-surface" />
          )}
          <Text variant="secondary">{existingName ? `Your ${existingName}` : existing.isSuccess ? 'That piece was removed' : 'Your existing piece'}</Text>
        </View>
      </View>
      <Text variant="secondary">Identical pieces can be real separate pieces. bowr never merges them for you.</Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={exact ? 'Use existing piece' : 'Use existing piece instead'}
          variant="secondary"
          disabled={!existing.data}
          busy={resolve.isPending && resolve.variables === 'use_existing'}
          onPress={() => (exact ? resolve.mutate('use_existing') : setConfirming(true))}
        />
        <Button
          label={exact ? 'Add as another piece' : 'Keep both'}
          variant="secondary"
          busy={resolve.isPending && resolve.variables === 'add_another'}
          onPress={() => resolve.mutate('add_another')}
        />
        <Button label="Decide later" variant="quiet" onPress={() => setLater(true)} />
      </View>
      {error ? <Banner tone="error" message={error} /> : null}
      <ConfirmDialog
        visible={confirming}
        title="Remove this new piece?"
        consequences={['This new piece and its photos will be deleted.', 'Your existing piece stays as it is.']}
        confirmLabel="Remove new piece"
        destructive
        busy={resolve.isPending}
        onConfirm={() => resolve.mutate('use_existing')}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}
