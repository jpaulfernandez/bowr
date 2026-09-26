import { MediaGrants } from '@bowr/contracts';
import type { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Text } from '../../components/Text';
import { apiRequest } from '../../lib/api';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';

type Grant = z.infer<typeof MediaGrants>[number];
type Waiting = { assetId: string; variant: string; resolve: (grant: Grant) => void; reject: (error: unknown) => void };
let waiting: Waiting[] = [];
let flushing: ReturnType<typeof setTimeout> | null = null;

/**
 * Images that mount together (a page of tiles) share one authorization request
 * of up to 50 grants instead of one request each.
 */
function requestGrant(assetId: string, variant: string): Promise<Grant> {
  return new Promise((resolve, reject) => {
    waiting.push({ assetId, variant, resolve, reject });
    flushing ??= setTimeout(flush, 10);
  });
}

function flush() {
  flushing = null;
  const batch = waiting.slice(0, 50);
  waiting = waiting.slice(50);
  if (waiting.length > 0) flushing = setTimeout(flush, 0);
  apiRequest('/media/access', {
    method: 'POST',
    body: { requests: batch.map((w) => ({ asset_id: w.assetId, variant: w.variant })) },
    schema: MediaGrants,
  }).then(
    (grants) => batch.forEach((w, i) => w.resolve(grants[i]!)),
    (error) => batch.forEach((w) => w.reject(error)),
  );
}

/**
 * Shows a private asset through a short-lived signed URL. The URL lives only in
 * the user-scoped query cache. An expired or failed image refreshes authorization
 * once, then shows an image error.
 */
export function PrivateImage({
  assetId,
  label,
  size = 96,
  variant = 'original',
}: {
  assetId: string;
  label: string;
  size?: number;
  /** The rendition to show: an asset signs only its own role. */
  variant?: 'original' | 'cutout' | 'thumbnail' | 'mask';
}) {
  const { userId } = useSession();
  const refreshed = useRef(false);
  const [failed, setFailed] = useState(false);
  const grant = useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'media', assetId, variant],
    queryFn: () => requestGrant(assetId, variant),
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
