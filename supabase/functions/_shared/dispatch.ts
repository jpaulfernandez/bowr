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
  const { data: issued, error } = await serviceClient().rpc('svc_issue_job_claim', {
    p_job_id: jobId,
    p_nonce_hash: await sha256Hex(token),
  });
  if (error) return 'failed';
  if (!issued) return 'not_queued';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Modal-Key': key, 'Modal-Secret': secret },
      body: JSON.stringify({ job_id: jobId, claim_token: token }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? 'dispatched' : 'failed';
  } catch {
    // The job stays queued; P0.04 reconciliation re-dispatches it.
    return 'failed';
  }
}
