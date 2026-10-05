// SPDX-License-Identifier: Apache-2.0
// P4-16 first-sign-in race on the Node SQLite adapter: one connection, and two connections to one database file (two
// `serve` processes, or `serve` and the CLI). Lives here because this project has both `@relic-bridge/auth` and
// `@relic-bridge/storage-sqlite`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { describe } from 'vitest';
import { runLoginRace } from '../../../packages/auth/test/login-race.ts';

describe('first sign-in race (sqlite)', () => {
  runLoginRace({
    name: 'sqlite, one connection',
    open: async () => {
      const s = await openSqliteStorage({ path: ':memory:' });
      return { a: s, b: s, close: () => s.close() };
    },
  });
  runLoginRace({
    name: 'sqlite file, two connections',
    open: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rb-login-race-'));
      const path = join(dir, 'race.db');
      const a = await openSqliteStorage({ path });
      const b = await openSqliteStorage({ path });
      return {
        a,
        b,
        close: async () => {
          await a.close();
          await b.close();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  });
});
