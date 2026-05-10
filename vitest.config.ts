import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    testTimeout: 5000,
    environment: 'node',
  },
});
