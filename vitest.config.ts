import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/test-log-capture.ts'],
    testTimeout: 10000
  },
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: ['src/**/types.ts', 'src/index.ts'],
    reporter: ['text', 'json-summary', 'html']
  }
});
