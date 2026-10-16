// SPDX-License-Identifier: Apache-2.0
// CPU benchmark project (P3-10): the hot paths inside workerd (`@cloudflare/vitest-plugin`), local D1. Run through
// `pnpm bench:cpu` (scripts/bench-cpu.ts), which reads the results from the JSON reporter and compares them with
// `bench/baseline.json`. Not part of `pnpm test` or the root project list (the root picks up `vitest.config.ts` only).
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
          // The per-token limit (120/min) would refuse a benchmark loop; the limiter's cost is a binding call (I/O).
          RB_RATE_LIMIT: 'off',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@relic-bridge/admin-ui': src('../../packages/admin-ui/src/index.ts'),
      '@relic-bridge/auth': src('../../packages/auth/src/index.ts'),
      '@relic-bridge/core': src('../../packages/core/src/index.ts'),
      '@relic-bridge/http-app': src('../../packages/http-app/src/index.ts'),
      '@relic-bridge/storage/d1': src('../../packages/storage/src/d1.ts'),
      '@relic-bridge/storage/testing': src('../../packages/storage/src/testing.ts'),
      '@relic-bridge/storage': src('../../packages/storage/src/index.ts'),
    },
  },
  test: {
    name: 'worker-bench',
    // vitest 5 persists transforms to node_modules/.vitest-cache, which workerd cannot read from inside the isolate.
    fsModuleCache: false,
    include: ['bench/**/*.bench.ts'],
    testTimeout: 120_000,
    // One file, scenarios in order, nothing else running in the same isolate.
    fileParallelism: false,
  },
});
