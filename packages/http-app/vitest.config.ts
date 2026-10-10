// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineProject({
  resolve: {
    alias: {
      '@relic-bridge/admin-ui': src('../admin-ui/src/index.ts'),
      '@relic-bridge/auth': src('../auth/src/index.ts'),
      '@relic-bridge/core': src('../core/src/index.ts'),
      '@relic-bridge/storage': src('../storage/src/index.ts'),
    },
  },
  test: { name: 'http-app' },
});
