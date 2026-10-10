// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@relic-bridge/admin-ui': fileURLToPath(
        new URL('../../packages/admin-ui/src/index.ts', import.meta.url),
      ),
      '@relic-bridge/auth': fileURLToPath(new URL('../../packages/auth/src/index.ts', import.meta.url)),
      '@relic-bridge/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@relic-bridge/http-app': fileURLToPath(
        new URL('../../packages/http-app/src/index.ts', import.meta.url),
      ),
      '@relic-bridge/storage': fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
      '@relic-bridge/storage-sqlite': fileURLToPath(
        new URL('../../packages/storage-sqlite/src/index.ts', import.meta.url),
      ),
      // The OAuth provider imports `WorkerEntrypoint` for `instanceof` checks only (ADR-0009).
      'cloudflare:workers': fileURLToPath(
        new URL('../../packages/http-app/src/oauth/cloudflare-workers-shim.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'cli',
    // Transformed by Vite (not loaded by Node) so the `cloudflare:workers` alias applies inside it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
