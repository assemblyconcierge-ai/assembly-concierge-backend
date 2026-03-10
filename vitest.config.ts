import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/fixtures/setup.ts'],
    testTimeout: 15_000,
    alias: {
      '@common': path.resolve(__dirname, 'src/common'),
      '@modules': path.resolve(__dirname, 'src/modules'),
      '@db': path.resolve(__dirname, 'src/db'),
    },
  },
});
