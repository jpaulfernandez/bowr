import { z } from 'zod';

/** Stable application error codes (ARCHITECTURE section 7.5). */
export const errorCodes = [
  'AUTH_REQUIRED',
  'INVITE_REQUIRED',
  'MEMBERSHIP_INACTIVE',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
export const ErrorCode = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().max(64),
    message: z.string().max(500),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  request_id: z.string().uuid(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
