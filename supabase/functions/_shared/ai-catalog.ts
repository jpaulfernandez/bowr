// Server-side AI task catalog generated from config/models.yaml. Prices are
// integer USD micros per million tokens; all arithmetic rounds up.
import catalog from './generated/ai-catalog.json' with { type: 'json' };

type Price = {
  effective_from: string;
  effective_until?: string;
  input_per_mtok_micros: number;
  output_per_mtok_micros: number;
};

export type TaskConfig = {
  provider: 'gemini';
  model: string;
  prompt_version: string;
  output_schema_version: number;
  max_input_tokens: number;
  max_output_tokens: number;
  thinking: 'disabled' | { budget_tokens: number };
  safety_margin_percent: number;
  lighter: { model: string; max_output_tokens: number };
  prices: Price[];
};

export type EffectivePrice = Price & { version: string };

export function taskConfig(task: string): TaskConfig | null {
  return (catalog.tasks as Record<string, TaskConfig>)[task] ?? null;
}

/** The single price effective at `at` (UTC date), or null when none or several apply. */
export function effectivePrice(config: TaskConfig, at: Date): EffectivePrice | null {
  const day = at.toISOString().slice(0, 10);
  const matching = config.prices.filter((p) =>
    p.effective_from <= day && (!p.effective_until || day < p.effective_until)
  );
  if (matching.length !== 1) return null;
  const price = matching[0]!;
  return { ...price, version: `${config.model}@${price.effective_from}` };
}

const perToken = (tokens: number, microsPerMillion: number) => Math.ceil((tokens * microsPerMillion) / 1_000_000);

/** Worst case for admitted input plus maximum billed output (thinking included), with margin. */
export function reservationMicros(
  input: number,
  maxOutput: number,
  thinking: TaskConfig['thinking'],
  price: Price,
  marginPercent: number,
) {
  const output = maxOutput + (thinking === 'disabled' ? 0 : thinking.budget_tokens);
  const base = perToken(input, price.input_per_mtok_micros) + perToken(output, price.output_per_mtok_micros);
  return Math.max(1, Math.ceil(base * (1 + marginPercent / 100)) + 1);
}

/** Billed cost from provider usage. Output billing includes thinking tokens. */
export function billedMicros(promptTokens: number, outputTokens: number, thinkingTokens: number, price: Price) {
  return perToken(promptTokens, price.input_per_mtok_micros) +
    perToken(outputTokens + thinkingTokens, price.output_per_mtok_micros);
}
