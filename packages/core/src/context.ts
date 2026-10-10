// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, RbError } from './errors.ts';
import type { Logger } from './logger.ts';
import type { Secret } from './secret.ts';

/** New Relic data-center regions with a documented NerdGraph endpoint (RESEARCH §6). */
export type Region = 'US' | 'EU' | 'JP';

/** The New Relic credential a request runs with. The key is only readable through `Secret.reveal()`. */
export interface Credential {
  /** Stable id (storage id, or "env" for stdio env mode). Used for cache keys and limiter scoping, never the key. */
  readonly id: string;
  readonly region: Region;
  readonly apiKey: Secret;
}

/** Accounts this request may touch: the intersection computed upstream (ARCHITECTURE §4). */
export interface AccountScope {
  readonly allowed: readonly number[];
  readonly default: number;
}

/** Per-request subrequest budget (ADR-0010). Every fetch / storage call spends from it. */
export interface Budget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  canSpend(n?: number): boolean;
  /** Spend `n` units or throw RB_BUDGET_EXHAUSTED. */
  spend(n?: number, what?: string): void;
}

/** Bounds concurrent work (e.g. NerdGraph calls) for one credential (ADR-0010). See `createSemaphoreLimiter`. */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Query limits for a project, possibly tightened per grant. Enforced in P1-04. */
export interface QueryLimits {
  /** Max rows a query may return (injected / clamped LIMIT). */
  readonly maxLimit: number;
  /** Max time window a query may cover, in days. */
  readonly maxWindowDays: number;
  readonly eventTypes: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  /** Whether `run_nrql` (arbitrary NRQL) is available. */
  readonly rawNrql: boolean;
  /** Response size cap, enforced while reading the body. */
  readonly maxResponseBytes: number;
}

/** What the server knows about the connection, for `whoami`. Filled by the stdio CLI (P1-11) and grant resolution (P2). */
export interface ConnectionInfo {
  /** Project slug, when the connection belongs to a project. */
  readonly project?: string;
  /** Names of the tools this caller may use. */
  readonly allowedTools?: readonly string[];
  /** Granted tools withheld because their expected cost exceeds the request budget (ADR-0010), with the reason. */
  readonly unavailableTools?: readonly { readonly name: string; readonly reason: string }[];
}

export const DEFAULT_LIMITS: QueryLimits = Object.freeze({
  maxLimit: 1000,
  maxWindowDays: 7,
  eventTypes: Object.freeze({}),
  rawNrql: true,
  maxResponseBytes: 512 * 1024,
});

export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/**
 * Everything a tool handler may use. Built **per request** and passed explicitly; nothing request-scoped may live in
 * module state (THREAT_MODEL T21).
 */
export interface ToolContext {
  readonly requestId: string;
  readonly credential: Credential;
  readonly accounts: AccountScope;
  readonly budget: Budget;
  readonly limiter: Limiter;
  readonly limits: QueryLimits;
  /** Optional descriptive info about the connection (project, granted tools). Never credentials. */
  readonly connection?: ConnectionInfo;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** Simple counting budget. One instance per request. */
export function createBudget(limit: number): Budget {
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    canSpend: (n = 1) => used + n <= limit,
    spend(n = 1, what = 'subrequest') {
      if (used + n > limit) {
        throw new RbError(ErrorCode.BudgetExhausted, `Request budget exhausted before ${what}.`, {
          hint: 'Narrow the request (fewer entities, shorter window) or ask for a partial result.',
          details: { limit, used },
        });
      }
      used += n;
    },
  };
}

/** A limiter that applies no bound (tests, one-shot scripts). Servers use `LimiterPool` per credential. */
export const unboundedLimiter: Limiter = Object.freeze({ run: <T>(task: () => Promise<T>) => task() });

/** Generate a request id with WebCrypto (works on Node and Workers). */
export function newRequestId(): string {
  return crypto.randomUUID();
}
