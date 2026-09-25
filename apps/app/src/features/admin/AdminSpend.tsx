import { AdminBudget, BudgetThresholds, DiagnosticOutcome } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Heading, Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { apiRequest } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { formatMicros, formatResetTime } from '../../lib/format';
import { userKeys } from '../../lib/query-keys';

const modeLabel = { normal: 'Normal', lighter: 'Lighter mode', paused: 'Paused' } as const;

const budgetKey = (userId: string) => [...userKeys.all(userId), 'admin', 'budget'] as const;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row flex-wrap justify-between gap-2 border-t border-divider py-2">
      <Text variant="secondary">{label}</Text>
      <Text className="text-body text-text" style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

/** AI spend for the shared allowance (DESIGN 12.3). Spend only, never content. */
export function AdminSpend({ userId }: { userId: string }) {
  const budget = useQuery({
    queryKey: budgetKey(userId),
    queryFn: ({ signal }) => apiRequest('/admin/budget', { schema: AdminBudget, signal }),
  });

  if (budget.isPending) return <Text variant="secondary">Loading AI spend</Text>;
  if (budget.isError || !budget.data) {
    return (
      <Banner tone="error" message="AI spend couldn't load.">
        <Button label="Try again" variant="secondary" onPress={() => void budget.refetch()} />
      </Banner>
    );
  }
  const { period, settings } = budget.data;

  return (
    <View className="gap-4">
      <Heading level={2}>AI spend</Heading>
      {settings.paused_reason === 'over_reservation' ? (
        <Banner tone="error" message="AI is paused: a charge was higher than its reservation. Review usage, then resume deliberately." />
      ) : null}
      {!budget.data.ai_enabled ? (
        <Banner tone="warning" message="AI is turned off for this environment. Manual features keep working." />
      ) : null}
      <View className="max-w-prose rounded-control border border-divider bg-surface px-4 pb-2 pt-3">
        <Text className="text-action text-text">{`${modeLabel[period.mode]} · resets ${formatResetTime(period.resets_at)}`}</Text>
        <Row label="Month to date (actual)" value={formatMicros(period.settled_micros)} />
        <Row label="Reserved for requests in progress" value={formatMicros(period.reserved_micros)} />
        <Row label="Of which not yet confirmed by the provider" value={formatMicros(period.unknown_micros)} />
        <Row label="Held from last month" value={formatMicros(period.held_micros)} />
        <Row label="Remaining before the AI pause" value={formatMicros(period.remaining_micros)} />
        <Row label="Requests refused by the limit" value={String(period.refusals)} />
      </View>
      {budget.data.by_task.length > 0 ? (
        <View className="max-w-prose gap-1">
          <Heading level={3}>By task</Heading>
          {budget.data.by_task.map((task) => (
            <Row
              key={task.task}
              label={`${task.task} · ${task.attempts} ${task.attempts === 1 ? 'request' : 'requests'}`}
              value={formatMicros(task.settled_micros)}
            />
          ))}
        </View>
      ) : null}
      {budget.data.by_member.length > 0 ? (
        <View className="max-w-prose gap-1">
          <Heading level={3}>By member</Heading>
          {budget.data.by_member.map((member) => (
            <Row key={member.display_name} label={member.display_name} value={formatMicros(member.settled_micros)} />
          ))}
        </View>
      ) : null}
      <Diagnostic userId={userId} />
      <Thresholds userId={userId} budget={budget.data} />
    </View>
  );
}

const outcomeText = (outcome: DiagnosticOutcome) => {
  switch (outcome.status) {
    case 'completed':
      return `Diagnostic completed in ${outcome.mode} mode. Cost ${formatMicros(outcome.settled_micros ?? 0)}.`;
    case 'refused':
      return 'Diagnostic refused before reaching the provider: the AI limit is reached or AI is paused.';
    case 'uncertain':
      return 'The provider did not confirm this request. Its reserved cost stays counted and it will not be sent again.';
    case 'provider_rejected':
      return 'The provider rejected the request before processing it. Nothing was charged.';
    case 'invalid_output':
      return 'The provider answered with an invalid result. The cost was recorded.';
    default:
      return 'AI is unavailable. Manual features keep working.';
  }
};

function Diagnostic({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => apiRequest('/admin/ai-diagnostic', { method: 'POST', idempotencyKey: crypto.randomUUID(), schema: DiagnosticOutcome }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: budgetKey(userId) }),
  });
  return (
    <View className="max-w-prose gap-3">
      <Text variant="secondary">
        The diagnostic sends one tiny request with no personal content through the same limit as every AI feature.
      </Text>
      <Button label="Run AI diagnostic" variant="secondary" busy={run.isPending} busyLabel="Running diagnostic" onPress={() => run.mutate()} />
      {run.data ? <Banner tone={run.data.status === 'completed' ? 'success' : 'info'} message={outcomeText(run.data)} /> : null}
      {run.isError ? <Banner tone="error" message="The diagnostic couldn't run." /> : null}
    </View>
  );
}

const toDollars = (micros: number) => (micros / 1_000_000).toFixed(2);
const toMicros = (value: string) => Math.round(Number(value) * 1_000_000);

function Thresholds({ userId, budget }: { userId: string; budget: AdminBudget }) {
  const queryClient = useQueryClient();
  const { settings } = budget;
  const [lighter, setLighter] = useState(toDollars(settings.lighter_micros));
  const [stop, setStop] = useState(toDollars(settings.stop_micros));
  const [ceiling, setCeiling] = useState(toDollars(settings.ceiling_micros));
  const [confirming, setConfirming] = useState<null | { clearPause: boolean }>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  const values = { lighter_micros: toMicros(lighter), stop_micros: toMicros(stop), ceiling_micros: toMicros(ceiling) };
  const valid =
    Object.values(values).every((v) => Number.isSafeInteger(v) && v >= 0) &&
    values.lighter_micros <= values.stop_micros &&
    values.stop_micros <= values.ceiling_micros &&
    values.ceiling_micros <= 10_000_000;

  const save = useMutation({
    mutationFn: (clearPause: boolean) =>
      apiRequest('/admin/budget', {
        method: 'PATCH',
        idempotencyKey: key.current,
        body: { expected_revision: settings.revision, ...values, clear_pause: clearPause },
        schema: BudgetThresholds,
      }),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: budgetKey(userId) });
    },
    onError: (err) => {
      key.current = crypto.randomUUID();
      setConfirming(null);
      setError(
        err instanceof ApiError && err.code === 'REVISION_CONFLICT'
          ? 'The limits changed somewhere else. Reload and try again.'
          : 'Check the limits: lighter mode ≤ pause ≤ ceiling ≤ $10.00.',
      );
    },
  });

  return (
    <View className="max-w-prose gap-3">
      <Heading level={3}>Monthly limits</Heading>
      <Text variant="secondary">The ceiling can never be higher than $10.00. Set the pause to $0.00 to stop all AI requests.</Text>
      <TextField label="Lighter mode from (USD)" value={lighter} onChangeText={setLighter} inputMode="decimal" />
      <TextField label="Pause AI at (USD)" value={stop} onChangeText={setStop} inputMode="decimal" />
      <TextField label="Monthly ceiling (USD)" value={ceiling} onChangeText={setCeiling} inputMode="decimal" />
      {!valid ? <Banner tone="error" message="Lighter mode must be at most the pause, and the pause at most the ceiling of $10.00 or less." /> : null}
      {error ? <Banner tone="error" message={error} /> : null}
      <Button label="Review new limits" disabled={!valid} onPress={() => setConfirming({ clearPause: false })} />
      {settings.paused_reason ? (
        <Button label="Resume AI" variant="secondary" onPress={() => setConfirming({ clearPause: true })} />
      ) : null}
      <ConfirmDialog
        visible={confirming !== null}
        title={confirming?.clearPause ? 'Resume AI?' : 'Change the monthly AI limits?'}
        consequences={[
          `Lighter mode from ${formatMicros(values.lighter_micros)}, pause at ${formatMicros(values.stop_micros)}, ceiling ${formatMicros(values.ceiling_micros)}.`,
          `This month ${formatMicros(budget.period.settled_micros + budget.period.reserved_micros + budget.period.held_micros)} is already spent or reserved.`,
          values.stop_micros === 0 ? 'All AI requests will be refused until you raise the pause.' : 'Requests above the pause are refused before reaching the provider.',
        ]}
        confirmLabel={confirming?.clearPause ? 'Resume AI' : 'Save limits'}
        busy={save.isPending}
        onConfirm={() => save.mutate(confirming?.clearPause ?? false)}
        onCancel={() => setConfirming(null)}
      />
    </View>
  );
}
