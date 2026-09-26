import { z } from 'zod';
import { AiStatus } from './budget';
import { UploadLimits } from './uploads';

export const MembershipState = z.enum(['pending', 'active', 'suspended', 'deleting']);
export type MembershipState = z.infer<typeof MembershipState>;
export const MembershipRole = z.enum(['owner', 'member']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const ProfileSettings = z.object({
  display_name: z.string().max(80).nullable(),
  city: z.string().max(80).nullable(),
  timezone: z.string().max(64),
  locale: z.string().max(16),
  temperature_unit: z.enum(['celsius', 'fahrenheit']),
  measurement_unit: z.enum(['metric', 'imperial']),
  onboarding_completed_at: z.string().nullable(),
  revision: z.number().int().positive(),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

/** GET /v1/bootstrap. Non-active identities receive only gate-safe fields. */
export const Bootstrap = z.object({
  user_id: z.string().uuid(),
  membership: z.object({
    state: MembershipState,
    role: MembershipRole.nullable(),
  }),
  profile: ProfileSettings.nullable(),
  /** When an unredeemed account will be removed; null for other states. */
  pending_expires_at: z.string().nullable(),
  /** Enforced upload limits for active members; null for other states. */
  upload_limits: UploadLimits.nullable(),
  /** Shared AI budget mode and reset time for active members; null otherwise. */
  ai: AiStatus.nullable(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const BootstrapResponse = z.object({
  data: Bootstrap,
  request_id: z.string().uuid(),
});
