import { z } from 'zod';

/** Shared AI budget as seen by any member: mode and reset time only. */
export const AiStatus = z.object({
  status: z.enum(['normal', 'lighter', 'paused', 'unavailable']),
  resets_at: z.string(),
});
export type AiStatus = z.infer<typeof AiStatus>;

const micros = z.number().int().nonnegative();

export const AdminBudget = z.object({
  ai_enabled: z.boolean(),
  settings: z.object({
    lighter_micros: micros,
    stop_micros: micros,
    ceiling_micros: micros,
    paused_reason: z.string().nullable(),
    revision: z.number().int().positive(),
  }),
  period: z.object({
    period_start: z.string(),
    resets_at: z.string(),
    settled_micros: micros,
    reserved_micros: micros,
    unknown_micros: micros,
    held_micros: micros,
    remaining_micros: micros,
    mode: z.enum(['normal', 'lighter', 'paused']),
    refusals: z.number().int().nonnegative(),
  }),
  by_task: z.array(
    z.object({ task: z.string(), attempts: z.number().int(), settled_micros: micros, reserved_micros: micros, refusals: z.number().int() }),
  ),
  by_member: z.array(z.object({ display_name: z.string(), settled_micros: micros, reserved_micros: micros })),
});
export type AdminBudget = z.infer<typeof AdminBudget>;

export const BudgetThresholds = z.object({
  lighter_micros: micros,
  stop_micros: micros,
  ceiling_micros: micros,
  paused_reason: z.string().nullable(),
  revision: z.number().int().positive(),
});

export const DiagnosticOutcome = z.object({
  status: z.enum(['completed', 'invalid_output', 'refused', 'unavailable', 'provider_rejected', 'uncertain']),
  reason: z.string().optional(),
  mode: z.enum(['normal', 'lighter']).optional(),
  reserved_micros: z.number().int().optional(),
  settled_micros: z.number().int().optional(),
});
export type DiagnosticOutcome = z.infer<typeof DiagnosticOutcome>;
