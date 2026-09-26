import { MAX_PARTS_PER_PHOTO } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { RadioGroup } from '../../../../components/RadioGroup';
import { Prose, Screen } from '../../../../components/Screen';
import { Heading, Text } from '../../../../components/Text';
import { TextField } from '../../../../components/TextField';
import { PrivateImage } from '../../../../features/uploads/PrivateImage';
import { apiRequest, guardedRead } from '../../../../lib/api';
import { ApiError } from '../../../../lib/errors';
import { userKeys } from '../../../../lib/query-keys';
import { useSession } from '../../../../lib/session';
import { supabase } from '../../../../lib/supabase';

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
type Box = z.infer<typeof Box>;
const GroupEntry = z.object({
  id: z.string().uuid(),
  batch_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  state: z.string(),
  purpose: z.string(),
  proposed_parts: z.array(Box).nullable(),
  split_confirmed_at: z.string().nullable(),
  media_assets: z.object({ width: z.number().int().nullable(), height: z.number().int().nullable() }).nullable(),
});

/** A part being edited: whole percentages of the photo, as the member typed them. */
type Draft = { id: string; left: string; top: string; width: string; height: string };
const FIELDS = [
  ['left', 'From left'],
  ['top', 'From top'],
  ['width', 'Width'],
  ['height', 'Height'],
] as const;

const percent = (value: number) => String(Math.round(value * 1000) / 10);
const toDraft = (box: Box): Draft => ({
  id: crypto.randomUUID(),
  left: percent(box.x),
  top: percent(box.y),
  width: percent(box.w),
  height: percent(box.h),
});

/** Checks the typed numbers; the server re-validates every box. */
function toBox(draft: Draft): Box | null {
  const [x, y, w, h] = [draft.left, draft.top, draft.width, draft.height].map((v) => Number(v.replace(',', '.')) / 100);
  if ([x, y, w, h].some((v) => !Number.isFinite(v!))) return null;
  if (x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > 1.0001 || y! + h! > 1.0001) return null;
  return { x: x!, y: y!, w: w!, h: h! };
}

const Confirmed = z.object({ items: z.array(z.object({ item_id: z.string().uuid() })) });

/**
 * Keep a group photo as one set, or mark each piece (DESIGN 6.4). Nothing is
 * created until the member confirms. Rectangles are edited with number fields,
 * so no dragging is needed.
 */
export default function SplitGroup() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const { width: screen } = useWindowDimensions();
  const size = Math.max(200, Math.min(480, screen - 48));
  const entry = useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'group', id],
    queryFn: async ({ signal }) =>
      z.array(GroupEntry).parse(
        await guardedRead(() =>
          supabase
            .from('upload_entries')
            .select('id, batch_id, asset_id, state, purpose, proposed_parts, split_confirmed_at, media_assets(width, height)')
            .eq('id', id)
            .eq('purpose', 'grouped')
            .abortSignal(signal),
        ),
      )[0] ?? null,
    enabled: userId !== null && typeof id === 'string',
  });
  const [mode, setMode] = useState<'keep_one' | 'split' | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; body: string } | null>(null);

  const group = entry.data;
  // Proposals seed the draft; after the first edit the member's draft is kept.
  const proposed = useMemo(() => (group?.proposed_parts ?? []).map(toDraft), [group?.proposed_parts]);
  const parts = drafts ?? proposed;

  const confirm = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      if (!request.current || request.current.body !== text) request.current = { key: crypto.randomUUID(), body: text };
      return apiRequest(`/upload-entries/${id}/confirm-parts`, {
        method: 'POST',
        idempotencyKey: request.current.key,
        body,
        schema: Confirmed,
      });
    },
    onSuccess: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.all(userId) });
      router.replace(`/wardrobe/uploads/${group!.batch_id}`);
    },
    // The draft stays exactly as it was, so the member can correct and resend.
    onError: (err) => setError(err instanceof ApiError ? err.message : "The pieces weren't added. Try again."),
  });

  if (entry.isError) return <Screen title="Choose pieces"><Banner tone="error" message="This photo couldn't load." /></Screen>;
  if (!entry.isSuccess) return <Screen title="Choose pieces" />;
  if (!group || group.state !== 'ready' || group.split_confirmed_at) {
    return (
      <Screen title="Choose pieces">
        <Text>{group?.split_confirmed_at ? 'The pieces from this photo were already added.' : 'This photo is not waiting for pieces to be chosen.'}</Text>
        <Button label="Back to Bower" variant="secondary" className="self-start" onPress={() => router.replace('/wardrobe')} />
      </Screen>
    );
  }

  const width = group.media_assets?.width ?? 1;
  const height = group.media_assets?.height ?? 1;
  const scale = Math.min(size / width, size / height);
  const offset = { x: (size - width * scale) / 2, y: (size - height * scale) / 2 };
  const boxes = parts.map(toBox);
  const update = (partId: string, patch: Partial<Draft>) => setDrafts(parts.map((d) => (d.id === partId ? { ...d, ...patch } : d)));

  const submit = () => {
    setError(null);
    if (mode === 'keep_one') {
      confirm.mutate({ mode: 'keep_one', image: { width, height } });
      return;
    }
    const bad = boxes.findIndex((b) => b === null);
    if (parts.length === 0) return setError('Add at least one piece, or keep the photo as one set.');
    if (bad >= 0) return setError(`Check the numbers for piece ${bad + 1}: each must fit inside the photo.`);
    if (parts.length > MAX_PARTS_PER_PHOTO) {
      return setError(`Up to ${MAX_PARTS_PER_PHOTO} pieces per photo. Remove some, or photograph the rest separately.`);
    }
    confirm.mutate({ mode: 'split', image: { width, height }, parts: parts.map((d, i) => ({ part_id: d.id, box: boxes[i] })) });
  };

  return (
    <Screen title="Choose pieces" subtitle="Nothing is added to your Bower until you confirm.">
      <View style={{ width: size, height: size }} className="relative">
        <PrivateImage assetId={group.asset_id} label="The group photo" size={size} />
        {mode === 'split'
          ? boxes.map((box, index) =>
              box ? (
                <View
                  key={parts[index]!.id}
                  aria-hidden
                  pointerEvents="none"
                  className="absolute rounded-control border-2 border-accent"
                  style={{
                    left: offset.x + box.x * width * scale,
                    top: offset.y + box.y * height * scale,
                    width: box.w * width * scale,
                    height: box.h * height * scale,
                  }}
                >
                  <Text className="self-start bg-accent px-1 text-secondary text-on-accent">{String(index + 1)}</Text>
                </View>
              ) : null,
            )
          : null}
      </View>
      <RadioGroup
        label="How should this photo be added?"
        value={mode}
        options={[
          { value: 'keep_one', label: 'Keep as one set' },
          { value: 'split', label: 'Split into pieces' },
        ]}
        onChange={(value) => setMode(value)}
      />
      <Prose>
        <Text variant="secondary">
          Keep as one set for things sold and worn together, like a pair of earrings. Split to add each marked piece as its own
          piece with its own photo.
        </Text>
      </Prose>
      {mode === 'split' ? (
        <View className="max-w-prose gap-4">
          <Prose>
            <Text variant="secondary">
              {group.proposed_parts?.length
                ? 'bowr marked the pieces it found. Adjust, remove or add pieces. Numbers are percentages of the photo.'
                : 'No pieces were found automatically. Add a piece for each item. Numbers are percentages of the photo.'}
            </Text>
          </Prose>
          <View role="list" aria-label="Pieces to add" className="gap-4">
            {parts.map((draft, index) => (
              <View role="listitem" key={draft.id} className="gap-2 rounded-control border border-divider bg-surface p-3">
                <Heading level={3}>{`Piece ${index + 1}`}</Heading>
                <View className="flex-row flex-wrap gap-3">
                  {FIELDS.map(([field, label]) => (
                    <View key={field} className="w-[120px]">
                      <TextField
                        label={`${label} (%), piece ${index + 1}`}
                        value={draft[field]}
                        inputMode="decimal"
                        onChangeText={(value) => update(draft.id, { [field]: value })}
                        error={boxes[index] === null && index === boxes.indexOf(null) ? 'Must fit inside the photo' : undefined}
                      />
                    </View>
                  ))}
                </View>
                <Button
                  label={`Remove piece ${index + 1}`}
                  variant="quiet"
                  className="self-start"
                  onPress={() => setDrafts(parts.filter((d) => d.id !== draft.id))}
                />
              </View>
            ))}
          </View>
          <Button
            label="Add a piece"
            variant="secondary"
            className="self-start"
            onPress={() => setDrafts([...parts, toDraft({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 })])}
          />
          <Text role="status" aria-live="polite">
            {parts.length === 1 ? '1 piece will be added.' : `${parts.length} pieces will be added.`}
          </Text>
        </View>
      ) : null}
      {error ? <Banner tone="error" message={error} /> : null}
      <View className="max-w-prose gap-3">
        <Button
          label={mode === 'split' ? (parts.length === 1 ? 'Add 1 piece' : `Add ${parts.length} pieces`) : 'Add as one piece'}
          disabled={mode === null}
          busy={confirm.isPending}
          busyLabel="Adding pieces"
          onPress={submit}
        />
        <Button label="Decide later" variant="secondary" onPress={() => router.replace(`/wardrobe/uploads/${group.batch_id}`)} />
      </View>
    </Screen>
  );
}
