import { z } from 'zod';

/**
 * Client analytics allowlist (ARCHITECTURE 12.4, DESIGN 13.3). Only these events
 * and bounded categorical/numeric properties are sent. Never photos, image links,
 * entered text, email, invite codes or notes, measurements or precise location.
 * Server-side events (budget_mode_changed) are allowlisted in private.analytics_outbox.
 */
export const routeTemplates = [
  '/',
  '/auth',
  '/auth/check-email',
  '/auth/callback',
  '/privacy',
  '/invite',
  '/account-deleted',
  '/onboarding',
  '/wardrobe',
  '/wardrobe/gather',
  '/wardrobe/uploads/:id',
  '/more',
  '/admin',
  '/settings',
  '/settings/confirm',
  '/other',
] as const;
export type RouteTemplate = (typeof routeTemplates)[number];

/** Maps a concrete path to its template; IDs, query strings and fragments never leave the app. */
export function routeTemplate(pathname: string): RouteTemplate {
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (/^\/wardrobe\/uploads\/[^/]+$/.test(path)) return '/wardrobe/uploads/:id';
  return (routeTemplates as readonly string[]).includes(path) ? (path as RouteTemplate) : '/other';
}

const code = z.string().regex(/^[A-Z_]{3,40}$/);
const route = z.enum(routeTemplates);

export const AnalyticsEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('screen_viewed'), properties: z.object({ route }).strict() }).strict(),
  z.object({ event: z.literal('invite_redeemed'), properties: z.object({}).strict() }).strict(),
  z
    .object({ event: z.literal('upload_started'), properties: z.object({ files: z.number().int().min(1).max(20) }).strict() })
    .strict(),
  z
    .object({
      event: z.literal('upload_failed'),
      properties: z.object({ code, format: z.enum(['jpeg', 'png', 'webp', 'heic', 'heif', 'other']) }).strict(),
    })
    .strict(),
  z.object({ event: z.literal('client_error'), properties: z.object({ code, route }).strict() }).strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;
