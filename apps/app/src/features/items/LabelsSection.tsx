import type { Item } from '@bowr/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Heading, Text } from '../../components/Text';
import { apiRequest } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { PrivateImage } from '../uploads/PrivateImage';
import { itemKeys } from './queries';

/** Care-label photos attached to a piece (DESIGN 6.4: a separate attachment row). */
export function LabelsSection({ item }: { item: Item }) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const labels = item.item_assets.filter((a) => a.role === 'label' && a.detached_at === null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const remove = useMutation({
    mutationFn: (assetId: string) =>
      apiRequest(`/media/${assetId}`, { method: 'DELETE', idempotencyKey: crypto.randomUUID(), schema: z.unknown() }),
    onSuccess: () => {
      setConfirming(null);
      setNotice({ tone: 'success', message: 'Label removed. Its photo is being deleted; the details it filled in stay.' });
    },
    onError: (error) => {
      setConfirming(null);
      setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : "The label wasn't removed. Try again." });
    },
    onSettled: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: itemKeys.all(userId) });
    },
  });

  return (
    <View className="gap-3">
      <Heading level={2}>Care labels</Heading>
      {labels.length === 0 ? (
        <Text variant="secondary">Optional. A label photo can fill in brand, size and material; your own entries always win.</Text>
      ) : (
        <View role="list" aria-label="Care labels" className="flex-row flex-wrap gap-4">
          {labels.map((label, index) => (
            <View role="listitem" key={label.asset_id} className="gap-2">
              <PrivateImage assetId={label.asset_id} variant="original" label={`Care label ${index + 1}`} size={120} />
              <Button label={`Remove care label ${index + 1}`} variant="quiet" onPress={() => setConfirming(label.asset_id)} />
            </View>
          ))}
        </View>
      )}
      <Button
        label="Add care label"
        variant="secondary"
        className="self-start"
        onPress={() => router.push(`/wardrobe/gather?label_for=${item.id}`)}
      />
      {notice ? <Banner tone={notice.tone} message={notice.message} /> : null}
      <ConfirmDialog
        visible={confirming !== null}
        title="Remove this care label?"
        consequences={[
          'The label photo will be deleted.',
          'Brand, size and material already on this piece stay as they are.',
        ]}
        confirmLabel="Remove label"
        destructive
        busy={remove.isPending}
        onConfirm={() => confirming && remove.mutate(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </View>
  );
}
