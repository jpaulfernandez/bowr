/**
 * Pure piece rules (ARCHITECTURE 6.4, DESIGN 6.2–6.4): generated names and the
 * display state derived from lifecycle, review and processing. These three are
 * stored separately and never collapsed into one status column.
 */
import { categoryNoun, isCategory, type Category } from './taxonomy';

export type Lifecycle = 'active' | 'archived' | 'deleted';
export type StageState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'blocked_budget'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'uncertain';

export type ItemFacts = {
  name: string | null;
  category: string | null;
  subcategory: string | null;
  material: string | null;
  colors: ReadonlyArray<{ name: string }>;
  lifecycle: Lifecycle;
  category_review_required: boolean;
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A user-set name wins. Otherwise "Navy linen shirt" from known tags, falling
 * back to "Untitled top" or "Untitled piece".
 */
export function displayName(item: Pick<ItemFacts, 'name' | 'category' | 'subcategory' | 'material' | 'colors'>): string {
  const name = item.name?.trim();
  if (name) return name;
  const category = isCategory(item.category) ? item.category : null;
  const subcategory = item.subcategory && item.subcategory !== 'other' ? item.subcategory : null;
  const noun = subcategory ?? (category ? categoryNoun[category] : null);
  if (!noun) return 'Untitled piece';
  const color = item.colors[0]?.name;
  const material = item.material && item.material.length <= 12 && !/\d|%/.test(item.material) ? item.material.toLowerCase() : null;
  const words = [color, material, noun].filter(Boolean) as string[];
  if (words.length === 1) return `Untitled ${noun}`;
  return capitalize(words.join(' '));
}

export type DisplayState = 'archived' | 'processing' | 'needs_attention' | 'ready';

export type StageFacts = { stage: string; state: StageState };

/**
 * Processing: the cutout is still being made and the piece has no usable image
 * choice yet. Needs attention: category unresolved, or the cutout failed while
 * the original has not been chosen. Otherwise ready.
 */
export function displayState(
  item: Pick<ItemFacts, 'lifecycle' | 'category' | 'category_review_required'> & { display_image: 'cutout' | 'original' },
  stages: readonly StageFacts[],
  hasCutout: boolean,
): DisplayState {
  if (item.lifecycle === 'archived') return 'archived';
  const cutout = stages.find((s) => s.stage === 'cutout');
  const cutoutPending = cutout && ['queued', 'running', 'retry_wait'].includes(cutout.state);
  if (cutoutPending && !hasCutout && item.display_image === 'cutout') return 'processing';
  if (needsCategory(item)) return 'needs_attention';
  if (cutout?.state === 'failed' && !hasCutout && item.display_image === 'cutout') return 'needs_attention';
  return 'ready';
}

export const needsCategory = (item: Pick<ItemFacts, 'category' | 'category_review_required'>) =>
  !isCategory(item.category) || item.category_review_required;

/**
 * Automatic outfit selection needs an active piece with a resolved category.
 * It does not need every processing stage (an embedding) to have succeeded.
 */
export function autoSelectable(item: Pick<ItemFacts, 'lifecycle' | 'category' | 'category_review_required'>): boolean {
  return item.lifecycle === 'active' && !needsCategory(item);
}

/** A tile's accessible name: useful facts, never file names or hex values. */
export function tileLabel(item: Parameters<typeof displayName>[0], state: DisplayState): string {
  const category = isCategory(item.category) ? (item.category as Category) : null;
  const facts = [displayName(item), category ? categoryNoun[category] : null];
  if (state === 'processing') facts.push('processing');
  if (state === 'needs_attention') facts.push('needs attention');
  if (state === 'archived') facts.push('archived');
  return facts.filter(Boolean).join(', ');
}
