// Internal worker API: .../functions/v1/internal/v1/...
// Accepts only single-use claim tokens and job-scoped capabilities, never user JWTs.
import { type JobCapability, sha256Hex, signCapability, verifyCapability } from '../_shared/capability.ts';
import { afterResponse, dispatchRunnable } from '../_shared/dispatch.ts';
import { appError, errorResponse, fromDatabaseError, json } from '../_shared/http.ts';
import { imageInfo } from '../_shared/image-bytes.ts';
import { serviceClient } from '../_shared/service.ts';
import { deleteObject, getObject, presignGet, presignPut } from '../_shared/storage.ts';
import { isUuid, jsonBody } from '../_shared/validate.ts';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TRANSIENT_CODES = new Set(['TRANSIENT_STORAGE', 'WORKER_ERROR', 'DEADLINE_EXCEEDED']);
const FAILURE_CODES = new Set([
  'UNSUPPORTED_MEDIA',
  'MEDIA_TYPE_MISMATCH',
  'FILE_TOO_LARGE',
  'TOO_MANY_PIXELS',
  'CORRUPT_IMAGE',
  'ANIMATED_IMAGE',
  'SOURCE_MISSING',
]);
const STAGE_FAILURE_CODES = new Set(['NO_FOREGROUND', 'SOURCE_MISSING', 'CORRUPT_IMAGE', 'MODEL_UNAVAILABLE']);

/** Expected renditions per item stage: content type and exact or maximum edge. */
const STAGE_OUTPUTS: Record<string, Record<string, { contentType: 'image/webp' | 'image/png'; edge?: number }>> = {
  cutout: {
    cutout: { contentType: 'image/webp', edge: 1024 },
    thumbnail: { contentType: 'image/webp', edge: 256 },
    mask: { contentType: 'image/png' },
  },
};

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw fromDatabaseError(error);
  return data;
}

type ValidationClaimed = {
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

type StageClaimed = {
  job_id: string;
  kind: 'item_stage';
  stage: 'cutout';
  user_id: string;
  item_id: string;
  lease_generation: number;
  lease_expires_at: string;
  sources: Record<string, string>;
  outputs: Record<string, string>;
  input: Record<string, unknown>;
};

const contentTypeOf = (stage: string, name: string) => STAGE_OUTPUTS[stage]?.[name]?.contentType ?? 'image/webp';

async function signedOutputs(stage: string, keys: Record<string, string>, seconds: number) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(keys).map(async ([name, key]) => {
        const contentType = contentTypeOf(stage, name);
        return [name, { url: await presignPut(key, contentType, seconds), content_type: contentType }] as const;
      }),
    ),
  );
}

async function claim(req: Request, requestId: string): Promise<Response> {
  const body = await jsonBody(req, ['job_id', 'claim_token']);
  if (!isUuid(body.job_id) || typeof body.claim_token !== 'string' || !/^[0-9a-f]{64}$/.test(body.claim_token)) {
    throw appError(403, 'CLAIM_REJECTED');
  }
  const job = (await rpc('svc_claim_job', {
    p_job_id: body.job_id,
    p_nonce_hash: await sha256Hex(body.claim_token),
  })) as ValidationClaimed | StageClaimed;
  const seconds = (Date.parse(job.lease_expires_at) - Date.now()) / 1000;
  const exp = Math.floor(Date.parse(job.lease_expires_at) / 1000);

  if (job.kind === 'item_stage') {
    const capability = await signCapability({
      job_id: job.job_id,
      user_id: job.user_id,
      target_id: job.item_id,
      stage: job.stage,
      lease_generation: job.lease_generation,
      output_keys: job.outputs,
      exp,
    });
    return json(req, requestId, 200, {
      schema_version: 1,
      job_id: job.job_id,
      kind: job.kind,
      stage: job.stage,
      lease_generation: job.lease_generation,
      lease_expires_at: job.lease_expires_at,
      capability,
      input: job.input,
      sources: Object.fromEntries(
        await Promise.all(
          Object.entries(job.sources).map(async ([name, key]) => [name, { url: await presignGet(key, seconds) }]),
        ),
      ),
      outputs: await signedOutputs(job.stage, job.outputs, seconds),
    });
  }

  const capability = await signCapability({
    job_id: job.job_id,
    user_id: job.user_id,
    target_id: job.asset_id,
    stage: 'validate_upload',
    lease_generation: job.lease_generation,
    output_keys: { original: job.output_key },
    exp,
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

/** The capability must name this job and the lease generation the body claims. */
async function jobCapability(req: Request, jobId: string, body: Record<string, unknown>) {
  const capability = await verifyCapability(/^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1]);
  if (
    !capability || capability.job_id !== jobId || body.schema_version !== 1 ||
    body.lease_generation !== capability.lease_generation ||
    !(capability.stage === 'validate_upload' || capability.stage in STAGE_OUTPUTS)
  ) {
    throw appError(403, 'CAPABILITY_REJECTED');
  }
  return capability;
}

async function heartbeat(req: Request, requestId: string, jobId: string): Promise<Response> {
  const body = await jsonBody(req, ['schema_version', 'lease_generation']);
  const capability = await jobCapability(req, jobId, body);
  const result =
    (await rpc('svc_heartbeat_job', { p_job_id: jobId, p_lease_generation: capability.lease_generation })) as {
      status: 'renewed' | 'stale' | 'deadline_exceeded';
      lease_expires_at?: string;
    };
  if (result.status !== 'renewed' || !result.lease_expires_at) {
    return json(req, requestId, 200, { status: result.status });
  }
  const seconds = (Date.parse(result.lease_expires_at) - Date.now()) / 1000;
  const renewed = await signCapability({ ...capability, exp: Math.floor(Date.parse(result.lease_expires_at) / 1000) });
  // A renewed lease gets a fresh capability and output URLs with the new expiry.
  if (capability.stage === 'validate_upload') {
    return json(req, requestId, 200, {
      status: 'renewed',
      lease_expires_at: result.lease_expires_at,
      capability: renewed,
      output: {
        url: await presignPut(capability.output_keys.original!, 'image/webp', seconds),
        content_type: 'image/webp',
      },
    });
  }
  return json(req, requestId, 200, {
    status: 'renewed',
    lease_expires_at: result.lease_expires_at,
    capability: renewed,
    outputs: await signedOutputs(capability.stage, capability.output_keys, seconds),
  });
}

async function fail(req: Request, requestId: string, jobId: string): Promise<Response> {
  const body = await jsonBody(req, ['schema_version', 'lease_generation', 'failure_code']);
  const capability = await jobCapability(req, jobId, body);
  if (typeof body.failure_code !== 'string' || !TRANSIENT_CODES.has(body.failure_code)) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'failure_code' });
  }
  const result = await rpc('svc_fail_job_attempt', {
    p_job_id: jobId,
    p_lease_generation: capability.lease_generation,
    p_failure_code: body.failure_code,
  });
  // A freed processing slot lets the next runnable job start without waiting.
  afterResponse(dispatchRunnable(5));
  return json(req, requestId, 200, result);
}

/** Queues every output of a fenced or rejected attempt for deletion. */
async function discardOutputs(jobId: string, capability: JobCapability) {
  for (const key of Object.values(capability.output_keys)) {
    await rpc('svc_discard_job_output', { p_job_id: jobId, p_bucket: Deno.env.get('R2_BUCKET'), p_object_key: key });
    afterResponse(deleteObject(key));
  }
}

async function completeValidation(req: Request, requestId: string, jobId: string, body: Record<string, unknown>) {
  const capability = await jobCapability(req, jobId, body);
  if (capability.stage !== 'validate_upload') throw appError(403, 'CAPABILITY_REJECTED');
  const outputKey = capability.output_keys.original!;

  let output: Record<string, unknown> | null = null;
  if (body.outcome === 'ready') {
    const claimed = (body.output ?? {}) as Record<string, unknown>;
    const bytes = await getObject(outputKey, MAX_OUTPUT_BYTES);
    const info = bytes ? imageInfo(bytes) : null;
    // Publish only bytes the server has checked: presence, size, checksum and format.
    if (
      !bytes || info?.contentType !== 'image/webp' || bytes.byteLength !== claimed.byte_size ||
      (await sha256Hex(bytes)) !== claimed.sha256 ||
      !Number.isInteger(claimed.width) || !Number.isInteger(claimed.height) ||
      (claimed.width as number) < 1 || (claimed.height as number) < 1 ||
      Math.max(claimed.width as number, claimed.height as number) > 2048
    ) {
      await rpc('svc_discard_job_output', {
        p_job_id: jobId,
        p_bucket: Deno.env.get('R2_BUCKET'),
        p_object_key: outputKey,
      });
      throw appError(422, 'OUTPUT_REJECTED');
    }
    output = { ...claimed, object_key: outputKey };
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
    await discardOutputs(jobId, capability);
  }
  afterResponse(dispatchRunnable(5));
  return json(req, requestId, 200, result);
}

async function completeStage(req: Request, requestId: string, jobId: string, body: Record<string, unknown>) {
  const capability = await jobCapability(req, jobId, body);
  const expected = STAGE_OUTPUTS[capability.stage];
  if (!expected) throw appError(403, 'CAPABILITY_REJECTED');

  let outputs: Record<string, Record<string, unknown>> | null = null;
  if (body.outcome === 'ready') {
    const claimed = (body.outputs ?? {}) as Record<string, Record<string, unknown>>;
    outputs = {};
    for (const [name, rule] of Object.entries(expected)) {
      const key = capability.output_keys[name]!;
      const bytes = await getObject(key, MAX_OUTPUT_BYTES);
      const info = bytes ? imageInfo(bytes) : null;
      const said = claimed[name] ?? {};
      if (
        !bytes || !info || info.contentType !== rule.contentType || bytes.byteLength !== said.byte_size ||
        (await sha256Hex(bytes)) !== said.sha256 || info.width !== said.width || info.height !== said.height ||
        (rule.edge !== undefined && (info.width !== rule.edge || info.height !== rule.edge)) ||
        Math.max(info.width, info.height) > 2048
      ) {
        await discardOutputs(jobId, capability);
        throw appError(422, 'OUTPUT_REJECTED', { output: name });
      }
      outputs[name] = {
        object_key: key,
        content_type: info.contentType,
        width: info.width,
        height: info.height,
        byte_size: bytes.byteLength,
        sha256: said.sha256,
      };
    }
  } else if (
    body.outcome !== 'rejected' || typeof body.failure_code !== 'string' ||
    !STAGE_FAILURE_CODES.has(body.failure_code)
  ) {
    throw appError(422, 'VALIDATION_FAILED', { field: 'outcome' });
  }

  const result = (await rpc('svc_complete_item_stage', {
    p_job_id: jobId,
    p_lease_generation: capability.lease_generation,
    p_outcome: body.outcome,
    p_outputs: outputs,
    p_result: body.outcome === 'ready' ? body.result ?? null : null,
    p_failure_code: body.outcome === 'rejected' ? body.failure_code : null,
  })) as { status: 'applied' | 'already_applied' | 'stale' };

  if (result.status === 'stale' && outputs) await discardOutputs(jobId, capability);
  afterResponse(dispatchRunnable(5));
  return json(req, requestId, 200, result);
}

async function complete(req: Request, requestId: string, jobId: string): Promise<Response> {
  const body = await jsonBody(req, [
    'schema_version',
    'lease_generation',
    'outcome',
    'output',
    'outputs',
    'result',
    'failure_code',
  ]);
  const capability = await jobCapability(req, jobId, body);
  return capability.stage === 'validate_upload'
    ? await completeValidation(req, requestId, jobId, body)
    : await completeStage(req, requestId, jobId, body);
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  try {
    const path = new URL(req.url).pathname.replace(/^.*?\/internal(?=\/v1\/)/, '');
    if (req.method === 'POST' && path === '/v1/jobs/claim') return await claim(req, requestId);
    const jobMatch = /^\/v1\/jobs\/([^/]+)\/(complete|heartbeat|fail)$/.exec(path);
    if (req.method === 'POST' && jobMatch && isUuid(jobMatch[1])) {
      const handler = { complete, heartbeat, fail }[jobMatch[2] as 'complete' | 'heartbeat' | 'fail'];
      return await handler(req, requestId, jobMatch[1]!);
    }
    throw appError(404, 'NOT_FOUND');
  } catch (error) {
    return errorResponse(req, requestId, error);
  }
});
