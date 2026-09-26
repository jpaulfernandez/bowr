import { z } from 'zod';

/**
 * Worker contracts. The Python worker consumes the generated JSON Schema files
 * in services/worker/src/bowr_worker/contracts/, never this TypeScript source.
 */
export const workerFailureCodes = [
  'UNSUPPORTED_MEDIA',
  'MEDIA_TYPE_MISMATCH',
  'FILE_TOO_LARGE',
  'TOO_MANY_PIXELS',
  'CORRUPT_IMAGE',
  'ANIMATED_IMAGE',
  'SOURCE_MISSING',
] as const;

export const WorkerWake = z
  .object({
    job_id: z.string().uuid(),
    claim_token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const ValidationInput = z
  .object({
    declared_content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
    purpose: z.enum(['garment', 'care_label']),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    max_bytes: z.number().int().positive(),
    max_pixels: z.number().int().positive(),
    max_edge: z.union([z.literal(1024), z.literal(2048)]),
  })
  .strict();

export const ValidationClaim = z
  .object({
    schema_version: z.literal(1),
    job_id: z.string().uuid(),
    kind: z.literal('validate_upload'),
    lease_generation: z.number().int().positive(),
    lease_expires_at: z.string(),
    capability: z.string().min(20).max(2000),
    input: ValidationInput,
    source: z.object({ url: z.string().url() }).strict(),
    output: z.object({ url: z.string().url(), content_type: z.literal('image/webp') }).strict(),
  })
  .strict();

/** Local CPU models for image stages; pinned with checksums in config/models.yaml. */
export const cutoutModels = ['isnet_general_use', 'u2netp'] as const;
export const itemStageFailureCodes = ['NO_FOREGROUND', 'SOURCE_MISSING', 'CORRUPT_IMAGE', 'MODEL_UNAVAILABLE'] as const;

const signed = (contentType: 'image/webp' | 'image/png') =>
  z.object({ url: z.string().url(), content_type: z.literal(contentType) }).strict();
const cutoutOutputs = z.object({ cutout: signed('image/webp'), thumbnail: signed('image/webp'), mask: signed('image/png') }).strict();

/** An item stage computes renditions or results for one item media revision. */
export const ItemStageClaim = z
  .object({
    schema_version: z.literal(1),
    job_id: z.string().uuid(),
    kind: z.literal('item_stage'),
    stage: z.literal('cutout'),
    lease_generation: z.number().int().positive(),
    lease_expires_at: z.string(),
    capability: z.string().min(20).max(2000),
    input: z
      .object({
        model: z.enum(cutoutModels),
        original: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
        max_bytes: z.number().int().positive(),
      })
      .strict(),
    sources: z.object({ original: z.object({ url: z.string().url() }).strict() }).strict(),
    outputs: cutoutOutputs,
  })
  .strict();

export const WorkerClaimResponse = z.discriminatedUnion('kind', [ValidationClaim, ItemStageClaim]);

const rendition = (maxEdge: number) =>
  z
    .object({
      width: z.number().int().positive().max(maxEdge),
      height: z.number().int().positive().max(maxEdge),
      byte_size: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

export const ItemStageCompleteRequest = z.discriminatedUnion('outcome', [
  z
    .object({
      schema_version: z.literal(1),
      lease_generation: z.number().int().positive(),
      outcome: z.literal('ready'),
      outputs: z.object({ cutout: rendition(1024), thumbnail: rendition(256), mask: rendition(1024) }).strict(),
      result: z.object({ foreground_ratio: z.number().min(0).max(1) }).strict(),
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      lease_generation: z.number().int().positive(),
      outcome: z.literal('rejected'),
      failure_code: z.enum(itemStageFailureCodes),
    })
    .strict(),
]);

export const WorkerCompleteRequest = z.discriminatedUnion('outcome', [
  z
    .object({
      schema_version: z.literal(1),
      lease_generation: z.number().int().positive(),
      outcome: z.literal('ready'),
      output: z
        .object({
          width: z.number().int().positive().max(2048),
          height: z.number().int().positive().max(2048),
          byte_size: z.number().int().positive(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      lease_generation: z.number().int().positive(),
      outcome: z.literal('rejected'),
      failure_code: z.enum(workerFailureCodes),
    })
    .strict(),
]);

export const WorkerHeartbeatRequest = z
  .object({ schema_version: z.literal(1), lease_generation: z.number().int().positive() })
  .strict();

export const WorkerHeartbeatResponse = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('renewed'),
      lease_expires_at: z.string(),
      capability: z.string().min(20).max(2000),
      // Validation renews its single output; item stages renew every output.
      output: z.object({ url: z.string().url(), content_type: z.literal('image/webp') }).strict().optional(),
      outputs: z.record(z.string(), z.object({ url: z.string().url(), content_type: z.string() }).strict()).optional(),
    })
    .strict(),
  z.object({ status: z.enum(['stale', 'deadline_exceeded']) }).strict(),
]);

/** Transient failures only; unusable files are reported through completion. */
export const WorkerFailRequest = z
  .object({
    schema_version: z.literal(1),
    lease_generation: z.number().int().positive(),
    failure_code: z.enum(['TRANSIENT_STORAGE', 'WORKER_ERROR', 'DEADLINE_EXCEEDED']),
  })
  .strict();

/** Schemas exported for the worker, keyed by generated file name. */
export const workerJsonSchemas = {
  'worker_wake.schema.json': WorkerWake,
  'worker_claim_response.schema.json': WorkerClaimResponse,
  'worker_complete_request.schema.json': WorkerCompleteRequest,
  'item_stage_complete_request.schema.json': ItemStageCompleteRequest,
  'worker_heartbeat_request.schema.json': WorkerHeartbeatRequest,
  'worker_heartbeat_response.schema.json': WorkerHeartbeatResponse,
  'worker_fail_request.schema.json': WorkerFailRequest,
} as const;
