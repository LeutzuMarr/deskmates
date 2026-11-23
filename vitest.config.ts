import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts', 'tests/preview/**/*.test.ts', 'tests/bridge/**/*.test.ts', 'tests/bots/**/*.test.ts', 'tests/notes/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks'
  }
})
