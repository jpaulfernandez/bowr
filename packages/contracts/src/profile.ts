import { z } from 'zod';

const optionalText = z
  .string()
  .trim()
  .max(80, 'Use 80 characters or fewer.')
  .transform((value) => (value === '' ? null : value));

/** Allowlisted update_profile patch. The database remains authoritative. */
export const ProfilePatch = z
  .object({
    display_name: optionalText,
    city: optionalText,
    timezone: z.string().min(1).max(64),
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
    temperature_unit: z.enum(['celsius', 'fahrenheit']),
    measurement_unit: z.enum(['metric', 'imperial']),
    onboarding_completed: z.boolean(),
  })
  .partial()
  .strict();
export type ProfilePatch = z.infer<typeof ProfilePatch>;
