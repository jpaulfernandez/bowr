// Deletion processing shared by the API (right after a request) and maintenance.
import { serviceClient } from './service.ts';
import { bucketName, deleteObject, listObjects, putJournalEntry } from './storage.ts';

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

/** Copies new deletion journal rows to the external journal bucket, oldest first. */
export async function exportDeletionJournal() {
  const db = serviceClient();
  const { data, error } = await db.rpc('svc_unexported_journal', { p_limit: 100 });
  if (error) throw new Error(`journal read failed: ${error.code}`);
  const exported: number[] = [];
  for (const row of (data ?? []) as Array<{ id: number; kind: string; subject_id: string; recorded_at: string }>) {
    const body = JSON.stringify({ kind: row.kind, subject_id: row.subject_id, recorded_at: row.recorded_at });
    await putJournalEntry(`deletions/${row.recorded_at.slice(0, 10)}/${String(row.id).padStart(12, '0')}.json`, body);
    exported.push(row.id);
  }
  if (exported.length > 0) {
    const { error: markError } = await db.rpc('svc_mark_journal_exported', { p_ids: exported });
    if (markError) throw new Error(`journal mark failed: ${markError.code}`);
  }
  return exported.length;
}

/** Removes Auth identities whose stored objects are all confirmed absent. */
export async function processAccountDeletions() {
  const db = serviceClient();
  // The journal entry leaves the database before anything is removed.
  const journaled = await exportDeletionJournal();
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
    journal_exported: journaled,
    objects_deleted: media.deleted,
    objects_failed: media.failed,
    accounts_completed: completed,
    accounts_failed: failed,
  };
}

/** Five-minute temporary cleanup: expire abandoned uploads, then delete due objects. */
export async function temporaryCleanup() {
  const { data, error } = await serviceClient().rpc('svc_temporary_cleanup', { p_limit: 200 });
  if (error) throw new Error(`cleanup failed: ${error.code}`);
  // Care labels whose garment never became a piece are not kept.
  const { data: labels, error: labelError } = await serviceClient().rpc('svc_expire_unattached_labels', {
    p_limit: 200,
  });
  if (labelError) throw new Error(`label cleanup failed: ${labelError.code}`);
  // Grouped photos are never kept: unconfirmed ones expire, confirmed ones once cropped.
  const { data: groups, error: groupError } = await serviceClient().rpc('svc_expire_group_sources', { p_limit: 200 });
  if (groupError) throw new Error(`group cleanup failed: ${groupError.code}`);
  // Edited masks are inputs only; any the cutout never used are not kept.
  const { data: edits, error: editError } = await serviceClient().rpc('svc_expire_mask_inputs', { p_limit: 200 });
  if (editError) throw new Error(`mask cleanup failed: ${editError.code}`);
  const media = await processMediaDeletion();
  const summary = data as { uploads_expired: number; records_purged: number };
  return {
    ...summary,
    labels_expired: labels as number,
    groups_expired: groups as number,
    edits_expired: edits as number,
    objects_deleted: media.deleted,
    objects_failed: media.failed,
  };
}

// Newer keys may be worker output whose completion has not been recorded yet.
const ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

/** Daily reconciliation of the private bucket against the object registry. */
export async function reconcileOrphans() {
  const startedAt = new Date();
  const objects = await listObjects();
  const cutoff = startedAt.getTime() - ORPHAN_GRACE_MS;
  const { data, error } = await serviceClient().rpc('svc_reconcile_storage', {
    p_bucket: bucketName(),
    p_listed_keys: objects.map((o) => o.key),
    p_orphan_candidates: objects.filter((o) => o.lastModified < cutoff).map((o) => o.key),
    p_listing_started_at: startedAt.toISOString(),
  });
  if (error) throw new Error(`reconcile failed: ${error.code}`);
  const result = data as { orphans_queued: number; originals_missing: number };
  if (result.originals_missing > 0) {
    // Safe operational alert: a count only.
    console.warn(JSON.stringify({ alert: 'originals_missing', count: result.originals_missing }));
  }
  const media = await processMediaDeletion();
  return { listed: objects.length, ...result, objects_deleted: media.deleted };
}
