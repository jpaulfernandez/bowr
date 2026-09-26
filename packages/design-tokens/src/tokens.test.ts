import { describe, expect, it } from 'vitest';
import { colors } from './index';
import { contrastRatio } from './contrast';

// DESIGN.md section 8.3: approved pairs and their minimum ratios.
const approvedPairs: Array<[keyof typeof colors, keyof typeof colors, number]> = [
  ['text', 'surface', 14.19],
  ['text-secondary', 'surface', 5.88],
  ['text-secondary', 'canvas', 5.64],
  ['on-accent', 'accent', 7.01],
  ['accent', 'surface', 6.95],
  ['control-border', 'surface', 3.44],
  ['control-border', 'canvas', 3.3],
  ['flame-ink', 'flame-soft', 5.7],
  ['gold-ink', 'gold-soft', 5.9],
  ['text', 'gold', 7.59],
  ['success', 'success-soft', 5.15],
  ['error', 'error-soft', 5.48],
];

describe('design tokens', () => {
  it.each(approvedPairs)('%s on %s meets the documented ratio', (fg, bg, expected) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeCloseTo(expected, 1);
  });

  it('text pairs used for body copy meet WCAG AA 4.5:1', () => {
    for (const [fg, bg] of approvedPairs.filter(([fg]) => !fg.startsWith('control'))) {
      expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('flame is not approved for normal-size text on surface', () => {
    expect(contrastRatio(colors.flame, colors.surface)).toBeLessThan(4.5);
  });
});
