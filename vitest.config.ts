import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/client/assets.d.ts', 'src/invariant.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
      },
    },
  },
})
