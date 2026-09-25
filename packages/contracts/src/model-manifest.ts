import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Price per million tokens in integer USD micros ($1 = 1,000,000). */
const Price = z
  .object({
    effective_from: isoDate,
    effective_until: isoDate.optional(),
    input_per_mtok_micros: z.number().int().nonnegative(),
    output_per_mtok_micros: z.number().int().nonnegative(),
  })
  .strict();

const Task = z
  .object({
    provider: z.literal('gemini'),
    model: z.string().min(1).max(100),
    prompt_version: z.string().min(1).max(40),
    output_schema_version: z.number().int().positive(),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    // Only a verified, bounded thinking budget may be enabled; otherwise disabled.
    thinking: z.union([z.literal('disabled'), z.object({ budget_tokens: z.number().int().positive() }).strict()]),
    safety_margin_percent: z.number().int().min(0).max(100),
    // Envelope used from the lighter-mode threshold up to the operational stop.
    lighter: z.object({ model: z.string().min(1).max(100), max_output_tokens: z.number().int().positive() }).strict(),
    prices: z.array(Price).min(1),
  })
  .strict()
  .refine((task) => task.lighter.max_output_tokens <= task.max_output_tokens, 'lighter output must not exceed normal output');

const LocalModel = z
  .object({
    source: z.string().min(1),
    revision: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    license: z.string().min(1),
  })
  .strict();

export const ModelManifest = z
  .object({
    schema_version: z.literal(1),
    tasks: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), Task),
    local_models: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), LocalModel),
  })
  .strict();
export type ModelManifest = z.infer<typeof ModelManifest>;
