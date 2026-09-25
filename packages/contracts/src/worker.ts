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

export const WorkerClaimResponse = z
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

/** Schemas exported for the worker, keyed by generated file name. */
export const workerJsonSchemas = {
  'worker_wake.schema.json': WorkerWake,
  'worker_claim_response.schema.json': WorkerClaimResponse,
  'worker_complete_request.schema.json': WorkerCompleteRequest,
} as const;
