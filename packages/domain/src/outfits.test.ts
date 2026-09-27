import { describe, expect, it } from 'vitest';
import { outfitCoverage, slotForCategory, validOutfitPieces, type OutfitPiece } from './outfits';

const piece = (item_id: string, slot: OutfitPiece['slot'], ordinal: number): OutfitPiece => ({ item_id, slot, ordinal });

describe('manual outfit slots', () => {
  it('recognizes two complete compositions and honestly labels partial ones', () => {
    expect(outfitCoverage([piece('a', 'top', 0), piece('b', 'bottom', 1), piece('c', 'shoes', 2)]).complete).toBe(true);
    expect(outfitCoverage([piece('a', 'one_piece', 0), piece('c', 'shoes', 1)]).complete).toBe(true);
    expect(outfitCoverage([piece('a', 'one_piece', 0)]).missing).toEqual(['shoes']);
    expect(outfitCoverage([piece('a', 'top', 0), piece('c', 'shoes', 1)]).missing).toEqual(['bottom']);
  });

  it('rejects repeated pieces, duplicate core slots and dress plus separates', () => {
    expect(validOutfitPieces([piece('a', 'top', 0), piece('a', 'bottom', 1)])).toBe(false);
    expect(validOutfitPieces([piece('a', 'top', 0), piece('b', 'top', 1)])).toBe(false);
    expect(validOutfitPieces([piece('a', 'one_piece', 0), piece('b', 'bottom', 1)])).toBe(false);
    expect(validOutfitPieces([piece('a', 'accessory', 0), piece('b', 'accessory', 1)])).toBe(true);
  });

  it('assigns category slots but leaves unknown for explicit member choice', () => {
    expect(slotForCategory('dresses')).toBe('one_piece');
    expect(slotForCategory('jewelry')).toBe('accessory');
    expect(slotForCategory(null)).toBeNull();
  });
});
