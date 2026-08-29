import { defineConfig } from 'vitest/config'

/**
 * The integration suite is excluded from the default run because it needs the
 * Docker SSH server. CI runs it separately; see .github/workflows/ci.yml.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
