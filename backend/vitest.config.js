import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false, // integration tests share one real Redis
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.js'],
    pool: 'forks',
  },
});
