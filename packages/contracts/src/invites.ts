import { z } from 'zod';

export const RedeemInviteRequest = z.object({ code: z.string().trim().min(1).max(64) }).strict();

export const RedeemInviteResult = z.object({
  membership: z.object({ state: z.literal('active'), joined_at: z.string() }),
});

export const CreateInviteRequest = z
  .object({
    note: z.string().trim().max(200).nullable().optional(),
    expires_in_days: z.number().int().min(1).max(30).optional(),
  })
  .strict();

/** `code` is present only in the first response; a replay returns null. */
export const CreatedInvite = z.object({
  invite_id: z.string().uuid(),
  expires_at: z.string(),
  max_uses: z.number().int(),
  code: z.string().nullable(),
});
export type CreatedInvite = z.infer<typeof CreatedInvite>;

export const InviteStatus = z.enum(['active', 'used', 'expired', 'revoked']);

export const AdminOverview = z.object({
  members: z.array(
    z.object({
      user_id: z.string().uuid(),
      display_name: z.string().nullable(),
      role: z.enum(['owner', 'member']),
      state: z.enum(['active', 'suspended']),
      joined_at: z.string().nullable(),
      invited_by_name: z.string().nullable(),
      last_sign_in_at: z.string().nullable(),
    }),
  ),
  pending_count: z.number().int(),
  invites: z.array(
    z.object({
      id: z.string().uuid(),
      note: z.string().nullable(),
      created_at: z.string(),
      expires_at: z.string(),
      uses: z.number().int(),
      max_uses: z.number().int(),
      status: InviteStatus,
      redeemed_by_name: z.string().nullable(),
    }),
  ),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const PendingDeletionResult = z.object({ status: z.enum(['deleted', 'pending']) });
