// SPDX-License-Identifier: Apache-2.0
import {
  assertUserKey,
  createLogger,
  isRbError,
  type LogLevel,
  type LogSink,
  VERSION,
} from '@relic-bridge/core';
import { backupDatabase } from '@relic-bridge/storage-sqlite';
import { HELP_TEXT, isLogLevel, parseCliArgs, UsageError } from './args.ts';
import { ConfigError, type ConfigFs, type Env, loadConfig } from './config.ts';
import { keysGenerate, keysRotate } from './keys.ts';
import { serveProjectOverStdio } from './stdio.ts';
import { nerdGraphFetch } from './test-hooks.ts';

/** Everything `main` needs from the process, injected so it can be tested without spawning. */
export interface CliRuntime {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly platform: string;
  readonly homeDir?: string;
  readonly fs: ConfigFs;
  /** Only `help` and `version` write here. In stdio mode stdout is the MCP channel. */
  readonly stdout: (text: string) => void;
  readonly stderr: LogSink;
}

export type MainResult =
  | { readonly kind: 'exit'; readonly code: number }
  /** An async command (`keys rotate`); `done` resolves to its exit code. */
  | { readonly kind: 'pending'; readonly done: Promise<number> }
  | { readonly kind: 'serving'; readonly close: () => Promise<void> };

const exit = (code: number): MainResult => ({ kind: 'exit', code });

/** Run the CLI. Returns an exit code, or a handle when it is serving MCP over stdio. */
export function main(rt: CliRuntime): MainResult {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(rt.argv);
  } catch (error) {
    if (error instanceof UsageError) {
      rt.stderr(`relic-bridge: ${error.message}\n\n${HELP_TEXT}`);
      return exit(2);
    }
    throw error;
  }

  if (args.command === 'help') {
    rt.stdout(HELP_TEXT);
    return exit(0);
  }
  if (args.command === 'version') {
    rt.stdout(`${VERSION}\n`);
    return exit(0);
  }

  if (args.command === 'keys' && args.keysAction === 'generate') {
    return exit(keysGenerate(args.keyVersion ?? 1, rt.stdout, rt.stderr));
  }

  const envLevel = rt.env['RB_LOG_LEVEL']?.trim().toLowerCase();
  let level: LogLevel = 'info';
  if (args.logLevel) level = args.logLevel;
  else if (envLevel && isLogLevel(envLevel)) level = envLevel;
  const logger = createLogger({ level, sink: rt.stderr, fields: { app: 'relic-bridge' } });
  if (envLevel && !isLogLevel(envLevel)) {
    logger.warn('RB_LOG_LEVEL ignored: unknown level', { value: envLevel });
  }

  if (args.command === 'db' && args.file !== undefined) {
    const dbPath = (args.db ?? rt.env['RB_DB_PATH'] ?? '').trim();
    if (dbPath === '') {
      logger.error('no database given', { hint: 'pass --db <path> or set RB_DB_PATH' });
      return exit(2);
    }
    try {
      backupDatabase(dbPath, args.file);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : 'backup failed');
      return exit(1);
    }
    rt.stdout(`Backed up ${dbPath} to ${args.file}\n`);
    return exit(0);
  }

  if (args.command === 'keys' && args.keysAction === 'rotate') {
    const dbPath = (args.db ?? rt.env['RB_DB_PATH'] ?? '').trim();
    if (dbPath === '') {
      logger.error('no database given', { hint: 'pass --db <path> or set RB_DB_PATH' });
      return exit(2);
    }
    return {
      kind: 'pending',
      done: keysRotate({ dbPath, env: rt.env, fs: rt.fs, platform: rt.platform, stdout: rt.stdout, logger }),
    };
  }

  try {
    const { project, warnings } = loadConfig({
      ...(args.config === undefined ? {} : { configPath: args.config }),
      ...(args.project === undefined ? {} : { project: args.project }),
      env: rt.env,
      fs: rt.fs,
      platform: rt.platform,
      ...(rt.homeDir === undefined ? {} : { homeDir: rt.homeDir }),
    });
    for (const w of warnings) logger.warn(w);
    assertUserKey(project.apiKey);
    const fetch = nerdGraphFetch(rt.env, logger);
    const { handle, tools } = serveProjectOverStdio({
      project,
      logger,
      ...(fetch === undefined ? {} : { fetch }),
    });
    logger.info('serving MCP over stdio', {
      version: VERSION,
      mode: project.source,
      project: project.slug ?? null,
      region: project.region,
      defaultAccount: project.accounts.default,
      tools: tools.length,
    });
    return { kind: 'serving', close: () => handle.close() };
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message, error.hint === undefined ? {} : { hint: error.hint });
      return exit(1);
    }
    if (isRbError(error)) {
      logger.error(error.message, { code: error.code, ...(error.hint ? { hint: error.hint } : {}) });
      return exit(1);
    }
    throw error;
  }
}
