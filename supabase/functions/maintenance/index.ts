// Scheduled maintenance, called by pg_cron through pg_net with a machine secret,
// and a read-only health check for an external monitor with its own token.
// There is no user-facing route here and user JWTs are not accepted.
import { serviceClient } from '../_shared/service.ts';
import { runDiagnostic } from '../_shared/ai-gateway.ts';
import { observeBudgetMode } from '../_shared/analytics.ts';
import { dispatchRunnable } from '../_shared/dispatch.ts';
import {
  processAccountDeletions,
  processMediaDeletion,
  reconcileOrphans,
  temporaryCleanup,
} from '../_shared/lifecycle.ts';

function authorized(req: Request, secretName: string): boolean {
  const expected = Deno.env.get(secretName);
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
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_ai_rollover', {});
  if (error) throw new Error(`rollover failed: ${error.code}`);
  // After a reset, parked tag stages for pieces that still exist become runnable
  // again; each still needs a new reservation. Opening a screen never does this.
  const { data: resumed, error: resumeError } = await db.rpc('svc_resume_blocked_stages', { p_limit: 50 });
  if (resumeError) throw new Error(`resume failed: ${resumeError.code}`);
  if ((resumed as number) > 0) await dispatchRunnable(20);
  return {
    holds_created: (data as { holds_created: number }).holds_created,
    stages_resumed: resumed as number,
    ...(await observeBudgetMode()),
  };
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
  temporary_cleanup: temporaryCleanup,
  orphan_reconciliation: reconcileOrphans,
};

/** Heartbeats are recorded for scheduled tasks; other tasks are ignored by the database. */
async function recordRun(task: string, startedAt: Date, error: string | null) {
  const { error: recordError } = await serviceClient().rpc('svc_record_maintenance_run', {
    p_task: task,
    p_started_at: startedAt.toISOString(),
    p_error: error,
  });
  if (recordError) console.error(JSON.stringify({ alert: 'heartbeat_not_recorded', task }));
}

/** 200 when every scheduled task ran recently and nothing is overdue; 503 otherwise. Counts only. */
async function health(requestId: string, headers: Record<string, string>) {
  const { data, error } = await serviceClient().rpc('svc_operations_health', {});
  if (error) {
    return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' }, request_id: requestId }), {
      status: 503,
      headers,
    });
  }
  const report = data as { status: string };
  return new Response(JSON.stringify({ data: report, request_id: requestId }), {
    status: report.status === 'ok' ? 200 : 503,
    headers,
  });
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/health') && authorized(req, 'HEALTH_CHECK_TOKEN')) {
    return await health(requestId, headers);
  }
  if (req.method !== 'POST' || !authorized(req, 'MAINTENANCE_SECRET')) {
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
    const startedAt = new Date();
    let summary: Record<string, number>;
    try {
      summary = await run();
    } catch (error) {
      await recordRun(task!, startedAt, (error as Error).message);
      throw error;
    }
    await recordRun(task!, startedAt, null);
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
