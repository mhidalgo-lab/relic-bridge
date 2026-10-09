// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

/** `pnpm test:live`: opt-in suite against real New Relic. Not part of `pnpm test` or public CI. */
export default defineConfig({
  test: {
    name: 'live',
    include: ['packages/core/test/live/**/*.live.ts'],
    testTimeout: 60_000,
    passWithNoTests: false,
  },
});
