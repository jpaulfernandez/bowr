import { UploadBatchCreated } from '@bowr/contracts';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Prose, Screen } from '../../../components/Screen';
import { Text } from '../../../components/Text';
import { uploadManager } from '../../../features/uploads/upload-manager';
import { apiRequest } from '../../../lib/api';
import { ApiError } from '../../../lib/errors';
import { useBootstrap } from '../../../lib/bootstrap';
import { pickImages, type PickedImage } from '../../../platform/image-picker';

type Selected = PickedImage & { id: string; problem: string | null };

const formatNames: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/heic': 'HEIC',
};

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Gather() {
  const limits = useBootstrap().data?.upload_limits;
  const [selected, setSelected] = useState<Selected[]>([]);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; ids: string } | null>(null);

  const formats = (limits?.formats ?? []).map((f) => formatNames[f]).filter(Boolean);
  const limitText = limits
    ? `${Array.from(new Set(formats)).join(', ')} · up to ${Math.round(limits.max_bytes / (1024 * 1024))} MB and ${limits.max_pixels / 1_000_000} megapixels each · up to ${limits.max_files_per_batch} photos at a time`
    : '';

  const add = async (capture: boolean) => {
    setError(null);
    const picked = await pickImages({ capture });
    if (!limits) return;
    setSelected((current) =>
      [
        ...current,
        ...picked.map((image) => ({
          ...image,
          id: crypto.randomUUID(),
          problem: !limits.formats.includes(image.type)
            ? "This file type isn't supported."
            : image.size > limits.max_bytes
              ? `This photo is ${megabytes(image.size)}, over the ${Math.round(limits.max_bytes / (1024 * 1024))} MB limit.`
              : null,
        })),
      ].slice(0, limits.max_files_per_batch),
    );
  };

  const usable = selected.filter((s) => !s.problem);
  const create = useMutation({
    mutationFn: async () => {
      const ids = usable.map((s) => s.id).join(',');
      if (!request.current || request.current.ids !== ids) request.current = { key: crypto.randomUUID(), ids };
      const batch = await apiRequest('/upload-batches', {
        method: 'POST',
        idempotencyKey: request.current.key,
        body: {
          files: usable.map((s) => ({ client_file_id: s.id, purpose: 'garment', content_type: s.type, byte_size: s.size })),
        },
        schema: UploadBatchCreated,
      });
      return batch;
    },
    onSuccess: (batch) => {
      request.current = null;
      uploadManager.start(batch.entries, new Map(usable.map((s) => [s.id, { file: s.file, name: s.name }])));
      router.replace(`/wardrobe/uploads/${batch.batch_id}`);
    },
    onError: (err) =>
      setError(err instanceof ApiError && err.retryable ? "bowr couldn't start the upload. Try again." : 'Check the selected photos and try again.'),
  });

  return (
    <Screen title="Gather · add pieces" subtitle="Start with a few pieces you wear often.">
      <Prose>
        <Text variant="secondary">{limitText}</Text>
        <Text variant="secondary">Photos stay private to you. bowr removes location and camera details from each photo.</Text>
      </Prose>
      <View className="max-w-prose flex-row flex-wrap gap-3">
        <Button label="Choose photos" onPress={() => void add(false)} />
        {Platform.OS === 'web' ? <Button label="Take a photo" variant="secondary" onPress={() => void add(true)} /> : null}
      </View>
      {selected.length > 0 ? (
        <View role="list" aria-label="Selected photos" className="max-w-prose overflow-hidden rounded-control border border-divider bg-surface">
          {selected.map((item, index) => (
            <View role="listitem" key={item.id} className={`gap-2 p-4 ${index === 0 ? '' : 'border-t border-divider'}`}>
              <Text className="text-action text-text">{`Photo ${index + 1}: ${item.name}`}</Text>
              <Text variant="secondary">{megabytes(item.size)}</Text>
              {item.problem ? <Banner tone="error" message={item.problem} /> : null}
              <Button
                label={`Remove photo ${index + 1}`}
                variant="quiet"
                className="self-start"
                onPress={() => setSelected((current) => current.filter((s) => s.id !== item.id))}
              />
            </View>
          ))}
        </View>
      ) : null}
      {error ? <Banner tone="error" message={error} /> : null}
      <View className="max-w-prose gap-3">
        <Button
          label={usable.length === 1 ? 'Upload 1 photo' : `Upload ${usable.length} photos`}
          disabled={usable.length === 0}
          busy={create.isPending}
          busyLabel="Starting upload"
          onPress={() => create.mutate()}
        />
        <Button label="Back to Bower" variant="secondary" onPress={() => router.replace('/wardrobe')} />
      </View>
    </Screen>
  );
}
