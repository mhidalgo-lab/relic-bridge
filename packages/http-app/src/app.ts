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
  bearerToken,
  checkTokenFormat,
  type EffectiveAccess,
  hashToken,
  type Keyring,
  type KeyValidator,
  nerdGraphKeyValidator,
  openCredential,
  resolveAccess,
  verifyAccessToken,
} from '@relic-bridge/auth';
import {
  buildMcpServer,
  type Clock,
  createBudget,
  createBuiltinTools,
  type FetchLike,
  LimiterPool,
  type Logger,
  newRequestId,
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
import { peekJsonRpc, type RpcPeek } from './jsonrpc.ts';
import {
  applySecurityHeaders,
  checkHost,
  checkOrigin,
  defaultAllowedHostnames,
  originHostname,
  safeMcpHeader,
} from './security.ts';

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
}

export interface AuthFailureInfo {
  readonly requestId: string;
  /** Stable reason for logs/audit only; the client always gets the same 401. */
  readonly reason: string;
}

/**
 * Extension points for P2-07 (rate limiting) and P2-08 (audit). Hooks receive the Hono context so runtime-specific
 * code (client IP on Node, `waitUntil` on Workers) stays in the host.
 */
export interface HttpAppHooks {
  /** Before authentication (e.g. per-IP throttling of auth failures). Return a Response to stop the request. */
  beforeAuth?(c: Context, requestId: string): Promise<Response | undefined> | Response | undefined;
  /** After an authentication/authorization failure (the 401 is already decided). Must not throw. */
  onAuthFailure?(c: Context, info: AuthFailureInfo): void;
  /** After access resolution, before the MCP handler (rate limits). Return a Response (e.g. 429) to stop. */
  beforeMcp?(c: Context, info: McpRequestInfo): Promise<Response | undefined> | Response | undefined;
  /** After `beforeAuth` or `beforeMcp` refused a request (audit). Runs in the background; must not throw. */
  onRejected?(c: Context, info: RejectInfo): Promise<void> | void;
  /** After each tool call finished, success or error (audit). Runs in the background; must not throw. */
  onToolCall?(c: Context, info: McpRequestInfo, event: ToolCallEvent): Promise<void> | void;
  /** After the MCP handler answered (audit). Runs in the background (`waitUntil`); errors are logged. */
  afterMcp?(
    c: Context,
    info: McpRequestInfo,
    outcome: { readonly status: number; readonly durationMs: number },
  ): Promise<void> | void;
}

/** The admin REST API (P2-09). Without it, `/api/admin/*` answers 404. */
export interface AdminApiOptions {
  /** The bootstrap admin token (`RB_ADMIN_TOKEN`): 32-512 printable characters. Only its digest is kept. */
  readonly token: Secret;
  /** Needs the audit log too (the audit query endpoint). */
  readonly storage: StorageForAdmin;
  /** Records every admin change (`createAuditRecorder(...)`); omit only when auditing is off. */
  readonly audit?: { admin(event: AdminAuditEvent): Promise<void> };
  /** Checks New Relic keys before they are stored. Default: NerdGraph `actor` query (using `fetch`). */
  readonly validateKey?: KeyValidator;
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
  /** NerdGraph calls in flight per credential (1-25, default 5). */
  readonly concurrencyPerCredential?: number;
  /** `'auto'` (default): HSTS when the request URL is https. `true` for a TLS-terminating proxy. */
  readonly hsts?: 'auto' | boolean;
  /** Runs background work (Workers: `executionCtx.waitUntil`). Default: try `executionCtx`, else fire-and-forget. */
  readonly waitUntil?: (c: Context, task: Promise<unknown>) => void;
  readonly hooks?: HttpAppHooks;
  /** Enables `/api/admin/v1` (P2-09). */
  readonly admin?: AdminApiOptions;
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
const WWW_AUTHENTICATE = 'Bearer realm="relic-bridge"';

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

/** The single answer for every authentication and authorization failure (T19: nothing to enumerate). */
function unauthorized(): Response {
  return json(401, UNAUTHORIZED_BODY, { 'WWW-Authenticate': WWW_AUTHENTICATE });
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
  const adminVerifier = options.admin ? createAdminTokenVerifier(options.admin.token) : undefined;

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
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/version', (c) => c.json({ name: 'relic-bridge', version: VERSION }));

  if (options.admin && adminVerifier) {
    const admin = options.admin;
    app.route(
      ADMIN_API_BASE,
      createAdminApi({
        storage: admin.storage,
        keyring: options.keyring,
        verifier: adminVerifier,
        validateKey:
          admin.validateKey ??
          nerdGraphKeyValidator({ logger, clock, ...(options.fetch ? { fetch: options.fetch } : {}) }),
        catalog,
        clock,
        logger,
        maxBodyBytes: checkRange(
          'admin.maxBodyBytes',
          admin.maxBodyBytes ?? DEFAULT_ADMIN_MAX_BODY_BYTES,
          1024,
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        ),
        ...(admin.audit
          ? { audit: (event: AdminAuditEvent) => admin.audit?.admin(event) ?? Promise.resolve() }
          : {}),
        ...(hooks.beforeAuth ? { beforeAuth: hooks.beforeAuth } : {}),
        onAuthFailure: (c, reason) =>
          hooks.onAuthFailure?.(c, { requestId: c.get('requestId') as string, reason }),
        onRejected: (c, status) =>
          notifyRejected(c, {
            requestId: c.get('requestId') as string,
            status,
            reason: rejectReason(c.get('log')),
          }),
        runInBackground,
        // A revoked token, grant or key stops at once on this process (other processes: within the cache TTL).
        onChange: () => cache.clear(),
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
    const declared = c.req.header('content-length');
    if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBodyBytes)) {
      log['reject'] = 'body_size';
      return json(413, '{"error":"payload_too_large"}');
    }

    if (hooks.beforeAuth) {
      const stop = await hooks.beforeAuth(c, requestId);
      if (stop) {
        notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(log) });
        return stop;
      }
    }

    const deny = (reason: string): Response => {
      log['deny'] = reason;
      try {
        hooks.onAuthFailure?.(c, { requestId, reason });
      } catch {
        // A failing hook never changes the answer.
      }
      return unauthorized();
    };

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
      let verdict: Awaited<ReturnType<typeof verifyAccessToken>>;
      let decision: Awaited<ReturnType<typeof resolveAccess>>;
      try {
        verdict = await verifyAccessToken(options.storage, token, {
          now,
          onTouchError: (error) =>
            logger.warn('last_used_at write failed', {
              requestId,
              error: error instanceof Error ? error.name : typeof error,
            }),
        });
        if (!verdict.ok) return deny(verdict.reason);
        if (verdict.touch) runInBackground(c, verdict.touch, 'token_touch');
        decision = await resolveAccess({
          storage: options.storage,
          projectSlug: slug,
          principal: { grantId: verdict.grantId },
          catalog,
          now,
        });
      } catch (error) {
        // Storage trouble is never "allowed" (fail closed), and never a 401 that would make clients drop the token.
        log['error'] = error instanceof Error ? error.name : typeof error;
        logger.error('access resolution failed', { requestId, error: log['error'] });
        return json(503, '{"error":"unavailable"}', { 'Retry-After': '5' });
      }
      log['tokenId'] = verdict.tokenId;
      if (!decision.ok) return deny(decision.reason);
      resolved = { tokenId: verdict.tokenId, access: decision.access, credential: decision.credential };
      cache.set(cacheKey, resolved, now, [verdict.expiresAt, decision.access.expiresAt]);
    } else {
      log['cached'] = true;
    }
    const { access, tokenId } = resolved;
    log['tokenId'] = tokenId;
    log['grantId'] = access.grantId;

    // What the request asks for comes from the body, never from the `Mcp-Method` / `Mcp-Name` headers alone: the SDK
    // cross-checks those only for modern requests, so a legacy request could name `subscriptions/listen` in a header
    // to skip rate limiting, or a granted tool to hide an ungranted call from the audit (P2-12).
    let mcpMethod: string | null = null;
    let mcpName: string | null = null;
    if (c.req.method === 'POST') {
      const peek = await peekWithin(c.req.raw, maxBodyBytes, timeoutMs);
      if (peek === 'timeout') {
        log['timeout'] = true;
        return json(504, '{"error":"timeout"}');
      }
      if (peek.kind === 'too_large') {
        log['reject'] = 'body_size';
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
      scope = Object.freeze({
        tools: allTools.filter((t) => access.tools.includes(t.name)),
        ctx: Object.freeze({
          requestId,
          credential,
          accounts: access.accounts,
          budget: createBudget(callBudget),
          limiter: limiters.for(credential.id),
          limits: access.limits,
          connection: Object.freeze({ project: access.projectSlug, allowedTools: access.tools }),
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
    // One deadline for the whole exchange: before the headers it answers 504; after them (SSE) it ends the stream,
    // so a tool that never finishes can't hold the connection open.
    const deadline = new Deadline(timeoutMs, () => {
      log['timeout'] = true;
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
    response = deadline.bound(response);
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
