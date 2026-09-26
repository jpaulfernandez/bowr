import { MediaGrants } from '@bowr/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Text } from '../../components/Text';
import { apiRequest } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';

/**
 * Shows a private asset through a short-lived signed URL. The URL lives only in
 * the user-scoped query cache. An expired or failed image refreshes authorization
 * once, then shows an image error.
 */
export function PrivateImage({ assetId, label, size = 96 }: { assetId: string; label: string; size?: number }) {
  const { userId } = useSession();
  const refreshed = useRef(false);
  const [failed, setFailed] = useState(false);
  const grant = useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'media', assetId, 'original'],
    queryFn: async ({ signal }) =>
      (await apiRequest('/media/access', {
        method: 'POST',
        body: { requests: [{ asset_id: assetId, variant: 'original' }] },
        schema: MediaGrants,
        signal,
      }))[0]!,
    enabled: userId !== null,
    staleTime: 4 * 60_000,
    gcTime: 5 * 60_000,
  });

  const box = { width: size, height: size };
  if (failed || grant.isError || grant.data?.status === 'not_found') {
    return (
      <View style={box} className="items-center justify-center rounded-image border border-divider bg-surface-subtle p-1">
        <Text variant="secondary" className="text-center">
          Image unavailable
        </Text>
      </View>
    );
  }
  if (!grant.data) return <View style={box} className="rounded-image bg-surface-subtle" aria-hidden />;

  return (
    <Image
      // Remount after a refresh: a re-signed URL can be identical within the same second.
      key={grant.dataUpdatedAt}
      source={{ uri: grant.data.url }}
      style={box}
      resizeMode="contain"
      accessibilityLabel={label}
      className="rounded-image bg-surface"
      onError={() => {
        if (refreshed.current) {
          setFailed(true);
          return;
        }
        refreshed.current = true;
        void grant.refetch();
      }}
    />
  );
}
