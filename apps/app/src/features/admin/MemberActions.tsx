import { type AdminOverview } from '@bowr/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { apiRequest } from '../../lib/api';
import { startReauth } from '../account/reauth';
import { adminOverviewKey } from './AdminInvites';

type Member = AdminOverview['members'][number];

/** Owner actions on a member. Neither grants access to the member's wardrobe. */
export function MemberActions({ userId, member }: { userId: string; member: Member }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | 'suspend' | 'restore' | 'owner'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const name = member.display_name ?? 'this member';

  const setAccess = useMutation({
    mutationFn: (action: 'suspend' | 'restore') =>
      apiRequest(`/admin/members/${member.user_id}/${action}`, { method: 'POST', idempotencyKey: crypto.randomUUID(), schema: z.unknown() }),
    onSuccess: () => {
      setDialog(null);
      void queryClient.invalidateQueries({ queryKey: adminOverviewKey(userId) });
    },
  });
  const transfer = useMutation({
    mutationFn: () => startReauth('transfer_ownership', member.user_id),
    onSuccess: (result) => {
      setDialog(null);
      setNotice(result.via === 'email' ? `We sent a confirmation link to ${result.email}. Open it in this browser to finish.` : 'Continue with Google to confirm.');
    },
  });

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        {member.state === 'active' ? (
          <>
            <Button label={`Suspend ${name}`} variant="destructive" onPress={() => setDialog('suspend')} />
            <Button label={`Make ${name} the owner`} variant="secondary" onPress={() => setDialog('owner')} />
          </>
        ) : (
          <Button label={`Restore ${name}`} variant="secondary" onPress={() => setDialog('restore')} />
        )}
      </View>
      {notice ? <Banner tone="info" message={notice} /> : null}
      <ConfirmDialog
        visible={dialog === 'suspend'}
        title={`Suspend ${name}?`}
        consequences={[
          `${name} can no longer open their wardrobe or add photos. Their data is kept.`,
          'A photo link they already opened can keep working for up to five minutes; downloaded images cannot be recalled.',
          'You can restore access at any time.',
        ]}
        confirmLabel="Suspend"
        destructive
        busy={setAccess.isPending}
        onConfirm={() => setAccess.mutate('suspend')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'restore'}
        title={`Restore ${name}?`}
        consequences={[`${name} can use bowr again with their existing wardrobe.`]}
        confirmLabel="Restore access"
        busy={setAccess.isPending}
        onConfirm={() => setAccess.mutate('restore')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'owner'}
        title={`Make ${name} the owner?`}
        consequences={[
          `${name} will manage invites, members and AI limits. You will become a regular member.`,
          'Neither of you gains access to the other’s wardrobe.',
          'To confirm, we will send a new sign-in link to your email.',
        ]}
        confirmLabel="Send confirmation link"
        busy={transfer.isPending}
        onConfirm={() => transfer.mutate()}
        onCancel={() => setDialog(null)}
      />
    </View>
  );
}
