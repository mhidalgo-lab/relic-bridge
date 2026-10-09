// SPDX-License-Identifier: Apache-2.0
// `relic-bridge init`: first-run wizard for a local instance. Creates the master key (a 0600 file) unless one is
// configured, the database, and optionally a first credential, project, service grant and device token. On a terminal
// it asks for what is missing; without one, flags drive it and anything not given is skipped (add it later with the
// individual commands).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateMasterKey, MASTER_KEY_ENV } from '@relic-bridge/auth';
import type { Logger } from '@relic-bridge/core';
import { UsageError } from '../args.ts';
import { ConfigError } from '../config.ts';
import { resolveMasterKeyEnv } from '../keys.ts';
import { defaultConfigDir, resolveDbPath } from '../serve.ts';
import { nerdGraphFetch } from '../test-hooks.ts';
import { intList, intOption, type ManageArgs } from './args.ts';
import { api } from './client.ts';
import { issueToken, type Run, rec, str } from './commands.ts';
import type { ManageContext } from './io.ts';
import { openLocalClient } from './local.ts';
import { plain } from './render.ts';
import { readNewRelicKey } from './secrets.ts';

export async function initCommand(ctx: ManageContext, args: ManageArgs, logger: Logger): Promise<number> {
  const { values } = args;
  const json = values.json === true;
  // RB_REMOTE is ignored by init on purpose: it creates local state.
  if (values.remote !== undefined)
    throw new UsageError('init sets up a local database; it does not take --remote.');
  const tty = ctx.host.stdinIsTTY;
  const ask = async (q: string, fallback?: string): Promise<string | undefined> =>
    tty ? await ctx.host.prompt(q, fallback) : undefined;
  const note = (line: string): void => {
    if (!json) ctx.stderr(line);
  };

  const dbPath = resolveDbPath(values.db, ctx.env, ctx.platform, ctx.homeDir);
  const report: Record<string, unknown> = { database: dbPath };

  // 1. Master key.
  let env = ctx.env;
  const existing = resolveMasterKeyEnv(ctx.env, ctx.fs, ctx.platform, ctx.keychain);
  if (existing[MASTER_KEY_ENV] === undefined) {
    if (existsSync(dbPath)) {
      throw new ConfigError(
        `The database ${dbPath} already exists but no master key is configured.`,
        'Set RB_MASTER_KEY or RB_MASTER_KEY_FILE to the key it was created with; a new key could not read its credentials.',
      );
    }
    // Never next to the database by default (THREAT_MODEL T7): a copy or backup of the data directory must not
    // carry the key that decrypts it.
    const configDir = defaultConfigDir(ctx.env, ctx.platform, ctx.homeDir);
    const keyPath =
      values['master-key-file'] ?? (configDir === null ? undefined : join(configDir, 'master.key'));
    if (keyPath === undefined) {
      throw new ConfigError(
        'No place for the master key file.',
        'Pass --master-key-file <path> outside the data directory, or set RB_MASTER_KEY_FILE to an existing key.',
      );
    }
    if (resolve(dirname(keyPath)) === resolve(dirname(dbPath))) {
      throw new ConfigError(
        `The master key file ${keyPath} would sit next to the database it protects.`,
        'Choose a --master-key-file outside the data directory: anyone with a copy of both can read every stored New Relic key.',
      );
    }
    const key = generateMasterKey(1);
    try {
      ctx.host.writeSecretFile(keyPath, `${key}\n`);
    } catch {
      throw new ConfigError(
        `Could not create ${keyPath} (it may already exist).`,
        'To reuse an existing key set RB_MASTER_KEY_FILE; to create a new one use --master-key-file <new path>.',
      );
    }
    env = { ...ctx.env, [MASTER_KEY_ENV]: key };
    report['masterKeyFile'] = keyPath;
    note(
      `Master key created: ${keyPath} (mode 0600). Back it up now: without it the stored New Relic keys cannot be ` +
        `decrypted. Start the server with RB_MASTER_KEY_FILE=${keyPath}.`,
    );
  } else {
    note('Using the master key from RB_MASTER_KEY / RB_MASTER_KEY_FILE.');
  }

  // 2. Database.
  const nrFetch = ctx.host.nerdGraphFetch ?? nerdGraphFetch(ctx.env, logger);
  const localCtx: ManageContext = { ...ctx, env };
  const client = await openLocalClient({
    ctx: localCtx,
    logger,
    ...(values.db === undefined ? {} : { db: values.db }),
    needsKey: true,
    create: true,
    ...(nrFetch === undefined ? {} : { nerdGraphFetch: nrFetch }),
  });
  try {
    note(`Database ready: ${dbPath}`);
    const run: Run = { ctx: localCtx, args, client, json };

    // 3. First credential.
    let credential: Record<string, unknown> | undefined;
    const label = values.label ?? (await ask('Label for the first New Relic key', 'main'));
    if (label !== undefined) {
      const region = (values.region ?? (await ask('Region (US, EU or JP)', 'US')) ?? 'US').toUpperCase();
      const apiKey = await readNewRelicKey(localCtx, values);
      const res = rec(await api(client, 'POST', '/credentials', { body: { label, region, apiKey } }));
      credential = rec(res['data']);
      report['credential'] = credential;
      note(`Credential ${plain(credential['id'])} added (${plain(credential['validationStatus'])}).`);
    } else {
      note('No credential yet: run `relic-bridge credential add --label <name> --region US` (key on stdin).');
    }

    // 4. First project (needs an account id) and a service grant.
    let project: Record<string, unknown> | undefined;
    let grant: Record<string, unknown> | undefined;
    if (credential !== undefined) {
      const reachable = Array.isArray(credential['reachableAccountIds'])
        ? (credential['reachableAccountIds'] as number[])
        : [];
      const slug = values.slug ?? (await ask('Project slug (the URL is /p/<slug>/mcp)', 'default'));
      if (slug !== undefined) {
        const fallback = reachable[0] === undefined ? undefined : String(reachable[0]);
        const raw = values['default-account'] ?? (await ask('Default account id', fallback)) ?? fallback;
        const def = intOption('default-account', raw, 1, Number.MAX_SAFE_INTEGER);
        if (def === undefined) {
          note(
            'No account id available: add the project with `relic-bridge project add --slug <s> --default-account <id>`.',
          );
        } else {
          const allowed = new Set([def, ...(intList('accounts', values.accounts) ?? [])]);
          const p = rec(
            await api(client, 'POST', '/projects', {
              body: {
                slug,
                defaultAccountId: def,
                allowedAccountIds: [...allowed],
                defaultCredentialId: credential['id'],
              },
            }),
          );
          project = rec(p['data']);
          report['project'] = project;
          note(`Project ${plain(project['slug'])} created.`);
          const g = rec(
            await api(client, 'POST', '/grants', {
              body: { projectId: project['id'], label: `${slug}-devices` },
            }),
          );
          grant = rec(g['data']);
          report['grant'] = grant;
        }
      }
    }

    // 5. First device token.
    if (grant !== undefined) {
      const device =
        values.device ?? (await ask('Name of the first device', 'first-device')) ?? 'first-device';
      if (json) {
        const res = rec(
          await api(client, 'POST', '/tokens', { body: { grantId: grant['id'], label: device } }),
        );
        report['token'] = res['token'];
        report['data'] = res['data'];
        report['mcpUrl'] =
          `${(values.url ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')}/p/${str(project?.['slug'])}/mcp`;
      } else {
        await issueToken(run, {
          grantId: str(grant['id']),
          label: device,
          ...(values.url === undefined ? {} : { url: values.url }),
          ...(values.client === undefined ? {} : { client: values.client }),
          noConfig: values['no-config'] === true,
        });
      }
    }
    if (json) ctx.stdout(`${JSON.stringify(report)}\n`);
    else
      note(
        'Next: start the server with `relic-bridge serve` (RB_MASTER_KEY_FILE set), then connect your client.',
      );
    return 0;
  } finally {
    await client.close();
  }
}
