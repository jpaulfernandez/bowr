import { AccountDeletionStarted, ReauthProof } from '@bowr/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Prose, Screen } from '../../../components/Screen';
import { Text } from '../../../components/Text';
import { clearPendingReauth, readPendingReauth, rememberDeletionStatus } from '../../../features/account/reauth';
import { apiRequest } from '../../../lib/api';
import { ApiError } from '../../../lib/errors';
import { useSession } from '../../../lib/session';

const copy = {
  delete_account: {
    title: 'Delete your account',
    body: 'Your pieces, photos, uploads and settings will be deleted. Photos are removed from storage within a day. This cannot be undone.',
    action: 'Delete my account permanently',
  },
  transfer_ownership: {
    title: 'Transfer ownership',
    body: 'The member you chose becomes the owner. You become a regular member and lose access to Admin. Wardrobes stay private.',
    action: 'Transfer ownership',
  },
} as const;

/** Final step after a fresh sign-in: verify the challenge, then act once. */
export default function ConfirmAction() {
  const [pending] = useState(readPendingReauth);
  const { discardSession } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error('no_pending');
      const proof = await apiRequest(`/account/reauth-challenges/${pending.challengeId}/verify`, {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        schema: ReauthProof,
      });
      if (pending.action === 'delete_account') {
        const started = await apiRequest('/account', {
          method: 'DELETE',
          idempotencyKey: crypto.randomUUID(),
          body: { proof: proof.proof },
          schema: AccountDeletionStarted,
        });
        return { kind: 'deleted' as const, statusToken: started.status_token };
      }
      await apiRequest('/admin/ownership-transfer', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: { recipient_user_id: pending.recipientId, proof: proof.proof },
        schema: z.unknown(),
      });
      return { kind: 'transferred' as const };
    },
    onSuccess: async (result) => {
      clearPendingReauth();
      if (result.kind === 'deleted') {
        rememberDeletionStatus(result.statusToken);
        await discardSession();
        router.replace('/account-deleted');
      } else {
        await queryClient.invalidateQueries();
        router.replace('/more');
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'OWNER_TRANSFER_REQUIRED') {
        clearPendingReauth();
        setError('Other members are active. Transfer ownership in Admin before deleting your account.');
      } else if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') {
        clearPendingReauth();
        setError('This confirmation expired or was already used. Start again from Settings.');
      } else {
        setError("That didn't complete. Nothing was changed; try again.");
      }
    },
  });

  if (!pending) {
    return (
      <Screen title="Nothing to confirm">
        <Prose>
          <Text>There is no confirmation waiting in this browser. Start again from Settings.</Text>
        </Prose>
        <Button label="Back to Settings" variant="secondary" onPress={() => router.replace('/settings')} />
      </Screen>
    );
  }
  const text = copy[pending.action];
  return (
    <Screen title={text.title} subtitle="You signed in again to confirm.">
      <Prose>
        <Text>{text.body}</Text>
      </Prose>
      <View className="max-w-prose gap-3">
        {error ? <Banner tone="error" message={error} /> : null}
        <Button
          label={text.action}
          variant={pending.action === 'delete_account' ? 'destructive' : 'primary'}
          busy={confirm.isPending}
          busyLabel="Confirming"
          onPress={() => confirm.mutate()}
        />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            clearPendingReauth();
            router.replace('/settings');
          }}
        />
      </View>
    </Screen>
  );
}
