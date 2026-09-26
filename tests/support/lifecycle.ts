import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from './stack';

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Starts an account deletion the way the API does after a verified fresh sign-in
 * (the fresh sign-in itself is covered by the P0.06 tests). Returns the status token.
 */
export async function startDeletion(userId: string): Promise<string> {
  const [{ c }] = await sql()`select public.svc_create_reauth_challenge(${userId}, 'delete_account', ${randomUUID()}) ->> 'challenge_id' as c`;
  const proof = hex(randomBytes(32));
  await sql()`select public.svc_verify_reauth_challenge(${userId}, ${c}, ${randomUUID()}, now(), ${proof})`;
  const statusToken = randomBytes(32).toString('hex');
  await sql()`select public.svc_start_account_deletion(${userId}, ${proof}, ${hex(Buffer.from(statusToken))})`;
  return statusToken;
}
