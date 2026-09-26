import { describe, expect, it } from 'vitest';
import { AnalyticsEvent, routeTemplate } from './analytics';

describe('routeTemplate', () => {
  it('replaces IDs and drops query strings and fragments', () => {
    expect(routeTemplate('/wardrobe/uploads/5f0c7f1e-8a61-4f0a-9d9b-2b0f5d5c1a11')).toBe('/wardrobe/uploads/:id');
    expect(routeTemplate('/auth/callback?code=secret#x')).toBe('/auth/callback');
    expect(routeTemplate('/settings/')).toBe('/settings');
    expect(routeTemplate('/invite/ABCD-EFGH')).toBe('/other');
  });
});

describe('AnalyticsEvent', () => {
  it('accepts only allowlisted events with bounded properties', () => {
    expect(AnalyticsEvent.safeParse({ event: 'upload_started', properties: { files: 3 } }).success).toBe(true);
    expect(AnalyticsEvent.safeParse({ event: 'item_photo', properties: {} }).success).toBe(false);
  });

  it('rejects free text, emails, URLs and extra fields', () => {
    const rejected = [
      { event: 'invite_redeemed', properties: { code: 'ABCD-EFGH' } },
      { event: 'client_error', properties: { code: 'Cannot read x of undefined', route: '/' } },
      { event: 'client_error', properties: { code: 'UNEXPECTED', route: '/wardrobe/uploads/123' } },
      { event: 'upload_failed', properties: { code: 'NETWORK', format: 'png', name: 'me@example.test.png' } },
      { event: 'screen_viewed', properties: { route: '/', $current_url: 'https://bowr.app/?code=1' } },
    ];
    for (const event of rejected) expect(AnalyticsEvent.safeParse(event).success).toBe(false);
  });
});
