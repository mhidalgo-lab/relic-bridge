// SPDX-License-Identifier: Apache-2.0
// The OAuth token lifecycle suite (P5-05) on the Node SQLite adapter `relic-bridge serve` uses: refresh single use and
// reuse detection under concurrency on a real SQLite database (memory here, D1 under the Workers pool).
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { httpAppHost, useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';
import { oauthLifecycleSuite } from '../../../packages/http-app/test/authz/oauth-lifecycle-suite.ts';

useAuthzHost({
  ...httpAppHost,
  prepare: async () => ({ storage: await openSqliteStorage({ path: ':memory:' }) }),
});

oauthLifecycleSuite();
