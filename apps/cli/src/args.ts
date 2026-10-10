// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { type LogLevel, redact } from '@relic-bridge/core';

export type Command = 'stdio' | 'serve' | 'db' | 'keys' | 'credential' | 'audit' | 'help' | 'version';

export interface CliArgs {
  readonly command: Command;
  readonly config?: string;
  readonly project?: string;
  readonly logLevel?: LogLevel;
  /** `db backup <file>`: the subcommand and its destination. */
  readonly dbAction?: 'backup';
  readonly file?: string;
  /** `credential revalidate`. */
  readonly credentialAction?: 'revalidate';
  /** `--db <path>`: the SQLite database file (or RB_DB_PATH). */
  readonly db?: string;
  /** `keys generate | rotate`. */
  readonly keysAction?: 'generate' | 'rotate';
  /** `keys generate --key-version <n>` (default 1). */
  readonly keyVersion?: number;
  /** `audit purge [--older-than-days <n>]`. */
  readonly auditAction?: 'purge';
  readonly olderThanDays?: string;
  /** `serve --port <n>` / `--host <addr>` (validated by `serveSettings`). */
  readonly port?: string;
  readonly host?: string;
}

/** Bad command line: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const COMMANDS: readonly Command[] = [
  'stdio',
  'serve',
  'db',
  'keys',
  'credential',
  'audit',
  'help',
  'version',
];
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
  let keysAction: 'generate' | 'rotate' | undefined;
  let credentialAction: 'revalidate' | undefined;
  let auditAction: 'purge' | undefined;
  if (command === 'db' && !values.help && !values.version) {
    if (positionals[1] !== 'backup')
      throw new UsageError('Usage: relic-bridge db backup <file> [--db <path>].');
    if (positionals.length !== 3 || (positionals[2] ?? '').trim() === '') {
      throw new UsageError('db backup needs exactly one destination file.');
    }
    dbAction = 'backup';
    file = positionals[2];
  } else if (command === 'keys' && !values.help && !values.version) {
    const action = positionals[1];
    if ((action !== 'generate' && action !== 'rotate') || positionals.length !== 2) {
      throw new UsageError(
        'Usage: relic-bridge keys generate [--key-version <n>] | keys rotate [--db <path> | --remote <url>].',
      );
    }
    keysAction = action;
  } else if (command === 'credential' && !values.help && !values.version) {
    if (positionals[1] !== 'revalidate' || positionals.length !== 2) {
      throw new UsageError('Usage: relic-bridge credential revalidate [--db <path>].');
    }
    credentialAction = 'revalidate';
  } else if (command === 'audit' && !values.help && !values.version) {
    if (positionals[1] !== 'purge' || positionals.length !== 2) {
      throw new UsageError('Usage: relic-bridge audit purge [--older-than-days <n>] [--db <path>].');
    }
    auditAction = 'purge';
  } else if (
    command !== 'db' &&
    command !== 'keys' &&
    command !== 'credential' &&
    command !== 'audit' &&
    positionals.length > 1
  ) {
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
  let keyVersion: number | undefined;
  const kv = values['key-version'];
  if (kv !== undefined) {
    if (keysAction !== 'generate') throw new UsageError('--key-version only applies to keys generate.');
    if (!/^[1-9][0-9]{0,5}$/.test(kv.trim()))
      throw new UsageError('--key-version must be an integer 1..999999.');
    keyVersion = Number(kv.trim());
  }
  if (values.db !== undefined && command === 'keys' && keysAction !== 'rotate') {
    throw new UsageError('--db only applies to keys rotate.');
  }
  const olderThan = values['older-than-days'];
  if (olderThan !== undefined) {
    if (auditAction !== 'purge') throw new UsageError('--older-than-days only applies to audit purge.');
    if (!/^\d{1,5}$/.test(olderThan.trim()) || Number(olderThan) < 1) {
      throw new UsageError('--older-than-days must be an integer of at least 1.');
    }
  }
  for (const flag of ['port', 'host'] as const) {
    const v = values[flag];
    if (v === undefined) continue;
    if (command !== 'serve') throw new UsageError(`--${flag} only applies to serve.`);
    if (v.trim() === '') throw new UsageError(`--${flag} needs a value.`);
  }
  if (command === 'serve' && (values.config !== undefined || values.project !== undefined)) {
    throw new UsageError('serve reads projects from the database (--db), not --config / --project.');
  }
  return {
    command,
    ...(dbAction === undefined || file === undefined ? {} : { dbAction, file }),
    ...(values.db === undefined ? {} : { db: values.db }),
    ...(keysAction === undefined ? {} : { keysAction }),
    ...(credentialAction === undefined ? {} : { credentialAction }),
    ...(auditAction === undefined ? {} : { auditAction }),
    ...(olderThan === undefined ? {} : { olderThanDays: olderThan.trim() }),
    ...(keyVersion === undefined ? {} : { keyVersion }),
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(values.port === undefined ? {} : { port: values.port }),
    ...(values.host === undefined ? {} : { host: values.host }),
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
      port: { type: 'string' },
      host: { type: 'string' },
      'key-version': { type: 'string' },
      'older-than-days': { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

export const HELP_TEXT = `relic-bridge: unofficial MCP server for New Relic (NerdGraph)

Usage:
  relic-bridge [stdio] [--config <file> [--project <slug>]] [--log-level <level>]
  relic-bridge serve [--port <n>] [--host <addr>] [--db <path>]
  relic-bridge db backup <file> [--db <path>]
  relic-bridge keys generate [--key-version <n>]
  relic-bridge keys rotate [--db <path>]
  relic-bridge keys rotate --remote <url> [--batch-size <n>]
  relic-bridge credential revalidate [--db <path>]
  relic-bridge audit purge [--older-than-days <n>] [--db <path>]
  relic-bridge init | admin-token | user | credential | project | grant | token | audit tail
                    Manage a local database or a remote instance (--remote); run
                    "relic-bridge init --help" for the full list.
  relic-bridge --help | --version

Commands:
  stdio              Serve MCP over stdin/stdout (default). Logs go to stderr.
  serve              Serve MCP over HTTP at /p/<project>/mcp for remote devices, with
                     projects, grants and device tokens from the SQLite database.
                     Needs RB_MASTER_KEY. Binds 127.0.0.1:8787 by default.
  db backup <file>   Write a consistent snapshot of the SQLite database to <file> (mode 0600,
                     never overwrites). Safe while the server is running.
  keys generate      Print a new random master key (v<n>:<base64>) once, on stdout.
                     Store it in a secret manager and back it up.
  keys rotate        Re-encrypt every stored New Relic key under RB_MASTER_KEY, reading
                     old rows with RB_MASTER_KEY_PREVIOUS. Resumable; safe to run again.
                     With --remote <url> the server does it (both keys set there; a
                     Worker on D1): needs RB_ADMIN_TOKEN, see "relic-bridge init --help".
  credential revalidate
                     Re-check every stored New Relic key with New Relic. A key New Relic
                     refuses is marked invalid and every grant using it stops working;
                     reachable accounts are refreshed. Exit 1 if any key is invalid or
                     could not be checked (run it from cron to get alerted).
  audit purge        Delete audit log rows older than --older-than-days (default
                     RB_AUDIT_RETENTION_DAYS, else 90). Safe while the server is running.
  help               Show this help.
  version            Print the version.

Options:
  --config <file>    YAML config with one or more projects (or RB_CONFIG).
  --project <slug>   Project to serve from the config file (or RB_PROJECT).
                     Optional when the file has a single project.
  --db <path>        SQLite database (or RB_DB_PATH). Defaults to
                     <data dir>/relic-bridge.db (RB_DATA_DIR, else ~/.local/share/relic-bridge,
                     ~/Library/Application Support/relic-bridge or %LOCALAPPDATA%\\relic-bridge).
  --port <n>         serve: TCP port (or RB_PORT; default 8787, 0 = any free port).
  --host <addr>      serve: address to bind (or RB_HOST; default 127.0.0.1). A non-loopback
                     address also needs RB_ALLOWED_HOSTS.
  --older-than-days <n>
                     audit purge: delete rows older than this many days.
  --key-version <n>  Version written into a generated key (default 1).
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
  RB_QUERY_CACHE         on (default) or off: reuse NRQL results for a short time (also serve).
  RB_QUERY_CACHE_TTL     Seconds a result over a moving window is reused, 0-300 (default 30).

HTTP server (serve):
  RB_ALLOWED_HOSTS       Hostnames clients use to reach the server (Host check against DNS
                         rebinding). Default: localhost, 127.0.0.1, [::1].
  RB_ALLOWED_ORIGINS     Browser Origin hostnames allowed (default: RB_ALLOWED_HOSTS).
  RB_CORS_ORIGINS        Origins allowed cross-origin (CORS); off by default.
  RB_ACCESS_CACHE_TTL    Seconds a token's resolved access is cached, 0-60 (default 30).
                         A revoked token stops working within this time.
  RB_HSTS                auto (default: when the request is https), true (behind a TLS
                         proxy) or false.
  RB_TRUSTED_PROXY_HOPS  Reverse proxies in front of the server, 0-5 (default 0). Set it
                         behind a proxy, or every client shares the proxy's address for
                         rate limiting.
  RB_RATE_LIMIT          on (default) or off: all rate limiting.
  RB_RATE_LIMIT_IP | _AUTH_FAIL | _TOKEN | _GRANT | _PASSTHROUGH_KEY | _SIGN_IN | _WRITE
                         One limit each, "<requests>/<seconds>" or off (see the self-hosting
                         guide for the defaults).

Pass-through (serve; off by default):
  RB_PASSTHROUGH         on enables /passthrough/mcp: the client sends its own New Relic key.
                         Serve it over HTTPS only.
  RB_PASSTHROUGH_IDENTITY_TTL
                         Seconds a key's reachable accounts are cached, 0-300 (default 60).

Audit log (serve):
  RB_AUDIT               on (default) or off.
  RB_AUDIT_NRQL          mask (default: literal values hidden) | hash | full | off.
  RB_AUDIT_RETENTION_DAYS  Days to keep rows (default 90; 0 keeps everything). Purged at
                         startup and hourly.
  RB_AUDIT_CLIENT_IP     on (default) or off: record the client address on refused requests.

Write tools (stdio and serve, off by default; see docs/adr/0015-opt-in-write-tools.md):
  RB_WRITE_TOOLS         off (default) or on: offer the write tools (create_change_event,
                         acknowledge_issue, close_issue, create_dashboard). Even then a tool works
                         only when it is named explicitly (stdio: RB_TOOLS or the YAML tools list;
                         serve: the project and the grant). serve needs RB_AUDIT=on.
  RB_WRITE_APPROVAL      required (default) or client: a write is refused unless the client supports
                         MCP elicitation and the person approves the exact change (a client that
                         cannot be asked can only dry-run, nothing is changed). client lets the model
                         set confirm: true instead and logs a warning at startup.

MCP Apps (stdio and serve; see docs/guide/charts.md):
  RB_MCP_APPS            on (default) or off: offer the chart view (_meta.ui on run_nrql and
                         get_query_result, and the ui:// resource) to clients that declare MCP Apps.

MCP Tasks (stdio and serve):
  RB_TASKS               on (default) or off: kill switch for the Tasks extension. off advertises no
                         tasks capability, stores no task, and answers tasks/* as unknown methods;
                         slow calls answer inline (run_nrql returns its query handle).

Registry-friendly discovery (serve, off by default; see docs/guide/registry-listing.md):
  RB_PUBLIC_TOOL_CATALOG off (default) or on: answer initialize and tools/list without a token
                         (static read-only tool list, the same for every project URL) and serve
                         /.well-known/relic-bridge/tools.json. Tool calls still need a token.

Self-monitoring (serve, off by default):
  RB_OTEL                off (default) or on: export traces, metrics and logs about this server over OTLP
                         (needs RB_OTEL_ENDPOINT; optional RB_OTEL_HEADERS, RB_OTEL_SAMPLE, RB_OTEL_TRACEPARENT). See docs/guide/observability.md.

Admin API (serve):
  RB_ADMIN_TOKEN         Bootstrap admin token (32+ printable characters, e.g. from
                         "openssl rand -base64 32"; or RB_ADMIN_TOKEN_FILE, mode 0600).
                         Enables /api/admin/v1 (acts as owner); with sign-in configured the
                         admin API also takes admin sessions.

Sign-in (serve; off until a provider is set; docs/guide/identity-providers.md):
  RB_PUBLIC_URL          Origin browsers use (https, or http://localhost); redirect URIs are
                         <RB_PUBLIC_URL>/auth/callback/<provider>.
  RB_GOOGLE_CLIENT_ID, RB_GOOGLE_CLIENT_SECRET, RB_GOOGLE_HOSTED_DOMAIN
  RB_GITHUB_CLIENT_ID, RB_GITHUB_CLIENT_SECRET
  (each *_CLIENT_SECRET also as *_CLIENT_SECRET_FILE, a file with mode 0600)
  RB_OIDC_ISSUER, RB_OIDC_CLIENT_ID, RB_OIDC_CLIENT_SECRET, RB_OIDC_NAME, RB_OIDC_LABEL, RB_OIDC_SCOPES
  RB_CF_ACCESS_TEAM, RB_CF_ACCESS_AUD
                         One block per provider; a client id needs its secret.
  RB_LOGIN_ALLOW_EMAILS, RB_LOGIN_ALLOW_DOMAINS, RB_LOGIN_ALLOW_GITHUB_ORGS
                         Who may sign in without a pre-created user (deny by default).
  RB_LOGIN_AUTO_PROVISION  off (default) | member | admin: create users for allowlisted
                         identities on first sign-in.
  RB_SESSION_IDLE_MINUTES  Admin sessions end after this many idle minutes (5-1440, default 30).
  RB_SESSION_MAX_HOURS   Admin sessions end this many hours after sign-in (1-168, default 12).

OAuth for MCP clients (serve; off by default; needs sign-in; docs/guide/oauth.md):
  RB_OAUTH               on: claude.ai, phones and other OAuth clients connect after a person
                         signs in and approves the app.
  RB_OAUTH_DCR           on (default) or off: dynamic client registration at /oauth/register.
  RB_OAUTH_DCR_LIMIT     Dynamic registrations per hour for the whole server (default 30), or off.
  RB_OAUTH_DCR_IP_LIMIT  Dynamic registrations per hour for one client address (default 10), or off.
  RB_OAUTH_DCR_REDIRECT_HOSTS
                         Comma-separated https redirect hosts dynamic clients may use.
  RB_OAUTH_ACCESS_TTL    Access-token lifetime (default 1h; 60s-24h; seconds or 90m, 12h, 30d).
  RB_OAUTH_REFRESH_TTL   Absolute lifetime of an app authorization (default 30d; 1h-365d); refreshing
                         does not extend it.
  RB_OAUTH_REFRESH_REUSE_WINDOW
                         Seconds an app may present a just-renewed refresh token again and get the
                         same new tokens (default 30; 0 or off = strict; up to 120).

Master key (serve / keys rotate / credential revalidate):
  RB_MASTER_KEY            Current master key, v<n>:<base64> (or RB_MASTER_KEY_FILE).
  RB_MASTER_KEY_PREVIOUS   Previous key while rotating (or RB_MASTER_KEY_PREVIOUS_FILE).

Keys are never accepted as command-line flags. MCP clients don't reliably pass your
shell environment to stdio servers: set NEW_RELIC_* in the client's "env" block.

Docs: https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/guide/configuration.md
`;
