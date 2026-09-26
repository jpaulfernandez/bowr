import { AdminOverview, CreatedInvite } from '@bowr/contracts';
import * as Clipboard from 'expo-clipboard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Heading, Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { apiRequest } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { formatDate, formatDateTime } from '../../lib/format';
import { userKeys } from '../../lib/query-keys';

type Invite = AdminOverview['invites'][number];

const statusLabel: Record<Invite['status'], string> = {
  active: 'Active',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const adminOverviewKey = (userId: string) => [...userKeys.all(userId), 'admin', 'overview'] as const;

export function AdminInvites({ userId, invites }: { userId: string; invites: Invite[] }) {
  return (
    <View className="gap-4">
      <Heading level={2}>Invites</Heading>
      <CreateInvite userId={userId} />
      {invites.length === 0 ? (
        <Text variant="secondary">No invites in the last 90 days.</Text>
      ) : (
        <View role="list" aria-label="Invites" className="overflow-hidden rounded-control border border-divider bg-surface">
          {invites.map((invite, index) => (
            <InviteRow key={invite.id} userId={userId} invite={invite} first={index === 0} />
          ))}
        </View>
      )}
    </View>
  );
}

function CreateInvite({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; body: string } | null>(null);

  const create = useMutation({
    mutationFn: (body: { note: string | null; expires_in_days: number }) => {
      const serialized = JSON.stringify(body);
      if (!request.current || request.current.body !== serialized) request.current = { key: crypto.randomUUID(), body: serialized };
      return apiRequest('/admin/invites', { method: 'POST', body, idempotencyKey: request.current.key, schema: CreatedInvite });
    },
    onSuccess: (invite) => {
      request.current = null;
      setCreated(invite);
      setCopied(false);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: adminOverviewKey(userId) });
    },
    onError: (err) => {
      if (err instanceof ApiError && !err.retryable) request.current = null;
      setError(err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? 'Check the note and expiry.' : "The invite wasn't created. Try again.");
    },
  });

  const submit = () => {
    const expires = Number(days);
    if (!Number.isInteger(expires) || expires < 1 || expires > 30) {
      setError('Choose an expiry between 1 and 30 days.');
      return;
    }
    setError(null);
    create.mutate({ note: note.trim() || null, expires_in_days: expires });
  };

  return (
    <View className="max-w-prose gap-4 rounded-control border border-divider bg-surface p-4">
      <Text variant="secondary">
        Each code admits one person. bowr does not send it for you; copy it and share it privately.
      </Text>
      <TextField label="Private note (optional)" hint="Only you can see this note." value={note} onChangeText={setNote} maxLength={200} />
      <TextField label="Expires after (days)" value={days} onChangeText={setDays} inputMode="numeric" maxLength={2} />
      {error ? <Banner tone="error" message={error} /> : null}
      <Button label="Create invite" busy={create.isPending} busyLabel="Creating invite" onPress={submit} />
      {created ? (
        created.code ? (
          <Banner tone="success" message={`Invite created. It expires ${formatDateTime(created.expires_at)}. The code is shown only now.`}>
            <Text selectable className="text-section-title text-text" aria-label="Invite code">
              {created.code}
            </Text>
            <Button
              label={copied ? 'Copied' : 'Copy code'}
              variant="secondary"
              onPress={() => {
                void Clipboard.setStringAsync(created.code ?? '').then(() => setCopied(true));
              }}
            />
          </Banner>
        ) : (
          <Banner
            tone="warning"
            message="This invite was already created and its code can't be shown again. Revoke it and create a new one if you didn't copy it."
          />
        )
      ) : null}
    </View>
  );
}

function InviteRow({ userId, invite, first }: { userId: string; invite: Invite; first: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const revoke = useMutation({
    mutationFn: () =>
      apiRequest(`/admin/invites/${invite.id}/revoke`, { method: 'POST', idempotencyKey: key, schema: z.unknown() }),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: adminOverviewKey(userId) });
    },
  });

  return (
    <View role="listitem" className={`gap-2 p-4 ${first ? '' : 'border-t border-divider'}`}>
      <Text className="text-action text-text">
        {statusLabel[invite.status]}
        {invite.note ? ` · ${invite.note}` : ''}
      </Text>
      <Text variant="secondary">
        {`Created ${formatDate(invite.created_at)} · expires ${formatDate(invite.expires_at)} · used ${invite.uses} of ${invite.max_uses}`}
      </Text>
      {invite.redeemed_by_name ? <Text variant="secondary">{`Joined: ${invite.redeemed_by_name}`}</Text> : null}
      {invite.status === 'active' ? (
        <Button label="Revoke invite" variant="destructive" className="self-start" onPress={() => setConfirming(true)} />
      ) : null}
      {revoke.isError ? <Banner tone="error" message="The invite wasn't revoked. Try again." /> : null}
      <ConfirmDialog
        visible={confirming}
        title="Revoke this invite?"
        consequences={[
          'Nobody will be able to use this code.',
          'People who already joined keep their access. Revoking an invite does not remove a member.',
        ]}
        confirmLabel="Revoke invite"
        destructive
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}
