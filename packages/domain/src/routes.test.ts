import { describe, expect, it } from 'vitest';
import { decideRoute, safeReturnTo, type Gate } from './routes';

const anonymous: Gate = { kind: 'anonymous' };
const pending: Gate = { kind: 'signed-in', state: 'pending', role: null };
const suspended: Gate = { kind: 'signed-in', state: 'suspended', role: null };
const member: Gate = { kind: 'signed-in', state: 'active', role: 'member' };

describe('decideRoute', () => {
  it('sends a member opening / to Bower', () => {
    expect(decideRoute('/', member)).toEqual({ type: 'redirect', to: '/wardrobe' });
  });

  it('sends pending, suspended and deleting identities to the gate', () => {
    for (const gate of [pending, suspended, { kind: 'signed-in', state: 'deleting', role: null } as Gate]) {
      expect(decideRoute('/', gate)).toEqual({ type: 'redirect', to: '/invite' });
      expect(decideRoute('/settings', gate)).toEqual({ type: 'redirect', to: '/invite' });
      expect(decideRoute('/invite', gate)).toEqual({ type: 'allow' });
    }
  });

  it('keeps an anonymous visitor destination through sign-in', () => {
    expect(decideRoute('/settings', anonymous)).toEqual({ type: 'redirect', to: '/auth?returnTo=%2Fsettings' });
    expect(decideRoute('/invite', anonymous)).toEqual({ type: 'redirect', to: '/auth' });
  });

  it('keeps privacy and the auth callback reachable for everyone', () => {
    for (const gate of [anonymous, pending, member]) {
      expect(decideRoute('/privacy', gate)).toEqual({ type: 'allow' });
      expect(decideRoute('/auth/callback', gate)).toEqual({ type: 'allow' });
    }
  });

  it('moves admitted members away from public and gate screens', () => {
    expect(decideRoute('/auth', member)).toEqual({ type: 'redirect', to: '/wardrobe' });
    expect(decideRoute('/invite', member)).toEqual({ type: 'redirect', to: '/wardrobe' });
    expect(decideRoute('/wardrobe/items/abc', member)).toEqual({ type: 'allow' });
  });
});

describe('safeReturnTo', () => {
  it('accepts member destinations', () => {
    expect(safeReturnTo('/settings')).toBe('/settings');
    expect(safeReturnTo('/wardrobe/')).toBe('/wardrobe');
  });

  it.each([
    'https://evil.example/settings',
    '//evil.example',
    '/\\evil.example',
    '/settings?next=https://evil.example',
    '/%2F%2Fevil.example',
    '/wardrobe/../../evil',
    'javascript:alert(1)',
    '/auth',
    '/invite',
    '/',
    '',
    null,
    42,
  ])('rejects %s', (value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});
