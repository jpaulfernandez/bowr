import { describe, expect, it } from 'vitest';
import { pickCandidate, scoreCandidate, type Observation } from './extraction-eval';

const shirt = { category: 'tops', subcategory: 'shirt', pattern: 'solid', formality: 2, seasons: ['mild', 'hot'] };

describe('extraction scoring', () => {
  it('counts per-field accuracy over labeled fields only, with denominators', () => {
    const observations: Observation[] = [
      { item: 'a', labels: shirt, predicted: { ...shirt, seasons: ['hot', 'mild'] }, latencyMs: 900, costMicros: 120 },
      { item: 'b', labels: { ...shirt, material: 'Linen' }, predicted: { ...shirt, material: 'linen ', pattern: 'striped' }, latencyMs: 1500, costMicros: 130 },
      { item: 'c', labels: { category: 'shoes' }, predicted: null, latencyMs: null, costMicros: 125 },
    ];
    const report = scoreCandidate(observations);
    expect(report.fields.category).toEqual({ correct: 2, labeled: 3, accuracy: 2 / 3 });
    expect(report.fields.pattern).toEqual({ correct: 1, labeled: 2, accuracy: 0.5 });
    expect(report.fields.material).toEqual({ correct: 1, labeled: 1, accuracy: 1 });
    expect(report.fields.seasons.correct).toBe(2);
    // Only "a" needed no edit; "b" had a wrong pattern and "c" was invalid.
    expect(report.uneditedAcceptance).toEqual({ accepted: 1, of: 3, rate: 1 / 3 });
    expect(report.invalid).toBe(1);
    expect(report.latencyMs).toEqual({ p50: 900, p95: 1500 });
    // An invalid output still cost money.
    expect(report.costMicros).toEqual({ total: 375, perItem: 125 });
  });

  it('picks the cheapest candidate within 10% of the best, or none', () => {
    const report = (rate: number, perItem: number) => ({
      ...scoreCandidate([]),
      uneditedAcceptance: { accepted: 0, of: 20, rate },
      costMicros: { total: perItem * 20, perItem },
    });
    expect(pickCandidate({ pro: report(0.85, 900), lite: report(0.8, 200), mini: report(0.6, 50) })).toBe('lite');
    expect(pickCandidate({ pro: report(0.85, 900), lite: report(0.7, 200) })).toBe('pro');
    expect(pickCandidate({})).toBeNull();
  });
});
