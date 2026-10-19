import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**']
  }
})
