// SPDX-License-Identifier: Apache-2.0
// The OAuth clients suite (P5-08) on the Node SQLite adapter `relic-bridge serve` uses.
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { httpAppHost, useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';
import { oauthClientsSuite } from '../../../packages/http-app/test/authz/oauth-clients-suite.ts';

useAuthzHost({
  ...httpAppHost,
  prepare: async () => ({ storage: await openSqliteStorage({ path: ':memory:' }) }),
});

oauthClientsSuite();
