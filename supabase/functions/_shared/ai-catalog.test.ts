import { assertEquals } from 'jsr:@std/assert@1.0.14';
import { billedMicros, effectivePrice, reservationMicros, type TaskConfig, taskConfig } from './ai-catalog.ts';

const base: TaskConfig = {
  provider: 'gemini',
  model: 'model-a',
  prompt_version: 'v1',
  output_schema_version: 1,
  max_input_tokens: 1000,
  max_output_tokens: 100,
  thinking: 'disabled',
  safety_margin_percent: 10,
  lighter: { model: 'model-a', max_output_tokens: 50 },
  prices: [
    {
      effective_from: '2026-01-01',
      effective_until: '2027-01-01',
      input_per_mtok_micros: 750000,
      output_per_mtok_micros: 3750000,
    },
    { effective_from: '2027-01-01', input_per_mtok_micros: 1500000, output_per_mtok_micros: 7500000 },
  ],
};

Deno.test('the effective tariff switches at its effective date (UTC)', () => {
  assertEquals(effectivePrice(base, new Date('2026-12-31T23:59:59Z'))?.version, 'model-a@2026-01-01');
  assertEquals(effectivePrice(base, new Date('2027-01-01T00:00:00Z'))?.version, 'model-a@2027-01-01');
});

Deno.test('an unknown or ambiguous price fails closed', () => {
  assertEquals(effectivePrice(base, new Date('2025-06-01T00:00:00Z')), null);
  const overlapping = { ...base, prices: [base.prices[1]!, { ...base.prices[1]!, output_per_mtok_micros: 1 }] };
  assertEquals(effectivePrice(overlapping, new Date('2027-06-01T00:00:00Z')), null);
});

Deno.test('the reservation covers the worst case input and output with margin, rounded up', () => {
  const price = base.prices[0]!;
  // 1000 * 0.75 + 100 * 3.75 = 750 + 375 = 1125 micros; +10% = 1237.5 -> 1238; +1 rounding micro.
  assertEquals(reservationMicros(1000, 100, 'disabled', price, 10), 1239);
  // A thinking budget is billed as output and must be reserved.
  assertEquals(reservationMicros(1000, 100, { budget_tokens: 100 }, price, 0), 750 + 750 + 1);
});

Deno.test('billed cost includes thinking tokens as output and never rounds down', () => {
  const price = base.prices[0]!;
  assertEquals(billedMicros(1, 0, 0, price), 1);
  assertEquals(billedMicros(1000, 50, 50, price), 750 + 375);
});

Deno.test('a settled charge never exceeds the reservation for admitted bounds', () => {
  const price = base.prices[0]!;
  for (const [input, output] of [[1000, 100], [1, 1], [999, 99]] as const) {
    assertEquals(billedMicros(input, output, 0, price) <= reservationMicros(1000, 100, 'disabled', price, 10), true);
  }
});

Deno.test('the shipped catalog has a single current price for the diagnostic task', () => {
  const diagnostic = taskConfig('diagnostic');
  assertEquals(diagnostic !== null, true);
  assertEquals(effectivePrice(diagnostic!, new Date('2026-09-25T00:00:00Z')) !== null, true);
});
