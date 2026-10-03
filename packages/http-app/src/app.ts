// SPDX-License-Identifier: Apache-2.0
// The relic-bridge HTTP app (ADR-0004, ADR-0005): per-project MCP endpoints authenticated with per-device tokens.
// Web-standard only; the same app runs under `@hono/node-server` (`relic-bridge serve`) and on Workers (Phase 3).
// No module-level request state (T21): everything request-scoped lives in the request's closure or `authInfo`.
import {
  type AuthInfo,
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import {
  type AuthenticatedAccess,
  authenticateAccess,
  bearerToken,
  checkTokenFormat,
  type EffectiveAccess,
  hashToken,
  isKeyRejection,
  type Keyring,
  type KeyValidator,
  nerdGraphKeyValidator,
  openCredential,
} from '@relic-bridge/auth';
import {
  buildMcpServer,
  type Clock,
  createBudget,
  createBuiltinTools,
  createSemaphoreLimiter,
  DEFAULT_CONCURRENCY,
  DEFAULT_LIMITS,
  type FetchLike,
  LimiterPool,
  type Logger,
  newRequestId,
  type QueryLimits,
  type Secret,
  silentLogger,
  systemClock,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
  VERSION,
} from '@relic-bridge/core';
import { SLUG_RE, type Storage } from '@relic-bridge/storage';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  AccessCache,
  type CachedAccess,
  DEFAULT_ACCESS_CACHE_ENTRIES,
  DEFAULT_ACCESS_CACHE_TTL_MS,
} from './access-cache.ts';
import {
  ADMIN_API_BASE,
  createAdminApi,
  DEFAULT_ADMIN_MAX_BODY_BYTES,
  type StorageForAdmin,
} from './admin/api.ts';
import { createAdminTokenVerifier } from './admin/token.ts';
import type { AdminAuditEvent } from './audit.ts';
import { createIdentityRoutes, IDENTITY_BASE, type IdentityOptions } from './identity.ts';
import { peekJsonRpc, type RpcPeek } from './jsonrpc.ts';
import {
  credentialIdOf,
  DEFAULT_PASSTHROUGH_IDENTITY_ENTRIES,
  DEFAULT_PASSTHROUGH_IDENTITY_TTL_MS,
  IdentityCache,
  isLoopbackHost,
  KeyFingerprinter,
  keyIdOf,
  PASSTHROUGH_KEY_HEADER,
  PASSTHROUGH_PATH,
  PASSTHROUGH_REGION_HEADER,
  type PassthroughOptions,
  type PassthroughRequestInfo,
  reachableAccounts,
  readPassthroughHeaders,
} from './passthrough.ts';
import {
  applySecurityHeaders,
  checkHost,
  checkOrigin,
  defaultAllowedHostnames,
  originHostname,
  safeMcpHeader,
} from './security.ts';
import { createSessionManager } from './session.ts';

/** Largest request body accepted on the MCP route by default (a tool call is a few KiB). */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024;
/** The whole MCP exchange (tool calls poll NRQL for up to 120 s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
/** Subrequest budget per MCP request on Node (ADR-0010 "paid" figure; Workers sets its own). */
export const DEFAULT_CALL_BUDGET = 1000;

export type StorageForHttp = Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials' | 'accessTokens'>;

/** What the hooks know about an authenticated MCP request. Never contains the token or the New Relic key. */
export interface McpRequestInfo {
  readonly requestId: string;
  readonly projectSlug: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly tokenId: string;
  readonly userId: string | null;
  /** The JSON-RPC method of a POST body (sanitised); null for GET/DELETE or a body without one. Never header-only. */
  readonly mcpMethod: string | null;
  /** `params.name` of the body (sanitised): the tool name for `tools/call`. */
  readonly mcpName: string | null;
  /** A `subscriptions/listen` request: answered at once, not a tool call (don't rate-limit it like one). */
  readonly listen: boolean;
  readonly access: EffectiveAccess;
}

/** A request refused by a hook before the MCP handler ran (a 429 from rate limiting, …). */
export interface RejectInfo {
  readonly requestId: string;
  readonly status: number;
  /** Stable reason (`rate_limit_ip`, `rate_limit_token`, …), or `null` when the hook gave none. */
  readonly reason: string | null;
  /** Set once the caller is authenticated (a `beforeMcp` refusal); absent for pre-authentication refusals. */
  readonly request?: McpRequestInfo;
  /** Set for a `beforePassthrough` refusal (P2-16): the key's fingerprint id, never the key. */
  readonly passthrough?: PassthroughRequestInfo;
}

export interface AuthFailureInfo {
  readonly requestId: string;
  /** Stable reason for logs/audit only; the client always gets the same 401. */
  readonly reason: string;
}

/**
 * Which credential a route authenticates (P3-13): an MCP access token (`/p/:slug/mcp`), the bootstrap admin token
 * (`/api/admin/*`) or a caller's New Relic key (pass-through). Checking the first two costs no outbound call; checking
 * a New Relic key asks NerdGraph, so hooks may treat it more strictly. `identity` is the sign-in routes (P4-01), which
 * check IdP answers, not a credential of ours.
 */
export type AuthScope = 'mcp_token' | 'admin_token' | 'passthrough_key' | 'identity';

/**
 * Extension points for P2-07 (rate limiting) and P2-08 (audit). Hooks receive the Hono context so runtime-specific
 * code (client IP on Node, `waitUntil` on Workers) stays in the host.
 */
export interface HttpAppHooks {
  /** Before authentication (e.g. the per-IP request limit). Return a Response to stop the request. */
  beforeAuth?(
    c: Context,
    requestId: string,
    scope: AuthScope,
  ): Promise<Response | undefined> | Response | undefined;
  /** After an authentication/authorization failure (the request is refused). Must not throw. */
  onAuthFailure?(c: Context, info: AuthFailureInfo): void;
  /**
   * After an authentication failure and `onAuthFailure`, before the 401 goes out (P3-13): a returned Response (a 429
   * for an address over its failure budget) is sent instead. Only failures reach it, so a credential that verifies is
   * never refused by the failure throttle. Must not throw.
   */
  refuseAuthFailure?(c: Context, info: AuthFailureInfo): Promise<Response | undefined> | Response | undefined;
  /** After access resolution, before the MCP handler (rate limits). Return a Response (e.g. 429) to stop. */
  beforeMcp?(c: Context, info: McpRequestInfo): Promise<Response | undefined> | Response | undefined;
  /**
   * Pass-through route (P2-15), after the caller's New Relic key was validated, before the MCP handler (per-key rate
   * limits). Return a Response (e.g. 429) to stop. The info carries a key fingerprint id, never the key.
   */
  beforePassthrough?(
    c: Context,
    info: PassthroughRequestInfo,
  ): Promise<Response | undefined> | Response | undefined;
  /**
   * After `beforeAuth`, `beforeMcp` or `beforePassthrough` refused a request (audit). Runs in the background; must not
   * throw.
   */
  onRejected?(c: Context, info: RejectInfo): Promise<void> | void;
  /** After each tool call finished, success or error (audit). Runs in the background; must not throw. */
  onToolCall?(c: Context, info: McpRequestInfo, event: ToolCallEvent): Promise<void> | void;
  /** After the MCP handler answered (audit). Runs in the background (`waitUntil`); errors are logged. */
  /**
   * After each tool call on the pass-through route finished, success or error (audit, P2-16). Runs in the background;
   * must not throw. The info carries the key's fingerprint id, never the key.
   */
  onPassthroughToolCall?(
    c: Context,
    info: PassthroughRequestInfo,
    event: ToolCallEvent,
  ): Promise<void> | void;
  afterMcp?(
    c: Context,
    info: McpRequestInfo,
    outcome: { readonly status: number; readonly durationMs: number },
  ): Promise<void> | void;
}

/** The admin REST API (P2-09). Without it, `/api/admin/*` answers 404. */
export interface AdminApiOptions {
  /**
   * The bootstrap admin token (`RB_ADMIN_TOKEN`): 32-512 printable characters. Only its digest is kept. Optional
   * when sign-in (`identity`) is configured: the admin API then takes admin sessions only.
   */
  readonly token?: Secret;
  /** Needs the audit log too (the audit query endpoint). */
  readonly storage: StorageForAdmin;
  /** Records every admin change (`createAuditRecorder(...)`); omit only when auditing is off. */
  readonly audit?: { admin(event: AdminAuditEvent): Promise<void> };
  /** Checks New Relic keys before they are stored. Default: NerdGraph `actor` query (using `fetch`). */
  readonly validateKey?: KeyValidator;
  /** Ceiling for `keys/rotate` `batchSize` (a Free-plan Worker allows 50 D1 queries per call). Default: none beyond 100. */
  readonly maxRotationBatch?: number;
  /** Largest admin request body. Default 64 KiB. */
  readonly maxBodyBytes?: number;
}

export interface HttpAppOptions {
  readonly storage: StorageForHttp;
  /** Decrypts stored New Relic keys (`loadKeyringFromEnv` + `verifyKeyChecks` at boot). */
  readonly keyring: Keyring;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** NerdGraph fetch override (tests). */
  readonly fetch?: FetchLike;
  /** `Host` allowlist (hostnames, no ports). Default: loopback names. `'*'` disables the check (not recommended). */
  readonly allowedHosts?: readonly string[] | '*';
  /** `Origin` allowlist (hostnames). Default: `allowedHosts` (or loopback names when that is `'*'`). */
  readonly allowedOrigins?: readonly string[];
  /** CORS: off unless origins are listed (full origins, e.g. `https://app.example.com`). */
  readonly corsOrigins?: readonly string[];
  /** Access cache TTL in ms, 0-60000 (0 disables). Default 30000. */
  readonly accessCacheTtlMs?: number;
  readonly accessCacheMaxEntries?: number;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly callBudget?: number;
  /**
   * Platform ceiling for NerdGraph response bodies in bytes (Workers plan presets, P3-03). A project's own
   * `maxResponseBytes` still applies; the smaller of the two wins. Default: no ceiling.
   */
  readonly maxResponseBytes?: number;
  /** NerdGraph calls in flight per credential (1-25, default 5). */
  readonly concurrencyPerCredential?: number;
  /** `'auto'` (default): HSTS when the request URL is https. `true` for a TLS-terminating proxy. */
  readonly hsts?: 'auto' | boolean;
  /** Runs background work (Workers: `executionCtx.waitUntil`). Default: try `executionCtx`, else fire-and-forget. */
  readonly waitUntil?: (c: Context, task: Promise<unknown>) => void;
  readonly hooks?: HttpAppHooks;
  /** Enables `/api/admin/v1` (P2-09). */
  readonly admin?: AdminApiOptions;
  /** Enables `/passthrough/mcp` (P2-15): callers bring their own New Relic key per request. Off when absent. */
  readonly passthrough?: PassthroughOptions;
  /** Enables the `/auth/*` sign-in routes (P4-01) and admin setup links. Off when absent. */
  readonly identity?: IdentityOptions;
}

type Env = { Variables: { requestId: string; started: number; log: Record<string, unknown> } };

/** The per-request scope handed to the MCP server factory through `authInfo.extra` (never module state). */
interface RequestScope {
  readonly tools: readonly ToolDefinition[];
  readonly ctx: ToolContext;
  readonly onToolCall?: (event: ToolCallEvent) => void;
}

const SCOPE_KEY = 'relicBridgeScope';

/** A request deadline that first races the response headers and then bounds the response body. */
class Deadline {
  readonly expired: Promise<void>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onExpire: (() => void) | undefined;
  #fired = false;

  constructor(ms: number, onFire: () => void) {
    this.expired = new Promise<void>((resolve) => {
      this.#timer = setTimeout(() => {
        this.#fired = true;
        onFire();
        resolve();
        this.#onExpire?.();
      }, ms);
    });
  }

  clear(): void {
    clearTimeout(this.#timer);
  }

  /** The response, with its body cut off when the deadline passes. Clears the timer once the body ends. */
  bound(response: Response): Response {
    const body = response.body;
    if (this.#fired || body === null) {
      this.clear();
      return response;
    }
    const reader = body.getReader();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#onExpire = () => {
          if (closed) return;
          closed = true;
          reader.cancel().catch(() => undefined);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
      },
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (closed) return;
          if (done) {
            closed = true;
            this.clear();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          if (closed) return;
          closed = true;
          this.clear();
          controller.error(error);
        }
      },
      cancel: (reason) => {
        closed = true;
        this.clear();
        return reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

const UNAUTHORIZED_BODY = '{"error":"unauthorized"}';
const WWW_AUTHENTICATE = 'Bearer realm="relic-bridge"';
/** Not `Bearer`: a client must not start OAuth discovery for a route that takes a New Relic key. */
const PASSTHROUGH_WWW_AUTHENTICATE = 'NewRelic-Api-Key realm="relic-bridge-passthrough"';
const BATCH_REFUSED_BODY =
  '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Batch requests are not supported: send one JSON-RPC message per request."}}';

/** {@link peekJsonRpc} bounded in time as well as size (a slowly trickled body can't hold the request forever). */
async function peekWithin(request: Request, maxBytes: number, ms: number): Promise<RpcPeek | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      peekJsonRpc(request, maxBytes),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

/** The single answer for every authentication and authorization failure (T19: nothing to enumerate). */
function unauthorized(): Response {
  return json(401, UNAUTHORIZED_BODY, { 'WWW-Authenticate': WWW_AUTHENTICATE });
}

/** The pass-through route's single answer for every key problem. */
function passthroughUnauthorized(): Response {
  return json(401, UNAUTHORIZED_BODY, { 'WWW-Authenticate': PASSTHROUGH_WWW_AUTHENTICATE });
}

function checkRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Build the HTTP app. Everything stateful (access cache, limiter pool, MCP handler, tool set) belongs to the
 * returned app instance; create one per process (Node) or isolate (Workers).
 */
export function createHttpApp(options: HttpAppOptions): Hono<Env> {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? systemClock;
  const allowedHosts = options.allowedHosts ?? defaultAllowedHostnames();
  const corsOrigins = [...(options.corsOrigins ?? [])];
  const corsHostnames = corsOrigins.map((o) => {
    const h = originHostname(o);
    if (h === null) throw new TypeError('corsOrigins must be origins like https://app.example.com');
    return h;
  });
  const allowedOrigins = [
    ...(options.allowedOrigins ?? (allowedHosts === '*' ? defaultAllowedHostnames() : allowedHosts)),
    ...corsHostnames,
    // The admin pages post from the public URL (P4-02): its origin always passes this coarse check (the admin API
    // and sign-out then require that exact origin for cookie sessions).
    ...(options.identity ? [new URL(options.identity.publicUrl).hostname] : []),
  ];
  const maxBodyBytes = checkRange(
    'maxBodyBytes',
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    1024,
    DEFAULT_MAX_REQUEST_BODY_SIZE,
  );
  const timeoutMs = checkRange(
    'requestTimeoutMs',
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    1000,
    600_000,
  );
  const callBudget = checkRange('callBudget', options.callBudget ?? DEFAULT_CALL_BUDGET, 1, 100_000);
  const responseCeiling =
    options.maxResponseBytes === undefined
      ? undefined
      : checkRange('maxResponseBytes', options.maxResponseBytes, 1024, 64 * 1024 * 1024);
  /** Apply the platform ceiling on top of a project's limits. */
  const capLimits = (limits: QueryLimits): QueryLimits =>
    responseCeiling === undefined || limits.maxResponseBytes <= responseCeiling
      ? limits
      : Object.freeze({ ...limits, maxResponseBytes: responseCeiling });
  /** Split granted tools into those the request budget can pay for and those it cannot (hidden, explained in whoami). */
  const affordable = (granted: readonly ToolDefinition[]) => {
    const tools: ToolDefinition[] = [];
    const unavailable: { name: string; reason: string }[] = [];
    for (const t of granted) {
      if (t.cost <= callBudget) tools.push(t);
      else {
        unavailable.push({
          name: t.name,
          reason: `needs about ${t.cost} NerdGraph calls, above this deployment's budget of ${callBudget} per request`,
        });
      }
    }
    return { tools, unavailable: Object.freeze(unavailable.map((u) => Object.freeze(u))) };
  };
  const cache = new AccessCache(
    options.accessCacheTtlMs ?? DEFAULT_ACCESS_CACHE_TTL_MS,
    options.accessCacheMaxEntries ?? DEFAULT_ACCESS_CACHE_ENTRIES,
  );
  const limiters = new LimiterPool(options.concurrencyPerCredential);
  // One tool set per app: its caches are keyed by credential id, region and account (never shared across tenants).
  const allTools = createBuiltinTools(options.fetch ? { fetch: options.fetch } : {});
  const catalog = allTools.map((t) => t.name);
  const hooks = options.hooks ?? {};
  // Scopes created by this app; the factory refuses anything else (defence in depth for `authInfo.extra`).
  const scopes = new WeakSet<RequestScope>();
  // Fails at construction (boot) for an unusable admin token, never per request.
  const adminVerifier = options.admin?.token ? createAdminTokenVerifier(options.admin.token) : undefined;
  if (options.admin && adminVerifier === undefined && !options.identity) {
    throw new TypeError('admin needs a token, or sign-in (identity) for admin sessions');
  }
  // Sign-in redirects come back to the public URL: its host must pass the Host check, or every callback would be 403.
  if (options.identity) {
    const publicHost = new URL(options.identity.publicUrl).hostname;
    if (allowedHosts !== '*' && !checkHost(publicHost, allowedHosts).ok) {
      throw new TypeError('identity.publicUrl must name a host in allowedHosts');
    }
  }

  const runInBackground = (c: Context, task: Promise<unknown>, what: string): void => {
    const guarded = task.catch((error: unknown) =>
      logger.warn('background task failed', {
        task: what,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    if (options.waitUntil) {
      options.waitUntil(c, guarded);
      return;
    }
    try {
      c.executionCtx.waitUntil(guarded);
    } catch {
      // Node: no execution context. The promise already logs its own failure.
    }
  };

  const rejectReason = (log: Record<string, unknown>): string | null =>
    typeof log['reject'] === 'string' ? log['reject'] : null;
  const notifyRejected = (c: Context, info: RejectInfo): void => {
    const hook = hooks.onRejected;
    if (hook)
      runInBackground(
        c,
        Promise.resolve().then(() => hook(c, info)),
        'on_rejected',
      );
  };

  // Every authentication failure: log and audit it (`onAuthFailure`), then let `refuseAuthFailure` answer instead of
  // the 401 (the failure throttle's 429, P3-13). Never rejects: a failing hook never changes the answer. The audit row
  // is the `auth.denied` one already written, so a 429 here is not also recorded as `request.rejected`.
  const denyWith = async (
    c: Context,
    info: AuthFailureInfo,
    log: Record<string, unknown>,
    fallback: () => Response,
  ): Promise<Response> => {
    log['deny'] = info.reason;
    try {
      hooks.onAuthFailure?.(c, info);
    } catch {
      // A failing hook never changes the answer.
    }
    try {
      const instead = await hooks.refuseAuthFailure?.(c, info);
      if (instead) return instead;
    } catch {
      // As above.
    }
    return fallback();
  };

  const mcp = createMcpHandler(
    (ctx: McpRequestContext) => {
      const scope = ctx.authInfo?.extra?.[SCOPE_KEY] as RequestScope | undefined;
      if (scope === undefined || !scopes.has(scope)) {
        // Unreachable: the route authenticates first. Fail closed rather than serve an unscoped server.
        throw new Error('MCP request without a resolved access scope');
      }
      return buildMcpServer({
        tools: scope.tools,
        ctx: scope.ctx,
        toolsListChanged: false,
        ...(scope.onToolCall ? { onToolCall: scope.onToolCall } : {}),
      });
    },
    {
      legacy: 'stateless',
      maxRequestBodySize: maxBodyBytes,
      onerror: (error) => logger.debug('mcp transport', { error: error.message.slice(0, 200) }),
    },
  );

  /** `413` for a declared body length over the limit (or an unparseable one), before any authentication work. */
  const refuseDeclaredBody = (c: Context<Env>): Response | undefined => {
    const declared = c.req.header('content-length');
    if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBodyBytes)) {
      c.get('log')['reject'] = 'body_size';
      return json(413, '{"error":"payload_too_large"}');
    }
    return undefined;
  };

  /**
   * What the request asks for comes from the body, never from the `Mcp-Method` / `Mcp-Name` headers alone: the SDK
   * cross-checks those only for modern requests, so a legacy request could name `subscriptions/listen` in a header to
   * skip rate limiting, or a granted tool to hide an ungranted call from the audit (P2-12). Batches are refused.
   */
  const readRpc = async (
    c: Context<Env>,
  ): Promise<{ readonly mcpMethod: string | null; readonly mcpName: string | null } | Response> => {
    const log = c.get('log');
    let mcpMethod: string | null = null;
    let mcpName: string | null = null;
    if (c.req.method === 'POST') {
      const peek = await peekWithin(c.req.raw, maxBodyBytes, timeoutMs);
      // Refused without reading the rest: release the unread original as well (never awaited, it may be stalled).
      const release = () => void c.req.raw.body?.cancel().catch(() => undefined);
      if (peek === 'timeout') {
        log['timeout'] = true;
        release();
        return json(504, '{"error":"timeout"}');
      }
      if (peek.kind === 'too_large') {
        log['reject'] = 'body_size';
        release();
        return json(413, '{"error":"payload_too_large"}');
      }
      if (peek.kind === 'batch') {
        // JSON-RPC batches left MCP in 2025-06-18; one request must be one call (rate limits and audit count calls).
        log['reject'] = 'batch';
        return json(400, BATCH_REFUSED_BODY);
      }
      if (peek.kind === 'message') {
        mcpMethod = safeMcpHeader(peek.method);
        mcpName = safeMcpHeader(peek.name);
      }
    }
    if (mcpMethod !== null) log['mcpMethod'] = mcpMethod;
    if (mcpName !== null) log['mcpName'] = mcpName;
    return { mcpMethod, mcpName };
  };

  /**
   * Hand the request to the MCP handler under one deadline for the whole exchange: before the headers it answers 504;
   * after them (SSE) it ends the stream, so a tool that never finishes can't hold the connection open.
   */
  const serveMcp = async (
    c: Context<Env>,
    authInfo: AuthInfo,
    mcpMethod: string | null,
    mcpName: string | null,
  ): Promise<Response> => {
    const requestId = c.get('requestId');
    const deadline = new Deadline(timeoutMs, () => {
      c.get('log')['timeout'] = true;
      logger.warn('mcp request timed out', { requestId, ms: timeoutMs, mcpMethod, mcpName });
    });
    let response: Response;
    try {
      response = await Promise.race([
        mcp.fetch(c.req.raw, { authInfo }),
        deadline.expired.then(() => json(504, '{"error":"timeout"}')),
      ]);
    } catch (error) {
      deadline.clear();
      throw error;
    }
    return deadline.bound(response);
  };

  // Admin sessions (P4-02): on whenever sign-in is configured. State lives in storage `kv`, never here (T21); the
  // manager holds configuration and a ≤ 5 s cache of user records.
  const identity = options.identity;
  const sessions = identity
    ? createSessionManager({
        publicUrl: identity.publicUrl,
        kv: identity.storage.kv,
        users: identity.storage.users,
        clock,
        logger,
        runInBackground,
        ...(identity.session ? { options: identity.session } : {}),
        ...(identity.audit?.admin
          ? {
              audit: (event: AdminAuditEvent) => identity.audit?.admin?.(event) ?? Promise.resolve(),
            }
          : {}),
      })
    : undefined;

  const app = new Hono<Env>();

  // 1. Request id + access log (one structured line per request, stderr via the logger).
  app.use('*', async (c, next) => {
    const requestId = newRequestId();
    c.set('requestId', requestId);
    c.set('started', clock.now());
    c.set('log', {});
    await next();
    c.res.headers.set('X-Request-Id', requestId);
    const path = new URL(c.req.url).pathname;
    const fields = {
      requestId,
      method: c.req.method,
      route: c.req.routePath === '/*' ? 'unmatched' : c.req.routePath,
      status: c.res.status,
      ms: clock.now() - c.get('started'),
      ...c.get('log'),
    };
    if (path === '/health') logger.debug('http request', fields);
    else logger.info('http request', fields);
  });

  // 2. Security headers on every response, including errors and 401s.
  app.use('*', async (c, next) => {
    await next();
    const hsts =
      options.hsts === 'auto' || options.hsts === undefined ? c.req.url.startsWith('https:') : options.hsts;
    try {
      applySecurityHeaders(c.res.headers, hsts);
    } catch {
      // Immutable headers (a fetched Response): copy once.
      c.res = new Response(c.res.body, c.res);
      applySecurityHeaders(c.res.headers, hsts);
    }
  });

  // 3. DNS rebinding / cross-origin protection (T24), before anything else is looked at.
  app.use('*', async (c, next) => {
    // Runtimes build the request URL from the Host header; in-process callers (tests, service bindings) may not set
    // the header at all, so the URL's host stands in for it.
    const host = checkHost(c.req.header('host') ?? new URL(c.req.url).host, allowedHosts);
    if (!host.ok) {
      c.get('log')['reject'] = 'host';
      return json(403, '{"error":"forbidden_host"}');
    }
    const origin = checkOrigin(c.req.header('origin'), allowedOrigins);
    if (!origin.ok) {
      c.get('log')['reject'] = 'origin';
      return json(403, '{"error":"forbidden_origin"}');
    }
    await next();
  });

  // 4. CORS: off unless configured.
  if (corsOrigins.length > 0) {
    app.use(
      '/p/*',
      cors({
        origin: corsOrigins,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Authorization',
          'Content-Type',
          'Accept',
          'Mcp-Protocol-Version',
          'Mcp-Method',
          'Mcp-Name',
          'Mcp-Session-Id',
          'Last-Event-ID',
        ],
        exposeHeaders: ['Mcp-Protocol-Version', 'Mcp-Session-Id', 'WWW-Authenticate', 'X-Request-Id'],
        maxAge: 600,
        credentials: false,
      }),
    );
    if (options.passthrough) {
      app.use(
        `${PASSTHROUGH_PATH}`,
        cors({
          origin: corsOrigins,
          allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
          allowHeaders: [
            PASSTHROUGH_KEY_HEADER,
            PASSTHROUGH_REGION_HEADER,
            'Content-Type',
            'Accept',
            'Mcp-Protocol-Version',
            'Mcp-Method',
            'Mcp-Name',
            'Mcp-Session-Id',
            'Last-Event-ID',
          ],
          exposeHeaders: ['Mcp-Protocol-Version', 'Mcp-Session-Id', 'WWW-Authenticate', 'X-Request-Id'],
          maxAge: 600,
          credentials: false,
        }),
      );
    }
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/version', (c) => c.json({ name: 'relic-bridge', version: VERSION }));

  if (options.admin) {
    const admin = options.admin;
    app.route(
      ADMIN_API_BASE,
      createAdminApi({
        storage: admin.storage,
        keyring: options.keyring,
        ...(adminVerifier ? { verifier: adminVerifier } : {}),
        ...(sessions ? { sessions } : {}),
        validateKey:
          admin.validateKey ??
          nerdGraphKeyValidator({ logger, clock, ...(options.fetch ? { fetch: options.fetch } : {}) }),
        catalog,
        clock,
        logger,
        ...(admin.maxRotationBatch === undefined
          ? {}
          : { maxRotationBatch: checkRange('admin.maxRotationBatch', admin.maxRotationBatch, 1, 100) }),
        maxBodyBytes: checkRange(
          'admin.maxBodyBytes',
          admin.maxBodyBytes ?? DEFAULT_ADMIN_MAX_BODY_BYTES,
          1024,
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        ),
        ...(admin.audit
          ? { audit: (event: AdminAuditEvent) => admin.audit?.admin(event) ?? Promise.resolve() }
          : {}),
        ...(hooks.beforeAuth
          ? { beforeAuth: (c: Context, id: string) => hooks.beforeAuth?.(c, id, 'admin_token') }
          : {}),
        onAuthFailure: (c, reason) =>
          hooks.onAuthFailure?.(c, { requestId: c.get('requestId') as string, reason }),
        ...(hooks.refuseAuthFailure
          ? {
              refuseAuthFailure: (c: Context, reason: string) =>
                hooks.refuseAuthFailure?.(c, { requestId: c.get('requestId') as string, reason }),
            }
          : {}),
        onRejected: (c, status) =>
          notifyRejected(c, {
            requestId: c.get('requestId') as string,
            status,
            reason: rejectReason(c.get('log')),
          }),
        runInBackground,
        // A revoked token, grant or key stops at once on this process (other processes: within the cache TTL); a
        // changed role or disabled user is re-read by the next session request here (elsewhere: within 5 s).
        onChange: () => {
          cache.clear();
          sessions?.forgetUsers();
        },
        ...(options.identity
          ? {
              setupLinks: {
                publicUrl: options.identity.publicUrl,
                kv: options.identity.storage.kv,
                providers: options.identity.providers.map((p) => ({ id: p.id, kind: p.kind })),
              },
            }
          : {}),
      }),
    );
  }

  if (options.identity) {
    app.route(
      IDENTITY_BASE,
      createIdentityRoutes(options.identity, {
        clock,
        logger,
        runInBackground,
        ...(sessions ? { sessions } : {}),
        ...(hooks.beforeAuth
          ? {
              beforeAuth: async (c: Context, id: string) => {
                const stop = await hooks.beforeAuth?.(c, id, 'identity');
                if (stop) {
                  notifyRejected(c, {
                    requestId: id,
                    status: stop.status,
                    reason: rejectReason(c.get('log')),
                  });
                }
                return stop;
              },
            }
          : {}),
      }),
    );
  }

  app.on(['GET', 'POST', 'DELETE'], '/p/:slug/mcp', async (c) => {
    const requestId = c.get('requestId');
    const log = c.get('log');
    const slug = c.req.param('slug');
    if (SLUG_RE.test(slug)) log['project'] = slug;

    // 5. Body size: a declared length over the limit is refused before authentication does any work. Bodies without
    // a length are bounded while the MCP handler reads them (same limit).
    const tooLarge = refuseDeclaredBody(c);
    if (tooLarge) return tooLarge;

    if (hooks.beforeAuth) {
      const stop = await hooks.beforeAuth(c, requestId, 'mcp_token');
      if (stop) {
        notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(log) });
        return stop;
      }
    }

    const deny = (reason: string): Promise<Response> => denyWith(c, { requestId, reason }, log, unauthorized);

    // 6. Authenticate, then authorise for this slug. The token is checked before the slug is looked at, so slugs
    // can't be probed without a valid token (T19); every denial is the same 401.
    const token = bearerToken(c.req.header('authorization'));
    if (token === null)
      return deny(c.req.header('authorization') === undefined ? 'missing_token' : 'malformed_header');
    const formatProblem = checkTokenFormat(token);
    if (formatProblem !== null) return deny(formatProblem);

    const now = clock.now();
    const cacheKey = `${await hashToken(token)}\n${slug}`;
    let resolved: Omit<CachedAccess, 'expiresAt'> | undefined = cache.get(cacheKey, now);
    if (resolved === undefined) {
      // One storage call on SQL storage (D1: one batch round trip, P3-09); repository reads otherwise.
      let auth: AuthenticatedAccess;
      try {
        auth = await authenticateAccess({
          storage: options.storage,
          token,
          projectSlug: slug,
          catalog,
          now,
          onTouch: (touch) => runInBackground(c, touch, 'token_touch'),
          onTouchError: (error) =>
            logger.warn('last_used_at write failed', {
              requestId,
              error: error instanceof Error ? error.name : typeof error,
            }),
        });
      } catch (error) {
        // Storage trouble is never "allowed" (fail closed), and never a 401 that would make clients drop the token.
        log['error'] = error instanceof Error ? error.name : typeof error;
        logger.error('access resolution failed', { requestId, error: log['error'] });
        return json(503, '{"error":"unavailable"}', { 'Retry-After': '5' });
      }
      if (!auth.ok) {
        if (auth.stage === 'access') log['tokenId'] = auth.tokenId;
        return deny(auth.reason);
      }
      resolved = { tokenId: auth.tokenId, access: auth.access, credential: auth.credential };
      cache.set(cacheKey, resolved, now, [auth.tokenExpiresAt, auth.access.expiresAt]);
    } else {
      log['cached'] = true;
    }
    const { access, tokenId } = resolved;
    log['tokenId'] = tokenId;
    log['grantId'] = access.grantId;

    // What the request asks for comes from the body, never from the `Mcp-Method` / `Mcp-Name` headers alone: the SDK
    // cross-checks those only for modern requests, so a legacy request could name `subscriptions/listen` in a header
    // to skip rate limiting, or a granted tool to hide an ungranted call from the audit (P2-12).
    const rpc = await readRpc(c);
    if (rpc instanceof Response) return rpc;
    const { mcpMethod, mcpName } = rpc;
    const info: McpRequestInfo = Object.freeze({
      requestId,
      projectSlug: access.projectSlug,
      projectId: access.projectId,
      grantId: access.grantId,
      tokenId,
      userId: access.userId,
      mcpMethod,
      mcpName,
      listen: mcpMethod === 'subscriptions/listen',
      access,
    });

    if (hooks.beforeMcp) {
      const stop = await hooks.beforeMcp(c, info);
      if (stop) {
        notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(log), request: info });
        return stop;
      }
    }

    // 7. Per-request scope: decrypt the key for this request only, register only the granted tools.
    let scope: RequestScope;
    try {
      const credential = await openCredential(access, resolved.credential, { keyring: options.keyring });
      const toolLogger = logger.child({ requestId, project: access.projectSlug, grantId: access.grantId });
      const granted = affordable(allTools.filter((t) => access.tools.includes(t.name)));
      scope = Object.freeze({
        tools: granted.tools,
        ctx: Object.freeze({
          requestId,
          credential,
          accounts: access.accounts,
          budget: createBudget(callBudget),
          limiter: limiters.for(credential.id),
          limits: capLimits(access.limits),
          connection: Object.freeze({
            project: access.projectSlug,
            allowedTools: access.tools,
            unavailableTools: granted.unavailable,
          }),
          logger: toolLogger,
          clock,
        }),
        ...(hooks.onToolCall
          ? {
              onToolCall: (event: ToolCallEvent) => {
                const hook = hooks.onToolCall;
                if (hook)
                  runInBackground(
                    c,
                    Promise.resolve().then(() => hook(c, info, event)),
                    'on_tool_call',
                  );
              },
            }
          : {}),
      });
    } catch (error) {
      log['error'] = error instanceof Error ? error.name : typeof error;
      logger.error('credential could not be opened', { requestId, credential: access.credential.id });
      return json(503, '{"error":"unavailable"}', { 'Retry-After': '30' });
    }
    scopes.add(scope);

    const authInfo: AuthInfo = {
      // The token id, never the token: the SDK treats this as opaque pass-through data.
      token: tokenId,
      clientId: access.grantId,
      scopes: [],
      extra: { [SCOPE_KEY]: scope },
    };

    const started = clock.now();
    const response = await serveMcp(c, authInfo, mcpMethod, mcpName);
    if (hooks.afterMcp) {
      const after = hooks.afterMcp;
      const outcome = Object.freeze({ status: response.status, durationMs: clock.now() - started });
      runInBackground(
        c,
        Promise.resolve().then(() => after(c, info, outcome)),
        'after_mcp',
      );
    }
    return response;
  });

  if (options.passthrough) {
    const pt = options.passthrough;
    const fingerprinter = new KeyFingerprinter(pt.fingerprintSecret);
    const identities = new IdentityCache(
      pt.identityTtlMs ?? DEFAULT_PASSTHROUGH_IDENTITY_TTL_MS,
      pt.identityCacheMaxEntries ?? DEFAULT_PASSTHROUGH_IDENTITY_ENTRIES,
    );
    const validateKey =
      pt.validateKey ??
      nerdGraphKeyValidator({ logger, clock, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const ptLimits = capLimits(pt.limits ?? DEFAULT_LIMITS);
    // Read-only tools only, whatever the catalog grows into (a caller's own key gets no write access through here).
    const ptGranted = affordable(allTools.filter((t) => t.kind === 'read'));
    const ptTools = Object.freeze(ptGranted.tools);
    const ptToolNames = Object.freeze(ptTools.map((t) => t.name));
    const requireTls = pt.requireTls ?? true;
    const concurrency = options.concurrencyPerCredential ?? DEFAULT_CONCURRENCY;
    createSemaphoreLimiter(concurrency); // validate at boot

    app.on(['GET', 'POST', 'DELETE'], PASSTHROUGH_PATH, async (c) => {
      const requestId = c.get('requestId');
      const log = c.get('log');
      log['passthrough'] = true;

      // A key must never travel in clear text: refuse plain HTTP unless a TLS proxy is declared or it stays on this
      // machine. Checked before anything reads the key header.
      if (
        requireTls &&
        !c.req.url.startsWith('https:') &&
        options.hsts !== true &&
        !isLoopbackHost(c.req.header('host') ?? new URL(c.req.url).host)
      ) {
        log['reject'] = 'tls_required';
        return json(403, '{"error":"tls_required"}');
      }
      const tooLarge = refuseDeclaredBody(c);
      if (tooLarge) return tooLarge;

      if (hooks.beforeAuth) {
        const stop = await hooks.beforeAuth(c, requestId, 'passthrough_key');
        if (stop) {
          notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(log) });
          return stop;
        }
      }

      const deny = (reason: string): Promise<Response> =>
        denyWith(c, { requestId, reason }, log, passthroughUnauthorized);

      // The key is wrapped in a `Secret` at once; `Authorization` is not read on this route (T12).
      const presented = readPassthroughHeaders(
        c.req.header(PASSTHROUGH_KEY_HEADER),
        c.req.header(PASSTHROUGH_REGION_HEADER),
      );
      if (!presented.ok) {
        if (presented.reason === 'passthrough_bad_region') {
          log['reject'] = 'bad_region';
          return json(400, '{"error":"invalid_region"}');
        }
        return deny(presented.reason);
      }
      const { key, region } = presented;
      const fingerprint = await fingerprinter.fingerprint(key, region);
      const keyId = keyIdOf(fingerprint);
      const credentialId = credentialIdOf(fingerprint);
      log['keyId'] = keyId;
      log['region'] = region;

      const now = clock.now();
      let accounts = identities.get(fingerprint, now);
      if (accounts === undefined) {
        let reachable: number[];
        try {
          const identity = await validateKey(Object.freeze({ id: credentialId, region, apiKey: key }));
          reachable = reachableAccounts(identity.accounts);
        } catch (error) {
          if (isKeyRejection(error)) return deny('passthrough_invalid_key');
          // New Relic could not be asked: neither allowed nor a 401 that makes the client drop its key.
          log['error'] = error instanceof Error ? error.name : typeof error;
          logger.warn('pass-through key validation unavailable', { requestId, keyId, error: log['error'] });
          return json(503, '{"error":"unavailable"}', { 'Retry-After': '5' });
        }
        if (reachable.length === 0) return deny('passthrough_no_accounts');
        identities.set(fingerprint, reachable, now);
        accounts = reachable;
      } else {
        log['cached'] = true;
      }

      const rpc = await readRpc(c);
      if (rpc instanceof Response) return rpc;
      const { mcpMethod, mcpName } = rpc;
      const info: PassthroughRequestInfo = Object.freeze({
        requestId,
        keyId,
        region,
        mcpMethod,
        mcpName,
        listen: mcpMethod === 'subscriptions/listen',
        accounts,
      });
      if (hooks.beforePassthrough) {
        const stop = await hooks.beforePassthrough(c, info);
        if (stop) {
          notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(log), passthrough: info });
          return stop;
        }
      }

      const scope: RequestScope = Object.freeze({
        tools: ptTools,
        ctx: Object.freeze({
          requestId,
          // Lives for this request only; tool caches key on the fingerprint id, never on the key.
          credential: Object.freeze({ id: credentialId, region, apiKey: key }),
          accounts: Object.freeze({ allowed: accounts, default: accounts[0] as number }),
          budget: createBudget(callBudget),
          // Per request: no per-key state that grows with the number of keys seen (the rate limiter bounds the rest).
          limiter: createSemaphoreLimiter(concurrency),
          limits: ptLimits,
          connection: Object.freeze({ allowedTools: ptToolNames, unavailableTools: ptGranted.unavailable }),
          logger: logger.child({ requestId, keyId }),
          clock,
        }),
        ...(hooks.onPassthroughToolCall
          ? {
              onToolCall: (event: ToolCallEvent) => {
                const hook = hooks.onPassthroughToolCall;
                if (hook)
                  runInBackground(
                    c,
                    Promise.resolve().then(() => hook(c, info, event)),
                    'on_passthrough_tool_call',
                  );
              },
            }
          : {}),
      });
      scopes.add(scope);
      const authInfo: AuthInfo = {
        // The fingerprint id, never the key: the SDK treats this as opaque pass-through data.
        token: keyId,
        clientId: keyId,
        scopes: [],
        extra: { [SCOPE_KEY]: scope },
      };
      return serveMcp(c, authInfo, mcpMethod, mcpName);
    });
  }

  app.notFound(() => json(404, '{"error":"not_found"}'));
  app.onError((error, c) => {
    logger.error('unhandled error', {
      requestId: c.get('requestId'),
      error: error instanceof Error ? error.name : typeof error,
    });
    return json(500, '{"error":"internal_error"}');
  });

  return app;
}
