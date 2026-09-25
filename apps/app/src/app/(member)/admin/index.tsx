import { AdminOverview } from '@bowr/contracts';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';
import { AdminInvites, adminOverviewKey } from '../../../features/admin/AdminInvites';
import { apiRequest } from '../../../lib/api';
import { formatDate } from '../../../lib/format';
import { useSession } from '../../../lib/session';

const stateLabel = { active: 'Active', suspended: 'Suspended' } as const;

/** Owner-only administration. The server rejects nonowners; hiding the link is not access control. */
export default function Admin() {
  const { userId } = useSession();
  const overview = useQuery({
    queryKey: adminOverviewKey(userId ?? 'none'),
    queryFn: ({ signal }) => apiRequest('/admin/overview', { schema: AdminOverview, signal }),
    enabled: userId !== null,
  });

  return (
    <Screen title="Admin" subtitle="Members and invites">
      {overview.isPending ? <Text variant="secondary">Loading administration</Text> : null}
      {overview.isError ? (
        <Banner tone="error" message="Administration couldn't load.">
          <Button label="Try again" variant="secondary" onPress={() => void overview.refetch()} />
        </Banner>
      ) : null}
      {overview.data && userId ? (
        <View className="gap-8">
          <View className="gap-4">
            <Heading level={2}>Members</Heading>
            <Text variant="secondary">
              {`${overview.data.members.length} admitted · ${overview.data.pending_count} waiting for an invite. Wardrobes stay private to each member.`}
            </Text>
            <View role="list" aria-label="Members" className="overflow-hidden rounded-control border border-divider bg-surface">
              {overview.data.members.map((member, index) => (
                <View role="listitem" key={member.user_id} className={`gap-1 p-4 ${index === 0 ? '' : 'border-t border-divider'}`}>
                  <Text className="text-action text-text">
                    {`${member.display_name ?? 'Unnamed member'}${member.role === 'owner' ? ' · Owner' : ''}`}
                  </Text>
                  <Text variant="secondary">
                    {`${stateLabel[member.state]} · joined ${formatDate(member.joined_at)}${member.invited_by_name ? ` · invited by ${member.invited_by_name}` : ''}`}
                  </Text>
                  <Text variant="secondary">{`Last sign-in ${formatDate(member.last_sign_in_at)}`}</Text>
                </View>
              ))}
            </View>
          </View>
          <AdminInvites userId={userId} invites={overview.data.invites} />
        </View>
      ) : null}
    </Screen>
  );
}
