// SPDX-License-Identifier: Apache-2.0
// The Cloudflare Worker host (P3-01): mounts the shared Hono app (`@relic-bridge/http-app`) with Workers plumbing:
// secrets from bindings, `ctx.waitUntil` for background writes, the client address from `CF-Connecting-IP`, and a
// per-isolate runtime (keyring with its imported CryptoKeys, access cache, rate-limit buckets, the app) built lazily
// on the first request. The runtime holds configuration and caches only, never request data (THREAT_MODEL T21).
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { CryptoError, loadKeyringFromEnv, verifyKeyChecks } from '@relic-bridge/auth';
import { createLogger, type FetchLike, type Logger, type LogSink, Secret, VERSION } from '@relic-bridge/core';
import {
  checkAdminToken,
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  DEFAULT_RATE_LIMITS,
  mergeHooks,
  normalizeClientIp,
  SECURITY_HEADERS,
} from '@relic-bridge/http-app';
import { type Storage, StorageError } from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import type { Context } from 'hono';
import type { WorkerEnv } from './env.ts';
import { WorkersRateLimiter } from './rate-limit.ts';
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
  /** Cap on refusal rows per minute (tests that provoke thousands of refusals). Default: the recorder's. */
  readonly auditMaxAuthRowsPerMinute?: number;
  /** Epoch-ms clock for the boot retry window (tests). */
  readonly now?: () => number;
  /** Retention purge budget per run (tests). Default: `PURGE_BATCH_ROWS`, `PURGE_MAX_BATCHES`, `PURGE_BUDGET_MS`. */
  readonly purge?: Partial<PurgeBudget>;
}

/** What one scheduled run may spend on deleting audit rows. */
export interface PurgeBudget {
  /** Rows per DELETE statement (keeps each statement small for D1). */
  readonly batchRows: number;
  /** Statements per run. */
  readonly maxBatches: number;
  /** Wall-clock budget; no new batch starts after it. */
  readonly budgetMs: number;
}

/**
 * Defaults: 500-row batches, 20 per run (10,000 rows), 10 s. Each DELETE is one D1 query (the Free plan allows 50 D1
 * queries per invocation); a backlog beyond the budget is finished by the next run, so an hourly trigger clears
 * 240,000 rows a day at most, far above what the audit caps allow.
 */
export const DEFAULT_PURGE_BUDGET: PurgeBudget = Object.freeze({
  batchRows: 500,
  maxBatches: 20,
  budgetMs: 10_000,
});

/** The module Worker's `fetch` handler (typed with the web `Request`/`Response` the shared app uses). */
export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
  /** Cron trigger (P3-08): deletes audit rows past the retention period. Never rejects. */
  scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void>;
}

/** What one isolate keeps between requests: configuration and caches, no request data. */
interface Runtime {
  readonly settings: WorkerSettings;
  readonly log: Logger;
  readonly adminApi: boolean;
  /** Where rate limits are counted: the binding plus the isolate, the isolate alone, or nowhere. */
  readonly limiter: 'binding+isolate' | 'isolate' | 'off';
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

  // Shared limiter (Rate Limiting binding) plus per-isolate buckets (P3-04, src/rate-limit.ts). Two instances so
  // unauthenticated traffic can't push token/grant buckets out of the bounded isolate store.
  const binding = settings.rateLimit ? env.RATE_LIMITER : undefined;
  if (settings.rateLimit && binding === undefined) {
    log.warn('RATE_LIMITER binding missing: rate limits are per isolate only (weaker).');
  }
  const rateLimitHooks = settings.rateLimit
    ? createRateLimitHooks({
        limiter: new WorkersRateLimiter({ binding }),
        preAuthLimiter: new WorkersRateLimiter({ binding }),
        rules: DEFAULT_RATE_LIMITS,
        logger: log,
        getClientIp: workersClientIp,
      })
    : undefined;

  // Pass-through keys are fingerprinted under a secret every isolate shares, so one key maps to one limiter bucket
  // everywhere; without the binding the per-key limit would be per isolate, so that fails the boot too.
  let fingerprintSecret: Secret | undefined;
  if (settings.passthrough) {
    const raw = typeof env.RB_FINGERPRINT_SECRET === 'string' ? env.RB_FINGERPRINT_SECRET.trim() : '';
    if (new TextEncoder().encode(raw).length < 32) {
      throw new WorkerConfigError(
        'RB_FINGERPRINT_SECRET',
        'RB_PASSTHROUGH=on needs the RB_FINGERPRINT_SECRET secret (at least 32 bytes; `openssl rand -base64 32`)',
      );
    }
    if (binding === undefined) {
      throw new WorkerConfigError('RATE_LIMITER', 'RB_PASSTHROUGH=on needs the RATE_LIMITER binding');
    }
    fingerprintSecret = new Secret(raw);
  }
  const audit = settings.audit.enabled
    ? createAuditRecorder({
        storage,
        logger: log,
        nrql: settings.audit.nrql,
        ...(options.auditMaxAuthRowsPerMinute === undefined
          ? {}
          : { maxAuthRowsPerMinute: options.auditMaxAuthRowsPerMinute }),
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
    ...(fingerprintSecret === undefined ? {} : { passthrough: { fingerprintSecret } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(adminRaw === ''
      ? {}
      : { admin: { token: new Secret(adminRaw), storage, ...(audit === undefined ? {} : { audit }) } }),
  });

  const limiter = !settings.rateLimit ? 'off' : binding === undefined ? 'isolate' : 'binding+isolate';
  return { settings, log, adminApi: adminRaw !== '', limiter, app };
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
      rateLimit: runtime.limiter,
      passthrough: settings.passthrough,
    });
    return runtime;
  };

  /**
   * Audit retention (P3-08), the same policy as `relic-bridge audit purge` (`recorder.purge`, `RB_AUDIT_RETENTION_DAYS`).
   * Needs no master key, so it does not boot the runtime (a bad key must not stop the cleanup). Deletes oldest rows
   * first in bounded batches and stops at the budget; the next run resumes. Failures are logged, never thrown.
   */
  const purgeAudit = async (env: WorkerEnv): Promise<void> => {
    try {
      const settings = parseWorkerSettings(env);
      const log = createLogger({
        level: settings.logLevel,
        ...(options.logSink === undefined ? {} : { sink: options.logSink }),
      });
      const days = settings.audit.retentionDays;
      if (days <= 0) {
        log.info('audit purge skipped', { reason: 'retention is 0 (keep everything)' });
        return;
      }
      const budget = { ...DEFAULT_PURGE_BUDGET, ...options.purge };
      const storage = await (options.openStorage ?? openD1Storage)(env);
      const recorder = createAuditRecorder({ storage, logger: log });
      const started = now();
      let removed = 0;
      let batches = 0;
      let complete = false;
      while (batches < budget.maxBatches && now() - started < budget.budgetMs) {
        const n = await recorder.purge(days, { limit: budget.batchRows });
        batches++;
        removed += n;
        if (n < budget.batchRows) {
          complete = true;
          break;
        }
      }
      if (removed > 0) {
        await recorder.admin({
          actor: {},
          action: 'audit.purge',
          targetType: 'audit_log',
          details: { removed, olderThanDays: days, source: 'cron' },
        });
      }
      log.info('audit purge finished', { removed, batches, retentionDays: days, complete });
    } catch (error) {
      logger.error('audit purge failed', bootFailure(error));
    }
  };

  return {
    async scheduled(_controller, env) {
      await purgeAudit(env);
    },
    async fetch(request, env, ctx) {
      const runtime = await runtimeFor(env);
      if (runtime === null) return unavailable();
      return runtime.app.fetch(request, env, ctx);
    },
  };
}
