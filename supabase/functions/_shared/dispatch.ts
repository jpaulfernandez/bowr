// Authenticated wake-up for the processing worker (Modal proxy auth in
// staging/production). The worker receives only a single-use claim token.
import { sha256Hex } from './capability.ts';
import { serviceClient } from './service.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Runs work after the response when the runtime supports it; the durable job does not depend on it. */
export function afterResponse(work: Promise<unknown>): void {
  const guarded = work.catch((error) =>
    console.error(JSON.stringify({ event: 'after_response_failed', error: (error as Error).name }))
  );
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(guarded);
}

export async function dispatchJob(jobId: string): Promise<'dispatched' | 'not_queued' | 'failed'> {
  const url = Deno.env.get('WORKER_DISPATCH_URL');
  const key = Deno.env.get('WORKER_DISPATCH_KEY');
  const secret = Deno.env.get('WORKER_DISPATCH_SECRET');
  if (!url || !key || !secret) return 'failed';

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const nonceHash = await sha256Hex(token);
  const db = serviceClient();
  const { data: issued, error } = await db.rpc('svc_issue_job_claim', { p_job_id: jobId, p_nonce_hash: nonceHash });
  if (error) return 'failed';
  if (!issued) return 'not_queued';

  let ok = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Modal-Key': key, 'Modal-Secret': secret },
      body: JSON.stringify({ job_id: jobId, claim_token: token }),
      signal: AbortSignal.timeout(5000),
    });
    ok = response.ok;
  } catch {
    ok = false;
  }
  if (!ok) {
    // The job stays queued; the minute scheduler dispatches it again.
    await db.rpc('svc_release_job_claim', { p_job_id: jobId, p_nonce_hash: nonceHash });
    return 'failed';
  }
  return 'dispatched';
}

/** Reconciles and dispatches runnable jobs, within the concurrency limits. */
export async function dispatchRunnable(
  limit = 20,
): Promise<{ runnable: number; dispatched: number; deferred: number }> {
  const { data, error } = await serviceClient().rpc('svc_reconcile_jobs', { p_limit: limit });
  if (error) throw new Error(`reconcile failed: ${error.code}`);
  let dispatched = 0;
  let deferred = 0;
  for (const row of (data ?? []) as Array<{ job_id: string }>) {
    if ((await dispatchJob(row.job_id)) === 'dispatched') dispatched += 1;
    else deferred += 1;
  }
  return { runnable: (data ?? []).length, dispatched, deferred };
}
