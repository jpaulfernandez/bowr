import { z } from 'zod';

/** Redacted operational health (ARCHITECTURE 14.3): task names, times and counts only. */
export const OperationsHealth = z
  .object({
    status: z.enum(['ok', 'degraded']),
    checked_at: z.string(),
    stale_tasks: z.array(z.string()),
    heartbeats: z.array(
      z
        .object({
          task: z.string(),
          last_succeeded_at: z.string().nullable(),
          last_failed_at: z.string().nullable(),
          stale: z.boolean(),
        })
        .strict(),
    ),
    deletions_pending: z.number().int(),
    deletions_overdue: z.number().int(),
    accounts_deleting: z.number().int(),
    accounts_overdue: z.number().int(),
    jobs_stuck: z.number().int(),
    oldest_queued_seconds: z.number().int(),
    ai_unknown_attempts: z.number().int(),
    journal_unexported: z.number().int(),
  })
  .strict();
export type OperationsHealth = z.infer<typeof OperationsHealth>;
