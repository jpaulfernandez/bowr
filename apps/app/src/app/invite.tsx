import { PendingDeletionResult } from '@bowr/contracts';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Prose, Screen } from '../components/Screen';
import { Heading, Text } from '../components/Text';
import { TextLink } from '../components/TextLink';
import { RedeemInviteForm } from '../features/invites/RedeemInviteForm';
import { apiRequest } from '../lib/api';
import { useBootstrap } from '../lib/bootstrap';
import { formatDateTime } from '../lib/format';
import { useSession } from '../lib/session';

const copy = {
  suspended: {
    title: 'Access paused',
    body: 'The owner has paused this account. Your wardrobe is not available while access is paused.',
  },
  deleting: {
    title: 'Account deletion in progress',
    body: 'This account is being deleted. Its data is no longer available.',
  },
} as const;

/** Gate for signed-in identities without active membership. */
export default function Invite() {
  const { userId, signOut } = useSession();
  const bootstrap = useBootstrap();
  const state = bootstrap.data?.membership.state;

  if (state === 'suspended' || state === 'deleting') {
    return (
      <Screen title={copy[state].title}>
        <Prose>
          <Text>{copy[state].body}</Text>
        </Prose>
        <View className="max-w-prose gap-3">
          <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
          <TextLink href="/privacy">How bowr handles your data</TextLink>
        </View>
      </Screen>
    );
  }

  return (
    <Screen title="Enter bowr" subtitle="bowr is invite-only.">
      <Prose>
        <Text>Enter the invite code the owner gave you to open your private Bower.</Text>
        {bootstrap.data?.pending_expires_at ? (
          <Text variant="secondary">
            {`Accounts without an invite are deleted after 24 hours. This one will be deleted after ${formatDateTime(bootstrap.data.pending_expires_at)}.`}
          </Text>
        ) : null}
      </Prose>
      {userId ? <RedeemInviteForm userId={userId} /> : null}
      <View className="max-w-prose gap-3">
        <Heading level={2}>Not the right account?</Heading>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
        <DeletePendingAccount />
        <TextLink href="/privacy">How bowr handles your data</TextLink>
      </View>
    </Screen>
  );
}

function DeletePendingAccount() {
  const { discardSession } = useSession();
  const [open, setOpen] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const remove = useMutation({
    mutationFn: () => apiRequest('/account/pending', { method: 'DELETE', idempotencyKey: key, schema: PendingDeletionResult }),
    onSuccess: async () => {
      setOpen(false);
      await discardSession();
      router.replace('/');
    },
  });

  return (
    <>
      <Button label="Delete this account" variant="destructive" onPress={() => setOpen(true)} />
      {remove.isError ? <Banner tone="error" message="bowr couldn't delete this account. Try again." /> : null}
      <ConfirmDialog
        visible={open}
        title="Delete this account?"
        consequences={[
          'Your sign-in and settings will be deleted. No wardrobe data exists for this account yet.',
          'You can sign in again later and enter an invite code.',
        ]}
        confirmLabel="Delete account"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
