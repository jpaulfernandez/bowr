import { EntryState } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { Screen } from '../../../../components/Screen';
import { Text } from '../../../../components/Text';
import { DuplicateChoice, useDuplicateReviews } from '../../../../features/items/DuplicateChoice';
import { entryStatus } from '../../../../features/uploads/copy';
import { PrivateImage } from '../../../../features/uploads/PrivateImage';
import { uploadManager, useLocalUploads } from '../../../../features/uploads/upload-manager';
import { apiRequest, guardedRead } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/format';
import { userKeys } from '../../../../lib/query-keys';
import { useSession } from '../../../../lib/session';
import { ApiError } from '../../../../lib/errors';
import { pickImages } from '../../../../platform/image-picker';
import { supabase } from '../../../../lib/supabase';

const Entries = z.array(
  z.object({
    id: z.string().uuid(),
    asset_id: z.string().uuid(),
    state: EntryState,
    failure_code: z.string().nullable(),
    declared_content_type: z.string(),
    created_at: z.string(),
    purpose: z.enum(['garment', 'care_label', 'grouped', 'replacement']),
    parent_entry_id: z.string().uuid().nullable(),
    target_item_id: z.string().uuid().nullable(),
    split_confirmed_at: z.string().nullable(),
    items: z.array(z.object({ id: z.string().uuid(), lifecycle: z.string() })),
  }),
);
type Entry = z.infer<typeof Entries>[number];

const inProgress = (entry: Entry) => entry.state === 'uploaded' || entry.state === 'validating';

export default function UploadReceipt() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const local = useLocalUploads();
  const key = [...userKeys.all(userId ?? 'none'), 'upload-batch', id] as const;
  // Poll every 2 s at first, then 5 s, then 10 s while work is moving (P0.04-T4).
  const pollingSince = useRef<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const entries = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      Entries.parse(
        await guardedRead(() =>
          supabase
            .from('upload_entries')
            .select(
              'id, asset_id, state, failure_code, declared_content_type, created_at, purpose, parent_entry_id, target_item_id, split_confirmed_at, items!items_user_id_source_entry_id_fkey(id, lifecycle)',
            )
            .eq('batch_id', id)
            .order('created_at')
            .order('id')
            .abortSignal(signal),
        ),
      ),
    enabled: userId !== null && typeof id === 'string',
    // Poll only while server-side work or local uploads are still moving.
    // Stops at terminal states; hidden tabs do not poll, and focus refetches.
    refetchInterval: (query) => {
      const data = query.state.data;
      const moving = data?.some((e) => inProgress(e) || (e.state === 'awaiting_upload' && local.get(e.id)?.status !== 'failed' && local.has(e.id)));
      if (!moving) {
        pollingSince.current = null;
        return false;
      }
      pollingSince.current ??= Date.now();
      const elapsed = Date.now() - pollingSince.current;
      return elapsed < 10_000 ? 2000 : elapsed < 60_000 ? 5000 : 10_000;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Where each ready care label is attached (labels never become pieces).
  const labelAssets = (entries.data ?? []).filter((e) => e.purpose === 'care_label' && e.state === 'ready').map((e) => e.asset_id);
  const attachments = useQuery({
    queryKey: [...key, 'labels', labelAssets.join(',')],
    queryFn: async ({ signal }) =>
      z
        .array(z.object({ asset_id: z.string().uuid(), item_id: z.string().uuid() }))
        .parse(
          await guardedRead(() =>
            supabase.from('item_assets').select('asset_id, item_id').in('asset_id', labelAssets).is('detached_at', null).abortSignal(signal),
          ),
        ),
    enabled: userId !== null && labelAssets.length > 0,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
  const [attentionOnly, setAttentionOnly] = useState(false);
  // A garment photo that repeats a piece already in the Bower waits for a choice.
  const held = (entries.data ?? []).filter((e) => e.purpose === 'garment' && e.state === 'ready' && e.items.length === 0).map((e) => e.id);
  const reviews = useDuplicateReviews('entry_id', held);
  const reviewOf = (entry: Entry) => reviews.data?.find((r) => r.entry_id === entry.id) ?? null;
  const pieces = (entry: Entry) => entry.items.filter((i) => i.lifecycle !== 'deleted');
  const awaitingParts = (entry: Entry) => entry.purpose === 'grouped' && entry.state === 'ready' && entry.split_confirmed_at === null;

  const cancel = useMutation({
    mutationFn: (entryId: string) =>
      apiRequest(`/upload-entries/${entryId}/cancel`, { method: 'POST', idempotencyKey: crypto.randomUUID(), schema: z.unknown() }),
    onSuccess: (_data, entryId) => {
      uploadManager.forget(entryId);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const retry = useMutation({
    mutationFn: (entryId: string) =>
      apiRequest(`/upload-entries/${entryId}/retry`, { method: 'POST', idempotencyKey: crypto.randomUUID(), schema: z.unknown() }),
    onSuccess: () => {
      pollingSince.current = null;
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setNotice(err instanceof ApiError ? err.message : "bowr couldn't retry this photo. Try again."),
  });

  const chooseAgain = async (entry: Entry) => {
    const [picked] = await pickImages({ capture: false });
    if (!picked) return;
    if (picked.type !== entry.declared_content_type) {
      setNotice('Choose the same photo you selected before, in the same format.');
      return;
    }
    setNotice(null);
    pollingSince.current = null;
    uploadManager.reselect(entry.id, { file: picked.file, name: picked.name });
  };

  const allRows = entries.data ?? [];
  const numberOf = (entryId: string) => allRows.findIndex((e) => e.id === entryId) + 1;
  const labelState = (entry: Entry): 'attached' | 'waiting' | 'unattached' | null => {
    if (entry.purpose !== 'care_label' || entry.state !== 'ready') return null;
    if (attachments.data?.some((a) => a.asset_id === entry.asset_id)) return 'attached';
    const parent = allRows.find((e) => e.id === entry.parent_entry_id);
    return parent && ['rejected', 'failed', 'canceled'].includes(parent.state) ? 'unattached' : 'waiting';
  };
  const needsAttention = (entry: Entry) =>
    awaitingParts(entry) ||
    reviewOf(entry)?.state === 'pending' ||
    entry.state === 'rejected' ||
    entry.state === 'failed' ||
    labelState(entry) === 'unattached' ||
    (entry.state === 'awaiting_upload' && (!local.has(entry.id) || local.get(entry.id)?.status === 'failed'));
  const rows = allRows;
  const sending = rows.filter((e) => e.state === 'awaiting_upload' && local.has(e.id) && local.get(e.id)!.status !== 'failed');
  const uploaded = rows.filter((e) => e.state !== 'awaiting_upload' && e.state !== 'canceled').length;
  const checking = rows.filter(inProgress).length;
  const ready = rows.filter((e) => e.state === 'ready').length;
  const attention = rows.filter(needsAttention).length;
  const shown = attentionOnly ? rows.filter(needsAttention) : rows;

  const summary =
    sending.length > 0
      ? `${uploaded} of ${rows.length} photos uploaded. Keep this tab open until uploads finish.`
      : checking > 0
        ? "Your photos are uploaded. We'll finish checking them in the background."
        : `${ready} ready${attention > 0 ? ` · ${attention} need attention` : ''}.`;

  return (
    <Screen title="Upload receipt" subtitle={rows[0] ? `Started ${formatDateTime(rows[0].created_at)}` : undefined}>
      {entries.isError ? <Banner tone="error" message="This receipt couldn't load." /> : null}
      {notice ? <Banner tone="error" message={notice} /> : null}
      {rows.length > 0 ? (
        <Text role="status" aria-live="polite" className="max-w-prose text-body text-text">
          {summary}
        </Text>
      ) : null}
      {attention > 0 || attentionOnly ? (
        <Button
          label={attentionOnly ? 'Show all photos' : `Show only photos that need attention (${attention})`}
          variant="secondary"
          className="self-start"
          onPress={() => setAttentionOnly((only) => !only)}
        />
      ) : null}
      <View role="list" aria-label="Photos in this upload" className="max-w-prose overflow-hidden rounded-control border border-divider bg-surface">
        {shown.map((entry, index) => {
          const task = local.get(entry.id);
          const number = numberOf(entry.id);
          const label = `Photo ${number}${task ? `: ${task.name}` : ''}${entry.purpose === 'care_label' ? ' (care label)' : entry.purpose === 'grouped' ? ' (group photo)' : entry.purpose === 'replacement' ? ' (new photo for a piece)' : ''}`;
          const attached = labelState(entry);
          const review = reviewOf(entry);
          const made = pieces(entry);
          const status = awaitingParts(entry)
            ? 'Several pieces in one photo · choose how to add them'
            : entry.purpose === 'grouped' && entry.split_confirmed_at
              ? made.length === 1
                ? '1 piece added'
                : `${made.length} pieces added`
              : entry.purpose === 'replacement' && entry.state === 'ready'
                ? entry.target_item_id
                  ? 'Photo replaced · the new cutout follows'
                  : 'Not used: the piece was removed'
                : review?.state === 'pending'
                ? 'Already in your Bower? Choose below.'
                : review?.state === 'use_existing'
                  ? 'Kept your existing piece; no new piece added'
                  : attached === 'attached'
              ? 'Care label attached to its piece'
              : attached === 'waiting'
                ? entry.parent_entry_id
                  ? `Uploaded · waiting for its piece (photo ${numberOf(entry.parent_entry_id)})`
                  : 'Uploaded · attaching to its piece'
                : attached === 'unattached'
                  ? "Not attached: its piece's photo couldn't be used. This label will be removed."
                  : entryStatus(entry.state, task, entry.failure_code);
          // A confirmed group photo and a repeated photo are deleted once they have served.
          const photoKept = entry.state === 'ready' && !entry.split_confirmed_at && review?.state !== 'use_existing';
          return (
            <View role="listitem" key={entry.id} className={`flex-row flex-wrap gap-4 p-4 ${index === 0 ? '' : 'border-t border-divider'}`}>
              {photoKept ? (
                <PrivateImage assetId={entry.asset_id} label={`${label}, uploaded photo`} />
              ) : (
                <View aria-hidden style={{ width: 96, height: 96 }} className="rounded-image bg-surface-subtle" />
              )}
              <View className="min-w-0 flex-1 basis-[160px] gap-2">
                <Text className="text-action text-text">{label}</Text>
                <Text className={needsAttention(entry) ? 'text-secondary text-error' : 'text-secondary text-text-secondary'}>{status}</Text>
                {review?.state === 'pending' ? (
                  <DuplicateChoice
                    review={review}
                    label={`photo ${number}`}
                    photo={<PrivateImage assetId={entry.asset_id} label={`Photo ${number}, just uploaded`} size={120} />}
                  />
                ) : null}
                <View className="flex-row flex-wrap gap-2">
                  {made.length === 1 ? (
                    <Button
                      label={`View piece from photo ${number}`}
                      variant="secondary"
                      onPress={() => router.push(`/wardrobe/items/${made[0]!.id}`)}
                    />
                  ) : null}
                  {made.length > 1
                    ? made.map((piece, k) => (
                        <Button
                          key={piece.id}
                          label={`View piece ${k + 1} from photo ${number}`}
                          variant="secondary"
                          onPress={() => router.push(`/wardrobe/items/${piece.id}`)}
                        />
                      ))
                    : null}
                  {review?.state === 'use_existing' && review.existing_item_id ? (
                    <Button
                      label={`View existing piece for photo ${number}`}
                      variant="secondary"
                      onPress={() => router.push(`/wardrobe/items/${review.existing_item_id}`)}
                    />
                  ) : null}
                  {entry.purpose === 'replacement' && entry.state === 'ready' && entry.target_item_id ? (
                    <Button
                      label={`View piece for photo ${number}`}
                      variant="secondary"
                      onPress={() => router.push(`/wardrobe/items/${entry.target_item_id}`)}
                    />
                  ) : null}
                  {awaitingParts(entry) ? (
                    <Button label={`Choose pieces from photo ${number}`} onPress={() => router.push(`/wardrobe/split/${entry.id}`)} />
                  ) : null}
                  {task?.status === 'failed' ? (
                    <Button label={`Retry photo ${number}`} variant="secondary" onPress={() => uploadManager.retry(entry.id)} />
                  ) : null}
                  {entry.state === 'awaiting_upload' && !task ? (
                    <Button label={`Choose photo ${number} again`} variant="secondary" onPress={() => void chooseAgain(entry)} />
                  ) : null}
                  {entry.state === 'failed' ? (
                    <Button
                      label={`Try photo ${number} again`}
                      variant="secondary"
                      busy={retry.isPending && retry.variables === entry.id}
                      onPress={() => retry.mutate(entry.id)}
                    />
                  ) : null}
                  {['awaiting_upload', 'uploaded', 'validating', 'failed'].includes(entry.state) || awaitingParts(entry) ? (
                    <Button
                      label={`Cancel photo ${number}`}
                      variant="quiet"
                      busy={cancel.isPending && cancel.variables === entry.id}
                      onPress={() => cancel.mutate(entry.id)}
                    />
                  ) : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View className="max-w-prose gap-3">
        <Button label="Gather more photos" variant="secondary" onPress={() => router.push('/wardrobe/gather')} />
        <Button label="Back to Bower" variant="quiet" onPress={() => router.replace('/wardrobe')} />
      </View>
    </Screen>
  );
}
