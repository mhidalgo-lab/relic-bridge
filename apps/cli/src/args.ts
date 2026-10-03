// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { type LogLevel, redact } from '@relic-bridge/core';

export type Command = 'stdio' | 'db' | 'help' | 'version';

export interface CliArgs {
  readonly command: Command;
  readonly config?: string;
  readonly project?: string;
  readonly logLevel?: LogLevel;
  /** `db backup <file>`: the subcommand and its destination. */
  readonly dbAction?: 'backup';
  readonly file?: string;
  /** `--db <path>`: the SQLite database file (or RB_DB_PATH). */
  readonly db?: string;
}

/** Bad command line: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const COMMANDS: readonly Command[] = ['stdio', 'db', 'help', 'version'];
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse argv (without `node` and the script). Strict: unknown options fail, so no flag can carry a secret by accident
 * (T23 spirit: keys come from env or the config file). Error messages are redacted in case a key was typed anyway.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(redact(error instanceof Error ? error.message : String(error)));
  }
  const { values, positionals } = parsed;
  let command: Command = 'stdio';
  const given = positionals[0];
  if (given !== undefined) {
    if (!(COMMANDS as readonly string[]).includes(given)) {
      throw new UsageError(`Unknown command "${redact(given).slice(0, 40)}".`);
    }
    command = given as Command;
  }
  let dbAction: 'backup' | undefined;
  let file: string | undefined;
  if (command === 'db' && !values.help && !values.version) {
    if (positionals[1] !== 'backup')
      throw new UsageError('Usage: relic-bridge db backup <file> [--db <path>].');
    if (positionals.length !== 3 || (positionals[2] ?? '').trim() === '') {
      throw new UsageError('db backup needs exactly one destination file.');
    }
    dbAction = 'backup';
    file = positionals[2];
  } else if (command !== 'db' && positionals.length > 1) {
    throw new UsageError(`Expected at most one command, got ${positionals.length}.`);
  }
  if (values.help) command = 'help';
  else if (values.version) command = 'version';

  const logLevel = values['log-level'];
  if (logLevel !== undefined && !isLogLevel(logLevel)) {
    throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(', ')}.`);
  }
  if (values.config !== undefined && values.config.trim() === '') {
    throw new UsageError('--config needs a file path.');
  }
  if (values.project !== undefined && values.project.trim() === '') {
    throw new UsageError('--project needs a project slug.');
  }
  if (values.db !== undefined && values.db.trim() === '') {
    throw new UsageError('--db needs a file path.');
  }
  return {
    command,
    ...(dbAction === undefined || file === undefined ? {} : { dbAction, file }),
    ...(values.db === undefined ? {} : { db: values.db }),
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(logLevel === undefined ? {} : { logLevel }),
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      project: { type: 'string' },
      db: { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

export const HELP_TEXT = `relic-bridge: unofficial MCP server for New Relic (NerdGraph)

Usage:
  relic-bridge [stdio] [--config <file> [--project <slug>]] [--log-level <level>]
  relic-bridge db backup <file> [--db <path>]
  relic-bridge --help | --version

Commands:
  stdio              Serve MCP over stdin/stdout (default). Logs go to stderr.
  db backup <file>   Write a consistent snapshot of the SQLite database to <file> (mode 0600,
                     never overwrites). Safe while the server is running.
  help               Show this help.
  version            Print the version.

Options:
  --config <file>    YAML config with one or more projects (or RB_CONFIG).
  --project <slug>   Project to serve from the config file (or RB_PROJECT).
                     Optional when the file has a single project.
  --db <path>        SQLite database for the db command (or RB_DB_PATH).
  --log-level <lvl>  debug | info | warn | error (or RB_LOG_LEVEL; default info).
  -h, --help         Show this help.
  -v, --version      Print the version.

Env mode (no config file):
  NEW_RELIC_API_KEY      New Relic User key (NRAK-...). Required.
  NEW_RELIC_ACCOUNT_ID   Default account id. Required.
  NEW_RELIC_REGION       US (default), EU or JP.
  RB_ACCOUNTS            Extra account ids this connection may query (comma-separated).
  RB_TOOLS               Tool allowlist (comma-separated). Default: all read-only tools.
  RB_LIMITS_*            MAX_LIMIT, MAX_WINDOW_DAYS, RAW_NRQL, MAX_RESPONSE_BYTES,
                         EVENT_TYPES_ALLOW, EVENT_TYPES_DENY.

Keys are never accepted as command-line flags. MCP clients don't reliably pass your
shell environment to stdio servers: set NEW_RELIC_* in the client's "env" block.

Docs: https://github.com/matiashidalgo/relic-bridge/blob/main/docs/guide/configuration.md
`;
