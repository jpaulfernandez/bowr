// Scheduled maintenance, called by pg_cron through pg_net with a machine secret.
// There is no user-facing route here and user JWTs are not accepted.
import { serviceClient } from '../_shared/service.ts';
import { deleteObject } from '../_shared/storage.ts';

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

/** Deletes due objects and confirms absence before completing each task. */
async function mediaDeletion() {
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_claim_deletion_tasks', { p_limit: 100 });
  if (error) throw new Error(`claim failed: ${error.code}`);
  let deleted = 0;
  let failed = 0;
  for (const task of (data ?? []) as Array<{ id: number; object_key: string }>) {
    let absent = false;
    let message: string | null = null;
    try {
      absent = await deleteObject(task.object_key);
    } catch (err) {
      message = (err as Error).message.slice(0, 80);
    }
    await db.rpc('svc_complete_deletion_task', { p_task_id: task.id, p_confirmed_absent: absent, p_error: message });
    if (absent) deleted += 1;
    else failed += 1;
  }
  return { claimed: (data ?? []).length, deleted, failed };
}

const tasks: Record<string, () => Promise<Record<string, number>>> = {
  pending_account_cleanup: pendingAccountCleanup,
  media_deletion: mediaDeletion,
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
