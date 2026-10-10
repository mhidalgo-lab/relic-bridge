// SPDX-License-Identifier: Apache-2.0
// The OAuth integration suite (P5-01) on the Node SQLite adapter `relic-bridge serve` uses: the provider's state in
// the `kv` table of a real SQLite database (the http-app project runs it on memory storage, the Worker on D1). Lives
// here because this project has `@relic-bridge/storage-sqlite`.
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { httpAppHost, useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';
import { oauthSuite } from '../../../packages/http-app/test/authz/oauth-suite.ts';

useAuthzHost({
  ...httpAppHost,
  prepare: async () => ({ storage: await openSqliteStorage({ path: ':memory:' }) }),
});

oauthSuite();
