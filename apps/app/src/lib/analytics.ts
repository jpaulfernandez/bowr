// Usage analytics through PostHog's capture API with explicit payloads only. No
// SDK runs in the page, so there is no autocapture, session recording or automatic
// URL capture to switch off. Events are validated against the allowlist and sent
// fire-and-forget: an analytics outage never blocks or fails a user action.
import { AnalyticsEvent, routeTemplate } from '@bowr/contracts';
import { ApiError } from './errors';

const host = process.env.EXPO_PUBLIC_POSTHOG_HOST?.replace(/\/$/, '');
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;

const anonymousId = () => `anon-${crypto.randomUUID()}`;
let distinctId = anonymousId();

/** The internal user ID while signed in (never email); a new random ID after sign-out. */
export function identifyAnalytics(userId: string | null): void {
  distinctId = userId ?? anonymousId();
}

export function track(event: AnalyticsEvent): void {
  if (!host || !apiKey) return;
  const parsed = AnalyticsEvent.safeParse(event);
  if (!parsed.success) return;
  fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      event: parsed.data.event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: { ...parsed.data.properties, $process_person_profile: false },
    }),
  }).catch(() => {});
}

/** Reports uncaught browser errors as a safe code and route template; never messages or stacks. */
export function installErrorReporting(): () => void {
  if (typeof window === 'undefined' || !window.addEventListener) return () => {};
  const report = (error: unknown) =>
    track({
      event: 'client_error',
      properties: { code: error instanceof ApiError ? error.code : 'UNEXPECTED', route: routeTemplate(window.location.pathname) },
    });
  const onError = (event: ErrorEvent) => report(event.error);
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
