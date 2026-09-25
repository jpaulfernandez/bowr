import { z } from 'zod';

export const ReauthAction = z.enum(['delete_account', 'transfer_ownership']);
export type ReauthAction = z.infer<typeof ReauthAction>;

export const ReauthChallenge = z.object({ challenge_id: z.string().uuid(), action: ReauthAction, expires_at: z.string() });

export const ReauthProof = ReauthChallenge.extend({ proof: z.string().regex(/^[0-9a-f]{64}$/) });

export const AccountDeletionStarted = z.object({
  deletion_id: z.string().uuid(),
  state: z.literal('objects_pending'),
  status_token: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Progress only; the status capability reveals no identity or content. */
export const AccountDeletionStatus = z.object({
  state: z.enum(['objects_pending', 'auth_pending', 'complete']),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  objects_remaining: z.number().int().nonnegative(),
});
export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatus>;
