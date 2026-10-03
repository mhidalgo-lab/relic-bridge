// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts'],
    coverage: {
      provider: 'v8',
      // Enforced with `pnpm test:coverage` (CI). The runtime-agnostic core carries the logic and the safety rules.
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/**/index.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
