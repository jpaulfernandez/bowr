// Internal worker API: .../functions/v1/internal/v1/...
// Accepts only single-use claim tokens and job-scoped capabilities, never user JWTs.
import { sha256Hex, signCapability, verifyCapability } from '../_shared/capability.ts';
import { afterResponse } from '../_shared/dispatch.ts';
import { appError, errorResponse, fromDatabaseError, json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service.ts';
import { deleteObject, getObject, presignGet, presignPut } from '../_shared/storage.ts';
import { isUuid, jsonBody } from '../_shared/validate.ts';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FAILURE_CODES = new Set([
  'UNSUPPORTED_MEDIA',
  'MEDIA_TYPE_MISMATCH',
  'FILE_TOO_LARGE',
  'TOO_MANY_PIXELS',
  'CORRUPT_IMAGE',
  'ANIMATED_IMAGE',
  'SOURCE_MISSING',
]);

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw fromDatabaseError(error);
  return data;
}

type Claimed = {
  job_id: string;
  kind: 'validate_upload';
  user_id: string;
  asset_id: string;
  lease_generation: number;
  lease_expires_at: string;
  source_key: string;
  output_key: string;
  input: Record<string, unknown>;
};

async function claim(req: Request, requestId: string): Promise<Response> {
  const body = await jsonBody(req, ['job_id', 'claim_token']);
  if (!isUuid(body.job_id) || typeof body.claim_token !== 'string' || !/^[0-9a-f]{64}$/.test(body.claim_token)) {
    throw appError(403, 'CLAIM_REJECTED');
  }
  const job =
    (await rpc('svc_claim_job', { p_job_id: body.job_id, p_nonce_hash: await sha256Hex(body.claim_token) })) as Claimed;
  const seconds = (Date.parse(job.lease_expires_at) - Date.now()) / 1000;
  const capability = await signCapability({
    job_id: job.job_id,
    user_id: job.user_id,
    asset_id: job.asset_id,
    stage: 'validate_upload',
    lease_generation: job.lease_generation,
    output_key: job.output_key,
    exp: Math.floor(Date.parse(job.lease_expires_at) / 1000),
  });
  return json(req, requestId, 200, {
    schema_version: 1,
    job_id: job.job_id,
    kind: job.kind,
    lease_generation: job.lease_generation,
    lease_expires_at: job.lease_expires_at,
    capability,
    input: job.input,
    source: { url: await presignGet(job.source_key, seconds) },
    output: { url: await presignPut(job.output_key, 'image/webp', seconds), content_type: 'image/webp' },
  });
}

function isWebp(bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  return bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

async function complete(req: Request, requestId: string, jobId: string): Promise<Response> {
  const capability = await verifyCapability(/^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1]);
  if (!capability || capability.job_id !== jobId) throw appError(403, 'CAPABILITY_REJECTED');
  const body = await jsonBody(req, ['schema_version', 'lease_generation', 'outcome', 'output', 'failure_code']);
  if (body.schema_version !== 1 || body.lease_generation !== capability.lease_generation) {
    throw appError(403, 'CAPABILITY_REJECTED');
  }

  let output: Record<string, unknown> | null = null;
  if (body.outcome === 'ready') {
    const claimed = (body.output ?? {}) as Record<string, unknown>;
    const bytes = await getObject(capability.output_key, MAX_OUTPUT_BYTES);
    // Publish only bytes the server has checked: presence, size, checksum and format.
    if (
      !bytes || !isWebp(bytes) || bytes.byteLength !== claimed.byte_size ||
      (await sha256Hex(bytes)) !== claimed.sha256 ||
      !Number.isInteger(claimed.width) || !Number.isInteger(claimed.height) ||
      (claimed.width as number) < 1 || (claimed.height as number) < 1 ||
      Math.max(claimed.width as number, claimed.height as number) > 2048
    ) {
      await rpc('svc_discard_job_output', {
        p_job_id: jobId,
        p_bucket: Deno.env.get('R2_BUCKET'),
        p_object_key: capability.output_key,
      });
      throw appError(422, 'OUTPUT_REJECTED');
    }
    output = { ...claimed, object_key: capability.output_key };
  } else if (
    body.outcome !== 'rejected' || typeof body.failure_code !== 'string' || !FAILURE_CODES.has(body.failure_code)
  ) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'outcome' });
  }

  const result = (await rpc('svc_complete_validation', {
    p_job_id: jobId,
    p_lease_generation: capability.lease_generation,
    p_outcome: body.outcome,
    p_output: output,
    p_failure_code: body.outcome === 'rejected' ? body.failure_code : null,
  })) as { status: 'applied' | 'already_applied' | 'stale' };

  if (result.status === 'stale' && output) {
    // A fenced attempt never attaches output; it is queued for deletion instead.
    await rpc('svc_discard_job_output', {
      p_job_id: jobId,
      p_bucket: Deno.env.get('R2_BUCKET'),
      p_object_key: capability.output_key,
    });
    afterResponse(deleteObject(capability.output_key));
  }
  return json(req, requestId, 200, result);
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const path = new URL(req.url).pathname.replace(/^.*?\/internal(?=\/v1\/)/, '');
    if (req.method === 'POST' && path === '/v1/jobs/claim') return await claim(req, requestId);
    const completeMatch = /^\/v1\/jobs\/([^/]+)\/complete$/.exec(path);
    if (req.method === 'POST' && completeMatch && isUuid(completeMatch[1])) {
      return await complete(req, requestId, completeMatch[1]!);
    }
    throw appError(404, 'NOT_FOUND');
  } catch (error) {
    return errorResponse(req, requestId, error);
  }
});
