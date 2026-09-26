import { useQuery } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { Text as RNText, View } from 'react-native';
import { z } from 'zod';
import { Button } from '../../../components/Button';
import { Prose, Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';
import { guardedRead } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { userKeys } from '../../../lib/query-keys';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';

const Batches = z.array(z.object({ id: z.string().uuid(), entry_count: z.number().int(), created_at: z.string() }));

export default function Bower() {
  const { userId } = useSession();
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

  return (
    <Screen title="Bower" subtitle="Your wardrobe">
      <View className="max-w-prose gap-3">
        <Button label="Gather" onPress={() => router.push('/wardrobe/gather')} />
      </View>
      <Prose>
        <Text>Your Bower is empty. Pieces you add will appear here, visible only to you.</Text>
      </Prose>
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
