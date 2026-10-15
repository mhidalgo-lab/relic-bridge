// SPDX-License-Identifier: Apache-2.0
import {
  assertUserKey,
  createLogger,
  DEPRECATED_CONFIG,
  type DeprecatedConfig,
  deprecatedConfigInUse,
  describeDeprecatedConfig,
  isRbError,
  type LogLevel,
  type LogSink,
  VERSION,
} from '@relic-bridge/core';
import { backupDatabase } from '@relic-bridge/storage-sqlite';
import { HELP_TEXT, isLogLevel, parseCliArgs, UsageError } from './args.ts';
import { auditPurge } from './audit.ts';
import { ConfigError, type ConfigFs, type Env, loadConfig } from './config.ts';
import { credentialRevalidate } from './credentials.ts';
import { dbExport } from './db-export.ts';
import { keysGenerate, keysRotate } from './keys.ts';
import { isManageArgv, parseManageArgs } from './manage/args.ts';
import { MANAGE_HELP } from './manage/help.ts';
import type { ManageHost } from './manage/io.ts';
import { runManage } from './manage/run.ts';
import {
  createProcessQueryCache,
  isBootError,
  queryCacheSettings,
  type RunningServer,
  resolveDbPath,
  serveSettings,
  startServer,
  WRITE_APPROVAL_CLIENT_WARNING,
} from './serve.ts';
import {
  isUnconfigured,
  serveProjectOverStdio,
  serveSetupModeOverStdio,
  stdioMcpApps,
  stdioTasks,
  stdioTelemetry,
  stdioWriteApproval,
  stdioWriteTools,
} from './stdio.ts';
import { nerdGraphFetch } from './test-hooks.ts';

/** Everything `main` needs from the process, injected so it can be tested without spawning. */
export interface CliRuntime {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly platform: string;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly fs: ConfigFs;
  /** Only `help` and `version` write here. In stdio mode stdout is the MCP channel. */
  readonly stdout: (text: string) => void;
  readonly stderr: LogSink;
  /** Terminal, stdin, fetch and file access for the management commands (P2-10). */
  readonly manage?: ManageHost;
  /** Deprecated-config registry (tests inject one). Default: `DEPRECATED_CONFIG` (P8-67). */
  readonly deprecations?: readonly DeprecatedConfig[];
}

export type MainResult =
  | { readonly kind: 'exit'; readonly code: number }
  /** An async command (`keys rotate`); `done` resolves to its exit code. */
  | { readonly kind: 'pending'; readonly done: Promise<number> }
  | { readonly kind: 'serving'; readonly close: () => Promise<void> }
  /** `serve`: resolves to the running HTTP server, or to an exit code when it could not start. */
  | { readonly kind: 'server'; readonly started: Promise<RunningServer | number> };

const exit = (code: number): MainResult => ({ kind: 'exit', code });

/** Run the CLI. Returns an exit code, or a handle when it is serving MCP over stdio. */
export function main(rt: CliRuntime): MainResult {
  if (isManageArgv(rt.argv)) return manage(rt);
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

  // `--db`, `RB_DB_PATH`, else the data directory (`RB_DATA_DIR`, as in the Docker image): the same database `serve`
  // and the management commands use, so `db backup` and `keys rotate` work where the docs run them.
  const maintenanceDbPath = (flag: string | undefined): string | null => {
    try {
      return resolveDbPath(flag, rt.env, rt.platform, rt.homeDir);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      logger.error('no database given', { hint: 'pass --db <path>, or set RB_DB_PATH or RB_DATA_DIR' });
      return null;
    }
  };

  if (args.command === 'db' && args.dbAction === 'export' && args.file !== undefined) {
    const dbPath = maintenanceDbPath(args.db);
    if (dbPath === null) return exit(2);
    return {
      kind: 'pending',
      done: dbExport({
        dbPath,
        file: args.file,
        includeAudit: args.noAudit !== true,
        force: args.force === true,
        env: rt.env,
        stdout: rt.stdout,
        logger,
      }),
    };
  }

  if (args.command === 'db' && args.dbAction === 'backup' && args.file !== undefined) {
    const dbPath = maintenanceDbPath(args.db);
    if (dbPath === null) return exit(2);
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
    const dbPath = maintenanceDbPath(args.db);
    if (dbPath === null) return exit(2);
    return {
      kind: 'pending',
      done: keysRotate({ dbPath, env: rt.env, fs: rt.fs, platform: rt.platform, stdout: rt.stdout, logger }),
    };
  }

  if (args.command === 'audit' && args.auditAction === 'purge') {
    const dbPath = maintenanceDbPath(args.db);
    if (dbPath === null) return exit(2);
    return {
      kind: 'pending',
      done: auditPurge({
        dbPath,
        env: rt.env,
        ...(args.olderThanDays === undefined ? {} : { olderThanDays: args.olderThanDays }),
        stdout: rt.stdout,
        logger,
      }),
    };
  }

  if (args.command === 'serve') {
    const bootError = (error: unknown): number => {
      if (!isBootError(error)) throw error;
      logger.error(error.message, {
        ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
        ...('hint' in error && typeof error.hint === 'string' ? { hint: error.hint } : {}),
      });
      return 1;
    };
    let settings: ReturnType<typeof serveSettings>;
    let fetch: ReturnType<typeof nerdGraphFetch>;
    try {
      settings = serveSettings({
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.host === undefined ? {} : { host: args.host }),
        ...(args.db === undefined ? {} : { db: args.db }),
        env: rt.env,
        platform: rt.platform,
        fs: rt.fs,
        ...(rt.homeDir === undefined ? {} : { homeDir: rt.homeDir }),
        argv: rt.argv,
        ...(rt.deprecations === undefined ? {} : { deprecations: rt.deprecations }),
      });
      fetch = nerdGraphFetch(rt.env, logger);
    } catch (error) {
      return exit(bootError(error));
    }
    return {
      kind: 'server',
      started: startServer({
        settings,
        env: rt.env,
        fs: rt.fs,
        platform: rt.platform,
        logger,
        ...(fetch === undefined ? {} : { fetch }),
      }).catch(bootError),
    };
  }

  if (args.command === 'credential' && args.credentialAction === 'revalidate') {
    const dbPath = maintenanceDbPath(args.db);
    if (dbPath === null) return exit(2);
    let fetch: ReturnType<typeof nerdGraphFetch>;
    try {
      fetch = nerdGraphFetch(rt.env, logger);
    } catch (error) {
      if (error instanceof ConfigError) {
        logger.error(error.message, error.hint === undefined ? {} : { hint: error.hint });
        return exit(1);
      }
      throw error;
    }
    return {
      kind: 'pending',
      done: credentialRevalidate({
        dbPath,
        env: rt.env,
        fs: rt.fs,
        platform: rt.platform,
        stdout: rt.stdout,
        logger,
        ...(fetch === undefined ? {} : { fetch }),
      }),
    };
  }

  // stdio: one warning per deprecated variable or flag in use (names only), before anything else can fail (P8-67).
  const deprecations = rt.deprecations ?? DEPRECATED_CONFIG;
  for (const e of deprecatedConfigInUse({ env: rt.env, argv: rt.argv }, deprecations)) {
    logger.warn(describeDeprecatedConfig(e));
  }

  if (isUnconfigured(rt.env, args)) {
    // Setup mode (P7-14): list the tools so clients, registries and inspectors can see them; every call explains
    // what to configure. No key, so nothing can reach New Relic.
    const { handle, tools } = serveSetupModeOverStdio({ logger, mcpApps: stdioMcpApps(rt.env) });
    logger.warn('no configuration: serving the tool list only (setup mode); tool calls explain what to set', {
      version: VERSION,
      tools: tools.length,
      hint: 'Set NEW_RELIC_API_KEY and NEW_RELIC_ACCOUNT_ID, or pass --config <file>.',
    });
    return { kind: 'serving', close: () => handle.close() };
  }

  try {
    const { project, warnings, deprecated } = loadConfig({
      ...(args.config === undefined ? {} : { configPath: args.config }),
      ...(args.project === undefined ? {} : { project: args.project }),
      env: rt.env,
      fs: rt.fs,
      platform: rt.platform,
      ...(rt.homeDir === undefined ? {} : { homeDir: rt.homeDir }),
      deprecations,
    });
    for (const e of deprecated ?? []) logger.warn(describeDeprecatedConfig(e));
    for (const w of warnings) logger.warn(w);
    const requireWriteApproval = stdioWriteApproval(rt.env);
    const writeTools = stdioWriteTools(rt.env);
    if (writeTools && !requireWriteApproval) logger.warn(WRITE_APPROVAL_CLIENT_WARNING);
    assertUserKey(project.apiKey);
    const fetch = nerdGraphFetch(rt.env, logger);
    const telemetry = stdioTelemetry(rt.env, logger);
    const { handle, tools } = serveProjectOverStdio({
      project,
      logger,
      ...(telemetry === undefined ? {} : { telemetry }),
      queryCache: createProcessQueryCache(queryCacheSettings(rt.env)),
      writeTools,
      requireWriteApproval,
      mcpApps: stdioMcpApps(rt.env),
      tasks: stdioTasks(rt.env),
      ...(fetch === undefined ? {} : { fetch }),
    });
    logger.info('serving MCP over stdio', {
      version: VERSION,
      mode: project.source,
      project: project.slug ?? null,
      region: project.region,
      defaultAccount: project.accounts.default,
      tools: tools.length,
      telemetry: telemetry !== undefined,
    });
    return {
      kind: 'serving',
      close: async () => {
        await handle.close();
        telemetry?.close();
        await telemetry?.flush();
      },
    };
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

/** `init`, `credential|project|grant|token|user ...`, `audit tail`, `admin-token generate` (P2-10). */
function manage(rt: CliRuntime): MainResult {
  let args: ReturnType<typeof parseManageArgs>;
  try {
    args = parseManageArgs(rt.argv);
  } catch (error) {
    if (error instanceof UsageError) {
      rt.stderr(`relic-bridge: ${error.message}\n\nTry: relic-bridge init --help`);
      return exit(2);
    }
    throw error;
  }
  if (args.help) {
    rt.stdout(MANAGE_HELP);
    return exit(0);
  }
  if (rt.manage === undefined) {
    rt.stderr('relic-bridge: management commands are not available in this runtime.');
    return exit(1);
  }
  const envLevel = rt.env['RB_LOG_LEVEL']?.trim().toLowerCase();
  const given = args.values['log-level'];
  if (given !== undefined && !isLogLevel(given)) {
    rt.stderr('relic-bridge: --log-level must be debug, info, warn or error.');
    return exit(2);
  }
  const level: LogLevel = given ?? (envLevel && isLogLevel(envLevel) ? envLevel : 'warn');
  const logger = createLogger({ level, sink: rt.stderr, fields: { app: 'relic-bridge' } });
  return {
    kind: 'pending',
    done: runManage(
      {
        host: rt.manage,
        env: rt.env,
        fs: rt.fs,
        platform: rt.platform,
        ...(rt.homeDir === undefined ? {} : { homeDir: rt.homeDir }),
        ...(rt.cwd === undefined ? {} : { cwd: rt.cwd }),
        stdout: rt.stdout,
        stderr: rt.stderr,
      },
      args,
      logger,
    ),
  };
}
