import type { Category } from './taxonomy';

export const outfitSlots = ['top', 'bottom', 'one_piece', 'outerwear', 'shoes', 'eyewear', 'headwear', 'bag', 'accessory'] as const;
export type OutfitSlot = (typeof outfitSlots)[number];
export type OutfitPiece = { item_id: string; slot: OutfitSlot; ordinal: number };

const categorySlot: Record<Category, OutfitSlot> = {
  tops: 'top', bottoms: 'bottom', dresses: 'one_piece', outerwear: 'outerwear', shoes: 'shoes',
  eyewear: 'eyewear', headwear: 'headwear', bags: 'bag', belts: 'accessory', watches: 'accessory', jewelry: 'accessory',
};

export function slotForCategory(category: Category | null): OutfitSlot | null {
  return category ? categorySlot[category] : null;
}

export function outfitCoverage(pieces: readonly Pick<OutfitPiece, 'slot'>[]) {
  const slots = new Set(pieces.map((piece) => piece.slot));
  const clothing = slots.has('one_piece') || (slots.has('top') && slots.has('bottom'));
  const missing = [
    ...(clothing ? [] : slots.has('one_piece') ? [] : slots.has('top') ? ['bottom'] : slots.has('bottom') ? ['top'] : ['top or one-piece', 'bottom if using a top']),
    ...(slots.has('shoes') ? [] : ['shoes']),
  ];
  return { complete: clothing && slots.has('shoes'), missing };
}

export function validOutfitPieces(pieces: readonly OutfitPiece[]): boolean {
  if (pieces.length < 1 || pieces.length > 20) return false;
  if (new Set(pieces.map((piece) => piece.item_id)).size !== pieces.length) return false;
  const core = new Set<OutfitSlot>();
  const ordinals = new Set<number>();
  for (const piece of pieces) {
    if (!outfitSlots.includes(piece.slot) || !Number.isInteger(piece.ordinal) || piece.ordinal < 0 || piece.ordinal > 19) return false;
    if (ordinals.has(piece.ordinal)) return false;
    ordinals.add(piece.ordinal);
    if (piece.slot !== 'accessory') {
      if (core.has(piece.slot)) return false;
      core.add(piece.slot);
    }
  }
  return !(core.has('one_piece') && (core.has('top') || core.has('bottom')));
}
