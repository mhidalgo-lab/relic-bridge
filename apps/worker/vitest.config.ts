// SPDX-License-Identifier: Apache-2.0
// Worker tests run inside workerd (`@cloudflare/vitest-plugin`) with the bindings from `wrangler.jsonc` (local D1,
// KV and rate-limit simulators). Test secrets are generated per run, never committed.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          RB_MASTER_KEY: `v1:${randomBytes(32).toString('base64')}`,
          RB_ADMIN_TOKEN: randomBytes(24).toString('hex'),
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@relic-bridge/auth': src('../../packages/auth/src/index.ts'),
      '@relic-bridge/core': src('../../packages/core/src/index.ts'),
      '@relic-bridge/http-app': src('../../packages/http-app/src/index.ts'),
      // Subpaths first: an alias also matches `<name>/…`.
      '@relic-bridge/storage/d1': src('../../packages/storage/src/d1.ts'),
      '@relic-bridge/storage/testing': src('../../packages/storage/src/testing.ts'),
      '@relic-bridge/storage': src('../../packages/storage/src/index.ts'),
    },
  },
  // The first request into a fresh workerd module graph compiles the SDK and the app (seconds on a cold CI runner).
  test: { name: 'worker', testTimeout: 30_000 },
});
