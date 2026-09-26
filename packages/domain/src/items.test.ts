import { describe, expect, it } from 'vitest';
import { autoSelectable, displayName, displayState, tileLabel } from './items';
import { accessoryAttributes, accessoryCategories, categories, categorySynonyms, subcategories } from './taxonomy';

const base = { name: null, category: null, subcategory: null, material: null, colors: [] as Array<{ name: string }> };

describe('displayName', () => {
  it('prefers the member’s own name', () => {
    expect(displayName({ ...base, name: '  Sunday shirt ', category: 'tops' })).toBe('Sunday shirt');
  });
  it('builds a name from known tags', () => {
    expect(displayName({ ...base, category: 'tops', subcategory: 'shirt', material: 'Linen', colors: [{ name: 'navy' }] })).toBe(
      'Navy linen shirt',
    );
    expect(displayName({ ...base, category: 'shoes', subcategory: 'loafers', colors: [{ name: 'brown' }] })).toBe('Brown loafers');
  });
  it('falls back to "Untitled" with the category noun, or "Untitled piece"', () => {
    expect(displayName({ ...base, category: 'tops' })).toBe('Untitled top');
    expect(displayName({ ...base, category: 'bags', subcategory: 'other' })).toBe('Untitled bag');
    expect(displayName(base)).toBe('Untitled piece');
  });
  it('keeps label-style material text out of generated names', () => {
    expect(displayName({ ...base, category: 'tops', subcategory: 'polo', material: '100% cotton', colors: [{ name: 'white' }] })).toBe(
      'White polo',
    );
  });
});

describe('displayState', () => {
  const item = { lifecycle: 'active' as const, category: 'tops', category_review_required: false, display_image: 'cutout' as const };
  it('is processing while the first cutout is being made', () => {
    expect(displayState(item, [{ stage: 'cutout', state: 'running' }], false)).toBe('processing');
  });
  it('needs attention for an unresolved category, even with a finished cutout', () => {
    expect(displayState({ ...item, category: null }, [{ stage: 'cutout', state: 'succeeded' }], true)).toBe('needs_attention');
    expect(displayState({ ...item, category_review_required: true }, [], true)).toBe('needs_attention');
  });
  it('needs attention when the cutout failed, until the original is chosen', () => {
    const failed = [{ stage: 'cutout', state: 'failed' as const }];
    expect(displayState(item, failed, false)).toBe('needs_attention');
    expect(displayState({ ...item, display_image: 'original' }, failed, false)).toBe('ready');
  });
  it('a part of a group photo is processing until cropped, and needs attention if the crop failed', () => {
    expect(displayState(item, [{ stage: 'crop', state: 'queued' }], false)).toBe('processing');
    expect(displayState(item, [{ stage: 'crop', state: 'failed' }], false)).toBe('needs_attention');
    expect(displayState(item, [{ stage: 'crop', state: 'succeeded' }, { stage: 'cutout', state: 'succeeded' }], true)).toBe('ready');
  });
  it('archived wins over processing', () => {
    expect(displayState({ ...item, lifecycle: 'archived' }, [{ stage: 'cutout', state: 'queued' }], false)).toBe('archived');
  });
});

describe('eligibility and labels', () => {
  it('automatic selection needs an active piece with a resolved category, not every stage', () => {
    expect(autoSelectable({ lifecycle: 'active', category: 'tops', category_review_required: false })).toBe(true);
    expect(autoSelectable({ lifecycle: 'active', category: null, category_review_required: true })).toBe(false);
    expect(autoSelectable({ lifecycle: 'archived', category: 'tops', category_review_required: false })).toBe(false);
  });
  it('tile labels combine useful facts without hex values', () => {
    expect(tileLabel({ ...base, category: 'eyewear', subcategory: 'shades', colors: [{ name: 'black' }] }, 'processing')).toBe(
      'Black shades, eyewear, processing',
    );
  });
});

describe('taxonomy', () => {
  it('keeps every PRD category first-class, including the six accessory categories', () => {
    expect(categories).toHaveLength(11);
    expect(accessoryCategories.every((c) => categories.includes(c))).toBe(true);
    for (const category of categories) expect(subcategories[category].length).toBeGreaterThan(0);
  });
  it('maps common words to categories ("shades" → eyewear, "pants" → bottoms)', () => {
    expect(categorySynonyms.eyewear).toContain('shades');
    expect(categorySynonyms.bottoms).toContain('pants');
    const words = Object.values(categorySynonyms).flat();
    expect(new Set(words).size).toBe(words.length);
  });
  it('attaches accessory attributes only to their categories', () => {
    expect(accessoryAttributes.frame_shape.categories).toEqual(['eyewear']);
    expect(accessoryAttributes.has_logo.values).toEqual([true, false]);
  });
});
