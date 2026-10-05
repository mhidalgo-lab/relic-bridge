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
      // The OAuth provider imports `WorkerEntrypoint` for `instanceof` checks only (ADR-0009).
      'cloudflare:workers': src('./src/oauth/cloudflare-workers-shim.ts'),
    },
  },
  test: {
    name: 'http-app',
    // Transformed by Vite (not loaded by Node) so the `cloudflare:workers` alias applies inside it.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
