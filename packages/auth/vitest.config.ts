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
  test: {
    name: 'auth',
    // Config-transfer tests derive keys with the production PBKDF2 cost (600 000 iterations, ~0.25 s on a dev machine,
    // several seconds on a starved CI runner), so the 5 s default is too tight under load (P8-29).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
