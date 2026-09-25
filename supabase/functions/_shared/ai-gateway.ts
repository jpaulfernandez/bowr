// The only path to a billable model call (ARCHITECTURE section 10). Clients and
// the worker never reach the provider; callers name a server task alias.
import { GoogleGenAI } from 'npm:@google/genai@2.24.0';
import { billedMicros, effectivePrice, reservationMicros, taskConfig } from './ai-catalog.ts';
import { serviceClient } from './service.ts';

export type AiOutcome =
  | {
    status: 'completed';
    mode: 'normal' | 'lighter';
    reserved_micros: number;
    settled_micros: number;
    output: unknown;
  }
  | { status: 'invalid_output'; mode: 'normal' | 'lighter'; reserved_micros: number; settled_micros: number }
  | { status: 'refused'; reason: string; resets_at?: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'provider_rejected'; reason: string }
  | { status: 'uncertain'; reserved_micros: number };

type RunOptions = {
  task: string;
  attemptKey: string;
  userId: string | null;
  jobId: string | null;
  prompt: string;
  responseSchema: Record<string, unknown>;
  validate: (value: unknown) => boolean;
};

const CALL_TIMEOUT_MS = Number(Deno.env.get('AI_CALL_TIMEOUT_MS') ?? 30_000);
// A call is not launched if it could still be running when the month rolls over.
const DISPATCH_WINDOW_SECONDS = 120;

function provider(): GoogleGenAI | null {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (Deno.env.get('AI_ENABLED') !== 'true' || !apiKey) return null;
  const baseUrl = Deno.env.get('GEMINI_BASE_URL');
  return new GoogleGenAI({ apiKey, httpOptions: { timeout: CALL_TIMEOUT_MS, ...(baseUrl ? { baseUrl } : {}) } });
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw new Error(`accounting ${name} failed: ${error.message}`);
  return data as T;
}

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : null;
}

export async function runAiTask(options: RunOptions): Promise<AiOutcome> {
  const config = taskConfig(options.task);
  const ai = provider();
  if (!config || !ai) return { status: 'unavailable', reason: 'ai_not_enabled' };
  const price = effectivePrice(config, new Date());
  // Unknown price or bound: fail closed before any accounting or provider call.
  if (!price || config.max_output_tokens <= 0 || config.lighter.max_output_tokens <= 0) {
    return { status: 'unavailable', reason: 'price_or_bound_unknown' };
  }

  const contents = options.prompt;
  // Reserve first, for the configured maximum input: a refused request never
  // contacts the provider, not even for a free token count.
  const reservation = await rpc<{
    usage_id: string;
    state: string;
    mode: 'normal' | 'lighter';
    model: string;
    reserved_micros: number;
    refusal_reason?: string;
    resets_at?: string;
  }>('svc_ai_reserve', {
    p_attempt_key: options.attemptKey,
    p_user_id: options.userId,
    p_job_id: options.jobId,
    p_task: options.task,
    p_model: config.model,
    p_lighter_model: config.lighter.model,
    p_price_version: price.version,
    p_reserve_normal: reservationMicros(
      config.max_input_tokens,
      config.max_output_tokens,
      config.thinking,
      price,
      config.safety_margin_percent,
    ),
    p_reserve_lighter: reservationMicros(
      config.max_input_tokens,
      config.lighter.max_output_tokens,
      config.thinking,
      price,
      config.safety_margin_percent,
    ),
    p_window_seconds: DISPATCH_WINDOW_SECONDS,
  });
  if (reservation.state === 'refused') {
    return { status: 'refused', reason: reservation.refusal_reason ?? 'budget', resets_at: reservation.resets_at };
  }
  if (reservation.state !== 'reserved') {
    // An existing attempt with this identity is never re-sent to the provider.
    return reservation.state === 'unknown'
      ? { status: 'uncertain', reserved_micros: reservation.reserved_micros }
      : { status: 'refused', reason: `attempt_${reservation.state}` };
  }

  // The admitted input must fit the bound the reservation assumed.
  let inputTokens: number;
  try {
    inputTokens = (await ai.models.countTokens({ model: reservation.model, contents })).totalTokens ?? Number.NaN;
  } catch {
    inputTokens = Number.NaN;
  }
  if (!Number.isFinite(inputTokens) || inputTokens > config.max_input_tokens) {
    await rpc('svc_ai_release', { p_usage_id: reservation.usage_id });
    return { status: 'unavailable', reason: Number.isFinite(inputTokens) ? 'input_too_large' : 'token_count_failed' };
  }

  // Tariff, pause and rollover are rechecked immediately before dispatch.
  const dispatchPrice = effectivePrice(config, new Date());
  const dispatch = await rpc<{ dispatch: boolean; reason?: string }>('svc_ai_mark_dispatching', {
    p_usage_id: reservation.usage_id,
    p_price_version: dispatchPrice?.version ?? 'unknown',
    p_window_seconds: DISPATCH_WINDOW_SECONDS,
  });
  if (!dispatch.dispatch) return { status: 'refused', reason: dispatch.reason ?? 'not_dispatchable' };

  const maxOutput = reservation.mode === 'lighter' ? config.lighter.max_output_tokens : config.max_output_tokens;
  let response;
  try {
    response = await ai.models.generateContent({
      model: reservation.model,
      contents,
      config: {
        maxOutputTokens: maxOutput,
        thinkingConfig: { thinkingBudget: config.thinking === 'disabled' ? 0 : config.thinking.budget_tokens },
        responseMimeType: 'application/json',
        responseJsonSchema: options.responseSchema,
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    });
  } catch (error) {
    const status = httpStatus(error);
    if (status !== null && status >= 400 && status < 500) {
      // Rejected before processing: known unbilled, release once.
      await rpc('svc_ai_release', { p_usage_id: reservation.usage_id });
      return { status: 'provider_rejected', reason: `http_${status}` };
    }
    // Timeout, connection loss or server error after sending: possibly billed.
    await rpc('svc_ai_mark_unknown', { p_usage_id: reservation.usage_id });
    return { status: 'uncertain', reserved_micros: reservation.reserved_micros };
  }

  const usage = response.usageMetadata;
  // Missing usage cannot be priced: settle conservatively at the reservation.
  const billed = usage?.promptTokenCount !== undefined
    ? billedMicros(usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0, usage.thoughtsTokenCount ?? 0, price)
    : reservation.reserved_micros;
  const settlement = await rpc<{ settled_micros: number; over_reservation?: boolean }>('svc_ai_settle', {
    p_usage_id: reservation.usage_id,
    p_input_tokens: usage?.promptTokenCount ?? null,
    p_output_tokens: usage?.candidatesTokenCount ?? null,
    p_thinking_tokens: usage?.thoughtsTokenCount ?? null,
    p_billed_micros: billed,
    p_provider_request_id: response.responseId ?? null,
  });
  if (settlement.over_reservation) {
    console.error(JSON.stringify({ alert: 'ai_charge_above_reservation', usage_id: reservation.usage_id }));
  }

  let output: unknown = null;
  try {
    output = JSON.parse(response.text ?? '');
  } catch {
    output = null;
  }
  const settled = {
    mode: reservation.mode,
    reserved_micros: reservation.reserved_micros,
    settled_micros: settlement.settled_micros,
  };
  // Model output is untrusted input: schema-validated here, then by the caller.
  return options.validate(output)
    ? { status: 'completed', ...settled, output }
    : { status: 'invalid_output', ...settled };
}

/** The synthetic, content-free diagnostic task. */
export function runDiagnostic(attemptKey: string, userId: string | null) {
  return runAiTask({
    task: 'diagnostic',
    attemptKey,
    userId,
    jobId: null,
    prompt: 'Return the JSON object {"ok": true}. This is a budget-guard diagnostic with no user content.',
    responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    validate: (value) => typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true,
  });
}

export function aiEnabled(): boolean {
  return Deno.env.get('AI_ENABLED') === 'true' && Boolean(Deno.env.get('GEMINI_API_KEY'));
}
