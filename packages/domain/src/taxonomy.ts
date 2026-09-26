/**
 * Piece taxonomy (DESIGN 4.5, PRD F2), versioned shared data. The database keeps
 * the same version in private.taxonomy() and the Edge reads a generated copy;
 * drift fails the integration and unit tests.
 */
export const TAXONOMY_VERSION = 1;

export const categories = [
  'tops',
  'bottoms',
  'outerwear',
  'dresses',
  'shoes',
  'eyewear',
  'headwear',
  'bags',
  'belts',
  'watches',
  'jewelry',
] as const;
export type Category = (typeof categories)[number];

/** Accessory categories are first-class; this set only powers an optional shortcut. */
export const accessoryCategories: readonly Category[] = ['eyewear', 'headwear', 'bags', 'belts', 'watches', 'jewelry'];

export const subcategories: Record<Category, readonly string[]> = {
  tops: ['t-shirt', 'shirt', 'polo', 'blouse', 'sweater', 'hoodie', 'tank', 'other'],
  bottoms: ['jeans', 'trousers', 'shorts', 'skirt', 'leggings', 'other'],
  outerwear: ['jacket', 'coat', 'blazer', 'cardigan', 'vest', 'other'],
  dresses: ['dress', 'jumpsuit', 'other'],
  shoes: ['sneakers', 'loafers', 'boots', 'sandals', 'slides', 'heels', 'other'],
  eyewear: ['shades', 'optical frames'],
  headwear: ['cap', 'bucket hat', 'beanie', 'other'],
  bags: ['tote', 'backpack', 'crossbody', 'shoulder bag', 'clutch', 'other'],
  belts: ['belt'],
  watches: ['watch'],
  jewelry: ['earrings', 'necklace', 'bracelet', 'ring', 'other'],
};

/** Singular nouns for generated names ("Untitled top"). */
export const categoryNoun: Record<Category, string> = {
  tops: 'top',
  bottoms: 'bottom',
  outerwear: 'layer',
  dresses: 'dress',
  shoes: 'shoes',
  eyewear: 'eyewear',
  headwear: 'hat',
  bags: 'bag',
  belts: 'belt',
  watches: 'watch',
  jewelry: 'jewelry',
};

export const categoryLabel: Record<Category, string> = {
  tops: 'Tops',
  bottoms: 'Bottoms',
  outerwear: 'Outerwear',
  dresses: 'Dresses',
  shoes: 'Shoes',
  eyewear: 'Eyewear',
  headwear: 'Headwear',
  bags: 'Bags',
  belts: 'Belts',
  watches: 'Watches',
  jewelry: 'Jewelry',
};

/** Search words that mean a category ("shades" finds eyewear, "pants" finds bottoms). */
export const categorySynonyms: Record<Category, readonly string[]> = {
  tops: ['top', 'tops', 'shirt', 'shirts', 'tee', 'tees', 't-shirt', 'blouse', 'sweater', 'hoodie', 'polo', 'tank'],
  bottoms: ['bottom', 'bottoms', 'pants', 'trousers', 'jeans', 'shorts', 'skirt', 'skirts', 'leggings', 'slacks'],
  outerwear: ['outerwear', 'jacket', 'jackets', 'coat', 'coats', 'blazer', 'cardigan', 'vest', 'layer'],
  dresses: ['dress', 'dresses', 'jumpsuit', 'gown'],
  shoes: ['shoe', 'shoes', 'sneakers', 'trainers', 'loafers', 'boots', 'sandals', 'slides', 'heels', 'footwear'],
  eyewear: ['eyewear', 'shades', 'sunglasses', 'sunnies', 'glasses', 'frames', 'spectacles'],
  headwear: ['headwear', 'hat', 'hats', 'cap', 'caps', 'bucket hat', 'beanie'],
  bags: ['bag', 'bags', 'tote', 'backpack', 'purse', 'handbag', 'crossbody', 'clutch'],
  belts: ['belt', 'belts'],
  watches: ['watch', 'watches', 'timepiece'],
  jewelry: ['jewelry', 'jewellery', 'earrings', 'necklace', 'bracelet', 'ring', 'rings', 'chain'],
};

export const patterns = ['solid', 'striped', 'checked', 'floral', 'graphic', 'printed', 'dotted', 'textured', 'other'] as const;
export type Pattern = (typeof patterns)[number];

/** Formality 1–5 (DESIGN 4.5). */
export const formalityLabels = ['Relaxed', 'Casual', 'Smart casual', 'Dressy', 'Formal'] as const;

/** Condition tags rather than a region-specific season preset (DESIGN 4.5). */
export const seasons = ['hot', 'mild', 'cold', 'rainy'] as const;
export type Season = (typeof seasons)[number];

/** Named colors: the name is always available next to the stored hex. */
export const namedColors = [
  { name: 'black', hex: '#1C1C1E' },
  { name: 'charcoal', hex: '#3F4148' },
  { name: 'grey', hex: '#8E9097' },
  { name: 'white', hex: '#F7F7F5' },
  { name: 'cream', hex: '#EFE6D2' },
  { name: 'beige', hex: '#D8C3A0' },
  { name: 'khaki', hex: '#B5A17A' },
  { name: 'tan', hex: '#B98C5A' },
  { name: 'brown', hex: '#6E4B32' },
  { name: 'burgundy', hex: '#6D1F2F' },
  { name: 'red', hex: '#C62F2F' },
  { name: 'pink', hex: '#E7A0B4' },
  { name: 'orange', hex: '#E0762C' },
  { name: 'mustard', hex: '#C9A13A' },
  { name: 'yellow', hex: '#EBD04A' },
  { name: 'olive', hex: '#6B6B32' },
  { name: 'green', hex: '#3E8A4F' },
  { name: 'teal', hex: '#2A7E80' },
  { name: 'light blue', hex: '#9CC3E4' },
  { name: 'blue', hex: '#2F5DB5' },
  { name: 'navy', hex: '#1F2A4D' },
  { name: 'purple', hex: '#6A4C93' },
  { name: 'silver', hex: '#BFC3C8' },
  { name: 'gold', hex: '#C9A54C' },
] as const;
export type ColorName = (typeof namedColors)[number]['name'];

/** Bounded accessory attributes (PRD F2) and the categories they apply to. */
export const accessoryAttributes = {
  sole_color: { categories: ['shoes'], values: namedColors.map((c) => c.name) },
  frame_shape: { categories: ['eyewear'], values: ['round', 'square', 'rectangle', 'aviator', 'cat-eye', 'oval', 'other'] },
  frame_color: { categories: ['eyewear'], values: namedColors.map((c) => c.name) },
  lens_tint: { categories: ['eyewear'], values: ['clear', 'dark', 'gradient', 'mirrored', 'colored'] },
  has_logo: { categories: ['headwear'], values: [true, false] },
} as const satisfies Record<string, { categories: readonly Category[]; values: readonly (string | boolean)[] }>;
export type AccessoryAttribute = keyof typeof accessoryAttributes;

export const MAX_COLORS = 5;
export const MAX_STYLE_TAGS = 10;

export const isCategory = (value: unknown): value is Category =>
  typeof value === 'string' && (categories as readonly string[]).includes(value);

/** The versioned data shared with the database and Edge (generated JSON). */
export function taxonomyDocument() {
  return {
    version: TAXONOMY_VERSION,
    categories: Object.fromEntries(categories.map((c) => [c, subcategories[c]])),
    patterns,
    seasons,
    colors: namedColors.map((c) => c.name),
    attributes: Object.fromEntries(
      Object.entries(accessoryAttributes).map(([key, rule]) => [key, { categories: rule.categories, values: rule.values }]),
    ),
    max_colors: MAX_COLORS,
    max_style_tags: MAX_STYLE_TAGS,
  };
}
