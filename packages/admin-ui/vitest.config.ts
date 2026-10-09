// SPDX-License-Identifier: Apache-2.0
import { defineProject } from 'vitest/config';

export default defineProject({
  // axe-core runs a whole browser-like rule engine per page; under a loaded full run (or slow CI) 5 s is not enough.
  test: { name: 'admin-ui', testTimeout: 30_000 },
});
