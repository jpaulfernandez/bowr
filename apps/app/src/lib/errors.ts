import { ErrorEnvelope } from '@bowr/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** A response that arrived after the signed-in account changed. Never rendered. */
export class StaleAccountError extends Error {
  constructor() {
    super('Response discarded after account change');
  }
}

export function apiErrorFromEnvelope(status: number, body: unknown): ApiError {
  const parsed = ErrorEnvelope.safeParse(body);
  if (!parsed.success) return new ApiError(status, 'SERVICE_UNAVAILABLE', 'bowr is temporarily unavailable.', true);
  const { code, message, retryable, details } = parsed.data.error;
  return new ApiError(status, code, message, retryable, details);
}

const rpcMessages: Record<string, string> = {
  REVISION_CONFLICT: 'This changed somewhere else. Reload and try again.',
  IDEMPOTENCY_CONFLICT: 'This request was already used for different input.',
  VALIDATION_FAILED: 'Check the highlighted values.',
  MEMBERSHIP_INACTIVE: 'This account cannot use bowr right now.',
  AUTH_REQUIRED: 'Sign in to continue.',
};

/** Maps PostgREST errors raised by private.raise_app_error (SQLSTATE PTxyz). */
export function apiErrorFromRpc(error: { code?: string; message?: string; details?: string | null }): ApiError {
  const match = /^PT(\d{3})$/.exec(error.code ?? '');
  if (!match || !error.message) return new ApiError(503, 'SERVICE_UNAVAILABLE', 'bowr is temporarily unavailable.', true);
  let details: Record<string, unknown> | undefined;
  try {
    details = error.details ? (JSON.parse(error.details) as Record<string, unknown>) : undefined;
  } catch {
    details = undefined;
  }
  const status = Number(match[1]);
  return new ApiError(status, error.message, rpcMessages[error.message] ?? 'Something went wrong.', status >= 500, details);
}
