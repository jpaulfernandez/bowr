import { AccountDeletionStatus } from '@bowr/contracts';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Prose, Screen } from '../components/Screen';
import { Text } from '../components/Text';
import { readDeletionStatus } from '../features/account/reauth';
import { apiBaseUrl, env } from '../lib/env';
import { formatDateTime } from '../lib/format';

/**
 * Deletion progress through a restricted status capability. "Deleted" is shown
 * only after the server confirms every stored object is gone.
 */
export default function AccountDeleted() {
  const [token] = useState(readDeletionStatus);
  const status = useQuery({
    queryKey: ['account-deletion-status', token],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${apiBaseUrl}/account/deletion-status`, {
        headers: { 'X-Deletion-Status': token ?? '', apikey: env.supabasePublishableKey },
        signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return AccountDeletionStatus.parse(((await response.json()) as { data: unknown }).data);
    },
    enabled: token !== null,
    refetchInterval: (query) => (query.state.data?.state === 'complete' ? false : 10_000),
  });

  const data = status.data;
  return (
    <Screen title={data?.state === 'complete' ? 'Account deleted' : 'Deleting your account'}>
      <Prose>
        {data?.state === 'complete' ? (
          <Text>{`Your account and its stored photos were deleted on ${formatDateTime(data.completed_at)}.`}</Text>
        ) : (
          <Text>
            You are signed out and your data is no longer accessible. bowr is still removing stored photos; this page
            says so until their deletion is confirmed.
          </Text>
        )}
        {data && data.state !== 'complete' ? (
          <Text role="status" variant="secondary">
            {data.objects_remaining > 0
              ? `${data.objects_remaining} stored ${data.objects_remaining === 1 ? 'file' : 'files'} still being deleted.`
              : 'Stored files are deleted. Removing your sign-in.'}
          </Text>
        ) : null}
        <Text variant="secondary">
          Database backups, where enabled, expire within seven days. Anything someone already downloaded cannot be recalled.
        </Text>
      </Prose>
      {token === null || status.isError ? (
        <Banner tone="info" message="Deletion continues even if this page cannot show its progress." />
      ) : null}
      <View className="max-w-prose">
        <Button label="Go to the welcome page" variant="secondary" onPress={() => router.replace('/')} />
      </View>
    </Screen>
  );
}
