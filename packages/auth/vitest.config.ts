// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineProject({
  resolve: {
    alias: {
      '@relic-bridge/core': src('../core/src/index.ts'),
      '@relic-bridge/storage/testing': src('../storage/src/testing.ts'),
      '@relic-bridge/storage': src('../storage/src/index.ts'),
    },
  },
  test: { name: 'auth' },
});
