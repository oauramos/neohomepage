import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests, kept apart from the unit suite.
 *
 * These are the checks that cannot be made without a real layout engine: whether the board is
 * correct with JavaScript disabled, whether axe finds anything, and whether the whole edit session
 * can be driven from the keyboard. Everything else belongs in vitest, where it runs in
 * milliseconds.
 *
 * The server is started per run against a temporary data directory, so a test never touches the
 * developer's own dashboard.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI !== undefined ? 'list' : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:7599',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
})
