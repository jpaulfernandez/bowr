// Exports the web SPA and writes a Vercel Build Output directory with the tested
// routes and headers. Usage: pnpm --filter @bowr/app export:web
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildOutputConfig } from './web-security.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
createRequire(import.meta.url)('@expo/env').load(root);

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const mediaOrigin = process.env.EXPO_PUBLIC_MEDIA_ORIGIN;
if (!supabaseUrl || !mediaOrigin) throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_MEDIA_ORIGIN are required');

const result = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist', '--clear'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
if (result.status !== 0) process.exit(result.status ?? 1);

const output = join(root, '.vercel', 'output');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, 'dist'), join(output, 'static'), { recursive: true });
writeFileSync(join(output, 'config.json'), `${JSON.stringify(buildOutputConfig({ supabaseUrl, mediaOrigin }), null, 2)}\n`);
console.log('Wrote .vercel/output (static + config.json)');
