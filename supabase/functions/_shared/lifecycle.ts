// Deletion processing shared by the API (right after a request) and maintenance.
import { serviceClient } from './service.ts';
import { deleteObject } from './storage.ts';

/** Deletes due objects and confirms absence before completing each task. */
export async function processMediaDeletion(limit = 100) {
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_claim_deletion_tasks', { p_limit: limit });
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

/** Removes Auth identities whose stored objects are all confirmed absent. */
export async function processAccountDeletions() {
  const db = serviceClient();
  const media = await processMediaDeletion();
  const { data, error } = await db.rpc('svc_account_deletions_ready', { p_limit: 20 });
  if (error) throw new Error(`deletions failed: ${error.code}`);
  let completed = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ deletion_id: string; user_id: string }>) {
    const { error: deleteError } = await db.auth.admin.deleteUser(row.user_id);
    const message = deleteError && deleteError.status !== 404 ? `auth_delete_${deleteError.status ?? 'error'}` : null;
    await db.rpc('svc_complete_account_deletion', { p_deletion_id: row.deletion_id, p_error: message });
    if (message) failed += 1;
    else completed += 1;
  }
  return {
    objects_deleted: media.deleted,
    objects_failed: media.failed,
    accounts_completed: completed,
    accounts_failed: failed,
  };
}
