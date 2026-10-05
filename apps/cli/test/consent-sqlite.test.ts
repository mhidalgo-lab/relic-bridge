// SPDX-License-Identifier: Apache-2.0
// The OAuth consent screen suite (P5-04) on the Node SQLite adapter `relic-bridge serve` uses.
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { consentSuite } from '../../../packages/http-app/test/authz/consent-suite.ts';
import { httpAppHost, useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';

useAuthzHost({
  ...httpAppHost,
  prepare: async () => ({ storage: await openSqliteStorage({ path: ':memory:' }) }),
});

consentSuite();
