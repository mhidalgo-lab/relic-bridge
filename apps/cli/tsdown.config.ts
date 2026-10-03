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
  // The workspace packages (core, auth, storage, storage-sqlite, http-app, admin-ui) are bundled from source; the MCP SDK, zod,
  // yaml and hono stay runtime dependencies.
  alias: {
    '@relic-bridge/admin-ui': fileURLToPath(new URL('../../packages/admin-ui/src/index.ts', import.meta.url)),
    '@relic-bridge/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
    '@relic-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    '@relic-bridge/http-app': fileURLToPath(new URL('../../packages/http-app/src/index.ts', import.meta.url)),
    '@relic-bridge/storage': fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
    '@relic-bridge/storage-sqlite': fileURLToPath(
      new URL('../../packages/storage-sqlite/src/index.ts', import.meta.url),
    ),
  },
  define: { __RB_TEST_HOOKS__: JSON.stringify(testHooks) },
});
