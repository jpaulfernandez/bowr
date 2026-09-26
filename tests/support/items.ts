import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect } from 'vitest';
import { api } from './api';
import { settleItemStages } from './jobs';
import { createSlot, putSlot } from './media';
import { sql, stack } from './stack';

export { wardrobeFixtures } from './media';

export async function waitUntil<T>(read: () => Promise<T | null | undefined>, label: string, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function itemForEntry(entryId: string) {
  const [row] = await sql()`select i.*, (select state from public.item_stages s where s.item_id = i.id and s.stage = 'cutout') as cutout_state
    from public.items i where i.source_entry_id = ${entryId}`;
  return row ?? null;
}

/** Uploads one garment photo through the public API and waits for its item. */
export async function gatherPiece(token: string, bytes: Buffer, contentType = 'image/png') {
  const { entry, batchId } = await createSlot(token, bytes, contentType);
  expect((await putSlot(entry, bytes)).status).toBe(200);
  const completed = await api(`/upload-entries/${entry.entry_id}/complete`, { token, method: 'POST', key: randomUUID() });
  expect(completed.status).toBe(202);
  const item = await waitUntil(() => itemForEntry(entry.entry_id), `item for entry ${entry.entry_id}`);
  return { entryId: entry.entry_id as string, assetId: entry.asset_id as string, batchId, itemId: item.id as string };
}

/** Waits until an item's stage leaves the pending states. */
export async function settledStage(itemId: string, stage: string, timeoutMs = 45_000) {
  return waitUntil(async () => {
    const [row] = await sql()`select * from public.item_stages where item_id = ${itemId} and stage = ${stage}`;
    return row && ['succeeded', 'failed', 'canceled', 'blocked_budget'].includes(row.state) ? row : null;
  }, `${stage} of ${itemId}`, timeoutMs);
}

export async function currentAssets(itemId: string) {
  return sql()`select ia.role, ia.asset_id, ia.media_revision, a.state, a.width, a.height, a.content_type, a.sha256
    from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
    where ia.item_id = ${itemId} and ia.detached_at is null order by ia.role`;
}

/** A Data API client acting as the signed-in member (RLS and RPC grants apply). */
export function userClient(token: string) {
  return createClient(stack().API_URL, stack().ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const internalUrl = (path: string) => `${stack().API_URL}/functions/v1/internal/v1${path}`;

/** POSTs to the internal worker API with a job capability. */
export async function internalPost(path: string, capability: string, body: unknown) {
  const response = await fetch(internalUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

/**
 * The harness re-runs an item's finished stage as a slow, older worker would:
 * the job is queued again and claimed by the test, not by the local worker.
 */
export async function harnessRerun(itemId: string, stage: string, { settle = true } = {}) {
  if (settle) await settleItemStages();
  const [{ job_id: jobId }] = await sql()`select job_id from public.item_stages where item_id = ${itemId} and stage = ${stage}`;
  // Requeued together with the harness's own claim, so the scheduler (or a
  // dispatch triggered by another completion) never hands it to the local worker.
  const token = randomBytes(32).toString('hex');
  await sql()`update private.jobs set state = 'queued', attempt_count = 0, next_run_at = now(),
      claim_nonce_hash = ${createHash('sha256').update(token).digest('hex')}, claim_expires_at = now() + interval '5 minutes'
    where id = ${jobId}`;
  const claimed = await fetch(internalUrl('/jobs/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, claim_token: token }),
  });
  expect(claimed.status).toBe(200);
  return { jobId: jobId as string, job: ((await claimed.json()) as any).data };
}
