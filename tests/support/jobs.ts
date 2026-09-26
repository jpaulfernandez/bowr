import { sql } from './stack';

/**
 * Issues a claim for a queued job as the test harness "worker", waiting while
 * the processing slots (one per member, two overall) are held by other work,
 * such as cutouts queued by earlier uploads. Returns whether it was issued.
 */
export async function issueClaimWhenFree(jobId: string, nonceHash: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ issued }] = await sql()`select public.svc_issue_job_claim(${jobId}, ${nonceHash}) as issued`;
    if (issued) return true;
    const [{ queued }] = await sql()`select state = 'queued' as queued from private.jobs where id = ${jobId}`;
    if (!queued) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Waits until cutouts and other item stages queued by earlier uploads have
 * finished. A finishing stage dispatches every runnable job, so a test that
 * needs an undispatched job (a "lost wake-up") creates it only after this.
 */
export async function settleItemStages(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ n }] = await sql()`select count(*)::int as n from private.jobs
      where kind = 'item_stage' and state in ('queued', 'running', 'retry_wait')`;
    if (n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('item stages did not settle');
}
