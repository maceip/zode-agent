import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{ts,tsx}',
      'program/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./tests/vitest.setup.ts'],
    testTimeout: 15_000,
  },
})
