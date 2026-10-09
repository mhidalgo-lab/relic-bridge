// SPDX-License-Identifier: Apache-2.0
// `relic-bridge serve` (P2-06): the HTTP app on Node (`@hono/node-server`) with SQLite storage. Everything
// runtime-specific lives here; the app itself (`@relic-bridge/http-app`) is web-standard.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { CryptoError, loadKeyringFromEnv, verifyKeyChecks } from '@relic-bridge/auth';
import { type FetchLike, type Logger, VERSION } from '@relic-bridge/core';
import {
  createHttpApp,
  defaultAllowedHostnames,
  MAX_ACCESS_CACHE_TTL_MS,
  originHostname,
} from '@relic-bridge/http-app';
import { StorageError } from '@relic-bridge/storage';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { ConfigError, type ConfigFs, type Env } from './config.ts';
import { resolveMasterKeyEnv } from './keys.ts';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';
export const DB_FILE_NAME = 'relic-bridge.db';

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

export interface ServeSettings {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly allowedHosts: readonly string[] | '*';
  readonly allowedOrigins?: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly accessCacheTtlMs?: number;
  readonly hsts: 'auto' | boolean;
  readonly warnings: readonly string[];
}

/** Validate flags and `RB_*` variables for `serve`. Throws `ConfigError` with a hint. */
export function serveSettings(input: {
  readonly port?: string;
  readonly host?: string;
  readonly db?: string;
  readonly env: Env;
  readonly platform: string;
  readonly homeDir?: string;
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

  return {
    port: Number(portRaw),
    host,
    dbPath: resolveDbPath(input.db, env, input.platform, input.homeDir),
    allowedHosts,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    corsOrigins,
    ...(accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs }),
    hsts,
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
}

/**
 * Boot: master key → database (created `0600` and migrated) → key check (a wrong key refuses to start) → app →
 * listen. Returns once listening. Errors are `ConfigError` / `CryptoError` / `StorageError` (printed by `main`).
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { settings, logger } = options;
  const keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(options.env, options.fs, options.platform));
  const created = !existsSync(settings.dbPath);
  const storage = await openSqliteStorage({ path: settings.dbPath });
  try {
    const { registered } = await verifyKeyChecks(storage, keyring);
    if (registered.length > 0) logger.info('master key registered', { versions: registered });
  } catch (error) {
    await storage.close();
    throw error;
  }
  if (created) logger.info('database created', { path: settings.dbPath });
  for (const w of settings.warnings) logger.warn(w);

  const app = createHttpApp({
    storage,
    keyring,
    logger,
    allowedHosts: settings.allowedHosts,
    ...(settings.allowedOrigins === undefined ? {} : { allowedOrigins: settings.allowedOrigins }),
    corsOrigins: settings.corsOrigins,
    ...(settings.accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs: settings.accessCacheTtlMs }),
    hsts: settings.hsts,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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
  });

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => {
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
