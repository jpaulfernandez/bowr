import { ProfileSettings } from '@bowr/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Prose, Screen } from '../../components/Screen';
import { Heading, Text } from '../../components/Text';
import { TextLink } from '../../components/TextLink';
import { rpc } from '../../lib/api';
import { useBootstrap } from '../../lib/bootstrap';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';

/**
 * Brief privacy explanation and first-step choices (DESIGN 6.1). Only actions
 * that exist in this release are offered; nothing here is required.
 */
export default function Onboarding() {
  const { userId } = useSession();
  const bootstrap = useBootstrap();
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());

  const finish = useMutation({
    mutationFn: async () => {
      const revision = bootstrap.data?.profile?.revision;
      if (!revision || bootstrap.data?.profile?.onboarding_completed_at) return null;
      return rpc(
        'update_profile',
        { p_request_id: key, p_expected_revision: revision, p_patch: { onboarding_completed: true } },
        ProfileSettings.pick({ revision: true }),
      );
    },
    onSettled: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.all(userId) });
    },
    onSuccess: () => router.replace('/wardrobe'),
  });

  return (
    <Screen title="Welcome to bowr" subtitle="Your wardrobe is private.">
      <Prose>
        <Text>Only you can see your Bower. The owner who invited you manages invitations, not your wardrobe.</Text>
        <Text>bowr records what you choose to save. It does not collect measurements, selfies or your location to get started.</Text>
        <TextLink href="/privacy">Read how bowr handles your data</TextLink>
      </Prose>
      <View className="max-w-prose gap-3">
        <Heading level={2}>{"Start when you're ready"}</Heading>
        <Button label="Go to my Bower" busy={finish.isPending} busyLabel="Opening your Bower" onPress={() => finish.mutate()} />
        {finish.isError ? <Banner tone="error" message="bowr couldn't save that. You can still open your Bower." /> : null}
        {finish.isError ? <Button label="Open Bower anyway" variant="secondary" onPress={() => router.replace('/wardrobe')} /> : null}
      </View>
    </Screen>
  );
}
