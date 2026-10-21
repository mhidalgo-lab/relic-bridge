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
  ADMIN_UI_BASE,
  type AdminCall,
  type AdminCallResult,
  type AdminUiDeps,
  createAdminUi,
  type UiPrincipal,
  type UiTool,
} from '@relic-bridge/admin-ui';
import {
  type AuthenticatedAccess,
  authenticateAccess,
  bearerToken,
  checkTokenFormat,
  type EffectiveAccess,
  hashToken,
  isCryptoError,
  isKeyRejection,
  type Keyring,
  type KeyValidator,
  nerdGraphKeyValidator,
  openCredential,
  TOKEN_PREFIX,
} from '@relic-bridge/auth';
import {
  APPROVAL_LEDGER_TTL_SECONDS,
  buildMcpServer,
  type Clock,
  compositeSiblings,
  createBudget,
  createBuiltinTools,
  createMemoryTaskStore,
  createSemaphoreLimiter,
  createWriteTools,
  DEFAULT_CONCURRENCY,
  DEFAULT_LIMITS,
  type FetchLike,
  type Limiter,
  LimiterPool,
  type Logger,
  newRequestId,
  PUBLIC_DISCOVERY_METHODS,
  publicCatalogTools,
  QueryCache,
  type QueryLimits,
  type Secret,
  type ServerRuntime,
  silentLogger,
  systemClock,
  type TaskStore,
  TOOL_CATALOG_PATH,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
  toolCatalog,
  VERSION,
  WRITE_TOOL_NAMES,
  type WriteIntent,
} from '@relic-bridge/core';
import { type KvRepository, SLUG_RE, type Storage } from '@relic-bridge/storage';
import { type Context, type ExecutionContext, Hono } from 'hono';
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
import { peekJsonRpc, type RpcPeek, type WriteRound } from './jsonrpc.ts';
import {
  createConsentScreen,
  OAUTH_APPROVALS_FORGET_PATH,
  OAUTH_APPROVALS_PATH,
  OAUTH_CONSENT_PATH,
} from './oauth/consent.ts';
import {
  createOAuthRuntime,
  looksLikeOAuthToken,
  MAX_OAUTH_TOKEN_CHARS,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_MAX_BODY_BYTES,
  OAUTH_METADATA_PATH,
  OAUTH_PROTECTED_RESOURCE_PREFIX,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  type OAuthAuthentication,
  type OAuthOptions,
  type OAuthRuntime,
} from './oauth/server.ts';
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
import { createQuotaGuard, type QuotaDenial, type QuotaStore } from './quota.ts';
import {
  applySecurityHeaders,
  checkHost,
  checkOrigin,
  defaultAllowedHostnames,
  originHostname,
  safeMcpHeader,
} from './security.ts';
import { createSessionManager, type SessionManager, type SessionPrincipal } from './session.ts';
import { serveTaskRequest, TASK_METHODS } from './tasks.ts';

/** Largest request body accepted on the MCP route by default (a tool call is a few KiB). */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024;
/** The whole MCP exchange (tool calls poll NRQL for up to 120 s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
/** Subrequest budget per MCP request on Node (ADR-0010 "paid" figure; Workers sets its own). */
export const DEFAULT_CALL_BUDGET = 1000;

export type StorageForHttp = Pick<
  Storage,
  'projects' | 'grants' | 'users' | 'credentials' | 'accessTokens' | 'settings' | 'grantUsage'
>;

/** What the hooks know about an authenticated MCP request. Never contains the token or the New Relic key. */
export interface McpRequestInfo {
  readonly requestId: string;
  readonly projectSlug: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly tokenId: string;
  readonly userId: string | null;
  /** The OAuth client of an OAuth access token (P5-01); null for a device token. */
  readonly clientId: string | null;
  /** The JSON-RPC method of a POST body (sanitised); null for GET/DELETE or a body without one. Never header-only. */
  readonly mcpMethod: string | null;
  /** `params.name` of the body (sanitised): the tool name for `tools/call`. */
  readonly mcpName: string | null;
  /**
   * For a `tools/call` of a write tool: how the raw body relates to the write limit (P7-35, see `WriteRound`). `null` or
   * absent means "unknown": the write bucket charges it. A `question` round is also marked on the tool context so it
   * cannot send a change.
   */
  readonly writeRound?: WriteRound | null;
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
 * check IdP answers, not a credential of ours. `admin_session` is the admin UI pages (P4-03), which check the session
 * cookie. `oauth` is the unauthenticated OAuth endpoints (P5-01: metadata, authorize, token, registration).
 */
export type AuthScope =
  | 'mcp_token'
  | 'admin_token'
  | 'passthrough_key'
  | 'identity'
  | 'admin_session'
  | 'oauth';

/**
 * What a finished MCP request looked like to the hooks. `rpcErrorCode`: the JSON-RPC `error.code` of a JSON answer
 * (an HTTP 200 or 404 can carry one, e.g. `-32601`), or of the one response in an SSE answer to a POST (P8-110); not read
 * for `tools/call` (a tool's own errors are tool events) nor for open-ended streams (P8-102).
 */
export interface McpOutcome {
  readonly status: number;
  readonly durationMs: number;
  readonly rpcErrorCode?: number;
}

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
  /**
   * A write tool is about to send its mutation (P7-28, audit). **Awaited**, and unlike every other hook it must reject
   * when the row could not be stored: the write is then refused with nothing sent. `createHttpApp` refuses
   * `writeTools: true` without it.
   */
  onWriteIntent?(c: Context, info: McpRequestInfo, intent: WriteIntent): Promise<void>;
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
  /**
   * A grant's quota refused a NerdGraph call (P7-12; audit). Runs in the background; must not throw. Carries the
   * period, what ran out, the cap and the reset time of that grant only.
   */
  onQuotaDenied?(c: Context, info: McpRequestInfo, denial: QuotaDenial): Promise<void> | void;
  afterMcp?(c: Context, info: McpRequestInfo, outcome: McpOutcome): Promise<void> | void;
  /** `afterMcp` for the pass-through route (P8-90). Runs in the background; must not throw. */
  afterPassthrough?(c: Context, info: PassthroughRequestInfo, outcome: McpOutcome): Promise<void> | void;
  /**
   * An MCP request (a POST with a JSON-RPC method) is about to be handled, after authentication and the pre-handler
   * hooks (P8-90). Return the ids of the span this request will be recorded as: they are put on the request's log
   * lines (`traceId`, `spanId`) so New Relic shows the logs in the trace. `undefined`: no span (not sampled). Runs in
   * the request path, so it must be synchronous, cheap and must not throw.
   */
  traceContext?(
    c: Context,
    info: McpRequestInfo | PassthroughRequestInfo,
  ): { readonly traceId: string; readonly spanId: string } | undefined;
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
  /** Wait between NRQL polls and retries (tests). Default: `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  /**
   * Cross-process NerdGraph concurrency (P7-10; the Workers Durable Object limiter): a limiter for a credential id,
   * entered after a slot of this process's own semaphore. It must fail open (never block) when its store is down.
   */
  readonly sharedConcurrency?: (credentialId: string) => Limiter;
  /**
   * `'auto'` (default): HSTS when the request URL is https (or when `hstsAlways` is set). `true` declares a
   * TLS-terminating proxy: HSTS on every response, and the pass-through TLS guard accepts plain-http requests.
   * `false` never sends HSTS.
   */
  readonly hsts?: 'auto' | boolean;
  /**
   * With `hsts: 'auto'`, send HSTS on every response even over a plain-http listener (P8-66: the public URL is https,
   * so a TLS proxy is presumably in front). Unlike `hsts: true` it declares nothing: the pass-through `tls_required`
   * guard still refuses plain http to a non-loopback host.
   */
  readonly hstsAlways?: boolean;
  /** Runs background work (Workers: `executionCtx.waitUntil`). Default: try `executionCtx`, else fire-and-forget. */
  readonly waitUntil?: (c: Context, task: Promise<unknown>) => void;
  readonly hooks?: HttpAppHooks;
  /** Enables `/api/admin/v1` (P2-09). */
  readonly admin?: AdminApiOptions;
  /** Enables `/passthrough/mcp` (P2-15): callers bring their own New Relic key per request. Off when absent. */
  readonly passthrough?: PassthroughOptions;
  /** Enables the `/auth/*` sign-in routes (P4-01) and admin setup links. Off when absent. */
  readonly identity?: IdentityOptions;
  /**
   * Enables the OAuth 2.1 authorization server (P5-01): `/oauth/*`, RFC 8414 metadata, and OAuth access tokens on
   * `/p/:slug/mcp` next to device tokens. Needs `identity` (its public URL is the issuer, its `kv` holds the state).
   */
  readonly oauth?: OAuthOptions;
  /**
   * NRQL query cache (P7-02). Default: an in-memory LRU keyed with the master-key-derived id key. `null` turns caching
   * off (`RB_QUERY_CACHE=off`). Entries are scoped per grant and per pass-through key (THREAT_MODEL T16).
   */
  readonly queryCache?: QueryCache | null;
  /**
   * Opt-in write tools (P7-09, ADR-0015, `RB_WRITE_TOOLS=on`). Default false: the write tools are not in the catalog at
   * all, so no project or grant can name them and OAuth never advertises `mcp:write`. On: a connection still gets one
   * only when its project and grant name it explicitly (and, over OAuth, its token carries `mcp:write`). Pass-through
   * connections never get write tools.
   */
  readonly writeTools?: boolean;
  /**
   * `RB_WRITE_APPROVAL=required` (P7-25): a write is refused unless the client can ask a person and the person approves
   * (MCP elicitation). Default false: `confirm: true` alone is enough when the client cannot be asked.
   */
  readonly requireWriteApproval?: boolean;
  /** The host runtime, shown by `whoami` (P8-112). */
  readonly runtime?: ServerRuntime;
  /**
   * Where per-grant quota counters live (P7-12). Default: `storage.grantUsage` (atomic on SQLite and D1). The Worker passes
   * its Durable Object store when `RB_SHARED_LIMITER=on`.
   */
  readonly quotaStore?: QuotaStore;
  /**
   * MCP Tasks extension (P7-13): where task records live (the storage `kv`; records are sealed and expire after 15
   * minutes). Absent: the extension is not offered and slow queries answer with their `queryId` handle, as for clients
   * without the extension. Project routes only (not pass-through).
   */
  readonly taskStore?: TaskStore;
  /**
   * Kill switch for the Tasks extension (P7-34, `RB_TASKS`). Default true. False: no tasks capability is advertised, no
   * task record is ever written (project routes and pass-through), a slow call answers inline as for a client without
   * the extension, and `tasks/*` are unknown methods.
   */
  readonly tasks?: boolean;
  /**
   * Where spent write approvals are remembered (P7-26): the storage `kv` (atomic `increment`, only the approval key, a
   * hash, is stored, expiring after the approval window). Absent: write approvals are bound to a time
   * window only and a replay inside it is not refused.
   */
  readonly approvalStore?: Pick<KvRepository, 'increment'>;
  /**
   * Registry-friendly discovery (P7-14, `RB_PUBLIC_TOOL_CATALOG=on`). Default false: every MCP request needs a
   * credential. On: `GET /.well-known/relic-bridge/tools.json` serves the static read-only tool catalog, and a POST to
   * `/p/:slug/mcp` without an `Authorization` header that asks only for `initialize`, `server/discover`, `ping` or
   * `tools/list` is answered from that same catalog, identically for every slug (no storage read: no project
   * existence oracle). Everything else still answers the standard 401.
   */
  readonly publicToolCatalog?: boolean;
  /**
   * Offer the MCP Apps chart view (P7-16, `RB_MCP_APPS`). Default true: `_meta.ui` and the `ui://` resource go to
   * clients that declare MCP Apps support. False: neither appears on any request.
   */
  readonly mcpApps?: boolean;
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
/** Largest unauthenticated discovery body read (P7-14): an `initialize` is well under 2 KiB. */
const PUBLIC_DISCOVERY_MAX_BYTES = 16 * 1024;
/** How long an unauthenticated discovery body may take to arrive. */
const PUBLIC_DISCOVERY_READ_MS = 10_000;
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

const RPC_PEEK_MAX = 8192;
/** How long a clone of a streamed answer is read for its JSON-RPC response before giving up (P8-110). */
const RPC_PEEK_SSE_MS = 5000;

/** The JSON-RPC error code of one parsed message, when it is a response carrying one. */
function codeOf(message: unknown): number | undefined {
  const code = (message as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined;
}

/** The first JSON-RPC response in an SSE text (`event: message` / `data: <json>`), as `{ error code }` or `{}`. */
function rpcErrorFromSse(text: string): { readonly rpcErrorCode?: number } | undefined {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      const message = JSON.parse(data) as { result?: unknown; error?: unknown } | null;
      if (message === null || typeof message !== 'object') continue;
      // A notification (progress, log) is not the answer: keep reading for the response.
      if (message.result === undefined && message.error === undefined) continue;
      const code = codeOf(message);
      return code === undefined ? {} : { rpcErrorCode: code };
    } catch {
      // A half-read event: nothing to say about it.
    }
  }
  return undefined;
}

/**
 * The JSON-RPC error code of a small JSON answer, or of the single response in an SSE answer to a POST, for the span
 * status (P8-102, P8-110). The response is cloned synchronously (call this before the client reads it); the clone is
 * read apart from the client's stream, bounded in size and time, and never for `tools/call` (a tool's own errors are
 * tool events) nor for open-ended streams (a standalone GET, `subscriptions/listen`). Never throws, never delays the
 * client: await the returned promise only in the background.
 */
function rpcErrorOf(
  response: Response,
  mcpMethod: string | null,
  httpMethod: string,
): Promise<{ readonly rpcErrorCode?: number }> {
  if (mcpMethod === null || mcpMethod === 'tools/call') return Promise.resolve({});
  const type = response.headers.get('content-type') ?? '';
  const sse = type.startsWith('text/event-stream');
  if (sse && (httpMethod !== 'POST' || mcpMethod === 'subscriptions/listen')) return Promise.resolve({});
  if (!sse && !type.startsWith('application/json')) return Promise.resolve({});
  let copy: Response;
  try {
    copy = response.clone();
  } catch {
    return Promise.resolve({});
  }
  const read = async (): Promise<{ readonly rpcErrorCode?: number }> => {
    if (!sse) {
      const text = await copy.text();
      if (text.length > RPC_PEEK_MAX) return {};
      const code = codeOf(JSON.parse(text));
      return code === undefined ? {} : { rpcErrorCode: code };
    }
    const reader = copy.body?.getReader();
    if (reader === undefined) return {};
    const decoder = new TextDecoder();
    let text = '';
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        received += value.byteLength;
        text += decoder.decode(value, { stream: !done });
      }
      const found = rpcErrorFromSse(text);
      if (found !== undefined) return found;
      if (done || received > RPC_PEEK_MAX) return {};
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = read().catch(() => ({}) as { readonly rpcErrorCode?: number });
  const timeout = new Promise<{ readonly rpcErrorCode?: number }>((resolve) => {
    timer = setTimeout(() => resolve({}), RPC_PEEK_SSE_MS);
  });
  return Promise.race([guarded, timeout]).finally(() => {
    clearTimeout(timer);
    // Release the clone's branch whatever happened, so a half-read stream holds no buffer.
    void copy.body?.cancel().catch(() => undefined);
  });
}

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

/** The single answer for every authentication and authorization failure (T19: nothing to enumerate). */
function unauthorized(challenge: string = WWW_AUTHENTICATE): Response {
  return json(401, UNAUTHORIZED_BODY, { 'WWW-Authenticate': challenge });
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
  // Per-grant quota counters (P7-12): the host's store, else the storage table (atomic on SQLite and D1).
  const quotaStore: QuotaStore = options.quotaStore ?? options.storage.grantUsage;
  const tasksOn = options.tasks !== false;
  const taskStore = tasksOn ? options.taskStore : undefined;
  const approvalStore = options.approvalStore;
  // The process-local slot first, then the shared one: only calls this process would run anyway compete across them.
  const sharedConcurrency = options.sharedConcurrency;
  const withShared = (local: Limiter, credentialId: string): Limiter => {
    if (sharedConcurrency === undefined) return local;
    const shared = sharedConcurrency(credentialId);
    return Object.freeze({ run: <T>(task: () => Promise<T>) => local.run(() => shared.run(task)) });
  };
  // The NRQL query cache lives with the app (process / isolate), never in module state (T21); scopes keep grants apart.
  const queryCache =
    options.queryCache === null
      ? undefined
      : (options.queryCache ?? new QueryCache({ macKey: options.keyring.queryCacheKeys().id }));
  // One tool set per app: its caches are keyed by credential id, region and account (never shared across tenants).
  const toolDeps = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  };
  const writeTools = options.writeTools === true;
  const allTools = [...createBuiltinTools(toolDeps), ...(writeTools ? createWriteTools(toolDeps) : [])];
  const catalog = allTools.map((t) => t.name);
  const hooks = options.hooks ?? {};
  // Every write is recorded before its mutation (P7-28): no audit hook, no write tools (`serve` and the Worker already
  // refuse `RB_WRITE_TOOLS=on` with `RB_AUDIT=off`; this holds for any other host).
  const onWriteIntent = hooks.onWriteIntent;
  if (writeTools && onWriteIntent === undefined) {
    throw new TypeError(
      'writeTools needs an audit hook (hooks.onWriteIntent, e.g. createAuditRecorder().hooks)',
    );
  }
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

  /**
   * The span ids of this MCP request for its log lines (P8-90): fields for the request's logger and the access-log
   * record. Empty when telemetry is off, the request is not sampled or the hook fails (never a failed request).
   */
  const traceFields = (
    c: Context,
    info: McpRequestInfo | PassthroughRequestInfo,
    log: Record<string, unknown>,
  ): { traceId?: string; spanId?: string } => {
    try {
      const ids = hooks.traceContext?.(c, info);
      if (ids === undefined) return {};
      log['traceId'] = ids.traceId;
      log['spanId'] = ids.spanId;
      return { traceId: ids.traceId, spanId: ids.spanId };
    } catch {
      return {};
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
        era: ctx.era,
        mcpApps: options.mcpApps !== false,
        requireWriteApproval: options.requireWriteApproval === true,
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        ...(scope.onToolCall ? { onToolCall: scope.onToolCall } : {}),
      });
    },
    {
      legacy: 'stateless',
      maxRequestBodySize: maxBodyBytes,
      onerror: (error) => logger.debug('mcp transport', { error: error.message.slice(0, 200) }),
    },
  );

  // Registry-friendly discovery (P7-14): a separate handler whose server holds the static read-only catalog and no
  // context at all, so nothing it serves can reach New Relic, storage or a project (a call would fail closed).
  const publicToolCatalog = options.publicToolCatalog === true;
  const publicTools = Object.freeze(publicCatalogTools(createBuiltinTools(toolDeps)));
  const publicMcp = publicToolCatalog
    ? createMcpHandler(
        () =>
          buildMcpServer({
            tools: publicTools,
            ctx: () => {
              throw new Error('the public tool catalog has no tool context');
            },
            toolsListChanged: false,
            prompts: [],
            resources: [],
          }),
        {
          legacy: 'stateless',
          maxRequestBodySize: PUBLIC_DISCOVERY_MAX_BYTES,
          onerror: (error) =>
            logger.debug('mcp transport (public catalog)', { error: error.message.slice(0, 200) }),
        },
      )
    : undefined;
  const publicCatalogBody = publicToolCatalog ? JSON.stringify(toolCatalog(publicTools)) : undefined;

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
  ): Promise<
    | {
        readonly mcpMethod: string | null;
        readonly mcpName: string | null;
        readonly round: WriteRound | null;
      }
    | Response
  > => {
    const log = c.get('log');
    let mcpMethod: string | null = null;
    let mcpName: string | null = null;
    let round: WriteRound | null = null;
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
        round = peek.round;
      }
    }
    if (mcpMethod !== null) log['mcpMethod'] = mcpMethod;
    if (mcpName !== null) log['mcpName'] = mcpName;
    return { mcpMethod, mcpName, round };
  };

  /**
   * Hand the request to the MCP handler under one deadline for the whole exchange: before the headers it answers 504;
   * after them (SSE) it ends the stream, so a tool that never finishes can't hold the connection open.
   */
  const serveMcp = async (
    c: Context<Env>,
    authInfo: AuthInfo | undefined,
    mcpMethod: string | null,
    mcpName: string | null,
    handler: typeof mcp = mcp,
  ): Promise<Response> => {
    const requestId = c.get('requestId');
    // Response headers received? After them the deadline only cuts the body: for a stream that is open-ended by design
    // (a standalone GET, `subscriptions/listen`) that is the normal end, not a timeout (P8-50).
    let responded = false;
    const openEnded = c.req.method === 'GET' || mcpMethod === 'subscriptions/listen';
    const deadline = new Deadline(timeoutMs, () => {
      if (responded && openEnded) {
        logger.info('mcp stream closed at deadline', { requestId, ms: timeoutMs, mcpMethod });
        return;
      }
      c.get('log')['timeout'] = true;
      logger.warn('mcp request timed out', { requestId, ms: timeoutMs, mcpMethod, mcpName });
    });
    let response: Response;
    try {
      response = await Promise.race([
        handler.fetch(c.req.raw, authInfo === undefined ? {} : { authInfo }).then((r) => {
          responded = true;
          return r;
        }),
        deadline.expired.then(() => json(504, '{"error":"timeout"}')),
      ]);
    } catch (error) {
      deadline.clear();
      throw error;
    }
    return deadline.bound(response);
  };

  /** `tasks/*` (P7-13) under the same request deadline as any MCP exchange (one task step at most). */
  const serveTasks = async (c: Context<Env>, scope: RequestScope): Promise<Response> => {
    const log = c.get('log');
    const deadline = new Deadline(timeoutMs, () => {
      log['timeout'] = true;
      logger.warn('task request timed out', { requestId: c.get('requestId'), ms: timeoutMs });
    });
    try {
      return await Promise.race([
        serveTaskRequest(c.req.raw, {
          ctx: scope.ctx,
          resume: { tools: scope.tools, ...(scope.onToolCall ? { onToolCall: scope.onToolCall } : {}) },
          log,
        }),
        deadline.expired.then(() => json(504, '{"error":"timeout"}')),
      ]);
    } finally {
      deadline.clear();
    }
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

  // OAuth 2.1 (P5-01): configuration and caches only; grants, codes and tokens live in storage `kv`.
  if (options.oauth && !identity) {
    throw new TypeError('oauth needs sign-in (identity): its public URL is the issuer');
  }
  // The admin UI's view of sessions (P4-03), shared by the admin pages and the OAuth consent screen (P5-04). The
  // in-process admin API calls go through `app`, built below (used at request time only).
  const uiAudit =
    options.admin?.audit?.admin.bind(options.admin.audit) ??
    options.identity?.audit?.admin?.bind(options.identity.audit);
  const uiDeps =
    options.identity && sessions
      ? adminUiDeps({
          sessions,
          publicUrl: options.identity.publicUrl,
          hooks,
          logger,
          runInBackground,
          audit: uiAudit,
          adminApi: options.admin !== undefined,
          tools: allTools.map((t) => ({
            name: t.name,
            title: t.title,
            group: t.group,
            kind: t.kind,
            ...(t.siblingTools === undefined ? {} : { siblings: t.siblingTools }),
          })),
          now: () => clock.now(),
          kv: options.identity.storage.kv,
          onRejected: (c, status) =>
            notifyRejected(c, { requestId: c.get('requestId'), status, reason: rejectReason(c.get('log')) }),
          fetchApp: (request, c) => {
            let ctx: ExecutionContext | undefined;
            try {
              ctx = c.executionCtx;
            } catch {
              // Node: no execution context
            }
            return app.fetch(request, c.env, ctx);
          },
        })
      : undefined;

  // The built-in sign-in and consent screen (P5-04), unless the caller brings its own consent step.
  const consentScreen =
    options.oauth && options.oauth.consent === undefined && identity && uiDeps
      ? createConsentScreen({
          sessions: uiDeps,
          storage: options.storage,
          kv: identity.storage.kv,
          catalog,
          toolTitles: new Map(allTools.map((t) => [t.name, t.title])),
          clock,
          logger,
          ...(uiAudit ? { audit: uiAudit } : {}),
          runInBackground,
        })
      : undefined;
  const oauth: OAuthRuntime | undefined =
    options.oauth && identity
      ? createOAuthRuntime({
          options: options.oauth,
          issuer: identity.publicUrl,
          kv: identity.storage.kv,
          storage: options.storage,
          catalog,
          clock,
          logger,
          runInBackground,
          ...(consentScreen ? { defaultConsent: consentScreen.handler } : {}),
          ...(uiAudit ? { audit: uiAudit } : {}),
          writeScope: writeTools,
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
      options.hsts === 'auto' || options.hsts === undefined
        ? options.hstsAlways === true || c.req.url.startsWith('https:')
        : options.hsts;
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
  if (publicCatalogBody !== undefined) {
    const body = publicCatalogBody;
    app.get(TOOL_CATALOG_PATH, () => json(200, body));
  }

  if (options.admin) {
    const admin = options.admin;
    app.route(
      ADMIN_API_BASE,
      createAdminApi({
        storage: admin.storage,
        usage: quotaStore,
        keyring: options.keyring,
        ...(adminVerifier ? { verifier: adminVerifier } : {}),
        ...(sessions ? { sessions } : {}),
        validateKey:
          admin.validateKey ??
          nerdGraphKeyValidator({ logger, clock, ...(options.fetch ? { fetch: options.fetch } : {}) }),
        catalog,
        compositeSiblings: compositeSiblings(allTools),
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
        ...(oauth ? { oauthDevices: oauth.devices, oauthClients: oauth.clients } : {}),
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
        identityHash: (idp, subject) => options.keyring.identityHash(idp, subject),
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

  if (oauth) {
    const rt = oauth;
    /** Pre-authentication limit (per IP) and declared body size, for the unauthenticated OAuth endpoints. */
    const gate = async (c: Context<Env>): Promise<Response | undefined> => {
      const declared = c.req.header('content-length');
      if (
        c.req.method === 'POST' &&
        declared !== undefined &&
        (!/^\d{1,15}$/.test(declared) || Number(declared) > OAUTH_MAX_BODY_BYTES)
      ) {
        c.get('log')['reject'] = 'body_size';
        return json(413, '{"error":"invalid_request","error_description":"Request body too large."}');
      }
      if (hooks.beforeAuth) {
        const requestId = c.get('requestId');
        const stop = await hooks.beforeAuth(c, requestId, 'oauth');
        if (stop) {
          notifyRejected(c, { requestId, status: stop.status, reason: rejectReason(c.get('log')) });
          return stop;
        }
      }
      return undefined;
    };
    const serve =
      (handler: (c: Context<Env>) => Promise<Response>) =>
      async (c: Context<Env>): Promise<Response> => {
        c.get('log')['oauth'] = true;
        return (await gate(c)) ?? handler(c);
      };
    app.get(
      OAUTH_METADATA_PATH,
      serve((c) => rt.metadata(c)),
    );
    app.get(
      `${OAUTH_PROTECTED_RESOURCE_PREFIX}/p/:slug/mcp`,
      serve(async (c) => rt.protectedResource(c.req.param('slug') ?? '')),
    );
    app.get(
      OAUTH_AUTHORIZE_PATH,
      serve((c) => rt.authorize(c)),
    );
    app.post(
      OAUTH_TOKEN_PATH,
      serve((c) =>
        rt.token(c, () => {
          cache.clear();
        }),
      ),
    );
    app.post(
      OAUTH_REGISTER_PATH,
      serve((c) => rt.register(c)),
    );
    // The consent form and the remembered approvals (P5-04): session pages, CSRF-checked posts.
    if (consentScreen) {
      const screen = consentScreen;
      app.post(
        OAUTH_CONSENT_PATH,
        serve((c) => screen.decide(c, rt)),
      );
      app.get(
        OAUTH_APPROVALS_PATH,
        serve((c) => screen.approvals(c)),
      );
      app.post(
        OAUTH_APPROVALS_FORGET_PATH,
        serve((c) => screen.forget(c)),
      );
    }
  }

  // Admin UI (P4-03): server-rendered pages under /admin, on whenever sign-in is (they need a session).
  if (uiDeps) {
    app.route(ADMIN_UI_BASE, createAdminUi(uiDeps));
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

    // With OAuth on, the challenge names this slug's Protected Resource Metadata (P5-02): built from the path alone,
    // so every denial on one URL is still byte-identical and an unknown slug answers like a known one (T19).
    const refused = oauth === undefined ? unauthorized : () => unauthorized(oauth.challenge(slug));
    const deny = (reason: string): Promise<Response> => denyWith(c, { requestId, reason }, log, refused);

    // Registry-friendly discovery (P7-14, opt-in): no `Authorization` header at all, and a body that only asks what the
    // server offers. Decided from the body (never the `Mcp-Method` header) and before the slug is looked at, so every
    // slug, known or not, gets the same answer; anything else is the same 401 as without the catalog.
    if (publicMcp !== undefined && c.req.header('authorization') === undefined) {
      if (c.req.method !== 'POST') return deny('missing_token');
      const peek = await peekWithin(c.req.raw, PUBLIC_DISCOVERY_MAX_BYTES, PUBLIC_DISCOVERY_READ_MS);
      if (
        peek === 'timeout' ||
        peek.kind !== 'message' ||
        peek.method === null ||
        !PUBLIC_DISCOVERY_METHODS.includes(peek.method)
      ) {
        // Refused without reading the rest: release the unread original (never awaited, it may be stalled).
        if (peek === 'timeout' || peek.kind === 'too_large')
          void c.req.raw.body?.cancel().catch(() => undefined);
        return deny('missing_token');
      }
      const method = safeMcpHeader(peek.method);
      log['publicCatalog'] = true;
      if (method !== null) log['mcpMethod'] = method;
      return serveMcp(c, undefined, method, null, publicMcp);
    }

    // 6. Authenticate, then authorise for this slug. The token is checked before the slug is looked at, so slugs
    // can't be probed without a valid token (T19); every denial is the same 401.
    const token = bearerToken(
      c.req.header('authorization'),
      oauth === undefined ? undefined : MAX_OAUTH_TOKEN_CHARS,
    );
    if (token === null)
      return deny(c.req.header('authorization') === undefined ? 'missing_token' : 'malformed_header');
    // Device tokens (`rb_…`, P2-05) and, when OAuth is on, provider-issued access tokens (P5-01). Anything else is
    // refused offline, before any storage read.
    const viaOAuth = oauth !== undefined && !token.startsWith(TOKEN_PREFIX) && looksLikeOAuthToken(token);
    if (!viaOAuth) {
      const formatProblem = checkTokenFormat(token);
      if (formatProblem !== null) return deny(formatProblem);
    }

    const now = clock.now();
    const cacheKey = `${await hashToken(token)}\n${slug}`;
    /** Resolve from storage (never the cache) and refresh the cache entry; a Response when refused. */
    const resolveFresh = async (): Promise<Omit<CachedAccess, 'expiresAt'> | Response> => {
      // One storage call on SQL storage (D1: one batch round trip, P3-09); repository reads otherwise.
      let auth: AuthenticatedAccess | OAuthAuthentication;
      try {
        auth =
          viaOAuth && oauth
            ? await oauth.authenticate(token, slug)
            : await authenticateAccess({
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
        cache.delete(cacheKey);
        if (auth.stage === 'access') log['tokenId'] = auth.tokenId;
        return deny(auth.reason);
      }
      const fresh = {
        tokenId: auth.tokenId,
        access: auth.access,
        credential: auth.credential,
        clientId: viaOAuth ? (auth as Extract<OAuthAuthentication, { ok: true }>).clientId : null,
      };
      cache.set(cacheKey, fresh, now, [auth.tokenExpiresAt, auth.access.expiresAt]);
      return fresh;
    };
    let resolved: Omit<CachedAccess, 'expiresAt'> | Response | undefined = cache.get(cacheKey, now);
    if (resolved === undefined) resolved = await resolveFresh();
    else log['cached'] = true;
    if (resolved instanceof Response) return resolved;
    log['tokenId'] = resolved.tokenId;
    log['grantId'] = resolved.access.grantId;
    if (resolved.clientId != null) log['oauthClient'] = resolved.clientId;

    // What the request asks for comes from the body, never from the `Mcp-Method` / `Mcp-Name` headers alone: the SDK
    // cross-checks those only for modern requests, so a legacy request could name `subscriptions/listen` in a header
    // to skip rate limiting, or a granted tool to hide an ungranted call from the audit (P2-12).
    const rpc = await readRpc(c);
    if (rpc instanceof Response) return rpc;
    const { mcpMethod, mcpName, round } = rpc;
    // A write tool call never runs on cached access (P7-28): a revoked grant, token or write tool stops the next write
    // at once, on every process, instead of within the cache TTL. Reads keep the cache.
    if (
      log['cached'] === true &&
      mcpMethod === 'tools/call' &&
      mcpName !== null &&
      WRITE_TOOL_NAMES.includes(mcpName)
    ) {
      resolved = await resolveFresh();
      if (resolved instanceof Response) return resolved;
      log['cached'] = false;
    }
    const { access, tokenId } = resolved;
    const clientId = resolved.clientId ?? null;
    log['tokenId'] = tokenId;
    log['grantId'] = access.grantId;
    if (clientId !== null) log['oauthClient'] = clientId;
    const info: McpRequestInfo = Object.freeze({
      requestId,
      projectSlug: access.projectSlug,
      projectId: access.projectId,
      grantId: access.grantId,
      tokenId,
      userId: access.userId,
      clientId,
      mcpMethod,
      mcpName,
      writeRound: round,
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
      const trace = traceFields(c, info, log);
      const toolLogger = logger.child({
        requestId,
        project: access.projectSlug,
        grantId: access.grantId,
        ...trace,
      });
      const granted = affordable(allTools.filter((t) => access.tools.includes(t.name)));
      scope = Object.freeze({
        tools: granted.tools,
        ctx: Object.freeze({
          requestId,
          credential,
          // P7-35: a call the write limit did not charge (a question round) cannot send a change.
          ...(info.writeRound === 'question' ? { writeQuestionOnly: true } : {}),
          accounts: access.accounts,
          budget: createBudget(callBudget),
          limiter: withShared(limiters.for(credential.id), credential.id),
          limits: capLimits(access.limits),
          ...(access.quota === null
            ? {}
            : {
                quota: createQuotaGuard({
                  store: quotaStore,
                  grantId: access.grantId,
                  quota: access.quota,
                  now: () => clock.now(),
                  logger: toolLogger,
                  onDenied: (denial) => {
                    const hook = hooks.onQuotaDenied;
                    if (hook)
                      runInBackground(
                        c,
                        Promise.resolve().then(() => hook(c, info, denial)),
                        'on_quota_denied',
                      );
                  },
                }),
              }),
          ...(queryCache === undefined
            ? {}
            : {
                queryCache: Object.freeze({
                  cache: queryCache,
                  scope: `project:${access.projectId}/grant:${access.grantId}`,
                }),
              }),
          // Tasks are visible to the device that created them only: project, grant, token (an OAuth device's token id
          // is stable across refreshes) and OAuth client (T32).
          ...(taskStore === undefined
            ? {}
            : {
                tasks: Object.freeze({
                  store: taskStore,
                  owner: `project:${access.projectId}/grant:${access.grantId}/token:${tokenId}/client:${clientId ?? '-'}`,
                }),
              }),
          // Spent write approvals, scoped to project, grant and user (P7-26): one approval answers one attempt.
          ...(approvalStore === undefined
            ? {}
            : {
                writeApprovals: Object.freeze({
                  consume: async (key: string): Promise<boolean> =>
                    (await approvalStore.increment(
                      `write-approval:${access.projectId}/${access.grantId}/${access.userId ?? '-'}/${key}`,
                      { expirationTtl: APPROVAL_LEDGER_TTL_SECONDS },
                    )) === 1,
                }),
              }),
          ...(onWriteIntent === undefined
            ? {}
            : {
                writeAudit: Object.freeze({
                  intent: (intent: WriteIntent): Promise<void> => onWriteIntent(c, info, intent),
                }),
              }),
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
      // P8-85 (V16.3.4): a secret-use failure is a row too. The credential id and the master key version only (never
      // key material, ciphertext or the error's message); capped (T20) because every request would write one.
      const stored = resolved.credential.key;
      const reason = isCryptoError(error) ? error.code : 'credential_unavailable';
      await uiAudit?.({
        actor: { requestId, userId: access.userId, grantId: access.grantId, tokenId, clientId },
        action: 'credential.decrypt_failed',
        targetType: 'credential',
        targetId: access.credential.id,
        projectId: access.projectId,
        status: 'error',
        errorCode: reason,
        capped: true,
        details: {
          project: access.projectSlug,
          ...(stored.kind === 'encrypted' ? { keyVersion: stored.keyVersion } : {}),
        },
      });
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
    // `tasks/*` (P7-13): answered here, the SDK has no Tasks runtime. Same scope, budget and hooks as any MCP request.
    const response =
      scope.ctx.tasks !== undefined && mcpMethod !== null && TASK_METHODS.includes(mcpMethod)
        ? await serveTasks(c, scope)
        : await serveMcp(c, authInfo, mcpMethod, mcpName);
    if (hooks.afterMcp) {
      const after = hooks.afterMcp;
      const status = response.status;
      const durationMs = clock.now() - started;
      const rpcError = rpcErrorOf(response, mcpMethod, c.req.method);
      runInBackground(
        c,
        rpcError.then((rpc) => after(c, info, Object.freeze({ status, durationMs, ...rpc }))),
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
    // Pass-through keeps nothing of the caller's, so its tasks live in the host's task store when it has one, else in a
    // bounded in-process one (sealed, lost on restart; P7-22).
    const ptTaskStore = tasksOn ? (taskStore ?? createMemoryTaskStore()) : undefined;
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
          limiter: withShared(createSemaphoreLimiter(concurrency), credentialId),
          limits: ptLimits,
          // Keyed by the key fingerprint id and the key itself (hashed): one caller's key never reads another's entries.
          ...(queryCache === undefined
            ? {}
            : { queryCache: Object.freeze({ cache: queryCache, scope: 'passthrough' }) }),
          // Tasks belong to the key's fingerprint (T32, T12): never the key. The fingerprint is keyed per app instance, so
          // a restart (or another replica without a shared `fingerprintSecret`) makes old tasks "not found".
          ...(ptTaskStore === undefined
            ? {}
            : {
                tasks: Object.freeze({
                  store: ptTaskStore,
                  owner: `passthrough:${credentialId}/region:${region}`,
                }),
              }),
          connection: Object.freeze({ allowedTools: ptToolNames, unavailableTools: ptGranted.unavailable }),
          logger: logger.child({ requestId, keyId, ...traceFields(c, info, log) }),
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
      const started = clock.now();
      const response =
        tasksOn && mcpMethod !== null && TASK_METHODS.includes(mcpMethod)
          ? await serveTasks(c, scope)
          : await serveMcp(c, authInfo, mcpMethod, mcpName);
      if (hooks.afterPassthrough) {
        const after = hooks.afterPassthrough;
        const status = response.status;
        const durationMs = clock.now() - started;
        const rpcError = rpcErrorOf(response, mcpMethod, c.req.method);
        runInBackground(
          c,
          rpcError.then((rpc) => after(c, info, Object.freeze({ status, durationMs, ...rpc }))),
          'after_passthrough',
        );
      }
      return response;
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

/** What `adminUiDeps` needs from `createHttpApp`. */
interface AdminUiWiring {
  readonly sessions: SessionManager;
  readonly publicUrl: string;
  readonly hooks: HttpAppHooks;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  readonly audit: ((event: AdminAuditEvent) => Promise<void>) | undefined;
  /** A pre-authentication hook refused a page (audit `request.rejected`). */
  readonly onRejected: (c: Context, status: number) => void;
  /** The admin API is mounted (else every `callAdmin` is a 404). */
  readonly adminApi: boolean;
  /** The tool catalogue the project and grant screens choose from (P4-04). */
  readonly tools: readonly UiTool[];
  readonly now: () => number;
  /** Single-use UI form handles (P4-07). */
  readonly kv: Pick<KvRepository, 'put' | 'take' | 'list'>;
  /** The whole app, for in-process admin API calls. */
  readonly fetchApp: (request: Request, c: Context) => Response | Promise<Response>;
}

/** Headers that carry the client address to the per-IP hooks; copied onto in-process admin API calls. */
const CLIENT_ADDRESS_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'] as const;

/**
 * The admin UI's view of the P4-02 sessions. Pages get a `UiPrincipal` (no session secret, only what pages show and
 * the CSRF token they embed); the session it came from stays here, keyed weakly by that object.
 */
function adminUiDeps(w: AdminUiWiring): AdminUiDeps {
  const { sessions, hooks } = w;
  const publicOrigin = new URL(w.publicUrl).origin;
  const origins = new WeakMap<UiPrincipal, SessionPrincipal>();
  const toUi = (p: SessionPrincipal): UiPrincipal => {
    const ui: UiPrincipal = Object.freeze({
      userId: p.user.id,
      email: p.user.email,
      displayName: p.user.displayName,
      role: p.role,
      csrf: p.session.record.csrf,
      expiresAt: p.session.record.expiresAt,
      idleExpiresAt: p.session.idleExpiresAt,
    });
    origins.set(ui, p);
    return ui;
  };
  const sessionOf = (ui: UiPrincipal): SessionPrincipal => {
    const p = origins.get(ui);
    if (p === undefined) throw new TypeError('unknown admin UI principal');
    return p;
  };
  const requestId = (c: Context) => c.get('requestId') as string;

  return {
    secureCookies: publicOrigin.startsWith('https:'),
    tools: w.tools,
    publicUrl: publicOrigin,
    now: w.now,
    clearSessionCookie: sessions.clearCookie,
    onceStore: {
      put: (key, ttlSeconds) => w.kv.put(key, '1', { expirationTtl: ttlSeconds }),
      take: async (key) => (await w.kv.take(key)) !== null,
      list: async (prefix, limit) => (await w.kv.list({ prefix, limit })).keys.map((k) => k.name),
    },
    async beforeAuth(c) {
      const stop = await hooks.beforeAuth?.(c, requestId(c), 'admin_session');
      if (stop) w.onRejected(c, stop.status);
      return stop;
    },

    async authenticate(c) {
      const auth = await sessions.authenticate(c);
      if (auth.ok) {
        (c.get('log') as Record<string, unknown>)['principal'] = 'session';
        return { ok: true, principal: toUi(auth.principal) };
      }
      if (auth.reason === 'none') return { ok: false, presented: false };
      // A broken, expired or revoked cookie: audited and charged like any failed credential (P3-13 throttle).
      const info = { requestId: requestId(c), reason: auth.reason };
      (c.get('log') as Record<string, unknown>)['deny'] = auth.reason;
      try {
        hooks.onAuthFailure?.(c, info);
      } catch {
        // never changes the answer
      }
      let instead: Response | undefined;
      try {
        instead = await hooks.refuseAuthFailure?.(c, info);
      } catch {
        // as above
      }
      return { ok: false, presented: true, ...(instead ? { response: instead } : {}) };
    },

    checkFetchOrigin: (c, unsafe) => sessions.checkFetchOrigin(c, unsafe),
    csrfMatches: (ui, presented) => sessions.csrfMatches(sessionOf(ui), presented),

    onForbidden(c, ui, reason) {
      if (!w.audit) return;
      w.runInBackground(
        c,
        w.audit({
          actor: { requestId: requestId(c), userId: ui.userId },
          action: 'admin.forbidden',
          targetType: 'admin_ui',
          targetId: null,
          status: 'denied',
          errorCode: 'forbidden',
          refusal: true,
          details: {
            via: 'session',
            reason,
            method: c.req.method,
            route: c.req.routePath.slice(0, 100),
            role: ui.role,
          },
        }),
        'admin_audit',
      );
    },

    onError(c, error) {
      w.logger.error('admin ui error', {
        requestId: requestId(c),
        error: error instanceof Error ? error.name : typeof error,
      });
    },

    async callAdmin(c, ui, call: AdminCall): Promise<AdminCallResult> {
      if (!w.adminApi) return { status: 404, body: null };
      const session = sessionOf(ui);
      const url = new URL(`${publicOrigin}${ADMIN_API_BASE}${call.path}`);
      // The path is ours to build, but never let it escape the admin API (`/../`, encoded or not).
      if (
        url.origin !== publicOrigin ||
        !url.pathname.startsWith(`${ADMIN_API_BASE}/`) ||
        url.search !== ''
      ) {
        throw new TypeError('admin UI calls must stay inside the admin API');
      }
      for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
      const cookie = sessions.readCookie(c);
      const headers = new Headers({
        accept: 'application/json',
        // Our own page, by construction: the UI checked the form's CSRF token before an unsafe call got here.
        origin: publicOrigin,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': session.session.record.csrf,
      });
      if (typeof cookie === 'string') headers.set('cookie', `${sessions.cookieName}=${cookie}`);
      for (const name of CLIENT_ADDRESS_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      let body: string | undefined;
      if (call.body !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(call.body);
      }
      const res = await w.fetchApp(
        new Request(url, { method: call.method, headers, ...(body === undefined ? {} : { body }) }),
        c,
      );
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: res.status, body: parsed };
    },
  };
}
