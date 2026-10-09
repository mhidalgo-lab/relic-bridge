// SPDX-License-Identifier: Apache-2.0
// The Cloudflare Worker host (P3-01): mounts the shared Hono app (`@relic-bridge/http-app`) with Workers plumbing:
// secrets from bindings, `ctx.waitUntil` for background writes, the client address from `CF-Connecting-IP`, and a
// per-isolate runtime (keyring with its imported CryptoKeys, access cache, rate-limit buckets, the app) built lazily
// on the first request. The runtime holds configuration and caches only, never request data (THREAT_MODEL T21).
import type { ExecutionContext } from '@cloudflare/workers-types';
import { CryptoError, loadKeyringFromEnv, verifyKeyChecks } from '@relic-bridge/auth';
import { createLogger, type FetchLike, type Logger, type LogSink, Secret, VERSION } from '@relic-bridge/core';
import {
  checkAdminToken,
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  DEFAULT_RATE_LIMITS,
  MemoryRateLimiter,
  mergeHooks,
  normalizeClientIp,
  SECURITY_HEADERS,
} from '@relic-bridge/http-app';
import { type Storage, StorageError } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import type { Context } from 'hono';
import type { WorkerEnv } from './env.ts';
import { parseWorkerSettings, WorkerConfigError, type WorkerSettings } from './settings.ts';

/** After a failed boot, requests within this window answer 503 at once instead of retrying the boot. */
export const BOOT_RETRY_MS = 5_000;

/** Opens the storage for this isolate (default: D1). */
export type OpenStorage = (env: WorkerEnv) => Storage | Promise<Storage>;

/** The storage could not be opened (no adapter, missing binding). */
export class WorkerStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerStorageUnavailableError';
  }
}

/**
 * Default storage: the D1 adapter on the `DB` binding (P3-02). Pending migrations are applied here, so they run once
 * per isolate as part of the lazy boot; a missing binding fails the boot closed.
 */
export const openD1Storage: OpenStorage = (env) => {
  if (env.DB === undefined) throw new WorkerStorageUnavailableError('the DB (D1) binding is missing');
  return createD1Storage(env.DB);
};

export interface WorkerOptions {
  /** Storage factory (tests inject the in-memory adapter). Default: `openD1Storage`. */
  readonly openStorage?: OpenStorage;
  /** NerdGraph fetch override (tests). */
  readonly fetch?: FetchLike;
  /** Log sink override (tests). Default: `console.error` → Workers Logs. */
  readonly logSink?: LogSink;
  /** Epoch-ms clock for the boot retry window (tests). */
  readonly now?: () => number;
}

/** The module Worker's `fetch` handler (typed with the web `Request`/`Response` the shared app uses). */
export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
}

/** What one isolate keeps between requests: configuration and caches, no request data. */
interface Runtime {
  readonly settings: WorkerSettings;
  readonly log: Logger;
  readonly adminApi: boolean;
  readonly app: {
    fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response>;
  };
}

/** The client address for rate limits and audit: Cloudflare sets `CF-Connecting-IP` and clients cannot override it. */
export const workersClientIp = (c: Context): string | null =>
  normalizeClientIp(c.req.header('cf-connecting-ip'));

/** Why a boot failed, for one log line. Messages of our own errors never contain secret values. */
function bootFailure(error: unknown): Record<string, unknown> {
  if (error instanceof WorkerConfigError)
    return { error: error.name, variable: error.variable, detail: error.message };
  if (error instanceof CryptoError) return { error: error.name, code: error.code, detail: error.message };
  if (error instanceof StorageError) return { error: error.name, code: error.code };
  if (error instanceof WorkerStorageUnavailableError) return { error: error.name, detail: error.message };
  return { error: error instanceof Error ? error.name : typeof error };
}

function unavailable(): Response {
  return new Response('{"error":"unavailable"}', {
    status: 503,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Retry-After': '5' },
  });
}

async function boot(env: WorkerEnv, options: WorkerOptions): Promise<Runtime> {
  const settings = parseWorkerSettings(env);
  const log = createLogger({
    level: settings.logLevel,
    ...(options.logSink === undefined ? {} : { sink: options.logSink }),
  });
  const keyring = await loadKeyringFromEnv({
    RB_MASTER_KEY: env.RB_MASTER_KEY,
    RB_MASTER_KEY_PREVIOUS: env.RB_MASTER_KEY_PREVIOUS,
  });

  const adminRaw = typeof env.RB_ADMIN_TOKEN === 'string' ? env.RB_ADMIN_TOKEN.trim() : '';
  if (adminRaw !== '') {
    const problem = checkAdminToken(adminRaw);
    if (problem !== null) {
      throw new WorkerConfigError('RB_ADMIN_TOKEN', `RB_ADMIN_TOKEN is ${problem.replace('_', ' ')}`);
    }
  }

  const storage = await (options.openStorage ?? openD1Storage)(env);
  const { registered } = await verifyKeyChecks(storage, keyring);
  if (registered.length > 0) log.info('master key registered', { versions: registered });

  // Interim limiter: buckets per isolate (P3-04 adds the Rate Limiting binding as the shared store). Two stores so
  // unauthenticated traffic can't push token/grant buckets out.
  const rateLimitHooks = settings.rateLimit
    ? createRateLimitHooks({
        limiter: new MemoryRateLimiter(),
        preAuthLimiter: new MemoryRateLimiter(),
        rules: DEFAULT_RATE_LIMITS,
        logger: log,
        getClientIp: workersClientIp,
      })
    : undefined;
  const audit = settings.audit.enabled
    ? createAuditRecorder({
        storage,
        logger: log,
        nrql: settings.audit.nrql,
        ...(settings.audit.clientIp ? { getClientIp: workersClientIp } : {}),
      })
    : undefined;
  const hooks =
    rateLimitHooks === undefined && audit === undefined
      ? undefined
      : mergeHooks(rateLimitHooks, audit?.hooks);

  const app = createHttpApp({
    storage,
    keyring,
    logger: log,
    allowedHosts: settings.allowedHosts,
    ...(settings.allowedOrigins === undefined ? {} : { allowedOrigins: settings.allowedOrigins }),
    corsOrigins: settings.corsOrigins,
    ...(settings.accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs: settings.accessCacheTtlMs }),
    callBudget: settings.callBudget,
    maxResponseBytes: settings.maxResponseBytes,
    concurrencyPerCredential: settings.concurrency,
    // Background work (audit rows) must outlive the response: the runtime cancels unawaited promises otherwise.
    waitUntil: (c, task) => c.executionCtx.waitUntil(task),
    ...(hooks === undefined ? {} : { hooks }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(adminRaw === ''
      ? {}
      : { admin: { token: new Secret(adminRaw), storage, ...(audit === undefined ? {} : { audit }) } }),
  });

  return { settings, log, adminApi: adminRaw !== '', app };
}

/**
 * The Worker's handler. One instance per isolate (the default export), so its runtime cache is per isolate: an
 * admin change clears only the serving isolate's access cache; other isolates follow within the cache TTL.
 *
 * A request that finds no runtime boots one itself and never awaits another request's boot: the boot does storage
 * I/O, and workerd ties I/O to the request that started it (a promise settled from a request that was cancelled
 * meanwhile would leave its waiters hanging). Concurrent cold requests therefore each boot; the first runtime to finish
 * is kept and the others are dropped, so every later request shares one set of caches.
 */
export function createWorker(options: WorkerOptions = {}): WorkerHandler {
  const now = options.now ?? Date.now;
  const logger = createLogger(options.logSink === undefined ? {} : { sink: options.logSink });
  // `env` is fixed for an isolate's lifetime (new secrets or vars mean a new deployment and new isolates); keying the
  // cache on it still rebuilds when a caller hands in a different one (tests).
  let ready: { readonly env: WorkerEnv; readonly runtime: Runtime } | undefined;
  let failed: { readonly env: WorkerEnv; readonly at: number } | undefined;

  const runtimeFor = async (env: WorkerEnv): Promise<Runtime | null> => {
    if (ready?.env === env) return ready.runtime;
    if (failed?.env === env && now() - failed.at < BOOT_RETRY_MS) return null;
    let runtime: Runtime;
    try {
      runtime = await boot(env, options);
    } catch (error) {
      logger.error('worker boot failed', bootFailure(error));
      failed = { env, at: now() };
      return null;
    }
    // Another request may have finished booting first: keep its runtime (one set of caches per isolate).
    if (ready?.env === env) return ready.runtime;
    ready = { env, runtime };
    failed = undefined;
    const { settings } = runtime;
    for (const w of settings.warnings) runtime.log.warn(w);
    runtime.log.info('worker runtime ready', {
      version: VERSION,
      plan: settings.plan,
      callBudget: settings.callBudget,
      maxResponseBytes: settings.maxResponseBytes,
      concurrency: settings.concurrency,
      adminApi: runtime.adminApi,
      audit: settings.audit.enabled ? settings.audit.nrql : 'off',
      rateLimit: settings.rateLimit ? 'isolate' : 'off',
    });
    return runtime;
  };

  return {
    async fetch(request, env, ctx) {
      const runtime = await runtimeFor(env);
      if (runtime === null) return unavailable();
      return runtime.app.fetch(request, env, ctx);
    },
  };
}
