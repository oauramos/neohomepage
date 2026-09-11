import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests: only what needs a real layout engine (no-JS render, axe, keyboard-only editing);
 * everything else belongs in vitest. The server starts per run on a temporary data directory.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
})
