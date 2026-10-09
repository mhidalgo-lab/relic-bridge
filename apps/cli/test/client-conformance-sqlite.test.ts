// SPDX-License-Identifier: Apache-2.0
// The client conformance suite (P5-06) on the Node SQLite adapter `relic-bridge serve` uses.
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { clientConformanceSuite } from '../../../packages/http-app/test/authz/client-conformance-suite.ts';
import { httpAppHost, useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';

useAuthzHost({
  ...httpAppHost,
  prepare: async () => ({ storage: await openSqliteStorage({ path: ':memory:' }) }),
});

clientConformanceSuite();
