import type { Item, ItemPatch } from '@bowr/contracts';
import { formalityLabels } from '@bowr/domain';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Heading, Text } from '../../components/Text';
import { guardedRead } from '../../lib/api';
import { useBootstrap } from '../../lib/bootstrap';
import { ApiError } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { itemKeys, stageFor, useRetryStage, useUpdateItem } from './queries';

const STAGE_LABEL = { crop: 'Photo', tags: 'Tags', colors: 'Colors', embedding: 'Matching' } as const;
type Stage = keyof typeof STAGE_LABEL;

function stageText(stage: Stage, state: string, code: string | null, resetsAt: string | null): string | null {
  if (['queued', 'running', 'retry_wait'].includes(state)) {
    return stage === 'crop'
      ? 'Cutting this piece out of its group photo.'
      : stage === 'tags'
        ? 'Suggesting tags.'
        : stage === 'colors'
          ? 'Measuring colors.'
          : 'Preparing matching.';
  }
  if (state === 'blocked_budget') {
    return `Tag suggestions wait for the monthly AI allowance${resetsAt ? `, which resets ${formatDateTime(resetsAt)}` : ''}. You can set details yourself meanwhile.`;
  }
  if (state === 'failed' || state === 'canceled') {
    if (stage === 'crop') {
      return code === 'SOURCE_MISSING'
        ? 'Its group photo is no longer available. Upload a photo of this piece instead.'
        : "This piece couldn't be cut out of its group photo.";
    }
    if (stage === 'tags') {
      if (code === 'AI_INVALID_OUTPUT') return "Tag suggestions couldn't be used. Your details are unchanged.";
      if (code === 'AI_UNCERTAIN') return "bowr couldn't confirm the last tag request; it may still count toward the AI allowance.";
      return "AI couldn't finish tagging. Your details are saved.";
    }
    if (stage === 'colors') return "Colors couldn't be measured. You can choose them yourself.";
    return code === 'MODEL_UNAVAILABLE' || code === 'INCOMPATIBLE_VECTOR_SPACE'
      ? "Matching isn't available for this piece yet. Everything else works."
      : "Matching couldn't be prepared for this piece.";
  }
  return null;
}

const Suggestion = z.object({
  suggested: z.record(z.string(), z.unknown()),
  applied_fields: z.array(z.string()),
  created_at: z.string(),
});

const FIELD_LABEL: Record<string, string> = {
  category: 'category',
  subcategory: 'type',
  pattern: 'pattern',
  material: 'material',
  formality: 'formality',
  seasons: 'conditions',
  style_tags: 'style tags',
  attributes: 'accessory details',
};

function valueText(field: string, value: unknown): string {
  if (field === 'formality' && typeof value === 'number') return formalityLabels[value - 1] ?? String(value);
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return Object.values(value).map(String).join(', ');
  return String(value);
}

/** Stage progress and the latest tag suggestion the member's own values kept out. */
export function ProcessingPanel({ item }: { item: Item }) {
  const { userId } = useSession();
  const resetsAt = useBootstrap().data?.ai?.resets_at ?? null;
  const retry = useRetryStage(item);
  const update = useUpdateItem(item);
  const [notice, setNotice] = useState<string | null>(null);
  const suggestion = useQuery({
    queryKey: [...itemKeys.one(userId ?? 'none', item.id), 'suggestion', item.revision],
    queryFn: async ({ signal }) =>
      z.array(Suggestion).parse(
        await guardedRead(() =>
          supabase
            .from('item_suggestions')
            .select('suggested, applied_fields, created_at')
            .eq('item_id', item.id)
            .eq('source', 'vision')
            .eq('status', 'applied')
            .order('created_at', { ascending: false })
            .limit(1)
            .abortSignal(signal),
        ),
      )[0] ?? null,
    enabled: userId !== null,
  });

  const rows = (Object.keys(STAGE_LABEL) as Stage[])
    .map((stage) => ({ stage, row: stageFor(item, stage) }))
    .filter(({ row }) => row !== null)
    .map(({ stage, row }) => ({ stage, row: row!, text: stageText(stage, row!.state, row!.failure_code, resetsAt) }))
    .filter((entry) => entry.text !== null);

  const current = item as unknown as Record<string, unknown>;
  const offers = suggestion.data
    ? Object.entries(suggestion.data.suggested).filter(
        ([field, value]) =>
          field in FIELD_LABEL && !suggestion.data!.applied_fields.includes(field) && JSON.stringify(current[field]) !== JSON.stringify(value),
      )
    : [];

  if (rows.length === 0 && offers.length === 0) return null;
  return (
    <View className="gap-3">
      <Heading level={2}>Suggestions and processing</Heading>
      {rows.map(({ stage, row, text }) => (
        <View key={stage} className="flex-row flex-wrap items-center gap-3">
          <Text role="status" className="min-w-0 flex-1 basis-[240px]">{`${STAGE_LABEL[stage]}: ${text}`}</Text>
          {row.can_retry ? (
            <Button
              label={`Retry ${STAGE_LABEL[stage].toLowerCase()}`}
              variant="secondary"
              busy={retry.isPending && retry.variables === stage}
              onPress={() =>
                retry.mutate(stage, {
                  onError: (error) => setNotice(error instanceof ApiError ? error.message : "The retry didn't start. Try again."),
                })
              }
            />
          ) : null}
        </View>
      ))}
      {offers.length > 0 ? <Text variant="secondary">Your edits take priority. You can still use a suggestion:</Text> : null}
      {offers.map(([field, value]) => (
        <View key={field} className="flex-row flex-wrap items-center gap-3">
          <Text className="min-w-0 flex-1 basis-[240px]">{`Suggested ${FIELD_LABEL[field]}: ${valueText(field, value)}`}</Text>
          <Button
            label={`Use suggested ${FIELD_LABEL[field]}`}
            variant="secondary"
            busy={update.isPending}
            onPress={() =>
              update.mutate(
                { patch: { [field]: value } as ItemPatch, key: crypto.randomUUID() },
                { onError: (error) => setNotice(error instanceof ApiError ? error.message : "That suggestion didn't save. Try again.") },
              )
            }
          />
        </View>
      ))}
      {notice ? <Banner tone="error" message={notice} /> : null}
    </View>
  );
}
