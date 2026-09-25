import { describe, expect, it } from 'vitest';
import { Bootstrap, ProfilePatch } from './index';

describe('ProfilePatch', () => {
  it('rejects authority fields', () => {
    expect(ProfilePatch.safeParse({ role: 'owner' }).success).toBe(false);
    expect(ProfilePatch.safeParse({ id: '00000000-0000-0000-0000-000000000000' }).success).toBe(false);
  });

  it('normalizes blank optional text to null', () => {
    expect(ProfilePatch.parse({ city: '   ' })).toEqual({ city: null });
  });
});

describe('Bootstrap', () => {
  it('accepts a pending identity without profile fields', () => {
    const parsed = Bootstrap.parse({
      user_id: '5e7659b9-0889-4ea4-b851-40b3e9c82b7a',
      membership: { state: 'pending', role: null },
      profile: null,
      pending_expires_at: '2026-09-26T08:00:00+00:00',
    });
    expect(parsed.profile).toBeNull();
  });

  it('rejects unknown membership states', () => {
    expect(
      Bootstrap.safeParse({
        user_id: '5e7659b9-0889-4ea4-b851-40b3e9c82b7a',
        membership: { state: 'admin', role: null },
        profile: null,
        pending_expires_at: null,
      }).success,
    ).toBe(false);
  });
});
