// SPDX-License-Identifier: Apache-2.0
// The Cloudflare Worker host (P3-01): mounts the shared Hono app (`@relic-bridge/http-app`) with Workers plumbing:
// secrets from bindings, `ctx.waitUntil` for background writes, the client address from `CF-Connecting-IP`, and a
// per-isolate runtime (keyring with its imported CryptoKeys, access cache, rate-limit buckets, the app) built lazily
// on the first request. The runtime holds configuration and caches only, never request data (THREAT_MODEL T21).
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
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
  type CacheApiLike,
  CacheApiQueryCacheStore,
  createLogger,
  type FetchLike,
  type Logger,
  type LogSink,
  MemoryQueryCacheStore,
  QueryCache,
  type QueryCacheStore,
  Secret,
  VERSION,
} from '@relic-bridge/core';
import {
  ADMIN_TOKEN_ADVICE,
  adminTokenLooksWeak,
  checkAdminToken,
  checkHost,
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  createTelemetry,
  DEFAULT_RATE_LIMITS,
  describeAdminTokenProblem,
  HSTS_VALUE,
  mergeHooks,
  normalizeClientIp,
  OAuthConfigError,
  type OAuthOptions,
  oauthSettingsFromEnv,
  SECURITY_HEADERS,
  TelemetryConfigError,
  telemetrySettingsFromEnv,
} from '@relic-bridge/http-app';
import {
  type KvPurgeBudget,
  purgeExpiredKv,
  purgeGrantUsage,
  type Storage,
  StorageError,
} from '@relic-bridge/storage';
import { createD1Storage } from '@relic-bridge/storage/d1';
import type { Context } from 'hono';
import { strictlyPublicCimdFetch } from './cimd-fetch.ts';
import type { WorkerEnv } from './env.ts';
import { WorkersRateLimiter } from './rate-limit.ts';
import {
  FREE_ROTATION_BATCH,
  parseWorkerSettings,
  WorkerConfigError,
  type WorkerSettings,
} from './settings.ts';
import { createDurableQuotaStore, createSharedConcurrency } from './shared-limiter.ts';

/**
 * After failed boots, requests answer 503 at once instead of retrying: 5 s after the first failure, 15 s after the
 * second, 60 s after the third and every later one. A successful boot resets the sequence.
 */
export const BOOT_BACKOFF_MS: readonly number[] = Object.freeze([5_000, 15_000, 60_000]);
/** The first backoff step. */
export const BOOT_RETRY_MS = BOOT_BACKOFF_MS[0] as number;
/** How long a request waits for another request's boot before it boots itself (default). */
export const BOOT_WAIT_MS = 3_000;

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
  /** Identity provider fetch override (tests: the mock IdP). */
  readonly identityFetch?: FetchLike;
  /** Log sink override (tests). Default: `console.error` → Workers Logs. */
  readonly logSink?: LogSink;
  /** Cap on refusal rows per minute (tests that provoke thousands of refusals). Default: the recorder's. */
  readonly auditMaxAuthRowsPerMinute?: number;
  /** Fetch for the OTLP self-monitoring exporter (tests: a mock receiver). */
  readonly telemetryFetch?: FetchLike;
  /** Epoch-ms clock for the boot backoff (tests). */
  readonly now?: () => number;
  /** How long a request waits for the boot in flight before it boots itself (tests). Default: `BOOT_WAIT_MS`. */
  readonly bootWaitMs?: number;
  /** Retention purge budget per run (tests). Default: `PURGE_BATCH_ROWS`, `PURGE_MAX_BATCHES`, `PURGE_BUDGET_MS`. */
  readonly purge?: Partial<PurgeBudget>;
  /** Expired `kv` row purge budget per run (tests). Default: `DEFAULT_KV_PURGE_BUDGET`. */
  readonly kvPurge?: Partial<KvPurgeBudget>;
  /**
   * The OAuth 2.1 server (P5-01; needs sign-in, `RB_PUBLIC_URL`), overriding the `RB_OAUTH*` variables (tests). A
   * deployment turns it on with `RB_OAUTH=on` (P5-04).
   */
  readonly oauth?: OAuthOptions;
  /** Cache API override for the query cache (tests). Default: `caches.open(QUERY_CACHE_NAME)` when available. */
  readonly queryCacheApi?: CacheApiLike;
}

/** Named Cache API cache of the NRQL query cache (P7-02). */
export const QUERY_CACHE_NAME = 'relic-bridge-query-cache';

/**
 * The query cache for one isolate (P7-02): the isolate's memory LRU, then (mode `on`) the colo's Cache API with
 * bodies encrypted under a master-key-derived key. Entry ids are keyed with the master key too, so every isolate of a
 * deployment computes the same id and no one without the key can link an id to a query.
 */
export function createWorkerQueryCache(
  settings: WorkerSettings['queryCache'],
  keys: { readonly id: CryptoKey; readonly data: CryptoKey },
  cacheApi?: CacheApiLike,
): QueryCache | null {
  if (settings.mode === 'off') return null;
  const stores: QueryCacheStore[] = [new MemoryQueryCacheStore()];
  const storage = (globalThis as { caches?: { open(name: string): Promise<CacheApiLike> } }).caches;
  if (settings.mode === 'on' && (cacheApi !== undefined || storage !== undefined)) {
    stores.push(
      new CacheApiQueryCacheStore({
        cache:
          cacheApi ??
          (() => (storage as { open(name: string): Promise<CacheApiLike> }).open(QUERY_CACHE_NAME)),
        aesKey: keys.data,
      }),
    );
  }
  return new QueryCache({ stores, macKey: keys.id, policy: { relativeTtlMs: settings.relativeTtlMs } });
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
 * Defaults: 500-row batches, 20 per run (10,000 rows), 10 s. Each DELETE is one D1 query (budgeted against the stricter
 * of Cloudflare's two published limits, 50 D1 queries per invocation on Free; see docs/RESEARCH.md); a backlog beyond the budget is finished by the next run, so an hourly trigger clears
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
  /** Sign-in provider ids (empty: sign-in off). */
  readonly identity: readonly string[];
  /** OAuth for MCP clients is on (P5-04). */
  readonly oauth: boolean;
  /** Where rate limits are counted: the binding plus the isolate, the isolate alone, or nowhere. */
  readonly limiter: 'binding+isolate' | 'isolate' | 'off';
  /** What the Durable Object limiter counts (P7-10); `off` without `RB_SHARED_LIMITER` or the binding. */
  readonly shared: 'rules+concurrency' | 'rules' | 'concurrency' | 'off';
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

function unavailable(retryAfterSeconds: number): Response {
  return new Response('{"error":"unavailable"}', {
    status: 503,
    headers: {
      ...SECURITY_HEADERS,
      // Built outside the app's header middleware; Workers are only reached over https (P8-66).
      'Strict-Transport-Security': HSTS_VALUE,
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
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
      throw new WorkerConfigError(
        'RB_ADMIN_TOKEN',
        `RB_ADMIN_TOKEN is ${describeAdminTokenProblem(problem)}. ${ADMIN_TOKEN_ADVICE}`,
      );
    }
    // Once per isolate boot; the token itself is never logged.
    if (adminTokenLooksWeak(adminRaw)) {
      log.warn(
        'RB_ADMIN_TOKEN does not look randomly generated; the admin API is reachable from the internet. ' +
          ADMIN_TOKEN_ADVICE,
      );
    }
  }

  let identity: IdentitySettings | null;
  try {
    identity = identitySettingsFromEnv(env as unknown as Record<string, string | undefined>);
  } catch (error) {
    if (error instanceof IdentityConfigError) throw new WorkerConfigError(error.variable, error.message);
    throw error;
  }
  if (identity !== null) {
    for (const w of identity.warnings) log.warn(w);
    if (
      settings.allowedHosts !== '*' &&
      !checkHost(new URL(identity.publicUrl).hostname, settings.allowedHosts).ok
    ) {
      throw new WorkerConfigError(
        'RB_PUBLIC_URL',
        'RB_PUBLIC_URL must name a host listed in RB_ALLOWED_HOSTS.',
      );
    }
  }

  // OAuth for MCP clients (P5-04): `RB_OAUTH=on`, the built-in consent screen, CIMD only with the strictly-public
  // fetch flag (ADR-0012). A programmatic `options.oauth` (tests) wins.
  let oauth: OAuthOptions | undefined = options.oauth;
  if (oauth === undefined) {
    let oauthSettings: ReturnType<typeof oauthSettingsFromEnv>;
    try {
      oauthSettings = oauthSettingsFromEnv(env as unknown as Record<string, unknown>, identity !== null);
    } catch (error) {
      if (error instanceof OAuthConfigError) throw new WorkerConfigError(error.variable, error.message);
      throw error;
    }
    if (oauthSettings !== null) {
      const cimd = strictlyPublicCimdFetch();
      if (cimd === null) {
        log.warn(
          'RB_OAUTH=on without the global_fetch_strictly_public compatibility flag: Client ID Metadata Documents are off (claude.ai falls back to dynamic registration).',
        );
      }
      oauth = { ...oauthSettings, ...(cimd === null ? {} : { clientMetadataDocuments: { fetch: cimd } }) };
    }
  }

  const storage = await (options.openStorage ?? openD1Storage)(env);
  const { registered, unreadable } = await verifyKeyChecks(storage, keyring);
  if (registered.length > 0) log.info('master key registered', { versions: registered });
  const unreadableWarning = describeUnreadableKeys(unreadable);
  if (unreadableWarning !== undefined) log.warn(unreadableWarning, { unreadable });

  // Shared limiter (Rate Limiting binding) plus per-isolate buckets (P3-04, src/rate-limit.ts). Two instances so
  // unauthenticated traffic can't push token/grant buckets out of the bounded isolate store.
  const binding = settings.rateLimit ? env.RATE_LIMITER : undefined;
  if (settings.rateLimit && binding === undefined) {
    log.warn('RATE_LIMITER binding missing: rate limits are per isolate only (weaker).');
  }
  // The Durable Object limiter (P7-10): opt-in; without the binding everything stays as it was, with a warning.
  const sharedNs = settings.sharedLimiter === 'off' ? undefined : env.SHARED_LIMITER;
  if (settings.sharedLimiter !== 'off' && sharedNs === undefined) {
    log.warn(
      `RB_SHARED_LIMITER=${settings.sharedLimiter} but the SHARED_LIMITER binding is missing: limits stay per isolate.`,
    );
  }
  const durable = settings.rateLimit ? sharedNs : undefined;
  const rateLimitHooks = settings.rateLimit
    ? createRateLimitHooks({
        limiter: new WorkersRateLimiter({ binding, durable, logger: log }),
        preAuthLimiter: new WorkersRateLimiter({ binding, durable, logger: log }),
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
  // Self-monitoring (P7-08): off unless RB_OTEL=on; the endpoint and headers (license key) come from env/secrets only.
  let telemetryConfig: ReturnType<typeof telemetrySettingsFromEnv>;
  try {
    telemetryConfig = telemetrySettingsFromEnv(env as Record<string, unknown>);
  } catch (error) {
    if (error instanceof TelemetryConfigError) throw new WorkerConfigError('RB_OTEL', error.message);
    throw error;
  }
  const telemetry =
    telemetryConfig === null
      ? undefined
      : createTelemetry({
          endpoint: telemetryConfig.endpoint,
          headers: telemetryConfig.headers,
          traceSampleRate: telemetryConfig.traceSampleRate,
          acceptTraceparent: telemetryConfig.acceptTraceparent,
          runtime: 'workers',
          logger: log,
          ...(options.telemetryFetch === undefined ? {} : { fetch: options.telemetryFetch }),
        });
  const hooks =
    rateLimitHooks === undefined && audit === undefined && telemetry === undefined
      ? undefined
      : mergeHooks(rateLimitHooks, audit?.hooks, telemetry?.hooks);

  const identityProviders =
    identity === null
      ? undefined
      : createIdentityProviders(identity, {
          ...(options.identityFetch === undefined ? {} : { fetch: options.identityFetch }),
        });

  const app = createHttpApp({
    storage,
    keyring,
    // With telemetry on, the request logs are also exported as OTLP logs (allowlisted; flushed with the next call).
    logger: telemetry === undefined ? log : telemetry.wrapLogger(log),
    allowedHosts: settings.allowedHosts,
    ...(settings.allowedOrigins === undefined ? {} : { allowedOrigins: settings.allowedOrigins }),
    corsOrigins: settings.corsOrigins,
    ...(settings.accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs: settings.accessCacheTtlMs }),
    callBudget: settings.callBudget,
    maxResponseBytes: settings.maxResponseBytes,
    concurrencyPerCredential: settings.concurrency,
    ...(settings.sharedLimiter === 'on' && sharedNs !== undefined
      ? { sharedConcurrency: createSharedConcurrency(sharedNs, { max: settings.concurrency, logger: log }) }
      : {}),
    // Quota counters in the shared limiter's `quota:` objects when it is on (a D1 write per call saved), else storage.
    ...(settings.sharedLimiter === 'on' && sharedNs !== undefined
      ? { quotaStore: createDurableQuotaStore(sharedNs, { fallback: storage.grantUsage, logger: log }) }
      : {}),
    queryCache: createWorkerQueryCache(settings.queryCache, keyring.queryCacheKeys(), options.queryCacheApi),
    writeTools: settings.writeTools,
    requireWriteApproval: settings.requireWriteApproval,
    publicToolCatalog: settings.publicToolCatalog,
    mcpApps: settings.mcpApps,
    tasks: settings.tasks,
    // MCP Tasks (P7-13): sealed task records in D1 `kv`, purged by the hourly cron with the other expired rows.
    taskStore: storage.kv,
    approvalStore: storage.kv,
    // Background work (audit rows) must outlive the response: the runtime cancels unawaited promises otherwise.
    waitUntil: (c, task) => c.executionCtx.waitUntil(task),
    ...(hooks === undefined ? {} : { hooks }),
    ...(fingerprintSecret === undefined ? {} : { passthrough: { fingerprintSecret } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(identityProviders === undefined || identity === null
      ? {}
      : {
          identity: {
            publicUrl: identity.publicUrl,
            providers: identityProviders,
            policy: identity.policy,
            storage,
            // Sign-in ends in an admin session (cookie, CSRF token, roles): `createHttpApp`'s `onLogin` (P4-02).
            session: { timeouts: identity.session },
            ...(audit === undefined ? {} : { audit }),
          },
        }),
    ...(oauth === undefined ? {} : { oauth: { clientIp: workersClientIp, ...oauth } }),
    // Admin API: the bootstrap token, admin sessions (sign-in configured, P4-02), or both.
    ...(adminRaw === '' && identityProviders === undefined
      ? {}
      : {
          admin: {
            ...(adminRaw === '' ? {} : { token: new Secret(adminRaw) }),
            storage,
            ...(audit === undefined ? {} : { audit }),
            // Budget 50 D1 queries per invocation on Free (the D1 limits page; the Workers page says 1,000, see RESEARCH); a rotation batch costs about its size plus 5 (P3-15).
            ...(settings.plan === 'free' ? { maxRotationBatch: FREE_ROTATION_BATCH } : {}),
          },
        }),
  });

  const limiter = !settings.rateLimit ? 'off' : binding === undefined ? 'isolate' : 'binding+isolate';
  const shared: Runtime['shared'] =
    sharedNs === undefined
      ? 'off'
      : settings.sharedLimiter === 'on'
        ? settings.rateLimit
          ? 'rules+concurrency'
          : 'concurrency'
        : settings.rateLimit
          ? 'rules'
          : 'off';
  return {
    shared,
    settings,
    log,
    adminApi: adminRaw !== '' || identityProviders !== undefined,
    identity: (identityProviders ?? []).map((p) => p.id),
    oauth: oauth !== undefined && identityProviders !== undefined,
    limiter,
    app,
  };
}

/**
 * The Worker's handler. One instance per isolate (the default export), so its runtime cache is per isolate: an
 * admin change clears only the serving isolate's access cache; other isolates follow within the cache TTL.
 *
 * Boot is single-flight per isolate (P3-12): the first request that finds no runtime starts the boot and concurrent
 * requests wait for that promise, so a cold isolate opens the storage once however many requests arrive. workerd ties
 * I/O to the request that started it, so a boot whose owner was cancelled may never settle; a waiter therefore waits
 * at most `bootWaitMs`, then starts a boot of its own (which later waiters share). Failed boots back off
 * (`BOOT_BACKOFF_MS`) and are logged once, by the request that ran the boot. The promise and the failure record hold
 * no request data (T21).
 */
export function createWorker(options: WorkerOptions = {}): WorkerHandler {
  const now = options.now ?? Date.now;
  const bootWaitMs = options.bootWaitMs ?? BOOT_WAIT_MS;
  const logger = createLogger(options.logSink === undefined ? {} : { sink: options.logSink });
  // `env` is fixed for an isolate's lifetime (new secrets or vars mean a new deployment and new isolates); keying the
  // cache on it still rebuilds when a caller hands in a different one (tests).
  let ready: { readonly env: WorkerEnv; readonly runtime: Runtime } | undefined;
  let inflight: { readonly env: WorkerEnv; readonly promise: Promise<Runtime | null> } | undefined;
  /** The most recent boot, settled or not: a waiter that times out joins it if it is newer than the one it waited for. */
  let latest: { readonly env: WorkerEnv; readonly promise: Promise<Runtime | null> } | undefined;
  let failed: { readonly env: WorkerEnv; readonly until: number; readonly count: number } | undefined;

  /** Boots once and records the outcome; never rejects. */
  const bootOnce = async (env: WorkerEnv): Promise<Runtime | null> => {
    let runtime: Runtime;
    try {
      runtime = await boot(env, options);
    } catch (error) {
      logger.error('worker boot failed', bootFailure(error));
      const count = failed?.env === env ? failed.count : 0;
      const step = BOOT_BACKOFF_MS[Math.min(count, BOOT_BACKOFF_MS.length - 1)] as number;
      failed = { env, until: now() + step, count: count + 1 };
      return null;
    }
    // Another boot (a waiter that gave up on a stuck one) may have finished first: keep its runtime.
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
      signIn: runtime.identity,
      audit: settings.audit.enabled ? settings.audit.nrql : 'off',
      rateLimit: runtime.limiter,
      sharedLimiter: runtime.shared,
      passthrough: settings.passthrough,
      oauth: runtime.oauth,
      queryCache: settings.queryCache.mode,
    });
    return runtime;
  };

  const startBoot = (env: WorkerEnv): Promise<Runtime | null> => {
    const promise = bootOnce(env);
    const entry = { env, promise };
    inflight = entry;
    latest = entry;
    void promise.then(() => {
      if (inflight === entry) inflight = undefined;
    });
    return promise;
  };

  /** The runtime, or the seconds after which a retry makes sense. */
  const runtimeFor = async (env: WorkerEnv): Promise<Runtime | number> => {
    if (ready?.env === env) return ready.runtime;
    const backoff = (): number =>
      failed === undefined ? 1 : Math.max(1, Math.ceil((failed.until - now()) / 1000));
    if (failed?.env === env && now() < failed.until) return backoff();

    let result: Runtime | null;
    const current = inflight?.env === env ? inflight : undefined;
    if (current === undefined) {
      result = await startBoot(env);
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The boot in flight did not settle in time (its owner may be gone): boot here, unless another waiter already
      // replaced it. Decided inside the timer callback, so waiters whose timers fire together share one new boot.
      const replacement = new Promise<Runtime | null>((resolve) => {
        timer = setTimeout(() => {
          resolve(
            latest !== undefined && latest.env === env && latest !== current
              ? latest.promise
              : startBoot(env),
          );
        }, bootWaitMs);
      });
      result = await Promise.race([current.promise, replacement]);
      clearTimeout(timer);
    }
    return result ?? backoff();
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

  /**
   * Expired `kv` rows (P4-09): abandoned `login:*` transactions, unused `setup:*` links, ended sessions. Independent of
   * the audit retention (which may be 0 or misconfigured) and of the master key. Bounded batches; failures are logged,
   * never thrown.
   */
  const purgeKv = async (env: WorkerEnv): Promise<void> => {
    try {
      const storage = await (options.openStorage ?? openD1Storage)(env);
      const result = await purgeExpiredKv(storage.kv, options.kvPurge, now);
      logger.info('kv purge finished', { ...result });
      // Quota counters of long-gone periods (P7-12).
      const usage = await purgeGrantUsage(storage.grantUsage, now());
      if (usage > 0) logger.info('quota counters purged', { removed: usage });
    } catch (error) {
      logger.error('kv purge failed', bootFailure(error));
    }
  };

  return {
    async scheduled(_controller, env) {
      await purgeAudit(env);
      await purgeKv(env);
    },
    async fetch(request, env, ctx) {
      const runtime = await runtimeFor(env);
      if (typeof runtime === 'number') return unavailable(runtime);
      return runtime.app.fetch(request, env, ctx);
    },
  };
}
