import { useQuery } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { Text as RNText, View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Prose, Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';
import { PieceTile } from '../../../features/items/PieceTile';
import { useBowerItems, useItemCount } from '../../../features/items/queries';
import { guardedRead } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { userKeys } from '../../../lib/query-keys';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';

const Batches = z.array(z.object({ id: z.string().uuid(), entry_count: z.number().int(), created_at: z.string() }));

const GAP = 12;
const MIN_TILE = 152;

/** Columns from the actual available width: at least two, tiles near 152 px (DESIGN 5.3). */
function grid(width: number) {
  const columns = Math.max(2, Math.floor((width + GAP) / (MIN_TILE + GAP)));
  return { columns, size: Math.floor((width - GAP * (columns - 1)) / columns) };
}

export default function Bower() {
  const { userId } = useSession();
  const items = useBowerItems();
  const count = useItemCount();
  const [width, setWidth] = useState(0);
  const receipts = useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'upload-batches', 'recent'],
    queryFn: async ({ signal }) =>
      Batches.parse(
        await guardedRead(() =>
          supabase
            .from('upload_batches')
            .select('id, entry_count, created_at')
            .order('created_at', { ascending: false })
            .order('id')
            .limit(5)
            .abortSignal(signal),
        ),
      ),
    enabled: userId !== null,
  });

  const pieces = items.data?.pages.flat() ?? [];
  const total = count.data;
  const subtitle = total === undefined ? 'Your wardrobe' : `Your wardrobe · ${total} ${total === 1 ? 'piece' : 'pieces'}`;
  const { size } = grid(width);

  return (
    <Screen title="Bower" subtitle={subtitle}>
      <View className="max-w-prose gap-3">
        <Button label="Gather" onPress={() => router.push('/wardrobe/gather')} />
      </View>
      {items.isError ? <Banner tone="error" message="Your pieces couldn't load. Check your connection and try again." /> : null}
      {items.isSuccess && pieces.length === 0 ? (
        <Prose>
          <Text>Your Bower is empty. Gather your first piece.</Text>
          <Text variant="secondary">Start with a few pieces you wear often. Pieces you add are visible only to you.</Text>
        </Prose>
      ) : null}
      {pieces.length > 0 ? (
        <View className="gap-4" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <Heading level={2}>Pieces</Heading>
          {width > 0 ? (
            <View role="list" aria-label="Pieces" className="flex-row flex-wrap" style={{ gap: GAP }}>
              {pieces.map((item) => (
                <PieceTile key={item.id} item={item} size={size} />
              ))}
            </View>
          ) : null}
          {items.hasNextPage ? (
            <Button
              label="Show more pieces"
              variant="secondary"
              className="self-start"
              busy={items.isFetchingNextPage}
              busyLabel="Loading pieces"
              onPress={() => void items.fetchNextPage()}
            />
          ) : (
            <Text variant="secondary">{`That's everything: ${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'}.`}</Text>
          )}
        </View>
      ) : null}
      {receipts.data && receipts.data.length > 0 ? (
        <View className="max-w-prose gap-3">
          <Heading level={2}>Recent uploads</Heading>
          <View role="list" className="overflow-hidden rounded-control border border-divider bg-surface">
            {receipts.data.map((batch, index) => (
              <View role="listitem" key={batch.id} className={index === 0 ? '' : 'border-t border-divider'}>
                <Link href={`/wardrobe/uploads/${batch.id}`} className="min-h-target px-4 py-3 hover:bg-surface-subtle">
                  <RNText className="text-body text-accent">
                    {`${batch.entry_count} ${batch.entry_count === 1 ? 'photo' : 'photos'} · ${formatDateTime(batch.created_at)}`}
                  </RNText>
                </Link>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
