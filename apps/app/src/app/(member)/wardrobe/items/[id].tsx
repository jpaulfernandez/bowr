import { categoryLabel, displayName, needsCategory } from '@bowr/domain';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { RadioGroup } from '../../../../components/RadioGroup';
import { Screen } from '../../../../components/Screen';
import { Heading, Text } from '../../../../components/Text';
import { PieceEditor } from '../../../../features/items/PieceEditor';
import { PieceImage } from '../../../../features/items/PieceImage';
import { ProcessingPanel } from '../../../../features/items/ProcessingPanel';
import { assetFor, stageFor, useItem, useRetryStage, useUpdateItem } from '../../../../features/items/queries';
import { ApiError } from '../../../../lib/errors';

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
  const setDisplay = (display_image: 'cutout' | 'original') => {
    setNotice(null);
    update.mutate(
      { patch: { display_image }, key: crypto.randomUUID() },
      { onError: (error) => setNotice(error instanceof ApiError ? error.message : "That change didn't save. Try again.") },
    );
  };

  return (
    <Screen title={displayName(piece)} subtitle={piece.category ? categoryLabel[piece.category] : 'Category not set'}>
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
          {needsCategory(piece) ? (
            <Banner tone="warning" message="Check category: choose one so this piece can be suggested in outfits. You can still find and use it." />
          ) : null}
          {notice ? <Banner tone="error" message={notice} /> : null}
          <ProcessingPanel item={piece} />
          <Heading level={2}>Details</Heading>
          <PieceEditor key={piece.id} item={piece} />
        </View>
      </View>
      <Button label="Back to Bower" variant="quiet" className="self-start" onPress={() => router.replace('/wardrobe')} />
    </Screen>
  );
}
