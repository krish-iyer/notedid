import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BROWSER_APP__: 'false' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
