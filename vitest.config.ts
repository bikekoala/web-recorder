import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. Regression suite (real-browser) lives under
    // `tests/regression/` and runs via `vitest.regression.config.ts`.
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 5000,
    environment: 'node',
  },
});
