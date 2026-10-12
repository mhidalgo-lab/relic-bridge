// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineProject({
  resolve: {
    alias: {
      '@relic-bridge/storage/testing': src('../storage/src/testing.ts'),
      '@relic-bridge/storage': src('../storage/src/index.ts'),
    },
  },
  test: {
    name: 'storage-sqlite',
    // The contract suites open real files and run synchronous node:sqlite calls on the test thread; on a loaded
    // Windows runner (antivirus scans, 2 cores) a single test was observed at 9.5 s against the 5 s default (P8-29).
    // The local run of the whole file takes seconds, so this only absorbs slow CI hosts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
