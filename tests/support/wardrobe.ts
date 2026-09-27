import { randomUUID } from 'node:crypto';
import { sql } from './stack';

/**
 * Synthetic wardrobes for search, sort and scale checks (P1.06): pieces are
 * inserted directly with varied tags and no photos, so the grid shows its
 * placeholders. Deterministic for a given size.
 */
export type SeedPiece = {
  id: string;
  name: string | null;
  category: string;
  subcategory: string | null;
  colors: Array<{ name: string; hex: string; proportion: number }>;
  seasons: string[];
  brand: string | null;
  material: string | null;
  created_at: string;
};

const KINDS: Array<[string, string | null, string | null]> = [
  ['tops', 'shirt', 'Oxford shirt'],
  ['tops', 't-shirt', null],
  ['bottoms', 'trousers', 'Linen trousers'],
  ['bottoms', 'jeans', null],
  ['shoes', 'sneakers', 'White sneakers'],
  ['outerwear', 'jacket', null],
  ['eyewear', 'shades', 'Aviators'],
  ['eyewear', 'optical frames', null],
  ['bags', 'tote', null],
  ['jewelry', 'ring', 'Signet ring'],
];
const COLORS = [
  { name: 'navy', hex: '#1F2A4D' },
  { name: 'white', hex: '#F7F7F5' },
  { name: 'black', hex: '#1C1C1E' },
  { name: 'olive', hex: '#6B6B32' },
  { name: 'tan', hex: '#B98C5A' },
];
const SEASONS = [['hot'], ['mild', 'cold'], [], ['rainy']];

export function wardrobeSpecs(count: number, start = Date.parse('2026-01-01T08:00:00Z')): SeedPiece[] {
  return Array.from({ length: count }, (_, i) => {
    const [category, subcategory, name] = KINDS[i % KINDS.length]!;
    return {
      id: randomUUID(),
      // Named pieces get a number so every name is distinct.
      name: name ? `${name} ${i + 1}` : null,
      category,
      subcategory,
      colors: [{ ...COLORS[Math.floor(i / KINDS.length) % COLORS.length]!, proportion: 1 }],
      seasons: SEASONS[i % SEASONS.length]!,
      brand: i % 7 === 0 ? 'Uniqlo' : null,
      material: i % 5 === 0 ? 'linen' : null,
      // Increasing times; pairs share a timestamp to exercise the ID tiebreak.
      created_at: new Date(start + Math.floor(i / 2) * 1000).toISOString(),
    };
  });
}

export async function seedPieces(userId: string, pieces: SeedPiece[]) {
  for (const p of pieces) {
    await sql()`insert into public.items (id, user_id, name, category, subcategory, colors, seasons, brand, material,
        category_review_required, created_at)
      values (${p.id}, ${userId}, ${p.name}, ${p.category}, ${p.subcategory}, ${sql().json(p.colors)}, ${p.seasons},
        ${p.brand}, ${p.material}, false, ${p.created_at})`;
  }
  return pieces;
}
