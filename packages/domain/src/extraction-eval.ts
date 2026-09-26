/**
 * Scoring for the blind tag-extraction comparison (P1.07-T1, PRD evaluation).
 * Pure: the runner collects one prediction per labeled photo and candidate;
 * this module turns them into per-field accuracy with explicit denominators,
 * unedited acceptance, invalid-output rate, latency and cost. No photo or
 * provider payload is part of a report.
 */

/** Fields a member would otherwise correct by hand, in review order (DESIGN 6.2). */
export const scoredFields = ['category', 'subcategory', 'pattern', 'formality', 'material', 'seasons'] as const;
export type ScoredField = (typeof scoredFields)[number];

/** A piece "needs no edit" when every labeled field among these is right. */
export const acceptanceFields: readonly ScoredField[] = ['category', 'subcategory', 'pattern', 'formality'];

export type Labels = Partial<Record<ScoredField, string | number | string[] | null>>;

export type Observation = {
  item: string;
  labels: Labels;
  /** Null when the output was invalid, refused or lost: it counts against the candidate. */
  predicted: Labels | null;
  latencyMs: number | null;
  costMicros: number | null;
};

export type FieldScore = { correct: number; labeled: number; accuracy: number | null };

export type CandidateReport = {
  items: number;
  invalid: number;
  invalidRate: number;
  fields: Record<ScoredField, FieldScore>;
  /** Pieces whose labeled acceptance fields were all right, over all pieces. */
  uneditedAcceptance: { accepted: number; of: number; rate: number | null };
  latencyMs: { p50: number | null; p95: number | null };
  costMicros: { total: number; perItem: number | null };
};

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return [...value].map((v) => String(v).trim().toLowerCase()).sort();
  if (typeof value === 'string') return value.trim().toLowerCase();
  return value ?? null;
};

export function fieldMatches(field: ScoredField, label: unknown, predicted: unknown): boolean {
  return JSON.stringify(normalize(label)) === JSON.stringify(normalize(predicted)) && (field !== 'seasons' || Array.isArray(predicted));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function scoreCandidate(observations: readonly Observation[]): CandidateReport {
  const fields = Object.fromEntries(scoredFields.map((f) => [f, { correct: 0, labeled: 0, accuracy: null as number | null }])) as Record<
    ScoredField,
    FieldScore
  >;
  let invalid = 0;
  let accepted = 0;
  for (const o of observations) {
    if (!o.predicted) invalid += 1;
    let allRight = true;
    for (const field of scoredFields) {
      if (!(field in o.labels)) continue;
      fields[field].labeled += 1;
      const right = o.predicted !== null && fieldMatches(field, o.labels[field], o.predicted[field]);
      if (right) fields[field].correct += 1;
      if (!right && acceptanceFields.includes(field)) allRight = false;
    }
    if (allRight && o.predicted) accepted += 1;
  }
  for (const field of scoredFields) {
    fields[field].accuracy = fields[field].labeled ? fields[field].correct / fields[field].labeled : null;
  }
  const latencies = observations.map((o) => o.latencyMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const total = observations.reduce((sum, o) => sum + (o.costMicros ?? 0), 0);
  return {
    items: observations.length,
    invalid,
    invalidRate: observations.length ? invalid / observations.length : 0,
    fields,
    uneditedAcceptance: { accepted, of: observations.length, rate: observations.length ? accepted / observations.length : null },
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costMicros: { total, perItem: observations.length ? Math.round(total / observations.length) : null },
  };
}

/**
 * The pick rule (P1.07-T2): the cheapest candidate whose unedited acceptance is
 * within `tolerance` (default 10%) of the best. Null when no candidate has a
 * measurable rate, so the gate stays open.
 */
export function pickCandidate(reports: Record<string, CandidateReport>, tolerance = 0.1): string | null {
  const rated = Object.entries(reports).filter(([, r]) => r.uneditedAcceptance.rate !== null && r.costMicros.perItem !== null);
  if (rated.length === 0) return null;
  const best = Math.max(...rated.map(([, r]) => r.uneditedAcceptance.rate!));
  const eligible = rated.filter(([, r]) => r.uneditedAcceptance.rate! >= best * (1 - tolerance));
  eligible.sort(([, a], [, b]) => a.costMicros.perItem! - b.costMicros.perItem!);
  return eligible[0]![0];
}
