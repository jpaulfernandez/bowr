import { UploadBatchCreated } from '@bowr/contracts';
import { displayName } from '@bowr/domain';
import { useMutation } from '@tanstack/react-query';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Text as RNText, View } from 'react-native';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { RadioGroup } from '../../../components/RadioGroup';
import { Prose, Screen } from '../../../components/Screen';
import { Text } from '../../../components/Text';
import { useItem, useItemCount } from '../../../features/items/queries';
import { uploadManager } from '../../../features/uploads/upload-manager';
import { apiRequest } from '../../../lib/api';
import { useBootstrap } from '../../../lib/bootstrap';
import { ApiError } from '../../../lib/errors';
import { pickImages, type PickedImage } from '../../../platform/image-picker';

type Kind = 'garment' | 'group' | 'label';
type Selected = PickedImage & {
  id: string;
  problem: string | null;
  rotation: 0 | 90 | 180 | 270;
  preview: string | null;
  kind: Kind;
  /** For a care label in this batch: the selected garment it belongs to. */
  labelFor: string | null;
};

/** Browsers can preview JPEG, PNG and WebP; HEIC keeps a labeled placeholder. */
const previewable = (type: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(type);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const params = useLocalSearchParams<{ label_for?: string }>();
  // Opened from a piece's "Add care label": every photo is a label for that piece.
  const targetId = typeof params.label_for === 'string' && UUID.test(params.label_for) ? params.label_for : undefined;
  const target = useItem(targetId);
  const limits = useBootstrap().data?.upload_limits;
  const [selected, setSelected] = useState<Selected[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<{ key: string; ids: string } | null>(null);
  const pieces = useItemCount();
  // The brief guide opens on a first upload and stays one tap away afterwards.
  const [tips, setTips] = useState<boolean | null>(null);
  const showTips = tips ?? pieces.data === 0;
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const formats = (limits?.formats ?? []).map((f) => formatNames[f]).filter(Boolean);
  const limitText = limits
    ? `${Array.from(new Set(formats)).join(', ')} · up to ${Math.round(limits.max_bytes / (1024 * 1024))} MB and ${limits.max_pixels / 1_000_000} megapixels each · up to ${limits.max_files_per_batch} photos at a time, including care labels`
    : '';

  function track(url: string) {
    previews.current.add(url);
    return url;
  }

  const add = async (capture: boolean) => {
    setError(null);
    setNotice(null);
    const picked = await pickImages({ capture });
    if (!limits || picked.length === 0) return;
    const room = limits.max_files_per_batch - selected.length;
    if (picked.length > room) {
      setNotice(
        `You can add up to ${limits.max_files_per_batch} photos at a time, including care labels. ${picked.length - Math.max(room, 0)} ${picked.length - Math.max(room, 0) === 1 ? "photo wasn't" : "photos weren't"} added; upload these first, then gather the rest.`,
      );
    }
    const accepted = picked.slice(0, Math.max(room, 0));
    setSelected((current) => [
      ...current,
      ...accepted.map((image) => ({
        ...image,
        id: crypto.randomUUID(),
        rotation: 0 as const,
        kind: (targetId ? 'label' : 'garment') as Kind,
        labelFor: null,
        preview: previewable(image.type) && Platform.OS === 'web' ? track(URL.createObjectURL(image.file)) : null,
        problem: !limits.formats.includes(image.type)
          ? "This file type isn't supported."
          : image.size > limits.max_bytes
            ? `This photo is ${megabytes(image.size)}, over the ${Math.round(limits.max_bytes / (1024 * 1024))} MB limit.`
            : null,
      })),
    ]);
  };

  const update = (id: string, patch: Partial<Selected>) =>
    setSelected((current) => current.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) =>
    // A label whose garment is removed needs its garment chosen again.
    setSelected((current) => current.filter((s) => s.id !== id).map((s) => (s.labelFor === id ? { ...s, labelFor: null } : s)));

  const usable = selected.filter((s) => !s.problem);
  const garments = usable.filter((s) => s.kind === 'garment');
  const unassigned = targetId ? [] : usable.filter((s) => s.kind === 'label' && !garments.some((g) => g.id === s.labelFor));
  const numberOf = (id: string) => selected.findIndex((s) => s.id === id) + 1;

  const create = useMutation({
    mutationFn: async () => {
      const files = usable.map((s) => ({
        client_file_id: s.id,
        purpose: s.kind === 'label' ? 'care_label' : s.kind === 'group' ? 'grouped' : 'garment',
        content_type: s.type,
        byte_size: s.size,
        rotation: s.rotation,
        ...(s.kind === 'label' && targetId ? { target_item_id: targetId } : {}),
        ...(s.kind === 'label' && !targetId && s.labelFor ? { label_for: s.labelFor } : {}),
      }));
      const ids = JSON.stringify(files);
      if (!request.current || request.current.ids !== ids) request.current = { key: crypto.randomUUID(), ids };
      return apiRequest('/upload-batches', {
        method: 'POST',
        idempotencyKey: request.current.key,
        body: { files },
        schema: UploadBatchCreated,
      });
    },
    onSuccess: (batch) => {
      request.current = null;
      uploadManager.start(batch.entries, new Map(usable.map((s) => [s.id, { file: s.file, name: s.name }])));
      router.replace(`/wardrobe/uploads/${batch.batch_id}`);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.retryable
          ? "bowr couldn't start the upload. Try again."
          : 'Check the selected photos and try again.',
      ),
  });

  const start = () => {
    if (unassigned.length > 0) {
      setError(`Choose which piece each care label belongs to (photo ${unassigned.map((s) => numberOf(s.id)).join(', ')}).`);
      return;
    }
    create.mutate();
  };

  const title = targetId ? 'Add care label' : 'Gather · add pieces';
  const subtitle = targetId
    ? target.data
      ? `For ${displayName(target.data)}. A label is attached to the piece; it never becomes a separate piece.`
      : 'A label is attached to its piece; it never becomes a separate piece.'
    : 'Start with a few pieces you wear often.';

  return (
    <Screen title={title} subtitle={subtitle}>
      {targetId && target.isSuccess && !target.data ? <Banner tone="error" message="This piece isn't in your Bower." /> : null}
      <Prose>
        <Text variant="secondary">{limitText}</Text>
        <Text variant="secondary">Photos stay private to you. bowr removes location and camera details from each photo.</Text>
      </Prose>
      <View className="max-w-prose gap-3">
        <View className="flex-row flex-wrap items-center gap-3">
          <Button
            label={showTips ? 'Hide photo tips' : 'Photo tips'}
            variant="quiet"
            aria-expanded={showTips}
            onPress={() => setTips(!showTips)}
          />
          <Link href="/help/photos" className="min-h-target justify-center px-3 py-2">
            <RNText className="text-action text-accent underline">Full photo guide</RNText>
          </Link>
        </View>
        {showTips ? (
          <View role="region" aria-label="Photo tips" className="gap-2 rounded-control border border-divider bg-surface p-4">
            <Text>One piece per photo, on a hanger or laid flat, against a plain background that contrasts with it.</Text>
            <Text>Use daylight near a window, no flash. Hold the phone straight on and level, with a little space around the piece.</Text>
            <Text>Shoes: the pair side by side, from the side. Shades: arms open, lens height, avoid glare.</Text>
            <Text>Jewelry and watches: several small pieces can share one photo on dark fabric. Mark it as several small pieces.</Text>
            <Text>A care label is optional: add its photo and choose the piece it belongs to. It counts toward the 20 photos.</Text>
          </View>
        ) : null}
      </View>
      <View className="max-w-prose flex-row flex-wrap gap-3">
        <Button label="Choose photos" onPress={() => void add(false)} />
        {Platform.OS === 'web' ? <Button label="Take a photo" variant="secondary" onPress={() => void add(true)} /> : null}
      </View>
      {notice ? <Banner tone="warning" message={notice} /> : null}
      {selected.length > 0 ? (
        <View role="list" aria-label="Selected photos" className="max-w-prose overflow-hidden rounded-control border border-divider bg-surface">
          {selected.map((item, index) => {
            const number = index + 1;
            const otherGarments = garments.filter((g) => g.id !== item.id);
            return (
              <View role="listitem" key={item.id} className={`flex-row flex-wrap gap-4 p-4 ${index === 0 ? '' : 'border-t border-divider'}`}>
                {item.preview ? (
                  <Image
                    source={{ uri: item.preview }}
                    accessibilityLabel={`Preview of photo ${number}${item.rotation ? `, rotated ${item.rotation} degrees` : ''}`}
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
                  <Text className="text-action text-text">{`Photo ${number}: ${item.name}`}</Text>
                  <Text variant="secondary">{`${megabytes(item.size)}${item.rotation ? ` · rotated ${item.rotation}°` : ''}`}</Text>
                  {item.problem ? <Banner tone="error" message={item.problem} /> : null}
                  {!item.problem && !targetId ? (
                    <RadioGroup
                      label={`Photo ${number} is`}
                      value={item.kind}
                      options={[
                        { value: 'garment', label: 'A piece' },
                        { value: 'group', label: 'Several small pieces' },
                        { value: 'label', label: 'A care label' },
                      ]}
                      onChange={(kind) => {
                        update(item.id, { kind, labelFor: null });
                        // Only a single-piece photo can hold care labels.
                        if (kind !== 'garment') setSelected((current) => current.map((s) => (s.labelFor === item.id ? { ...s, labelFor: null } : s)));
                      }}
                    />
                  ) : null}
                  {!item.problem && item.kind === 'group' ? (
                    <Text variant="secondary">
                      After upload you choose: keep it as one set, or mark each piece. No piece is added until you choose.
                    </Text>
                  ) : null}
                  {!item.problem && !targetId && item.kind === 'label' ? (
                    otherGarments.length > 0 ? (
                      <RadioGroup
                        label={`Care label in photo ${number} belongs to`}
                        value={item.labelFor}
                        options={otherGarments.map((g) => ({ value: g.id, label: `Photo ${numberOf(g.id)}` }))}
                        onChange={(labelFor) => update(item.id, { labelFor })}
                      />
                    ) : (
                      <Text variant="secondary">
                        {"Add the piece's photo too, or add this label later from the piece's page."}
                      </Text>
                    )
                  ) : null}
                  <View className="flex-row flex-wrap gap-2">
                    {!item.problem ? (
                      <Button
                        label={`Rotate photo ${number}`}
                        variant="secondary"
                        onPress={() => update(item.id, { rotation: ((item.rotation + 90) % 360) as Selected['rotation'] })}
                      />
                    ) : null}
                    <Button label={`Remove photo ${number}`} variant="quiet" onPress={() => remove(item.id)} />
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {error ? <Banner tone="error" message={error} /> : null}
      <View className="max-w-prose gap-3">
        <Button
          label={usable.length === 1 ? 'Upload 1 photo' : `Upload ${usable.length} photos`}
          disabled={usable.length === 0 || (targetId !== undefined && !target.data)}
          busy={create.isPending}
          busyLabel="Starting upload"
          onPress={start}
        />
        <Button
          label={targetId ? 'Back to piece' : 'Back to Bower'}
          variant="secondary"
          onPress={() => router.replace(targetId ? `/wardrobe/items/${targetId}` : '/wardrobe')}
        />
      </View>
    </Screen>
  );
}
