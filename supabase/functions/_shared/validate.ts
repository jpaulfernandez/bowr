import { appError } from './http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Edge mutations require a client-generated request identity (ARCHITECTURE 7.1). */
export function idempotencyKey(req: Request): string {
  const key = req.headers.get('Idempotency-Key');
  if (!isUuid(key)) throw appError(422, 'VALIDATION_FAILED', { field: 'Idempotency-Key' });
  return key;
}

const MAX_BODY_BYTES = 8 * 1024;

/** Reads a small JSON object body and rejects fields outside the allowlist. */
export async function jsonBody(req: Request, allowed: string[]): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw appError(413, 'VALIDATION_FAILED', { reason: 'body_too_large' });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw appError(422, 'VALIDATION_FAILED', { reason: 'invalid_json' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw appError(422, 'VALIDATION_FAILED', { reason: 'invalid_body' });
  }
  const unexpected = Object.keys(parsed).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw appError(422, 'VALIDATION_FAILED', { reason: 'unexpected_fields', fields: unexpected });
  }
  return parsed as Record<string, unknown>;
}
