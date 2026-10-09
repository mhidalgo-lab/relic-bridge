// SPDX-License-Identifier: Apache-2.0
// Rate limiting as `HttpAppHooks` (P2-07). Keeps the app free of limiter policy: it only knows the hook points.
//   beforeAuth         per-IP request limit; on the pass-through route also the auth-failure throttle (peek, below)
//   refuseAuthFailure  charges a failed authentication to the IP and answers 429 instead of 401 once the IP is over
//                      its failure budget (T1)
//   beforeMcp          per-token and per-grant limits (only reachable with a valid token)
//   beforePassthrough  per-key limit on the pass-through route (P2-15; only reachable with a key New Relic accepted)
//
// Lock-out semantics (P3-13, Phase 2 review M6): the failure throttle refuses further *failures* only. A request whose
// MCP access token or admin token verifies is served even from an IP that sprayed bad tokens, so nobody sharing your
// address (NAT, CGNAT, a laptop retrying a revoked token) can lock your devices out. The price is that a locked IP
// learns whether a guess was right (served vs 429), at the per-IP request rate instead of 10 per 5 minutes. That is no
// useful oracle: access tokens carry 256 random bits and admin tokens are refused at boot when predictable
// (`checkAdminToken`). Verifying costs no outbound call (a digest compare, a storage read bounded by the per-IP limit),
// and the comparison is constant time, so timing adds nothing the status code does not already say. The pass-through
// route keeps the strict rule (refuse a locked IP before anything): checking a New Relic key asks NerdGraph, and the
// key is the caller's, not one of our 256-bit secrets.
import { type Logger, WRITE_TOOL_NAMES } from '@relic-bridge/core';
import type { Context } from 'hono';
import type { AuthFailureInfo, AuthScope, HttpAppHooks, McpRequestInfo } from './app.ts';
import type { PassthroughRequestInfo } from './passthrough.ts';
import type { RateLimiter, RateLimitResult, RateLimitRule } from './rate-limit.ts';

/** Largest `Retry-After` sent (a day), whatever the bucket arithmetic says. */
const MAX_RETRY_AFTER_S = 86_400;

export interface RateLimitRules {
  /** Every request per client IP, before authentication (cheap-abuse and flood protection, T20). `null` = off. */
  readonly ip: RateLimitRule | null;
  /** Failed authentications per client IP (stricter, T1). `null` = off. */
  readonly authFailures: RateLimitRule | null;
  /** Requests per access token. `null` = off. */
  readonly token: RateLimitRule | null;
  /** Requests per grant, unless the grant sets its own `rateLimit`. `null` = off. */
  readonly grant: RateLimitRule | null;
  /** Pass-through requests per New Relic key (keyed by the key's fingerprint id, never the key). `null` = off. */
  readonly passthroughKey: RateLimitRule | null;
  /**
   * Sign-in requests (`/auth/*`) per client IP (P4-07), on top of `ip`: every sign-in start stores a login state, so an
   * unauthenticated client must not create thousands of them. Optional for callers built before it; `null` = off.
   */
  readonly signIn?: RateLimitRule | null;
  /**
   * Requests to the unauthenticated OAuth endpoints (P5-01: metadata, authorize, token, registration) per client IP, on
   * top of `ip`: registration and authorization write provider state. Optional for callers built before it; `null` =
   * off.
   */
  readonly oauth?: RateLimitRule | null;
  /**
   * Write tool calls per grant (P7-09, ADR-0015), on top of `token` and `grant`: stricter. The hook fails closed: a limiter
   * that throws refuses the write instead of allowing it. Whether the cap is deployment-wide depends on the limiter
   * (the Workers one needs the shared limiter, and refuses a write when that store is unreachable). Dry runs count too. Optional for callers built before it; `null` =
   * off.
   */
  readonly write?: RateLimitRule | null;
}

/** Sized for personal use: one MCP request makes a handful of NerdGraph calls against NRQL's 3,000/min/account. */
export const DEFAULT_RATE_LIMITS: RateLimitRules = Object.freeze({
  ip: Object.freeze({ requests: 600, perSeconds: 60 }),
  authFailures: Object.freeze({ requests: 10, perSeconds: 300 }),
  token: Object.freeze({ requests: 120, perSeconds: 60 }),
  grant: Object.freeze({ requests: 300, perSeconds: 60 }),
  passthroughKey: Object.freeze({ requests: 120, perSeconds: 60 }),
  signIn: Object.freeze({ requests: 60, perSeconds: 300 }),
  oauth: Object.freeze({ requests: 60, perSeconds: 300 }),
  write: Object.freeze({ requests: 20, perSeconds: 3600 }),
});

export interface RateLimitHooksOptions {
  /** Post-authentication limits (token, grant). */
  readonly limiter: RateLimiter;
  /**
   * Pre-authentication limits (IP, failures). Use a separate instance in production: unauthenticated traffic can
   * create many keys and must not push grant buckets out of a shared, bounded store.
   */
  readonly preAuthLimiter?: RateLimiter;
  /** Overrides of `DEFAULT_RATE_LIMITS`; `null` turns a rule off, `undefined` keeps the default. */
  readonly rules?: Partial<RateLimitRules> | undefined;
  /** Client address bucket key (`resolveClientIp`); `null` when unknown (then one shared `unknown` bucket is used). */
  readonly getClientIp: (c: Context) => string | null;
  readonly logger?: Logger;
}

/** The 429 answer: a JSON-RPC error whose message tells the agent to back off, plus `Retry-After`. */
export function rateLimited(retryAfterMs: number): Response {
  const seconds = Math.min(MAX_RETRY_AFTER_S, Math.max(1, Math.ceil(retryAfterMs / 1000) || 1));
  const message = `Rate limit reached. Slow down and retry after ${seconds} second${seconds === 1 ? '' : 's'}.`;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32029, message } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
  });
}

function mark(c: Context, reason: string): void {
  try {
    const log = c.get('log') as Record<string, unknown> | undefined;
    if (log) log['reject'] = reason;
  } catch {
    // no request log (a bare Context in a test)
  }
}

export function createRateLimitHooks(options: RateLimitHooksOptions): HttpAppHooks {
  const given = Object.fromEntries(Object.entries(options.rules ?? {}).filter(([, v]) => v !== undefined));
  const rules: RateLimitRules = { ...DEFAULT_RATE_LIMITS, ...given };
  const post = options.limiter;
  const pre = options.preAuthLimiter ?? options.limiter;
  const logger = options.logger;
  const ipKey = (c: Context): string => options.getClientIp(c) ?? 'unknown';

  // A limiter that fails (a remote store is down) fails open, loudly: authentication and access control still apply,
  // and refusing everyone would turn a limiter outage into a full outage.
  const guard = async (what: string, run: () => RateLimitResult | Promise<RateLimitResult>) => {
    try {
      return await run();
    } catch (error) {
      logger?.error('rate limiter failed (allowing)', {
        check: what,
        error: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  };

  return {
    async beforeAuth(c: Context, _requestId: string, scope: AuthScope) {
      const ip = ipKey(c);
      // Pass-through only: a locked IP is refused before its New Relic key is sent to NerdGraph for checking (valid
      // keys included). Token routes check the throttle on failure instead (`refuseAuthFailure`).
      if (rules.authFailures && scope === 'passthrough_key') {
        const rule = rules.authFailures;
        const r = await guard('auth_failures', () => pre.peek(`fail:${ip}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_auth_failures');
          return rateLimited(r.retryAfterMs);
        }
      }
      if (rules.signIn && scope === 'identity') {
        const rule = rules.signIn;
        const r = await guard('sign_in', () => pre.take(`signin:${ip}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_sign_in');
          return rateLimited(r.retryAfterMs);
        }
      }
      if (rules.oauth && scope === 'oauth') {
        const rule = rules.oauth;
        const r = await guard('oauth', () => pre.take(`oauth:${ip}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_oauth');
          return rateLimited(r.retryAfterMs);
        }
      }
      if (rules.ip) {
        const rule = rules.ip;
        const r = await guard('ip', () => pre.take(`ip:${ip}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_ip');
          return rateLimited(r.retryAfterMs);
        }
      }
      return undefined;
    },

    // Charged before the answer is sent (not in the background) so that the failure that exhausts the budget is the
    // last one answered 401. Once the bucket is empty nothing more is taken; it refills at the rule's rate.
    async refuseAuthFailure(c: Context, _info: AuthFailureInfo) {
      const rule = rules.authFailures;
      if (!rule) return undefined;
      const r = await guard('auth_failures', () => pre.take(`fail:${ipKey(c)}`, rule));
      if (r && !r.allowed) {
        mark(c, 'rate_limit_auth_failures');
        return rateLimited(r.retryAfterMs);
      }
      return undefined;
    },

    async beforeMcp(c: Context, info: McpRequestInfo) {
      // `subscriptions/listen` is answered at once and holds nothing; counting it would punish chatty-but-idle
      // clients that re-open it.
      if (info.listen) return undefined;
      if (rules.token) {
        const rule = rules.token;
        const r = await guard('token', () => post.take(`token:${info.tokenId}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_token');
          return rateLimited(r.retryAfterMs);
        }
      }
      const grantRule = info.access.rateLimit ?? rules.grant;
      if (grantRule) {
        const r = await guard('grant', () => post.take(`grant:${info.grantId}`, grantRule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_grant');
          return rateLimited(r.retryAfterMs);
        }
      }
      // Write tools (P7-09): a stricter bucket per grant, charged only for a granted write tool (an ungranted one is
      // answered "not found" anyway). Fails closed: no answer from the limiter, no write.
      const writeRule = rules.write;
      if (
        writeRule &&
        info.mcpMethod === 'tools/call' &&
        info.mcpName !== null &&
        WRITE_TOOL_NAMES.includes(info.mcpName) &&
        info.access.tools.includes(info.mcpName)
      ) {
        const r = await guard('write', () => post.take(`write:${info.grantId}`, writeRule));
        if (r === undefined || !r.allowed) {
          mark(c, 'rate_limit_write');
          return rateLimited(r?.retryAfterMs ?? 60_000);
        }
      }
      return undefined;
    },

    async beforePassthrough(c: Context, info: PassthroughRequestInfo) {
      if (info.listen || !rules.passthroughKey) return undefined;
      const rule = rules.passthroughKey;
      const r = await guard('passthrough_key', () => post.take(`key:${info.keyId}`, rule));
      if (r && !r.allowed) {
        mark(c, 'rate_limit_passthrough_key');
        return rateLimited(r.retryAfterMs);
      }
      return undefined;
    },
  };
}

/** Compose hook sets: `before*` hooks run in order and the first Response wins; `on*`/`after*` hooks all run. */
export function mergeHooks(...sets: readonly (HttpAppHooks | undefined)[]): HttpAppHooks {
  const hooks = sets.filter((s): s is HttpAppHooks => s !== undefined);
  return {
    async beforeAuth(c, requestId, scope) {
      for (const h of hooks) {
        const stop = await h.beforeAuth?.(c, requestId, scope);
        if (stop) return stop;
      }
      return undefined;
    },
    async refuseAuthFailure(c, info) {
      for (const h of hooks) {
        try {
          const stop = await h.refuseAuthFailure?.(c, info);
          if (stop) return stop;
        } catch {
          // a failing hook never changes the answer
        }
      }
      return undefined;
    },
    onAuthFailure(c, info) {
      for (const h of hooks) {
        try {
          h.onAuthFailure?.(c, info);
        } catch {
          // a failing hook never changes the answer
        }
      }
    },
    async beforeMcp(c, info) {
      for (const h of hooks) {
        const stop = await h.beforeMcp?.(c, info);
        if (stop) return stop;
      }
      return undefined;
    },
    async beforePassthrough(c, info) {
      for (const h of hooks) {
        const stop = await h.beforePassthrough?.(c, info);
        if (stop) return stop;
      }
      return undefined;
    },
    async onRejected(c, info) {
      await Promise.allSettled(hooks.map((h) => h.onRejected?.(c, info)));
    },
    async onToolCall(c, info, event) {
      await Promise.allSettled(hooks.map((h) => h.onToolCall?.(c, info, event)));
    },
    async onPassthroughToolCall(c, info, event) {
      await Promise.allSettled(hooks.map((h) => h.onPassthroughToolCall?.(c, info, event)));
    },
    async onQuotaDenied(c, info, denial) {
      await Promise.allSettled(hooks.map((h) => h.onQuotaDenied?.(c, info, denial)));
    },
    async afterMcp(c, info, outcome) {
      await Promise.allSettled(hooks.map((h) => h.afterMcp?.(c, info, outcome)));
    },
  };
}
