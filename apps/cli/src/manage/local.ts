// SPDX-License-Identifier: Apache-2.0
// Local mode: the Admin API runs in-process against the SQLite database, so the CLI gets exactly the validation,
// rule refusals, masking and audit of the remote API without any network or admin token. Every change is recorded
// with `via: cli` and the OS user (the request never leaves this process).
import { existsSync } from 'node:fs';
import {
  CryptoError,
  type Keyring,
  loadKeyringFromEnv,
  nerdGraphKeyValidator,
  verifyKeyChecks,
} from '@relic-bridge/auth';
import {
  createBuiltinTools,
  type FetchLike,
  type Logger,
  newRequestId,
  systemClock,
} from '@relic-bridge/core';
import { ADMIN_API_BASE, createAdminApi, createAuditRecorder } from '@relic-bridge/http-app';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { Hono } from 'hono';
import { ConfigError } from '../config.ts';
import { resolveMasterKeyEnv } from '../keys.ts';
import { resolveDbPath } from '../serve.ts';
import { type AdminClient, buildPath } from './client.ts';
import type { ManageContext } from './io.ts';

export interface LocalOptions {
  readonly ctx: ManageContext;
  readonly logger: Logger;
  /** `--db` */
  readonly db?: string;
  /** Needs the master key (credential add / rotate / revalidate); read-only commands run without it. */
  readonly needsKey: boolean;
  /** Create the database when missing (`init`). */
  readonly create?: boolean;
  /** NerdGraph fetch override (test hook). */
  readonly nerdGraphFetch?: FetchLike;
}

/** A keyring stand-in for commands that never decrypt: any use fails with a clear message. */
function absentKeyring(): Keyring {
  const refuse = (): never => {
    throw new ConfigError('This command needs the master key.', 'Set RB_MASTER_KEY or RB_MASTER_KEY_FILE.');
  };
  return new Proxy({} as Keyring, { get: () => refuse });
}

export async function openLocalClient(options: LocalOptions): Promise<AdminClient> {
  const { ctx, logger } = options;
  const dbPath = resolveDbPath(options.db, ctx.env, ctx.platform, ctx.homeDir);
  if (options.create !== true && !existsSync(dbPath)) {
    throw new ConfigError(
      `Database not found: ${dbPath}.`,
      'Run `relic-bridge init`, or pass --db <path> / set RB_DB_PATH.',
    );
  }
  let keyring: Keyring;
  if (options.needsKey) {
    try {
      keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(ctx.env, ctx.fs, ctx.platform));
    } catch (error) {
      if (error instanceof CryptoError) {
        throw new ConfigError(
          error.message,
          'Set RB_MASTER_KEY or RB_MASTER_KEY_FILE (see `relic-bridge keys generate`).',
        );
      }
      throw error;
    }
  } else {
    keyring = absentKeyring();
  }
  const storage = await openSqliteStorage({ path: dbPath });
  try {
    // A wrong master key must fail here, before anything is encrypted with it.
    if (options.needsKey) await verifyKeyChecks(storage, keyring);
  } catch (error) {
    await storage.close();
    throw error;
  }

  const recorder = createAuditRecorder({ storage, logger });
  const user = ctx.host.userName();
  const pending: Promise<unknown>[] = [];
  // Random per process; it exists only to satisfy the API's bearer check on an in-memory call.
  const secret = `${newRequestId()}${newRequestId()}${newRequestId()}`;
  const admin = createAdminApi({
    storage,
    keyring,
    verifier: { verify: (presented) => Promise.resolve(presented === secret) },
    validateKey: nerdGraphKeyValidator({
      logger,
      ...(options.nerdGraphFetch === undefined ? {} : { fetch: options.nerdGraphFetch }),
    }),
    catalog: createBuiltinTools().map((t) => t.name),
    clock: systemClock,
    logger,
    maxBodyBytes: 64 * 1024,
    // Role changes and disables end the user's admin sessions here too (P4-02).
    sessionKv: storage.kv,
    audit: (event) =>
      recorder.admin({ ...event, details: { ...(event.details ?? {}), via: 'cli', cliUser: user } }),
    runInBackground: (_c, task) => {
      pending.push(task.catch(() => undefined));
    },
  });
  const app = new Hono<{ Variables: { requestId: string; started: number; log: Record<string, unknown> } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', newRequestId());
    c.set('started', systemClock.now());
    c.set('log', {});
    await next();
  });
  app.route(ADMIN_API_BASE, admin);

  return {
    mode: 'local',
    baseUrl: null,
    async call(method, path, opts) {
      const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
      const init: RequestInit = { method, headers };
      if (opts?.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const res = await app.request(`${ADMIN_API_BASE}${buildPath(path, opts?.query)}`, init);
      const text = await res.text();
      // Audit rows are written after the response; wait so a short-lived CLI never exits before them.
      await Promise.all(pending.splice(0));
      return {
        status: res.status,
        body: res.status === 204 || text === '' ? null : (JSON.parse(text) as unknown),
      };
    },
    close: () => storage.close(),
  };
}
