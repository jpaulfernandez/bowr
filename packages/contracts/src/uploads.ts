import { z } from 'zod';

export const UploadLimits = z.object({
  max_bytes: z.number().int().positive(),
  max_pixels: z.number().int().positive(),
  max_files_per_batch: z.number().int().positive(),
  concurrent_uploads: z.number().int().positive(),
  formats: z.array(z.string()),
});
export type UploadLimits = z.infer<typeof UploadLimits>;

export const EntryState = z.enum(['awaiting_upload', 'uploaded', 'validating', 'ready', 'rejected', 'failed', 'canceled']);
export type EntryState = z.infer<typeof EntryState>;

export const SignedUpload = z.object({
  method: z.literal('PUT'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expires_at: z.string(),
});
export type SignedUpload = z.infer<typeof SignedUpload>;

export const UploadSlot = z.object({
  entry_id: z.string().uuid(),
  client_file_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  state: EntryState,
  upload: SignedUpload.nullable(),
});
export type UploadSlot = z.infer<typeof UploadSlot>;

export const UploadBatchCreated = z.object({ batch_id: z.string().uuid(), entries: z.array(UploadSlot) });

export const RenewedUpload = z.object({ entry_id: z.string().uuid(), upload: SignedUpload });

export const CompletedEntry = z.object({
  entry_id: z.string().uuid(),
  state: EntryState,
  job_id: z.string().uuid().nullable(),
  failure_code: z.string().nullable(),
});

export const MediaGrant = z.discriminatedUnion('status', [
  z.object({
    asset_id: z.string().uuid(),
    variant: z.string(),
    status: z.literal('ok'),
    url: z.string().url(),
    expires_at: z.string(),
    width: z.number().int(),
    height: z.number().int(),
  }),
  z.object({ asset_id: z.string().nullable(), variant: z.string(), status: z.literal('not_found') }),
]);
export type MediaGrant = z.infer<typeof MediaGrant>;
export const MediaGrants = z.array(MediaGrant);
