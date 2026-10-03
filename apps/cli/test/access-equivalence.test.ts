// SPDX-License-Identifier: Apache-2.0
// P3-09 equivalence on the Node SQLite adapter: the one-call access path decides exactly like the repository path.
// Lives here because this project has both `@relic-bridge/auth` and `@relic-bridge/storage-sqlite`.
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { describe } from 'vitest';
import { runAccessEquivalence } from '../../../packages/auth/test/access-equivalence.ts';

describe('access resolution equivalence (sqlite)', () => {
  runAccessEquivalence({
    name: 'sqlite',
    open: () => openSqliteStorage({ path: ':memory:' }),
    runs: 150,
  });
});
