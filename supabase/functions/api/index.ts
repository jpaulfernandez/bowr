// Public Edge API: https://<project>.supabase.co/functions/v1/api/v1/...
import { requireCaller } from '../_shared/auth.ts';
import { appError, errorResponse, fromDatabaseError, json, preflight } from '../_shared/http.ts';
import { clientIpHash, generateInviteCode, inviteDigest } from '../_shared/invite-codes.ts';
import { serviceClient } from '../_shared/service.ts';
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

route('GET', /^\/v1\/bootstrap$/, async ({ req, requestId }) => {
  const { db } = await requireCaller(req);
  const { data, error } = await db.rpc('get_bootstrap');
  if (error) throw fromDatabaseError(error);
  return json(req, requestId, 200, data);
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
