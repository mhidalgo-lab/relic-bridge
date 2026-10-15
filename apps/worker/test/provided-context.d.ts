// SPDX-License-Identifier: Apache-2.0
// Values the Node global setup hands to the workerd tests (`inject`). Kept out of test/node, whose tsconfig checks the
// setup on its own.
import type { D1ImportFixture } from './node/d1-import-fixture.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    d1Import: D1ImportFixture;
  }
}
