import type { EntryState } from '@bowr/contracts';
import type { LocalUpload } from './upload-manager';

const failures: Record<string, string> = {
  UNSUPPORTED_MEDIA: "This file isn't a supported photo. Choose a JPEG, PNG or WebP photo.",
  MEDIA_TYPE_MISMATCH: "This file's contents don't match its type. Save it again as JPEG or PNG.",
  FILE_TOO_LARGE: 'This photo is over 20 MB. Choose a smaller photo.',
  TOO_MANY_PIXELS: 'This photo is over 40 megapixels. Choose a smaller photo.',
  CORRUPT_IMAGE: "This photo couldn't be read. It may be damaged.",
  ANIMATED_IMAGE: "Animated images aren't supported. Choose a still photo.",
  SOURCE_MISSING: "The upload didn't arrive. Choose the photo again.",
  PROCESSING_FAILED: "bowr couldn't finish checking this photo. Your upload is saved; try again.",
};

export const failureMessage = (code: string | null) =>
  (code && failures[code]) ?? "This photo couldn't be used. Choose another photo.";

/** One truthful status line per entry; upload success is not reported as ready. */
export function entryStatus(state: EntryState, local: LocalUpload | undefined, failureCode: string | null): string {
  if (state === 'awaiting_upload') {
    if (!local) return 'Not uploaded. Choose this photo again.';
    if (local.status === 'failed') return 'Upload failed. Your other photos are unaffected.';
    if (local.status === 'uploading') return `Uploading · ${Math.round(local.progress * 100)}%`;
    if (local.status === 'completing') return 'Uploaded · confirming';
    return 'Waiting to upload';
  }
  if (state === 'uploaded' || state === 'validating') return 'Uploaded · checking photo';
  if (state === 'ready') return 'Ready';
  if (state === 'canceled') return 'Canceled';
  if (state === 'failed') return failureMessage(failureCode);
  return failureMessage(failureCode);
}
