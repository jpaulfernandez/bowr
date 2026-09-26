import { defineConfig, devices } from '@playwright/test';

// Runs against the exported web bundle served with production routes/headers and
// the local Supabase stack. Build first: pnpm --filter @bowr/app export:web
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'node apps/app/scripts/serve-web.mjs 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@phone/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
  ],
});
