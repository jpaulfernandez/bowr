import { OperationsHealth } from '@bowr/contracts';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Heading, Text } from '../../components/Text';
import { apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { userKeys } from '../../lib/query-keys';

const taskLabel: Record<string, string> = {
  dispatch_jobs: 'Photo processing',
  temporary_cleanup: 'Temporary photo cleanup',
  account_deletion: 'Account deletion',
  ai_rollover: 'AI month rollover',
  pending_account_cleanup: 'Uninvited account cleanup',
  orphan_reconciliation: 'Storage check',
};

/** Background work health (ARCHITECTURE 14.3). Counts and times only, never content. */
export function AdminOperations({ userId }: { userId: string }) {
  const health = useQuery({
    queryKey: [...userKeys.all(userId), 'admin', 'operations'],
    queryFn: ({ signal }) => apiRequest('/admin/operations', { schema: OperationsHealth, signal }),
  });

  if (health.isPending) return <Text variant="secondary">Loading background work</Text>;
  if (health.isError || !health.data) {
    return (
      <Banner tone="error" message="Background work status couldn't load.">
        <Button label="Try again" variant="secondary" onPress={() => void health.refetch()} />
      </Banner>
    );
  }
  const data = health.data;
  const facts = [
    `${data.deletions_pending} ${data.deletions_pending === 1 ? 'file' : 'files'} waiting for deletion, ${data.deletions_overdue} past the target`,
    `${data.accounts_deleting} ${data.accounts_deleting === 1 ? 'account' : 'accounts'} being deleted, ${data.accounts_overdue} past 24 hours`,
    `${data.jobs_stuck} stuck ${data.jobs_stuck === 1 ? 'job' : 'jobs'}`,
    `${data.ai_unknown_attempts} AI ${data.ai_unknown_attempts === 1 ? 'request' : 'requests'} not confirmed by the provider`,
  ];

  return (
    <View className="max-w-prose gap-3">
      <Heading level={2}>Background work</Heading>
      {data.status === 'ok' ? (
        <Banner tone="success" message="Scheduled cleanup and processing are running." />
      ) : (
        <Banner
          tone="warning"
          message="Some background work is late. Deletions stay pending until it runs; see the operations runbook."
        />
      )}
      <View role="list" aria-label="Scheduled tasks" className="rounded-control border border-divider bg-surface px-4 py-2">
        {data.heartbeats.map((beat) => (
          <View role="listitem" key={beat.task} className="flex-row flex-wrap justify-between gap-2 py-2">
            <Text variant="secondary">{taskLabel[beat.task] ?? beat.task}</Text>
            <Text className="text-body text-text">
              {`${beat.stale ? 'Late · ' : ''}last ran ${formatDateTime(beat.last_succeeded_at)}`}
            </Text>
          </View>
        ))}
      </View>
      {facts.map((fact) => (
        <Text key={fact} variant="secondary">
          {fact}
        </Text>
      ))}
    </View>
  );
}
