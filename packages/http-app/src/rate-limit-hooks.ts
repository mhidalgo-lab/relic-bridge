// SPDX-License-Identifier: Apache-2.0
// Rate limiting as `HttpAppHooks` (P2-07). Keeps the app free of limiter policy: it only knows the hook points.
//   beforeAuth    per-IP request limit, and the per-IP auth-failure throttle (peek; refused for valid and invalid
//                 tokens alike, so a 429 never tells an attacker whether a guess was right, T1/T19)
//   onAuthFailure charges the failure to the IP
//   beforeMcp     per-token and per-grant limits (only reachable with a valid token)
import type { Logger } from '@relic-bridge/core';
import type { Context } from 'hono';
import type { AuthFailureInfo, HttpAppHooks, McpRequestInfo } from './app.ts';
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
}

/** Sized for personal use: one MCP request makes a handful of NerdGraph calls against NRQL's 3,000/min/account. */
export const DEFAULT_RATE_LIMITS: RateLimitRules = Object.freeze({
  ip: Object.freeze({ requests: 600, perSeconds: 60 }),
  authFailures: Object.freeze({ requests: 10, perSeconds: 300 }),
  token: Object.freeze({ requests: 120, perSeconds: 60 }),
  grant: Object.freeze({ requests: 300, perSeconds: 60 }),
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
    async beforeAuth(c) {
      const ip = ipKey(c);
      if (rules.authFailures) {
        const rule = rules.authFailures;
        const r = await guard('auth_failures', () => pre.peek(`fail:${ip}`, rule));
        if (r && !r.allowed) {
          mark(c, 'rate_limit_auth_failures');
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

    onAuthFailure(c: Context, _info: AuthFailureInfo) {
      const rule = rules.authFailures;
      if (!rule) return;
      const task = guard('auth_failure_charge', () => pre.take(`fail:${ipKey(c)}`, rule));
      // The 401 is already decided; the charge may finish after the response (Workers keeps it alive).
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        // Node: no execution context; `guard` never rejects.
      }
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
      return undefined;
    },
  };
}

/** Compose hook sets: `before*` hooks run in order and the first Response wins; `on*`/`after*` hooks all run. */
export function mergeHooks(...sets: readonly (HttpAppHooks | undefined)[]): HttpAppHooks {
  const hooks = sets.filter((s): s is HttpAppHooks => s !== undefined);
  return {
    async beforeAuth(c, requestId) {
      for (const h of hooks) {
        const stop = await h.beforeAuth?.(c, requestId);
        if (stop) return stop;
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
    async onRejected(c, info) {
      await Promise.allSettled(hooks.map((h) => h.onRejected?.(c, info)));
    },
    async onToolCall(c, info, event) {
      await Promise.allSettled(hooks.map((h) => h.onToolCall?.(c, info, event)));
    },
    async afterMcp(c, info, outcome) {
      await Promise.allSettled(hooks.map((h) => h.afterMcp?.(c, info, outcome)));
    },
  };
}
