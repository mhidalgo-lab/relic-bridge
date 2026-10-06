// SPDX-License-Identifier: Apache-2.0
// `relic-bridge serve` (P2-06): the HTTP app on Node (`@hono/node-server`) with SQLite storage. Everything
// runtime-specific lives here; the app itself (`@relic-bridge/http-app`) is web-standard.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  CryptoError,
  createIdentityProviders,
  describeUnreadableKeys,
  IdentityConfigError,
  type IdentitySettings,
  identitySettingsFromEnv,
  loadKeyringFromEnv,
  verifyKeyChecks,
} from '@relic-bridge/auth';
import {
  type CacheCryptoKey,
  DEFAULT_QUERY_CACHE_POLICY,
  type FetchLike,
  type Logger,
  MAX_RELATIVE_TTL_MS,
  QueryCache,
  Secret,
  VERSION,
} from '@relic-bridge/core';
import {
  AUDIT_NRQL_MODES,
  type AuditNrqlMode,
  adminTokenLooksWeak,
  type ClientMetadataFetch,
  checkHost,
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  createTelemetry,
  DEFAULT_PASSTHROUGH_IDENTITY_TTL_MS,
  DEFAULT_RATE_LIMITS,
  defaultAllowedHostnames,
  MAX_ACCESS_CACHE_TTL_MS,
  MAX_PASSTHROUGH_IDENTITY_TTL_MS,
  MemoryRateLimiter,
  mergeHooks,
  OAuthConfigError,
  type OAuthSettings,
  oauthSettingsFromEnv,
  originHostname,
  PASSTHROUGH_KEY_HEADER,
  PASSTHROUGH_PATH,
  type RateLimitRule,
  type RateLimitRules,
  resolveClientIp,
  TelemetryConfigError,
  type TelemetrySettings,
  telemetrySettingsFromEnv,
} from '@relic-bridge/http-app';
import { purgeExpiredKv, purgeGrantUsage, StorageError } from '@relic-bridge/storage';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import type { Context } from 'hono';
import { parseRetentionDays } from './audit.ts';
import { createCimdFetch } from './cimd-fetch.ts';
import { ConfigError, type ConfigFs, type Env } from './config.ts';
import { resolveAdminToken, resolveIdpSecretEnv, resolveMasterKeyEnv } from './keys.ts';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';
/** How often `serve` deletes audit rows past retention. */
export const AUDIT_PURGE_INTERVAL_MS = 3_600_000;
export const DB_FILE_NAME = 'relic-bridge.db';
/** Boot warning for an admin token that passes `checkAdminToken` but does not look generated (P3-13). */
export const ADMIN_TOKEN_WEAK_WARNING =
  'RB_ADMIN_TOKEN does not look randomly generated. Anyone who reaches the admin API can guess at it: ' +
  'use `openssl rand -base64 32` or `relic-bridge admin-token generate`.';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Per-user data directory: `RB_DATA_DIR`, else `%LOCALAPPDATA%\relic-bridge` (Windows),
 * `~/Library/Application Support/relic-bridge` (macOS), `$XDG_DATA_HOME/relic-bridge` or
 * `~/.local/share/relic-bridge` (elsewhere). Docker sets `RB_DATA_DIR=/data` (P2-11).
 */
export function defaultDataDir(env: Env, platform: string, homeDir: string | undefined): string | null {
  const explicit = env['RB_DATA_DIR']?.trim();
  if (explicit) return explicit;
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim();
    if (local) return join(local, 'relic-bridge');
  }
  if (homeDir === undefined || homeDir === '') return null;
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'relic-bridge');
  const xdg = env['XDG_DATA_HOME']?.trim();
  return join(xdg ? xdg : join(homeDir, '.local', 'share'), 'relic-bridge');
}

/**
 * Per-user configuration directory, where `init` writes the master key by default: `%APPDATA%\relic-bridge`
 * (Windows), else `$XDG_CONFIG_HOME/relic-bridge` or `~/.config/relic-bridge`. Deliberately not the data directory:
 * the master key must never sit next to the database it decrypts (a copy or backup of one must not contain the other).
 */
export function defaultConfigDir(env: Env, platform: string, homeDir: string | undefined): string | null {
  if (platform === 'win32') {
    const roaming = env['APPDATA']?.trim();
    if (roaming) return join(roaming, 'relic-bridge');
  }
  if (homeDir === undefined || homeDir === '') return null;
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg ? xdg : join(homeDir, '.config'), 'relic-bridge');
}

/** The database file: `--db`, `RB_DB_PATH`, else `<data dir>/relic-bridge.db`. */
export function resolveDbPath(
  flag: string | undefined,
  env: Env,
  platform: string,
  homeDir: string | undefined,
): string {
  const explicit = (flag ?? env['RB_DB_PATH'] ?? '').trim();
  if (explicit !== '') return explicit;
  const dir = defaultDataDir(env, platform, homeDir);
  if (dir === null) {
    throw new ConfigError('No database path.', 'Pass --db <path>, or set RB_DB_PATH or RB_DATA_DIR.');
  }
  return join(dir, DB_FILE_NAME);
}

function list(env: Env, name: string): string[] | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `<requests>/<seconds>` (e.g. `600/60`) or `off` (null). */
export function parseRateRule(name: string, raw: string): RateLimitRule | null {
  const v = raw.trim().toLowerCase();
  if (v === 'off') return null;
  const m = /^(\d{1,7})\/(\d{1,6})$/.exec(v);
  if (m === null || Number(m[1]) < 1 || Number(m[2]) < 1) {
    throw new ConfigError(
      `${name} must look like <requests>/<seconds> (e.g. 600/60) or off.`,
      `Got "${raw.slice(0, 40)}".`,
    );
  }
  return { requests: Number(m[1]), perSeconds: Number(m[2]) };
}

function rateLimitSettings(env: Env, warnings: string[]): RateLimitRules | null {
  const all = env['RB_RATE_LIMIT']?.trim().toLowerCase();
  if (all === 'off' || all === 'false' || all === '0') {
    warnings.push('RB_RATE_LIMIT=off disables all rate limiting (brute-force and abuse protection).');
    return null;
  }
  if (all !== undefined && all !== '' && all !== 'on' && all !== 'true' && all !== '1') {
    throw new ConfigError(
      'RB_RATE_LIMIT must be on or off.',
      'Tune single limits with RB_RATE_LIMIT_IP etc.',
    );
  }
  const pick = (name: string, fallback: RateLimitRule | null): RateLimitRule | null => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? fallback : parseRateRule(name, raw);
  };
  const rules = {
    ip: pick('RB_RATE_LIMIT_IP', DEFAULT_RATE_LIMITS.ip),
    authFailures: pick('RB_RATE_LIMIT_AUTH_FAIL', DEFAULT_RATE_LIMITS.authFailures),
    token: pick('RB_RATE_LIMIT_TOKEN', DEFAULT_RATE_LIMITS.token),
    grant: pick('RB_RATE_LIMIT_GRANT', DEFAULT_RATE_LIMITS.grant),
    signIn: pick('RB_RATE_LIMIT_SIGN_IN', DEFAULT_RATE_LIMITS.signIn ?? null),
    passthroughKey: pick('RB_RATE_LIMIT_PASSTHROUGH_KEY', DEFAULT_RATE_LIMITS.passthroughKey),
    write: pick('RB_RATE_LIMIT_WRITE', DEFAULT_RATE_LIMITS.write ?? null),
  };
  if (rules.authFailures === null) {
    warnings.push('RB_RATE_LIMIT_AUTH_FAIL=off: failed authentications are not throttled per IP.');
  }
  return rules;
}

export interface AuditSettings {
  readonly enabled: boolean;
  readonly nrql: AuditNrqlMode;
  /** Days to keep rows; 0 keeps everything. */
  readonly retentionDays: number;
  readonly clientIp: boolean;
}

function onOff(env: Env, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  throw new ConfigError(`${name} must be on or off.`);
}

function auditSettings(env: Env, warnings: string[]): AuditSettings {
  const enabled = onOff(env, 'RB_AUDIT', true);
  const nrqlRaw = (env['RB_AUDIT_NRQL']?.trim().toLowerCase() ?? '') || 'mask';
  if (!(AUDIT_NRQL_MODES as readonly string[]).includes(nrqlRaw)) {
    throw new ConfigError(`RB_AUDIT_NRQL must be one of ${AUDIT_NRQL_MODES.join(', ')}.`);
  }
  const retentionDays = parseRetentionDays(env['RB_AUDIT_RETENTION_DAYS']);
  if (!enabled) warnings.push('RB_AUDIT=off: tool calls and refused requests are not recorded.');
  if (nrqlRaw === 'full') {
    warnings.push(
      'RB_AUDIT_NRQL=full stores query text including literal values (redacted for secrets only).',
    );
  }
  return {
    enabled,
    nrql: nrqlRaw as AuditNrqlMode,
    retentionDays,
    clientIp: onOff(env, 'RB_AUDIT_CLIENT_IP', true),
  };
}

function telemetrySettings(env: Env): TelemetrySettings | null {
  try {
    return telemetrySettingsFromEnv(env);
  } catch (error) {
    if (error instanceof TelemetryConfigError) {
      throw new ConfigError(`${error.message}.`, 'See docs/guide/observability.md.');
    }
    throw error;
  }
}

/** NRQL query cache (P7-02): `RB_QUERY_CACHE` (on|off, default on) and `RB_QUERY_CACHE_TTL` (seconds, 0-300). */
export interface QueryCacheSettings {
  readonly enabled: boolean;
  /** Lifetime of results over moving windows; 0 caches only settled fixed windows. */
  readonly relativeTtlMs: number;
}

/** Shared by `serve` and stdio. Throws `ConfigError`. */
export function queryCacheSettings(env: Env): QueryCacheSettings {
  const enabled = onOff(env, 'RB_QUERY_CACHE', true);
  const raw = env['RB_QUERY_CACHE_TTL']?.trim();
  let relativeTtlMs = DEFAULT_QUERY_CACHE_POLICY.relativeTtlMs;
  if (raw !== undefined && raw !== '') {
    const max = MAX_RELATIVE_TTL_MS / 1000;
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > max) {
      throw new ConfigError(`RB_QUERY_CACHE_TTL must be 0-${max} seconds.`);
    }
    relativeTtlMs = Number(raw) * 1000;
  }
  return { enabled, relativeTtlMs };
}

/** The in-memory query cache for this process, or null when `RB_QUERY_CACHE=off`. */
export function createProcessQueryCache(
  settings: QueryCacheSettings,
  macKey?: CacheCryptoKey,
): QueryCache | null {
  if (!settings.enabled) return null;
  return new QueryCache({
    ...(macKey === undefined ? {} : { macKey }),
    policy: { relativeTtlMs: settings.relativeTtlMs },
  });
}

/** Pass-through mode (P2-15): `null` when off (the default). */
export interface PassthroughSettings {
  readonly identityTtlMs: number;
}

function passthroughSettings(env: Env, warnings: string[]): PassthroughSettings | null {
  const ttlRaw = env['RB_PASSTHROUGH_IDENTITY_TTL']?.trim();
  let identityTtlMs = DEFAULT_PASSTHROUGH_IDENTITY_TTL_MS;
  if (ttlRaw !== undefined && ttlRaw !== '') {
    const max = MAX_PASSTHROUGH_IDENTITY_TTL_MS / 1000;
    if (!/^\d{1,3}$/.test(ttlRaw) || Number(ttlRaw) > max) {
      throw new ConfigError(
        `RB_PASSTHROUGH_IDENTITY_TTL must be 0-${max} seconds (0 validates every request).`,
      );
    }
    identityTtlMs = Number(ttlRaw) * 1000;
  }
  if (!onOff(env, 'RB_PASSTHROUGH', false)) return null;
  warnings.push(
    `RB_PASSTHROUGH=on: ${PASSTHROUGH_PATH} accepts New Relic keys in the ${PASSTHROUGH_KEY_HEADER} header. Serve it ` +
      'only over HTTPS (set RB_HSTS=true behind a TLS proxy); plain HTTP to a non-loopback host is refused.',
  );
  return { identityTtlMs };
}

export interface ServeSettings {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly allowedHosts: readonly string[] | '*';
  readonly allowedOrigins?: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly accessCacheTtlMs?: number;
  readonly hsts: 'auto' | boolean;
  /** Rate limit rules (`null` entries are off); `null` here disables rate limiting altogether (`RB_RATE_LIMIT=off`). */
  readonly rateLimits: RateLimitRules | null;
  /** Reverse proxies in front of the server (`X-Forwarded-For` is trusted for that many hops from the right). */
  readonly trustedProxyHops: number;
  readonly audit: AuditSettings;
  /** Pass-through mode (`RB_PASSTHROUGH`); `null` when off. */
  readonly passthrough: PassthroughSettings | null;
  /** Admin sign-in (P4-01, `RB_PUBLIC_URL` + provider variables); `null` when no provider is configured. */
  readonly identity: IdentitySettings | null;
  /** OAuth for MCP clients (P5-04, `RB_OAUTH=on`); `null` when off (the default). */
  readonly oauth: OAuthSettings | null;
  /** NRQL query cache (P7-02). */
  readonly queryCache: QueryCacheSettings;
  /** Self-monitoring via OTLP (P7-08, `RB_OTEL=on`); `null` when off (the default). */
  readonly telemetry: TelemetrySettings | null;
  /** Opt-in write tools (P7-09, `RB_WRITE_TOOLS=on`); off by default. Needs the audit log on. */
  readonly writeTools: boolean;
  /** Registry-friendly discovery (P7-14, `RB_PUBLIC_TOOL_CATALOG=on`); off by default. */
  readonly publicToolCatalog: boolean;
  /** MCP Apps chart view (P7-16, `RB_MCP_APPS`); on by default. */
  readonly mcpApps: boolean;
  readonly warnings: readonly string[];
}

/** `RB_WRITE_TOOLS` (P7-09, ADR-0015): off by default; refused without the audit log (every write must be recorded). */
export function writeToolsSetting(
  env: Env,
  audit: AuditSettings,
  warnings: string[],
  writeLimit: RateLimitRule | null = null,
): boolean {
  const on = onOff(env, 'RB_WRITE_TOOLS', false);
  if (!on) return false;
  if (!audit.enabled) {
    throw new ConfigError(
      'RB_WRITE_TOOLS=on needs the audit log (RB_AUDIT=on): every write must be recorded.',
      'See docs/adr/0015-opt-in-write-tools.md.',
    );
  }
  warnings.push(
    'RB_WRITE_TOOLS=on: write tools can be enabled per project and grant (owners only). See docs/guide/security-basics.md.',
  );
  if (writeLimit === null) {
    warnings.push('RB_WRITE_TOOLS=on with the write rate limit off: write tool calls are not rate limited.');
  }
  return true;
}

/**
 * `RB_PUBLIC_TOOL_CATALOG` (P7-14): off by default. On, registries and inspectors can list the static read-only tool
 * catalog without a credential; tool calls and data still need one.
 */
export function publicToolCatalogSetting(env: Env, warnings: string[], rateLimited: boolean): boolean {
  const on = onOff(env, 'RB_PUBLIC_TOOL_CATALOG', false);
  if (on && !rateLimited) {
    warnings.push(
      'RB_PUBLIC_TOOL_CATALOG=on with rate limiting off: unauthenticated discovery is not rate limited.',
    );
  }
  return on;
}

function oauthSettings(env: Env, identity: IdentitySettings | null): OAuthSettings | null {
  try {
    return oauthSettingsFromEnv(env, identity !== null);
  } catch (error) {
    if (error instanceof OAuthConfigError) {
      throw new ConfigError(error.message, 'See docs/guide/oauth.md.');
    }
    throw error;
  }
}

function identitySettings(
  env: Env,
  allowedHosts: readonly string[] | '*',
  warnings: string[],
): IdentitySettings | null {
  let settings: IdentitySettings | null;
  try {
    settings = identitySettingsFromEnv(env);
  } catch (error) {
    if (error instanceof IdentityConfigError) {
      throw new ConfigError(error.message, 'See docs/guide/identity-providers.md.');
    }
    throw error;
  }
  if (settings === null) return null;
  if (allowedHosts !== '*' && !checkHost(new URL(settings.publicUrl).hostname, allowedHosts).ok) {
    throw new ConfigError(
      'RB_PUBLIC_URL must name a host listed in RB_ALLOWED_HOSTS.',
      'Sign-in redirects come back to RB_PUBLIC_URL; requests for other hosts are refused.',
    );
  }
  warnings.push(...settings.warnings);
  return settings;
}

/** Validate flags and `RB_*` variables for `serve`. Throws `ConfigError` with a hint. */
export function serveSettings(input: {
  readonly port?: string;
  readonly host?: string;
  readonly db?: string;
  readonly env: Env;
  readonly platform: string;
  readonly homeDir?: string;
  /** Needed to read `RB_*_CLIENT_SECRET_FILE`; without it a `_FILE` variable is ignored. */
  readonly fs?: ConfigFs;
}): ServeSettings {
  const { env } = input;
  const warnings: string[] = [];
  const portRaw = (input.port ?? env['RB_PORT'] ?? String(DEFAULT_PORT)).trim();
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) {
    throw new ConfigError('--port must be an integer 0-65535 (0 picks a free port).');
  }
  const host = (input.host ?? env['RB_HOST'] ?? DEFAULT_HOST).trim();
  if (host === '' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(host)) {
    throw new ConfigError('--host must be an IP address or hostname to bind.');
  }
  const loopback = LOOPBACK.has(host.toLowerCase());

  let allowedHosts: readonly string[] | '*';
  const hostsEnv = list(env, 'RB_ALLOWED_HOSTS');
  if (hostsEnv === undefined) {
    if (!loopback) {
      throw new ConfigError(
        `Binding ${host} (not loopback) needs RB_ALLOWED_HOSTS.`,
        'Set RB_ALLOWED_HOSTS to the hostnames clients use to reach this server (e.g. mcp.example.com), so ' +
          'requests for any other Host are refused (DNS rebinding protection).',
      );
    }
    allowedHosts = defaultAllowedHostnames();
  } else if (hostsEnv.length === 1 && hostsEnv[0] === '*') {
    allowedHosts = '*';
    warnings.push('RB_ALLOWED_HOSTS=* disables Host validation (DNS rebinding protection).');
  } else {
    allowedHosts = hostsEnv.map((h) => h.toLowerCase());
  }

  const corsOrigins = list(env, 'RB_CORS_ORIGINS') ?? [];
  for (const o of corsOrigins) {
    if (originHostname(o) === null) {
      throw new ConfigError(
        `RB_CORS_ORIGINS: "${o.slice(0, 80)}" is not an origin.`,
        'Use https://host[:port].',
      );
    }
  }
  const allowedOrigins = list(env, 'RB_ALLOWED_ORIGINS');

  let accessCacheTtlMs: number | undefined;
  const ttl = env['RB_ACCESS_CACHE_TTL']?.trim();
  if (ttl !== undefined && ttl !== '') {
    const max = MAX_ACCESS_CACHE_TTL_MS / 1000;
    if (!/^\d{1,2}$/.test(ttl) || Number(ttl) > max) {
      throw new ConfigError(`RB_ACCESS_CACHE_TTL must be 0-${max} seconds (0 disables the cache).`);
    }
    accessCacheTtlMs = Number(ttl) * 1000;
  }

  const hstsRaw = env['RB_HSTS']?.trim().toLowerCase();
  let hsts: 'auto' | boolean = 'auto';
  if (hstsRaw === 'true' || hstsRaw === '1') hsts = true;
  else if (hstsRaw === 'false' || hstsRaw === '0') hsts = false;
  else if (hstsRaw !== undefined && hstsRaw !== '' && hstsRaw !== 'auto') {
    throw new ConfigError('RB_HSTS must be auto, true or false.');
  }

  const rateLimits = rateLimitSettings(env, warnings);
  const identity = identitySettings(
    input.fs === undefined ? env : resolveIdpSecretEnv(env, input.fs, input.platform),
    allowedHosts,
    warnings,
  );
  const hopsRaw = env['RB_TRUSTED_PROXY_HOPS']?.trim() ?? '0';
  if (!/^[0-5]$/.test(hopsRaw)) {
    throw new ConfigError(
      'RB_TRUSTED_PROXY_HOPS must be an integer 0-5 (reverse proxies in front of the server).',
    );
  }

  const audit = auditSettings(env, warnings);
  return {
    port: Number(portRaw),
    host,
    dbPath: resolveDbPath(input.db, env, input.platform, input.homeDir),
    allowedHosts,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    corsOrigins,
    ...(accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs }),
    hsts,
    rateLimits,
    trustedProxyHops: Number(hopsRaw),
    audit,
    passthrough: passthroughSettings(env, warnings),
    identity,
    oauth: oauthSettings(env, identity),
    queryCache: queryCacheSettings(env),
    telemetry: telemetrySettings(env),
    writeTools: writeToolsSetting(env, audit, warnings, rateLimits?.write ?? null),
    publicToolCatalog: publicToolCatalogSetting(env, warnings, rateLimits !== null),
    mcpApps: onOff(env, 'RB_MCP_APPS', true),
    warnings,
  };
}

export interface RunningServer {
  /** `http://host:port` actually bound. */
  readonly url: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly settings: ServeSettings;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly platform: string;
  readonly logger: Logger;
  /** NerdGraph fetch override (test hook). */
  readonly fetch?: FetchLike;
  /** Identity provider fetch override (tests). */
  readonly identityFetch?: FetchLike;
  /** CIMD document fetch override (tests). Default: the connect-time guarded fetcher. */
  readonly cimdFetch?: ClientMetadataFetch;
}

/**
 * Boot: master key → database (created `0600` and migrated) → key check (a wrong key refuses to start) → app →
 * listen. Returns once listening. Errors are `ConfigError` / `CryptoError` / `StorageError` (printed by `main`).
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { settings, logger } = options;
  const keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(options.env, options.fs, options.platform));
  // Admin API (P2-09): on only with a bootstrap admin token; checked before the database is touched.
  const adminToken = resolveAdminToken(options.env, options.fs, options.platform);
  if (adminToken !== undefined && adminTokenLooksWeak(adminToken)) {
    logger.warn(ADMIN_TOKEN_WEAK_WARNING);
  }
  const created = !existsSync(settings.dbPath);
  const storage = await openSqliteStorage({ path: settings.dbPath });
  try {
    const { registered, unreadable } = await verifyKeyChecks(storage, keyring);
    if (registered.length > 0) logger.info('master key registered', { versions: registered });
    const unreadableWarning = describeUnreadableKeys(unreadable);
    if (unreadableWarning !== undefined) logger.warn(unreadableWarning, { unreadable });
  } catch (error) {
    await storage.close();
    throw error;
  }
  if (created) logger.info('database created', { path: settings.dbPath });
  for (const w of settings.warnings) logger.warn(w);

  let warnedForwarded = false;
  const getClientIp = (c: Context): string | null => {
    let socketIp: string | undefined;
    try {
      socketIp = getConnInfo(c).remote.address;
    } catch {
      // not served through the Node adaptor (in-process call)
    }
    if (!warnedForwarded && settings.trustedProxyHops === 0 && c.req.header('x-forwarded-for')) {
      warnedForwarded = true;
      logger.warn(
        'X-Forwarded-For seen but RB_TRUSTED_PROXY_HOPS=0: behind a reverse proxy every client shares the ' +
          "proxy's address for rate limiting. Set RB_TRUSTED_PROXY_HOPS to the number of proxies.",
      );
    }
    return resolveClientIp({
      socketIp,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: settings.trustedProxyHops,
    });
  };

  // Two bounded in-memory stores: unauthenticated traffic (IP keys) can't push token/grant buckets out of the other.
  const rateLimitHooks =
    settings.rateLimits === null
      ? undefined
      : createRateLimitHooks({
          limiter: new MemoryRateLimiter(),
          preAuthLimiter: new MemoryRateLimiter(),
          rules: settings.rateLimits,
          logger,
          getClientIp,
        });

  // Audit (P2-08): records after the rate limiter so a refusal is seen by both.
  const audit = settings.audit.enabled
    ? createAuditRecorder({
        storage,
        logger,
        nrql: settings.audit.nrql,
        ...(settings.audit.clientIp ? { getClientIp } : {}),
      })
    : undefined;
  const purgeAudit = (): void => {
    if (audit === undefined || settings.audit.retentionDays <= 0) return;
    audit.purge(settings.audit.retentionDays).then(
      (removed) => {
        if (removed > 0)
          logger.info('audit rows purged', { removed, retentionDays: settings.audit.retentionDays });
      },
      (error: unknown) =>
        logger.warn('audit purge failed', { error: error instanceof Error ? error.name : typeof error }),
    );
  };
  // Expired `kv` rows (P4-09): abandoned logins, unused setup links, ended sessions. Always on, whatever the audit retention.
  let kvPurging = false;
  const purgeKv = (): void => {
    if (kvPurging) return;
    kvPurging = true;
    purgeExpiredKv(storage.kv)
      .then(async (result) => {
        if (result.removed > 0) logger.info('expired kv rows purged', { ...result });
        // Quota counters of long-gone periods (P7-12).
        const usage = await purgeGrantUsage(storage.grantUsage, Date.now());
        if (usage > 0) logger.info('quota counters purged', { removed: usage });
      })
      .then(
        () => {
          kvPurging = false;
        },
        (error: unknown) => {
          kvPurging = false;
          logger.warn('kv purge failed', { error: error instanceof Error ? error.name : typeof error });
        },
      );
  };
  const purgeHousekeeping = (): void => {
    purgeAudit();
    purgeKv();
  };
  purgeHousekeeping();
  const purgeTimer = setInterval(purgeHousekeeping, AUDIT_PURGE_INTERVAL_MS);
  purgeTimer.unref();
  const telemetry =
    settings.telemetry === null
      ? undefined
      : createTelemetry({
          endpoint: settings.telemetry.endpoint,
          headers: settings.telemetry.headers,
          traceSampleRate: settings.telemetry.traceSampleRate,
          runtime: 'node',
          logger,
        });
  const hooks =
    rateLimitHooks === undefined && audit === undefined && telemetry === undefined
      ? undefined
      : mergeHooks(rateLimitHooks, audit?.hooks, telemetry?.hooks);

  const app = createHttpApp({
    storage,
    keyring,
    logger,
    allowedHosts: settings.allowedHosts,
    ...(settings.allowedOrigins === undefined ? {} : { allowedOrigins: settings.allowedOrigins }),
    corsOrigins: settings.corsOrigins,
    ...(settings.accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs: settings.accessCacheTtlMs }),
    hsts: settings.hsts,
    queryCache: createProcessQueryCache(settings.queryCache, keyring.queryCacheKeys().id),
    writeTools: settings.writeTools,
    publicToolCatalog: settings.publicToolCatalog,
    mcpApps: settings.mcpApps,
    // MCP Tasks (P7-13): sealed task records in the `kv` table, purged with the other expired rows.
    taskStore: storage.kv,
    ...(hooks === undefined ? {} : { hooks }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // Admin API: the bootstrap token, admin sessions (sign-in configured, P4-02), or both.
    ...(adminToken === undefined && settings.identity === null
      ? {}
      : {
          admin: {
            ...(adminToken === undefined ? {} : { token: new Secret(adminToken) }),
            storage,
            ...(audit === undefined ? {} : { audit }),
          },
        }),
    ...(settings.passthrough === null
      ? {}
      : { passthrough: { identityTtlMs: settings.passthrough.identityTtlMs } }),
    ...(settings.identity === null
      ? {}
      : {
          identity: {
            publicUrl: settings.identity.publicUrl,
            providers: createIdentityProviders(settings.identity, {
              ...(options.identityFetch === undefined ? {} : { fetch: options.identityFetch }),
            }),
            policy: settings.identity.policy,
            storage,
            // Sign-in ends in an admin session (cookie, CSRF token, roles): `createHttpApp`'s `onLogin`.
            session: { timeouts: settings.identity.session },
            ...(audit === undefined ? {} : { audit }),
          },
        }),
    // OAuth for MCP clients (P5-04): the built-in consent screen, and CIMD through the connect-time SSRF guard.
    ...(settings.oauth === null
      ? {}
      : {
          oauth: {
            ...settings.oauth,
            clientIp: getClientIp,
            clientMetadataDocuments: { fetch: options.cimdFetch ?? createCimdFetch() },
          },
        }),
  });

  const server = createAdaptorServer({
    fetch: app.fetch,
    serverOptions: {
      // Slow-client protection: headers within 20 s, a whole request within 200 s (the app's own MCP deadline is
      // 180 s), idle keep-alive sockets closed after 5 s.
      headersTimeout: 20_000,
      requestTimeout: 200_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16 * 1024,
    },
  }) as Server;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(purgeTimer);
    await storage.close();
    const code = (error as { code?: string }).code;
    throw new ConfigError(
      `Cannot listen on ${settings.host}:${settings.port}${code ? ` (${code})` : ''}.`,
      code === 'EADDRINUSE' ? 'Another process uses this port: pick another with --port.' : undefined,
    );
  }
  server.on('error', (error: Error & { code?: string }) =>
    logger.error('http server error', { error: error.name, code: error.code }),
  );
  const address = server.address() as AddressInfo;
  const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${hostPart}:${address.port}`;
  logger.info('serving MCP over HTTP', {
    version: VERSION,
    url,
    endpoint: `${url}/p/<project>/mcp`,
    db: settings.dbPath,
    allowedHosts: settings.allowedHosts,
    cors: settings.corsOrigins.length > 0,
    rateLimit: settings.rateLimits !== null,
    audit: settings.audit.enabled ? settings.audit.nrql : 'off',
    adminApi:
      adminToken === undefined && settings.identity === null
        ? 'off'
        : `${url}/api/admin/v1 (${[adminToken === undefined ? null : 'token', settings.identity === null ? null : 'sessions'].filter((x) => x !== null).join(', ')})`,
    trustedProxyHops: settings.trustedProxyHops,
    passthrough: settings.passthrough === null ? 'off' : `${url}${PASSTHROUGH_PATH}`,
    oauth:
      settings.oauth === null
        ? 'off'
        : `${settings.identity?.publicUrl ?? url}/oauth/authorize (dcr ${settings.oauth.registration ? 'on' : 'off'})`,
    signIn:
      settings.identity === null
        ? 'off'
        : `${settings.identity.publicUrl}/auth/login (${settings.identity.providers.map((p) => p.kind).join(', ')})`,
  });

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => {
      clearInterval(purgeTimer);
      closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
          // Streams still open after 5 s are cut.
          setTimeout(() => server.closeAllConnections(), 5_000).unref();
        });
        await storage.close();
      })();
      return closing;
    },
  };
}

/** Errors `serve` prints as one log line and exits 1 on. */
export function isBootError(error: unknown): error is ConfigError | CryptoError | StorageError {
  return error instanceof ConfigError || error instanceof CryptoError || error instanceof StorageError;
}
