import { categories, namedColors, patterns, seasons } from '@bowr/domain';
import { z } from 'zod';

export const ItemColor = z.object({
  name: z.enum(namedColors.map((c) => c.name) as [string, ...string[]]),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  proportion: z.number().min(0).max(1).optional(),
});
export type ItemColor = z.infer<typeof ItemColor>;

export const FieldMeta = z.record(
  z.string(),
  z.object({
    v: z.number().int(),
    source: z.enum(['user', 'vision', 'label', 'computed']),
    locked: z.boolean().optional(),
    at: z.string().optional(),
  }),
);

export const StageName = z.enum(['cutout', 'colors', 'embedding', 'tags', 'label']);
export const StageState = z.enum(['queued', 'running', 'retry_wait', 'blocked_budget', 'succeeded', 'failed', 'canceled']);

export const ItemStage = z.object({
  stage: StageName,
  state: StageState,
  failure_code: z.string().nullable(),
  media_revision: z.number().int(),
  can_retry: z.boolean(),
});
export type ItemStage = z.infer<typeof ItemStage>;

export const ItemAssetRole = z.enum(['original', 'cutout', 'thumbnail', 'mask', 'label']);
export const ItemAsset = z.object({ asset_id: z.string().uuid(), role: ItemAssetRole, media_revision: z.number().int() });
export type ItemAsset = z.infer<typeof ItemAsset>;

/** A piece as read through the Data API (RLS, owner only). */
export const Item = z.object({
  id: z.string().uuid(),
  lifecycle: z.enum(['active', 'archived', 'deleted']),
  name: z.string().nullable(),
  category: z.enum(categories).nullable(),
  subcategory: z.string().nullable(),
  pattern: z.enum(patterns).nullable(),
  material: z.string().nullable(),
  formality: z.number().int().min(1).max(5).nullable(),
  colors: z.array(ItemColor),
  seasons: z.array(z.enum(seasons)),
  style_tags: z.array(z.string()),
  attributes: z.record(z.string(), z.union([z.string(), z.boolean()])),
  brand: z.string().nullable(),
  size_label: z.string().nullable(),
  price_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  purchased_on: z.string().nullable(),
  display_image: z.enum(['cutout', 'original']),
  category_review_required: z.boolean(),
  field_meta: FieldMeta,
  revision: z.number().int(),
  media_revision: z.number().int(),
  created_at: z.string(),
  item_assets: z.array(ItemAsset.extend({ detached_at: z.string().nullable() })),
  item_stages: z.array(ItemStage),
});
export type Item = z.infer<typeof Item>;

/** Columns selected for an Item, with its current attachments and stages. */
export const ITEM_SELECT =
  'id, lifecycle, name, category, subcategory, pattern, material, formality, colors, seasons, style_tags, attributes, brand, size_label, price_minor, currency, purchased_on, display_image, category_review_required, field_meta, revision, media_revision, created_at, item_assets(asset_id, role, media_revision, detached_at), item_stages(stage, state, failure_code, media_revision, can_retry)';

/** Fields a member may change through update_item. */
export const ItemPatch = z
  .object({
    name: z.string().max(80).nullable(),
    category: z.enum(categories).nullable(),
    subcategory: z.string().max(40).nullable(),
    pattern: z.enum(patterns).nullable(),
    material: z.string().max(60).nullable(),
    formality: z.number().int().min(1).max(5).nullable(),
    colors: z.array(ItemColor).max(5),
    seasons: z.array(z.enum(seasons)),
    style_tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9 -]{0,23}$/)).max(10),
    attributes: z.record(z.string(), z.union([z.string(), z.boolean()])),
    brand: z.string().max(60).nullable(),
    size_label: z.string().max(20).nullable(),
    price_minor: z.number().int().min(0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    purchased_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    display_image: z.enum(['cutout', 'original']),
  })
  .partial()
  .strict();
export type ItemPatch = z.infer<typeof ItemPatch>;

/** update_item result (no attachments). */
export const UpdatedItem = Item.omit({ item_assets: true, item_stages: true, created_at: true });
