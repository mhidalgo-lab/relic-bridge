// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/d1.ts', 'src/schema.ts', 'src/testing.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  external: ['vitest'],
});
