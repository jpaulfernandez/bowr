import { categoryLabel, displayName, needsCategory } from '@bowr/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Text as RNText, useWindowDimensions, View } from 'react-native';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { RadioGroup } from '../../../../components/RadioGroup';
import { Screen } from '../../../../components/Screen';
import { Heading, Text } from '../../../../components/Text';
import { DuplicateChoice, useDuplicateReviews } from '../../../../features/items/DuplicateChoice';
import { LabelsSection } from '../../../../features/items/LabelsSection';
import { PieceEditor } from '../../../../features/items/PieceEditor';
import { PieceImage } from '../../../../features/items/PieceImage';
import { ProcessingPanel } from '../../../../features/items/ProcessingPanel';
import { assetFor, stageFor, useBulkUpdate, useDeleteItem, useItem, useRetryStage, useUpdateItem } from '../../../../features/items/queries';
import { apiRequest } from '../../../../lib/api';
import { ApiError } from '../../../../lib/errors';
import { userKeys } from '../../../../lib/query-keys';
import { useSession } from '../../../../lib/session';

const cutoutFailures: Record<string, string> = {
  NO_FOREGROUND: "bowr couldn't find a single piece against the background.",
  PROCESSING_FAILED: "bowr couldn't finish the cutout.",
  SOURCE_MISSING: "The original photo couldn't be read for the cutout.",
  MODEL_UNAVAILABLE: 'Cutouts are unavailable right now.',
  RESTORED: 'bowr was restored from a backup while this cutout was being made.',
};

export default function PieceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);
  const retry = useRetryStage(item.data);
  const update = useUpdateItem(item.data);
  const [view, setView] = useState<'cutout' | 'original' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  // An explicit cutout with the other pinned model; the server bounds how often.
  const recut = useMutation({
    mutationFn: ({ model, revision }: { model: string; revision: number }) =>
      apiRequest(`/items/${id}/recut`, {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: { media_revision: revision, model },
        schema: z.unknown(),
      }),
    onSuccess: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.all(userId) });
    },
    onError: (error) => setNotice(error instanceof ApiError ? error.message : "The new cutout didn't start. Try again."),
  });
  const lifecycle = useBulkUpdate();
  const remove = useDeleteItem(item.data);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteKey = useRef<string | null>(null);
  const reviews = useDuplicateReviews(
    'item_id',
    typeof id === 'string' ? [id] : [],
    item.data?.item_stages.map((s) => `${s.stage}:${s.state}`).join(',') ?? '',
  );
  const review = reviews.data?.find((r) => r.state === 'pending') ?? null;

  if (item.isPending) return <Screen title="Piece" />;
  if (item.isError || !item.data) {
    return (
      <Screen title="Piece not available">
        <Text>{item.isError ? "This piece couldn't load. Check your connection and try again." : "This piece isn't in your Bower."}</Text>
        <Button label="Back to Bower" variant="secondary" className="self-start" onPress={() => router.replace('/wardrobe')} />
      </Screen>
    );
  }

  const piece = item.data;
  const cutout = assetFor(piece, 'cutout');
  const stage = stageFor(piece, 'cutout');
  const shown = view ?? (piece.display_image === 'cutout' && cutout ? 'cutout' : 'original');
  const imageSize = Math.min(480, Math.max(240, width - 48));
  const setLifecycle = (kind: 'archive' | 'restore') => {
    setNotice(null);
    lifecycle.mutate(
      { items: [piece], operation: { kind }, key: crypto.randomUUID() },
      { onError: (error) => setNotice(error instanceof ApiError ? error.message : "That change didn't save. Try again.") },
    );
  };
  const deletePiece = () => {
    deleteKey.current ??= crypto.randomUUID();
    remove.mutate(deleteKey.current, {
      onSuccess: () => router.replace(`/wardrobe?deleted=${piece.id}`),
      onError: (error) => {
        deleteKey.current = null;
        setConfirmingDelete(false);
        setNotice(error instanceof ApiError ? error.message : "The piece wasn't deleted. Try again.");
      },
    });
  };
  const setDisplay = (display_image: 'cutout' | 'original') => {
    setNotice(null);
    update.mutate(
      { patch: { display_image }, key: crypto.randomUUID() },
      { onError: (error) => setNotice(error instanceof ApiError ? error.message : "That change didn't save. Try again.") },
    );
  };

  return (
    <Screen title={displayName(piece)} subtitle={piece.category ? categoryLabel[piece.category] : 'Category not set'}>
      {piece.lifecycle === 'archived' ? (
        <Banner tone="info" message="This piece is archived. It stays out of new suggestions until you restore it.">
          <Button label="Restore" variant="secondary" busy={lifecycle.isPending} onPress={() => setLifecycle('restore')} />
        </Banner>
      ) : null}
      {review ? (
        <View className="max-w-prose">
          <DuplicateChoice
            review={review}
            label="this piece"
            photo={<PieceImage item={piece} size={120} label={`${displayName(piece)}, this new piece`} />}
          />
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-8">
        <View className="gap-3" style={{ width: imageSize, maxWidth: '100%' }}>
          <PieceImage item={piece} size={imageSize} view={shown} label={`${displayName(piece)}, ${shown === 'cutout' ? 'cutout' : 'original photo'}`} />
          {cutout ? (
            <RadioGroup
              label="Show"
              value={shown}
              options={[
                { value: 'cutout', label: 'Cutout' },
                { value: 'original', label: 'Original' },
              ]}
              onChange={setView}
            />
          ) : null}
          <Text variant="secondary">
            Original means the privacy-sanitized copy of your photo: bowr removed its location and camera details and kept it private
            to you.
          </Text>
          <Link href={`/help/photos${piece.category ? `?category=${piece.category}` : ''}`} className="min-h-target justify-center">
            <RNText className="text-action text-accent underline">
              {piece.category ? `Photo tips for ${categoryLabel[piece.category].toLowerCase()}` : 'Photo tips'}
            </RNText>
          </Link>
        </View>

        <View className="min-w-0 flex-1 basis-[320px] gap-6">
          {stage && ['queued', 'running', 'retry_wait'].includes(stage.state) ? (
            <Text role="status" aria-live="polite">
              Making the cutout. You can edit details meanwhile.
            </Text>
          ) : null}
          {stage && (stage.state === 'failed' || stage.state === 'canceled') && !cutout ? (
            <Banner
              tone="warning"
              message={`${cutoutFailures[stage.failure_code ?? ''] ?? "The cutout didn't finish."} Your original photo is saved${piece.display_image === 'original' ? ' and shown for this piece' : ''}.`}
            >
              <View className="flex-row flex-wrap gap-2">
                {stage.can_retry ? (
                  <Button
                    label="Retry cutout"
                    variant="secondary"
                    busy={retry.isPending}
                    busyLabel="Retrying"
                    onPress={() =>
                      retry.mutate('cutout', {
                        onError: (error) => setNotice(error instanceof ApiError ? error.message : "The retry didn't start. Try again."),
                      })
                    }
                  />
                ) : null}
                {piece.display_image === 'cutout' ? (
                  <Button label="Use original" variant="secondary" busy={update.isPending} onPress={() => setDisplay('original')} />
                ) : null}
              </View>
            </Banner>
          ) : null}
          {cutout && piece.display_image === 'original' ? (
            <View className="flex-row flex-wrap items-center gap-3">
              <Text variant="secondary">Your Bower shows the original photo for this piece.</Text>
              <Button label="Use cutout" variant="secondary" busy={update.isPending} onPress={() => setDisplay('cutout')} />
            </View>
          ) : null}
          <View className="gap-3">
            <Heading level={2}>Photo</Heading>
            <View className="flex-row flex-wrap gap-2">
              <Button label="Fix edges" variant="secondary" onPress={() => router.push(`/wardrobe/edges/${piece.id}`)} />
              {stage && !['queued', 'running', 'retry_wait'].includes(stage.state) ? (
                <Button
                  label="Try the other cutout model"
                  variant="secondary"
                  busy={recut.isPending}
                  busyLabel="Starting a new cutout"
                  onPress={() =>
                    recut.mutate({ model: stage.model === 'u2netp' ? 'isnet_general_use' : 'u2netp', revision: piece.media_revision })
                  }
                />
              ) : null}
              {cutout && piece.display_image === 'cutout' ? (
                <Button label="Use original" variant="secondary" busy={update.isPending} onPress={() => setDisplay('original')} />
              ) : null}
              <Button label="Replace photo" variant="secondary" onPress={() => router.push(`/wardrobe/gather?replace=${piece.id}`)} />
            </View>
            <Text variant="secondary">Your original photo is kept. A new cutout or photo replaces the current one only once it is ready.</Text>
          </View>
          {needsCategory(piece) ? (
            <Banner tone="warning" message="Check category: choose one so this piece can be suggested in outfits. You can still find and use it." />
          ) : null}
          {notice ? <Banner tone="error" message={notice} /> : null}
          <ProcessingPanel item={piece} />
          <Heading level={2}>Details</Heading>
          <PieceEditor key={piece.id} item={piece} />
          <LabelsSection item={piece} />
          <View className="gap-3">
            <Heading level={2}>Keep or remove</Heading>
            <View className="flex-row flex-wrap gap-2">
              {piece.lifecycle === 'active' ? (
                <Button label="Archive" variant="secondary" busy={lifecycle.isPending} onPress={() => setLifecycle('archive')} />
              ) : null}
              <Button label="Delete permanently" variant="quiet" onPress={() => setConfirmingDelete(true)} />
            </View>
            <Text variant="secondary">Archiving keeps the piece and its photos but leaves it out of new suggestions.</Text>
          </View>
        </View>
      </View>
      <Button label="Back to Bower" variant="quiet" className="self-start" onPress={() => router.replace('/wardrobe')} />
      <ConfirmDialog
        visible={confirmingDelete}
        title="Delete this piece permanently?"
        consequences={[
          'Its photos, cutout and care labels will be deleted.',
          'Its details and matching data will be erased.',
          'This cannot be undone. To keep it out of sight instead, archive it.',
        ]}
        confirmLabel="Delete piece"
        destructive
        busy={remove.isPending}
        onConfirm={deletePiece}
        onCancel={() => setConfirmingDelete(false)}
      />
    </Screen>
  );
}
