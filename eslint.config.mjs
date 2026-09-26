import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  expoConfig,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.vercel/**',
      '**/.expo/**',
      'supabase/functions/**',
      'services/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    settings: { 'import/resolver': { typescript: { project: ['apps/app/tsconfig.json', 'packages/*/tsconfig.json'] } } },
    rules: {
      'import/no-unresolved': 'off',
      // Zod schemas and their inferred types intentionally share a name.
      '@typescript-eslint/no-redeclare': 'off',
      '@typescript-eslint/array-type': 'off',
    },
  },
  {
    files: ['**/scripts/**/*.mjs', 'tests/**/*.ts', 'playwright.config.ts'],
    languageOptions: { globals: globals.node },
  },
]);
