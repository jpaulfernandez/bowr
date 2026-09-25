/**
 * Route access rules (DESIGN section 4.3, ARCHITECTURE section 4.1).
 * The server enforces authorization; these rules only choose which layout a
 * signed-in identity may render and where a redirect may land.
 */
export type MembershipState = 'pending' | 'active' | 'suspended' | 'deleting';
export type MembershipRole = 'owner' | 'member';

export type Gate =
  | { kind: 'anonymous' }
  | { kind: 'signed-in'; state: MembershipState; role: MembershipRole | null };

export type RouteDecision = { type: 'allow' } | { type: 'redirect'; to: string };

export const HOME_ROUTE = '/wardrobe';
export const GATE_ROUTE = '/invite';
export const SIGN_IN_ROUTE = '/auth';

const alwaysAvailable = new Set(['/privacy', '/auth/callback']);
const publicRoutes = new Set(['/', '/auth', '/auth/check-email']);
const gateRoutes = new Set([GATE_ROUTE]);
/** Top-level member destinations. Nested paths inherit their prefix. */
const memberPrefixes = ['/wardrobe', '/more', '/settings', '/onboarding'];
const ownerPrefixes = ['/admin'];

function normalize(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '/';
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : '/';
}

function hasPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Returns an allowlisted in-app destination, or null. Only member and owner
 * route paths qualify; scheme, host, protocol-relative, backslash, encoded and
 * query-carrying values are rejected.
 */
export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  if (!/^\/[A-Za-z0-9/-]*$/.test(raw) || raw.startsWith('//') || raw.includes('/../')) return null;
  const path = normalize(raw);
  return hasPrefix(path, memberPrefixes) || hasPrefix(path, ownerPrefixes) ? path : null;
}

export function decideRoute(rawPath: string, gate: Gate): RouteDecision {
  const path = normalize(rawPath);
  if (alwaysAvailable.has(path)) return { type: 'allow' };

  if (gate.kind === 'anonymous') {
    if (publicRoutes.has(path)) return { type: 'allow' };
    const returnTo = safeReturnTo(path);
    return { type: 'redirect', to: returnTo ? `${SIGN_IN_ROUTE}?returnTo=${encodeURIComponent(returnTo)}` : SIGN_IN_ROUTE };
  }

  if (gate.state !== 'active') {
    return gateRoutes.has(path) ? { type: 'allow' } : { type: 'redirect', to: GATE_ROUTE };
  }

  if (hasPrefix(path, memberPrefixes)) return { type: 'allow' };
  if (hasPrefix(path, ownerPrefixes)) {
    return gate.role === 'owner' ? { type: 'allow' } : { type: 'redirect', to: HOME_ROUTE };
  }
  return { type: 'redirect', to: HOME_ROUTE };
}
