// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/**
 * Test hooks (RB_TEST_NERDGRAPH_URL) are compiled in only when building with RB_TEST_HOOKS=1, which only the E2E test
 * does. The default build, the one that is published, refuses them.
 */
const testHooks = process.env['RB_TEST_HOOKS'] === '1';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
  // `@relic-bridge/core` and `@relic-bridge/storage` are bundled from source; the MCP SDK, zod and yaml stay runtime dependencies.
  alias: {
    '@relic-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    '@relic-bridge/storage': fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
  },
  define: { __RB_TEST_HOOKS__: JSON.stringify(testHooks) },
});
