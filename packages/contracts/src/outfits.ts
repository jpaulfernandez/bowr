import { outfitSlots } from '@bowr/domain';
import { z } from 'zod';

export const OutfitPiece = z.object({ item_id: z.string().uuid(), slot: z.enum(outfitSlots), ordinal: z.number().int().min(0).max(19) });
export type OutfitPiece = z.infer<typeof OutfitPiece>;
export const Outfit = z.object({
  id: z.string().uuid(), name: z.string().nullable(), source: z.enum(['manual', 'pair', 'inspo', 'generated', 'log']),
  loved: z.boolean(), revision: z.number().int(), deleted_at: z.string().nullable(), created_at: z.string(),
  outfit_items: z.array(OutfitPiece),
});
export type Outfit = z.infer<typeof Outfit>;
export const OUTFIT_SELECT = 'id, name, source, loved, revision, deleted_at, created_at, outfit_items(item_id, slot, ordinal)';
export const OutfitMutationResult = z.object({ id: z.string().uuid(), revision: z.number().int(), deleted_at: z.string().nullable() });
