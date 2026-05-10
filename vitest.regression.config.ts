import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/regression/**/*.test.ts'],
    // 4 cases × ~60s each (case + setup) + headroom. Per-case timeout is set
    // on each `it()` block (120s).
    testTimeout: 600_000,
    hookTimeout: 30_000,
    environment: 'node',
  },
});
