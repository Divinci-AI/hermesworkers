import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Worker safety limits (mirrors the monorepo convention): keep the pool
    // small so CI runners don't thrash.
    isolate: true,
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: false, maxThreads: 2, minThreads: 1 },
    },
  },
});
