// Single source for the deployed web routes and security headers. The export
// script writes them to the Vercel Build Output config; the local server applies
// the same config, so E2E tests exercise the headers that are deployed.

/** @param {{ supabaseUrl: string }} options */
export function securityHeaders({ supabaseUrl }) {
  const api = new URL(supabaseUrl).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // react-native-web injects its generated styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${api}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}

/** Vercel Build Output API v3 routes: headers, static files, SPA deep-link fallback. */
export function buildOutputConfig(options) {
  return {
    version: 3,
    routes: [
      { src: '/(.*)', headers: { ...securityHeaders(options), 'Cache-Control': 'no-cache' }, continue: true },
      { src: '/_expo/static/(.*)', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
      { handle: 'filesystem' },
      // Missing build assets are real 404s, not the app shell.
      { src: '/(_expo|assets)/(.*)', status: 404 },
      // Private routes such as /settings are rendered by the client from one index.html.
      { src: '/(.*)', dest: '/index.html' },
    ],
  };
}
