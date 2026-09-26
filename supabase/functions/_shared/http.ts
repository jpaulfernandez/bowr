// Shared HTTP envelope for public Edge endpoints (ARCHITECTURE section 7).
export type AppErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const INTERNAL_MESSAGE = 'Something went wrong.';
const messages: Record<string, string> = {
  AUTH_REQUIRED: 'Sign in to continue.',
  INVITE_REQUIRED: 'An invite is required to enter bowr.',
  MEMBERSHIP_INACTIVE: 'This account cannot use bowr right now.',
  NOT_FOUND: 'Not found.',
  REVISION_CONFLICT: 'This changed somewhere else. Reload and try again.',
  IDEMPOTENCY_CONFLICT: 'This request was already used for different input.',
  VALIDATION_FAILED: 'Check the highlighted values.',
  UNSUPPORTED_MEDIA: 'This file type is not supported. Use a JPEG, PNG or WebP photo.',
  FILE_TOO_LARGE: 'This photo is larger than the upload limit.',
  UPLOAD_MISSING: "The photo hasn't finished uploading.",
  UPLOAD_CANCELED: 'This upload was canceled.',
  UPLOAD_NOT_RENEWABLE: 'This upload can no longer be renewed.',
  UPLOAD_NOT_CANCELABLE: 'This upload has already finished.',
  CLAIM_REJECTED: 'Claim rejected.',
  RETRY_NOT_AVAILABLE: 'This photo is not waiting for a retry.',
  RETRY_LIMIT_REACHED: 'This photo has been retried too many times. Choose it again or remove it.',
  CAPABILITY_REJECTED: 'Capability rejected.',
  OUTPUT_REJECTED: 'Output rejected.',
  PARTS_NOT_AVAILABLE: 'This photo is no longer waiting for pieces to be chosen.',
  ALREADY_CONFIRMED: 'The pieces from this photo were already added.',
  SOURCE_EXPIRED: 'This group photo is no longer available. Upload it again to choose pieces.',
  ORIENTATION_MISMATCH: 'The photo changed while you were choosing pieces. Reload and try again.',
  ALREADY_DECIDED: 'This was already decided.',
  EXISTING_REMOVED: 'The matching piece was removed. Add this one instead.',
  MASK_REJECTED: "The edited edges couldn't be used. Reload the piece and try again.",
  REAUTH_REQUIRED: 'Confirm with a new sign-in link first.',
  OWNER_TRANSFER_REQUIRED: 'Transfer ownership to another member before deleting this account.',
  CANNOT_SUSPEND_OWNER: 'The owner cannot be suspended.',
  INVALID_RECIPIENT: 'Choose an active member to become the owner.',
  INVITE_UNAVAILABLE: "This invite code isn't available. Check it, or ask the owner for a new one.",
  RATE_LIMITED: 'Too many attempts. Try again later.',
  SERVICE_UNAVAILABLE: 'bowr is temporarily unavailable.',
  INTERNAL: 'Something went wrong.',
};

export function appError(status: number, code: string, details?: Record<string, unknown>): AppError {
  return new AppError(status, code, messages[code] ?? INTERNAL_MESSAGE, status >= 500 || status === 429, details);
}

function allowedOrigins(): Set<string> {
  return new Set(
    (Deno.env.get('APP_ORIGINS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins().has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, content-type, idempotency-key, apikey, x-client-info, x-deletion-status',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function baseHeaders(req: Request): Record<string, string> {
  return {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function json(req: Request, requestId: string, status: number, data: unknown): Response {
  return new Response(JSON.stringify({ data, request_id: requestId }), { status, headers: baseHeaders(req) });
}

export function errorResponse(req: Request, requestId: string, error: unknown): Response {
  const appErr = error instanceof AppError ? error : appError(500, 'INTERNAL');
  if (!(error instanceof AppError)) {
    // Operational log: request ID and error class only, never payloads or tokens.
    console.error(JSON.stringify({ request_id: requestId, error: (error as Error)?.name ?? 'unknown' }));
  }
  const body: { error: AppErrorBody; request_id: string } = {
    error: {
      code: appErr.code,
      message: appErr.message,
      retryable: appErr.retryable,
      ...(appErr.details ? { details: appErr.details } : {}),
    },
    request_id: requestId,
  };
  const headers: Record<string, string> = baseHeaders(req);
  const retryAfter = appErr.details?.retry_after_seconds;
  if (typeof retryAfter === 'number') headers['Retry-After'] = String(Math.ceil(retryAfter));
  return new Response(JSON.stringify(body), { status: appErr.status, headers });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/** Maps a PostgREST/RPC error raised by private.raise_app_error to AppError. */
export function fromDatabaseError(error: { code?: string; message?: string; details?: string | null }): AppError {
  const match = /^PT(\d{3})$/.exec(error.code ?? '');
  if (match && error.message && /^[A-Z_]{3,64}$/.test(error.message)) {
    let details: Record<string, unknown> | undefined;
    try {
      const parsed = error.details ? JSON.parse(error.details) : undefined;
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) details = parsed;
    } catch {
      details = undefined;
    }
    return appError(Number(match[1]), error.message, details);
  }
  return appError(503, 'SERVICE_UNAVAILABLE');
}
