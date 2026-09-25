// Scheduled maintenance, called by pg_cron through pg_net with a machine secret.
// There is no user-facing route here and user JWTs are not accepted.
import { serviceClient } from '../_shared/service.ts';
import { runDiagnostic } from '../_shared/ai-gateway.ts';
import { dispatchRunnable } from '../_shared/dispatch.ts';
import { processAccountDeletions, processMediaDeletion } from '../_shared/lifecycle.ts';

function authorized(req: Request): boolean {
  const expected = Deno.env.get('MAINTENANCE_SECRET');
  const provided = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!expected || expected.length < 32 || !provided) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function pendingAccountCleanup() {
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_claim_pending_account_cleanup', { p_limit: 50 });
  if (error) throw new Error(`claim failed: ${error.code}`);
  let deleted = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ user_id: string; deletion_reason: string }>) {
    const { error: deleteError } = await db.auth.admin.deleteUser(row.user_id);
    if (deleteError && deleteError.status !== 404) {
      // Stays in the deleting state; the next run retries it.
      failed += 1;
      continue;
    }
    await db.rpc('svc_record_pending_account_deleted', { p_user_id: row.user_id, p_reason: row.deletion_reason });
    deleted += 1;
  }
  return { claimed: (data ?? []).length, deleted, failed };
}

/** Recovers expired leases and due retries, then dispatches runnable jobs. */
async function dispatchJobs() {
  const db = serviceClient();
  const summary = await dispatchRunnable(20);
  const { data: stuck } = await db.rpc('svc_stuck_jobs');
  if ((stuck ?? []).length > 0) {
    // Safe operational alert: job IDs and states only.
    console.warn(JSON.stringify({ alert: 'stuck_jobs', jobs: stuck }));
  }
  return { ...summary, stuck: (stuck ?? []).length };
}

async function aiRollover() {
  const { data, error } = await serviceClient().rpc('svc_ai_rollover', {});
  if (error) throw new Error(`rollover failed: ${error.code}`);
  return { holds_created: (data as { holds_created: number }).holds_created };
}

/** Operator-only guarded smoke call through the same gateway and budget. */
async function aiDiagnostic() {
  const outcome = await runDiagnostic(`operator-diagnostic:${crypto.randomUUID()}`, null);
  console.log(JSON.stringify({ event: 'ai_diagnostic', status: outcome.status }));
  return {
    completed: outcome.status === 'completed' ? 1 : 0,
    settled_micros: 'settled_micros' in outcome ? outcome.settled_micros : 0,
    refused: outcome.status === 'refused' ? 1 : 0,
  };
}

const tasks: Record<string, () => Promise<Record<string, number>>> = {
  ai_rollover: aiRollover,
  ai_diagnostic: aiDiagnostic,
  dispatch_jobs: dispatchJobs,
  pending_account_cleanup: pendingAccountCleanup,
  media_deletion: () => processMediaDeletion(),
  account_deletion: processAccountDeletions,
};

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method !== 'POST' || !authorized(req)) {
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' }, request_id: requestId }), {
      status: 404,
      headers,
    });
  }
  try {
    const { task } = (await req.json()) as { task?: string };
    const run = task ? tasks[task] : undefined;
    if (!run) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' }, request_id: requestId }), {
        status: 404,
        headers,
      });
    }
    const summary = await run();
    console.log(JSON.stringify({ request_id: requestId, task, ...summary }));
    return new Response(JSON.stringify({ data: { task, ...summary }, request_id: requestId }), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error(JSON.stringify({ request_id: requestId, error: (error as Error).message }));
    return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' }, request_id: requestId }), {
      status: 503,
      headers,
    });
  }
});
