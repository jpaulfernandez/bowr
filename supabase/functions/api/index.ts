// Public Edge API: https://<project>.supabase.co/functions/v1/api/v1/...
import { aiEnabled, runDiagnostic } from '../_shared/ai-gateway.ts';
import { requireCaller } from '../_shared/auth.ts';
import { appError, errorResponse, fromDatabaseError, json, preflight } from '../_shared/http.ts';
import { sha256Hex } from '../_shared/capability.ts';
import { afterResponse, dispatchJob, dispatchRunnable } from '../_shared/dispatch.ts';
import { processAccountDeletions, processMediaDeletion } from '../_shared/lifecycle.ts';
import { clientIpHash, generateInviteCode, inviteDigest } from '../_shared/invite-codes.ts';
import { serviceClient } from '../_shared/service.ts';
import { imageInfo } from '../_shared/image-bytes.ts';
import { bucketName, deleteObject, headObject, presignGet, presignPut, putObject } from '../_shared/storage.ts';
import { idempotencyKey, isUuid, jsonBody } from '../_shared/validate.ts';

type Context = { req: Request; requestId: string; params: string[] };
type Handler = (ctx: Context) => Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

async function callService(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw fromDatabaseError(error);
  return data;
}

/** Shared budget mode and reset time; no other member's usage. */
async function aiStatus() {
  const status = (await callService('svc_ai_status', {})) as { mode: string; resets_at: string };
  return { status: aiEnabled() ? status.mode : 'unavailable', resets_at: status.resets_at };
}

const heicEnabled = () => Deno.env.get('UPLOAD_HEIC_ENABLED') === 'true';
const uploadFormats =
  () => ['image/jpeg', 'image/png', 'image/webp', ...(heicEnabled() ? ['image/heic', 'image/heif'] : [])];

route('GET', /^\/v1\/bootstrap$/, async ({ req, requestId }) => {
  const { db } = await requireCaller(req);
  const { data, error } = await db.rpc('get_bootstrap');
  if (error) throw fromDatabaseError(error);
  const bootstrap = data as {
    membership: { state: string };
    upload_limits?: Record<string, unknown> | null;
    ai?: unknown;
  };
  // Limits come from the server so UI copy cannot drift from what is enforced.
  if (bootstrap.upload_limits) bootstrap.upload_limits = { ...bootstrap.upload_limits, formats: uploadFormats() };
  bootstrap.ai = bootstrap.membership.state === 'active' ? await aiStatus() : null;
  return json(req, requestId, 200, bootstrap);
});

// --- Uploads ---------------------------------------------------------------

type SlotRow = {
  entry_id: string;
  client_file_id: string;
  asset_id: string;
  state: string;
  content_type: string;
  upload_expires_at: string;
  object_key?: string | null;
};

async function publicSlot(row: SlotRow) {
  const seconds = (Date.parse(row.upload_expires_at) - Date.now()) / 1000;
  const upload = row.object_key && row.state === 'awaiting_upload' && seconds > 1
    ? {
      method: 'PUT',
      url: await presignPut(row.object_key, row.content_type, seconds),
      headers: { 'Content-Type': row.content_type },
      expires_at: row.upload_expires_at,
    }
    : null;
  // Object keys stay server-side; the client receives only IDs and a signed URL.
  return {
    entry_id: row.entry_id,
    client_file_id: row.client_file_id,
    asset_id: row.asset_id,
    state: row.state,
    upload,
  };
}

route('POST', /^\/v1\/upload-batches$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  const body = await jsonBody(req, ['files']);
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 20) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'files' });
  }
  const files = body.files.map((file: unknown) => {
    const f = (file ?? {}) as Record<string, unknown>;
    const unexpected = Object.keys(f).filter((k) =>
      !['client_file_id', 'purpose', 'content_type', 'byte_size', 'rotation', 'label_for', 'target_item_id'].includes(k)
    );
    if (
      unexpected.length > 0 || !isUuid(f.client_file_id) ||
      (f.label_for !== undefined && !isUuid(f.label_for)) ||
      (f.target_item_id !== undefined && !isUuid(f.target_item_id))
    ) {
      throw appError(422, 'VALIDATION_FAILED', {
        field: 'files',
        reason: unexpected.length > 0 ? 'unexpected_fields' : 'client_file_id',
      });
    }
    if (!uploadFormats().includes(String(f.content_type))) {
      throw appError(415, 'UNSUPPORTED_MEDIA', { client_file_id: f.client_file_id });
    }
    return {
      client_file_id: String(f.client_file_id).toLowerCase(),
      purpose: f.purpose,
      content_type: f.content_type,
      byte_size: f.byte_size,
      rotation: f.rotation ?? 0,
      // A care label names its garment in this batch or an existing piece.
      ...(f.label_for !== undefined ? { label_for: String(f.label_for).toLowerCase() } : {}),
      ...(f.target_item_id !== undefined ? { target_item_id: String(f.target_item_id).toLowerCase() } : {}),
    };
  });
  const batch = (await callService('svc_create_upload_batch', {
    p_user_id: userId,
    p_request_id: key,
    p_bucket: bucketName(),
    p_files: files,
  })) as { batch_id: string; replayed: boolean; entries: SlotRow[] };
  return json(req, requestId, batch.replayed ? 200 : 201, {
    batch_id: batch.batch_id,
    entries: await Promise.all(batch.entries.map(publicSlot)),
  });
});

route('POST', /^\/v1\/upload-entries\/([^/]+)\/renew$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const row = (await callService('svc_renew_upload_entry', { p_user_id: userId, p_entry_id: params[0] })) as {
    entry_id: string;
    object_key: string;
    content_type: string;
    upload_expires_at: string;
  };
  const seconds = (Date.parse(row.upload_expires_at) - Date.now()) / 1000;
  return json(req, requestId, 200, {
    entry_id: row.entry_id,
    upload: {
      method: 'PUT',
      url: await presignPut(row.object_key, row.content_type, seconds),
      headers: { 'Content-Type': row.content_type },
      expires_at: row.upload_expires_at,
    },
  });
});

route('POST', /^\/v1\/upload-entries\/([^/]+)\/complete$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const object = (await callService('svc_upload_entry_object', { p_user_id: userId, p_entry_id: params[0] })) as {
    state: string;
    object_key: string | null;
  };
  // Upload success is only a claim: the server checks the object itself.
  const head = object.state === 'awaiting_upload' && object.object_key ? await headObject(object.object_key) : null;
  const result = (await callService('svc_complete_upload_entry', {
    p_user_id: userId,
    p_request_id: key,
    p_entry_id: params[0],
    p_object_size: head?.size ?? null,
  })) as { entry_id: string; state: string; job_id: string | null; failure_code: string | null };
  if (result.job_id && result.state === 'uploaded') afterResponse(dispatchJob(result.job_id));
  return json(req, requestId, 202, { ...result, poll_after_ms: 2000 });
});

route('POST', /^\/v1\/upload-entries\/([^/]+)\/cancel$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  return json(
    req,
    requestId,
    200,
    await callService('svc_cancel_upload_entry', { p_user_id: userId, p_entry_id: params[0] }),
  );
});

route('POST', /^\/v1\/upload-entries\/([^/]+)\/retry$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const result = (await callService('svc_retry_upload_entry', { p_user_id: userId, p_entry_id: params[0] })) as {
    job_id: string;
  };
  afterResponse(dispatchJob(result.job_id));
  return json(req, requestId, 202, { ...result, poll_after_ms: 2000 });
});

route('GET', /^\/v1\/upload-entries\/([^/]+)\/status$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  return json(
    req,
    requestId,
    200,
    await callService('svc_entry_job_status', { p_user_id: userId, p_entry_id: params[0] }),
  );
});

// Keep a grouped photo as one set, or confirm the parts to become pieces.
route('POST', /^\/v1\/upload-entries\/([^/]+)\/confirm-parts$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const body = await jsonBody(req, ['mode', 'image', 'parts']);
  const result = (await callService('svc_confirm_parts', {
    p_user_id: userId,
    p_request_id: key,
    p_entry_id: params[0],
    p_mode: body.mode ?? null,
    p_image: body.image ?? null,
    p_parts: body.parts ?? null,
  })) as { items: Array<{ job_id: string }> };
  for (const item of result.items) afterResponse(dispatchJob(item.job_id));
  return json(req, requestId, 200, result);
});

// Use existing / Add another for a possible duplicate. Decide later needs no call.
route('POST', /^\/v1\/duplicate-reviews\/([^/]+)\/resolve$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const body = await jsonBody(req, ['decision']);
  const result = await callService('svc_resolve_duplicate', {
    p_user_id: userId,
    p_request_id: key,
    p_review_id: params[0],
    p_decision: body.decision ?? null,
  });
  // A new piece or a moved label queues stages; removed media is deleted.
  afterResponse(dispatchRunnable(5));
  afterResponse(processMediaDeletion());
  return json(req, requestId, 200, result);
});

// --- Items -------------------------------------------------------------------

const ITEM_STAGES = ['crop', 'cutout', 'colors', 'embedding', 'tags', 'label'];

// Owner retries a failed or interrupted stage for the item's current media revision.
route('POST', /^\/v1\/items\/([^/]+)\/process$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const body = await jsonBody(req, ['stage', 'media_revision']);
  if (typeof body.stage !== 'string' || !ITEM_STAGES.includes(body.stage)) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'stage' });
  }
  if (!Number.isSafeInteger(body.media_revision)) throw appError(422, 'VALIDATION_FAILED', { field: 'media_revision' });
  const result = (await callService('svc_retry_item_stage', {
    p_user_id: userId,
    p_item_id: params[0],
    p_stage: body.stage,
    p_media_revision: body.media_revision,
  })) as { job_id: string };
  afterResponse(dispatchJob(result.job_id));
  return json(req, requestId, 202, { ...result, poll_after_ms: 2000 });
});

// A member-edited mask (P1.05): a PNG exactly the size of the piece's original.
// Only the mask is accepted; the cutout is composed on the server from the
// stored original, so no client-made cutout is ever published.
const MAX_MASK_BYTES = 4 * 1024 * 1024;
route('POST', /^\/v1\/items\/([^/]+)\/mask$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const revision = Number(new URL(req.url).searchParams.get('media_revision'));
  if (!Number.isSafeInteger(revision)) throw appError(422, 'VALIDATION_FAILED', { field: 'media_revision' });
  if (req.headers.get('Content-Type') !== 'image/png') throw appError(422, 'MASK_REJECTED');
  const bytes = new Uint8Array(await req.arrayBuffer());
  const info = imageInfo(bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MASK_BYTES || info?.contentType !== 'image/png') {
    throw appError(422, 'MASK_REJECTED');
  }
  const objectKey = `users/${userId}/items/${params[0]}/edits/${crypto.randomUUID()}.png`;
  await putObject(objectKey, bytes, 'image/png');
  let result: { job_id: string };
  try {
    result = (await callService('svc_submit_mask', {
      p_user_id: userId,
      p_request_id: key,
      p_item_id: params[0],
      p_media_revision: revision,
      p_bucket: bucketName(),
      p_object_key: objectKey,
      p_width: info.width,
      p_height: info.height,
      p_byte_size: bytes.byteLength,
      p_sha256: await sha256Hex(bytes),
    })) as { job_id: string };
  } catch (error) {
    // Nothing recorded it; an interrupted delete is caught by reconciliation.
    afterResponse(deleteObject(objectKey));
    throw error;
  }
  afterResponse(dispatchJob(result.job_id));
  return json(req, requestId, 202, { ...result, poll_after_ms: 2000 });
});

// An explicit cutout with another pinned model; bounded and never automatic.
route('POST', /^\/v1\/items\/([^/]+)\/recut$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const body = await jsonBody(req, ['media_revision', 'model']);
  if (!Number.isSafeInteger(body.media_revision)) throw appError(422, 'VALIDATION_FAILED', { field: 'media_revision' });
  const result = (await callService('svc_recut_item', {
    p_user_id: userId,
    p_request_id: key,
    p_item_id: params[0],
    p_media_revision: body.media_revision,
    p_model: typeof body.model === 'string' ? body.model : null,
  })) as { job_id: string };
  afterResponse(dispatchJob(result.job_id));
  return json(req, requestId, 202, { ...result, poll_after_ms: 2000 });
});

// Removes a care-label attachment; the piece and its values stay.
route('DELETE', /^\/v1\/media\/([^/]+)$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const result = await callService('svc_remove_label', { p_user_id: userId, p_asset_id: params[0] });
  afterResponse(processMediaDeletion());
  return json(req, requestId, 200, result);
});

route('POST', /^\/v1\/media\/access$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const body = await jsonBody(req, ['requests']);
  if (!Array.isArray(body.requests) || body.requests.length < 1 || body.requests.length > 50) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'requests' });
  }
  const requests = body.requests.map((r: unknown) => {
    const request = (r ?? {}) as Record<string, unknown>;
    return { asset_id: isUuid(request.asset_id) ? request.asset_id : null, variant: String(request.variant ?? '') };
  });
  const grants =
    (await callService('svc_authorize_media_access', { p_user_id: userId, p_requests: requests })) as Array<{
      asset_id: string | null;
      variant: string;
      status: 'ok' | 'not_found';
      object_key?: string;
      expires_at?: string;
      width?: number;
      height?: number;
    }>;
  return json(
    req,
    requestId,
    200,
    await Promise.all(grants.map(async (grant) => {
      const seconds = grant.expires_at ? (Date.parse(grant.expires_at) - Date.now()) / 1000 : 0;
      if (grant.status !== 'ok' || !grant.object_key || seconds < 1) {
        return { asset_id: grant.asset_id, variant: grant.variant, status: 'not_found' };
      }
      return {
        asset_id: grant.asset_id,
        variant: grant.variant,
        status: 'ok',
        url: await presignGet(grant.object_key, seconds),
        expires_at: grant.expires_at,
        width: grant.width,
        height: grant.height,
      };
    })),
  );
});

route('POST', /^\/v1\/invites\/redeem$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  const body = await jsonBody(req, ['code']);
  if (typeof body.code !== 'string' || body.code.trim().length === 0 || body.code.length > 64) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'code' });
  }
  const result = (await callService('svc_redeem_invite', {
    p_user_id: userId,
    p_code_digest: await inviteDigest(body.code),
    p_ip_hash: await clientIpHash(req),
  })) as { outcome: string; retry_after_seconds?: number; state?: string; joined_at?: string };
  if (result.outcome === 'rate_limited') {
    throw appError(429, 'RATE_LIMITED', { retry_after_seconds: result.retry_after_seconds ?? 3600 });
  }
  if (result.outcome !== 'admitted') throw appError(422, 'INVITE_UNAVAILABLE');
  return json(req, requestId, 200, { membership: { state: result.state, joined_at: result.joined_at } });
});

route('DELETE', /^\/v1\/account\/pending$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  await callService('svc_mark_pending_self_deletion', { p_user_id: userId });
  const { error } = await serviceClient().auth.admin.deleteUser(userId);
  // A failed Auth deletion stays in the deleting state and is retried by cleanup.
  return json(req, requestId, 202, { status: error ? 'pending' : 'deleted' });
});

route('GET', /^\/v1\/budget-status$/, async ({ req, requestId }) => {
  const { db } = await requireCaller(req);
  const { data, error } = await db.rpc('get_bootstrap');
  if (error) throw fromDatabaseError(error);
  if ((data as { membership: { state: string } }).membership.state !== 'active') {
    throw appError(403, 'MEMBERSHIP_INACTIVE');
  }
  return json(req, requestId, 200, await aiStatus());
});

route('GET', /^\/v1\/admin\/budget$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const budget = (await callService('svc_admin_budget', { p_actor_id: userId })) as Record<string, unknown>;
  return json(req, requestId, 200, { ...budget, ai_enabled: aiEnabled() });
});

// Redacted operational health for the owner: counts and heartbeat times only.
route('GET', /^\/v1\/admin\/operations$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  return json(req, requestId, 200, await callService('svc_admin_operations', { p_actor_id: userId }));
});

route('PATCH', /^\/v1\/admin\/budget$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  const body = await jsonBody(req, [
    'expected_revision',
    'lighter_micros',
    'stop_micros',
    'ceiling_micros',
    'clear_pause',
  ]);
  for (const field of ['expected_revision', 'lighter_micros', 'stop_micros', 'ceiling_micros']) {
    if (!Number.isSafeInteger(body[field])) throw appError(422, 'VALIDATION_FAILED', { field });
  }
  return json(
    req,
    requestId,
    200,
    await callService('svc_admin_update_budget', {
      p_actor_id: userId,
      p_request_id: key,
      p_expected_revision: body.expected_revision,
      p_lighter_micros: body.lighter_micros,
      p_stop_micros: body.stop_micros,
      p_ceiling_micros: body.ceiling_micros,
      p_clear_pause: body.clear_pause === true,
    }),
  );
});

route('POST', /^\/v1\/admin\/ai-diagnostic$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  await callService('svc_admin_budget', { p_actor_id: userId });
  // The request identity is the attempt identity: a retry never sends a second call.
  const outcome = await runDiagnostic(`diagnostic:${userId}:${key}`, userId);
  return json(req, requestId, 200, outcome);
});

// --- Account lifecycle ------------------------------------------------------

const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

route('POST', /^\/v1\/account\/reauth-challenges$/, async ({ req, requestId }) => {
  const { userId, sessionId } = await requireCaller(req);
  idempotencyKey(req);
  const body = await jsonBody(req, ['action']);
  return json(
    req,
    requestId,
    201,
    await callService('svc_create_reauth_challenge', {
      p_user_id: userId,
      p_action: body.action,
      p_session_id: sessionId,
    }),
  );
});

route('POST', /^\/v1\/account\/reauth-challenges\/([^/]+)\/verify$/, async ({ req, requestId, params }) => {
  const { userId, sessionId, authenticatedAt } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(403, 'REAUTH_REQUIRED');
  // The proof exists only in this response; the database keeps its hash.
  const proof = randomToken();
  const result = await callService('svc_verify_reauth_challenge', {
    p_user_id: userId,
    p_challenge_id: params[0],
    p_session_id: sessionId,
    p_authenticated_at: authenticatedAt?.toISOString() ?? null,
    p_proof_hash: await sha256Hex(proof),
  });
  return json(req, requestId, 200, { ...(result as Record<string, unknown>), proof });
});

route('DELETE', /^\/v1\/account$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  const body = await jsonBody(req, ['proof']);
  if (typeof body.proof !== 'string' || !/^[0-9a-f]{64}$/.test(body.proof)) throw appError(403, 'REAUTH_REQUIRED');
  const statusToken = randomToken();
  const result = await callService('svc_start_account_deletion', {
    p_user_id: userId,
    p_proof_hash: await sha256Hex(body.proof),
    p_status_token_hash: await sha256Hex(statusToken),
  });
  afterResponse(processAccountDeletions());
  // The status token only reveals deletion progress; it is not an access credential.
  return json(req, requestId, 202, { ...(result as Record<string, unknown>), status_token: statusToken });
});

route('GET', /^\/v1\/account\/deletion-status$/, async ({ req, requestId }) => {
  const token = req.headers.get('X-Deletion-Status') ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw appError(404, 'NOT_FOUND');
  return json(
    req,
    requestId,
    200,
    await callService('svc_account_deletion_status', { p_status_token_hash: await sha256Hex(token) }),
  );
});

route('POST', /^\/v1\/admin\/members\/([^/]+)\/(suspend|restore)$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  return json(
    req,
    requestId,
    200,
    await callService('svc_admin_set_suspension', {
      p_actor_id: userId,
      p_member_id: params[0],
      p_suspend: params[1] === 'suspend',
    }),
  );
});

route('POST', /^\/v1\/admin\/ownership-transfer$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  idempotencyKey(req);
  const body = await jsonBody(req, ['recipient_user_id', 'proof']);
  if (!isUuid(body.recipient_user_id)) throw appError(422, 'INVALID_RECIPIENT');
  if (typeof body.proof !== 'string' || !/^[0-9a-f]{64}$/.test(body.proof)) throw appError(403, 'REAUTH_REQUIRED');
  return json(
    req,
    requestId,
    200,
    await callService('svc_transfer_ownership', {
      p_actor_id: userId,
      p_recipient_id: body.recipient_user_id,
      p_proof_hash: await sha256Hex(body.proof),
    }),
  );
});

route('GET', /^\/v1\/admin\/overview$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  return json(req, requestId, 200, await callService('svc_admin_overview', { p_actor_id: userId }));
});

route('POST', /^\/v1\/admin\/invites$/, async ({ req, requestId }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  const body = await jsonBody(req, ['note', 'expires_in_days']);
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 200)) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'note' });
  }
  if (body.expires_in_days !== undefined && !Number.isInteger(body.expires_in_days)) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'expires_in_days' });
  }
  const code = generateInviteCode();
  const result = (await callService('svc_create_invite', {
    p_actor_id: userId,
    p_request_id: key,
    p_code_digest: await inviteDigest(code),
    p_note: body.note ?? null,
    p_expires_in_days: body.expires_in_days ?? null,
  })) as { invite_id: string; expires_at: string; max_uses: number; replayed: boolean };
  // The plaintext exists only in this response. A replay cannot show it again.
  return json(req, requestId, result.replayed ? 200 : 201, {
    invite_id: result.invite_id,
    expires_at: result.expires_at,
    max_uses: result.max_uses,
    code: result.replayed ? null : code,
  });
});

route('POST', /^\/v1\/admin\/invites\/([^/]+)\/revoke$/, async ({ req, requestId, params }) => {
  const { userId } = await requireCaller(req);
  const key = idempotencyKey(req);
  if (!isUuid(params[0])) throw appError(404, 'NOT_FOUND');
  const result = await callService('svc_revoke_invite', {
    p_actor_id: userId,
    p_request_id: key,
    p_invite_id: params[0],
  });
  return json(req, requestId, 200, result);
});

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === 'OPTIONS') return preflight(req);
  try {
    const path = new URL(req.url).pathname.replace(/^.*?\/api(?=\/v1\/)/, '');
    for (const candidate of routes) {
      const match = candidate.pattern.exec(path);
      if (match && candidate.method === req.method) {
        return await candidate.handler({ req, requestId, params: match.slice(1) });
      }
    }
    throw appError(404, 'NOT_FOUND');
  } catch (error) {
    return errorResponse(req, requestId, error);
  }
});
