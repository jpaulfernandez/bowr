// Fails when the exported web bundle contains source maps, server secrets or
// non-anonymous JWTs. Usage: pnpm --filter @bowr/app check:web
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '.vercel', 'output', 'static');
const failures = [];

const forbidden = [
  [/sb_secret_[A-Za-z0-9_-]{8,}/, 'Supabase secret key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY/, 'service-role variable name'],
  [/INVITE_HMAC_SECRET|WORKER_CAPABILITY_SECRET|MAINTENANCE_SECRET/, 'server secret variable name'],
  [/GEMINI_API_KEY|R2_SECRET_ACCESS_KEY|MODAL_TOKEN/, 'provider secret variable name'],
  [/HEALTH_CHECK_TOKEN|BACKUP_ENCRYPTION_KEY|POSTHOG_API_KEY/, 'operations secret variable name'],
  [/phx_[A-Za-z0-9]{8,}/, 'PostHog personal API key'],
  [/sourceMappingURL=/, 'source map reference'],
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else inspect(path);
  }
}

function inspect(path) {
  const name = relative(dist, path);
  if (name.endsWith('.map')) failures.push(`${name}: source map file`);
  if (!/\.(js|css|html|json|webmanifest)$/.test(name)) return;
  const text = readFileSync(path, 'utf8');
  for (const [pattern, label] of forbidden) if (pattern.test(text)) failures.push(`${name}: ${label}`);
  for (const token of text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (payload.role !== 'anon') failures.push(`${name}: JWT with role ${payload.role ?? 'unknown'}`);
    } catch {
      failures.push(`${name}: undecodable JWT-like value`);
    }
  }
}

walk(dist);
if (failures.length > 0) {
  console.error(`Web bundle inspection failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Web bundle inspection passed (${relative(process.cwd(), dist)}).`);
