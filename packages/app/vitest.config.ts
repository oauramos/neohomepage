import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: unit tests do not need the React or Tailwind
// plugins, and loading them would make every test run pay for a CSS pipeline.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
