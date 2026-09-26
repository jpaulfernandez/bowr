// Server-side analytics: allowlisted outbox events sent to PostHog's capture API.
// Only the event name and its bounded categorical properties leave the database.
import { serviceClient } from './service.ts';

const SYSTEM_DISTINCT_ID = 'bowr-system';

/** Records a budget-mode transition, then sends unsent events. Never throws. */
export async function observeBudgetMode(): Promise<{ analytics_sent: number; analytics_failed: number }> {
  const db = serviceClient();
  try {
    const { error } = await db.rpc('svc_observe_budget_mode', {});
    if (error) throw new Error(`observe failed: ${error.code}`);
    return { analytics_sent: await flushAnalytics(), analytics_failed: 0 };
  } catch (error) {
    // Analytics must not fail operational work; unsent rows are retried next run.
    console.warn(JSON.stringify({ alert: 'analytics_flush_failed', error: (error as Error).message.slice(0, 80) }));
    return { analytics_sent: 0, analytics_failed: 1 };
  }
}

async function flushAnalytics(): Promise<number> {
  const host = Deno.env.get('POSTHOG_HOST');
  const apiKey = Deno.env.get('POSTHOG_API_KEY');
  if (!host || !apiKey) return 0;
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_unsent_analytics', { p_limit: 50 });
  if (error) throw new Error(`outbox read failed: ${error.code}`);
  let sent = 0;
  for (
    const row of (data ?? []) as Array<
      { id: number; event: string; properties: Record<string, unknown>; created_at: string }
    >
  ) {
    const response = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: row.event,
        distinct_id: SYSTEM_DISTINCT_ID,
        timestamp: row.created_at,
        properties: { ...row.properties, $process_person_profile: false },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`capture ${response.status}`);
    // Marked one at a time so a later failure cannot resend this event.
    const { error: markError } = await db.rpc('svc_mark_analytics_sent', { p_ids: [row.id] });
    if (markError) throw new Error(`outbox mark failed: ${markError.code}`);
    sent += 1;
  }
  return sent;
}
