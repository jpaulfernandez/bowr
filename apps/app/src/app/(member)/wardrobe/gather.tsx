import { UploadBatchCreated } from '@bowr/contracts';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, View } from 'react-native';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Prose, Screen } from '../../../components/Screen';
import { Text } from '../../../components/Text';
import { uploadManager } from '../../../features/uploads/upload-manager';
import { apiRequest } from '../../../lib/api';
import { ApiError } from '../../../lib/errors';
import { useBootstrap } from '../../../lib/bootstrap';
import { useItemCount } from '../../../features/items/queries';
import { pickImages, type PickedImage } from '../../../platform/image-picker';

type Selected = PickedImage & { id: string; problem: string | null; rotation: 0 | 90 | 180 | 270; preview: string | null };

/** Browsers can preview JPEG, PNG and WebP; HEIC keeps a labeled placeholder. */
const previewable = (type: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(type);

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
  const pieces = useItemCount();
  // The brief guide opens on a first upload and stays one tap away afterwards.
  const [tips, setTips] = useState<boolean | null>(null);
  const showTips = tips ?? pieces.data === 0;
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

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
          rotation: 0 as const,
          preview: previewable(image.type) && Platform.OS === 'web' ? track(URL.createObjectURL(image.file)) : null,
          problem: !limits.formats.includes(image.type)
            ? "This file type isn't supported."
            : image.size > limits.max_bytes
              ? `This photo is ${megabytes(image.size)}, over the ${Math.round(limits.max_bytes / (1024 * 1024))} MB limit.`
              : null,
        })),
      ].slice(0, limits.max_files_per_batch),
    );
  };

  function track(url: string) {
    previews.current.add(url);
    return url;
  }

  const rotate = (id: string) =>
    setSelected((current) =>
      current.map((s) => (s.id === id ? { ...s, rotation: (((s.rotation + 90) % 360) as Selected['rotation']) } : s)),
    );

  const usable = selected.filter((s) => !s.problem);
  const create = useMutation({
    mutationFn: async () => {
      const ids = usable.map((s) => `${s.id}:${s.rotation}`).join(',');
      if (!request.current || request.current.ids !== ids) request.current = { key: crypto.randomUUID(), ids };
      const batch = await apiRequest('/upload-batches', {
        method: 'POST',
        idempotencyKey: request.current.key,
        body: {
          files: usable.map((s) => ({
            client_file_id: s.id,
            purpose: 'garment',
            content_type: s.type,
            byte_size: s.size,
            rotation: s.rotation,
          })),
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
      <View className="max-w-prose gap-3">
        <Button
          label={showTips ? 'Hide photo tips' : 'Photo tips'}
          variant="quiet"
          className="self-start"
          aria-expanded={showTips}
          onPress={() => setTips(!showTips)}
        />
        {showTips ? (
          <View role="region" aria-label="Photo tips" className="gap-2 rounded-control border border-divider bg-surface p-4">
            <Text>One piece per photo, on a hanger or laid flat, against a plain background that contrasts with it.</Text>
            <Text>Use daylight near a window, no flash. Hold the phone straight on and level, with a little space around the piece.</Text>
            <Text>Shoes: the pair side by side, from the side. Shades: arms open, lens height, avoid glare.</Text>
          </View>
        ) : null}
      </View>
      <View className="max-w-prose flex-row flex-wrap gap-3">
        <Button label="Choose photos" onPress={() => void add(false)} />
        {Platform.OS === 'web' ? <Button label="Take a photo" variant="secondary" onPress={() => void add(true)} /> : null}
      </View>
      {selected.length > 0 ? (
        <View role="list" aria-label="Selected photos" className="max-w-prose overflow-hidden rounded-control border border-divider bg-surface">
          {selected.map((item, index) => (
            <View role="listitem" key={item.id} className={`flex-row flex-wrap gap-4 p-4 ${index === 0 ? '' : 'border-t border-divider'}`}>
              {item.preview ? (
                <Image
                  source={{ uri: item.preview }}
                  accessibilityLabel={`Preview of photo ${index + 1}${item.rotation ? `, rotated ${item.rotation} degrees` : ''}`}
                  resizeMode="contain"
                  style={{ width: 96, height: 96, transform: [{ rotate: `${item.rotation}deg` }] }}
                  className="rounded-image bg-surface-subtle"
                />
              ) : (
                <View style={{ width: 96, height: 96 }} className="items-center justify-center rounded-image bg-surface-subtle p-1">
                  <Text variant="secondary" className="text-center">
                    No preview
                  </Text>
                </View>
              )}
              <View className="min-w-0 flex-1 basis-[160px] gap-2">
                <Text className="text-action text-text">{`Photo ${index + 1}: ${item.name}`}</Text>
                <Text variant="secondary">{`${megabytes(item.size)}${item.rotation ? ` · rotated ${item.rotation}°` : ''}`}</Text>
                {item.problem ? <Banner tone="error" message={item.problem} /> : null}
                <View className="flex-row flex-wrap gap-2">
                  {!item.problem ? (
                    <Button label={`Rotate photo ${index + 1}`} variant="secondary" onPress={() => rotate(item.id)} />
                  ) : null}
                  <Button
                    label={`Remove photo ${index + 1}`}
                    variant="quiet"
                    onPress={() => setSelected((current) => current.filter((s) => s.id !== item.id))}
                  />
                </View>
              </View>
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
