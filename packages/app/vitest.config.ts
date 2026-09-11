import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so unit tests skip the React and Tailwind plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
