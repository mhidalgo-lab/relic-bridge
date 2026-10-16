// SPDX-License-Identifier: Apache-2.0
import type { QueryCacheBinding } from './cache/query-cache.ts';
import { ErrorCode, RbError } from './errors.ts';
import type { Logger } from './logger.ts';
import type { Secret } from './secret.ts';
import type { TaskBinding } from './tasks.ts';

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
  /** NerdGraph attempts made so far (P7-18). Optional so custom budgets in tests need not implement it. */
  readonly nerdgraphCalls?: number;
  /** Response bytes read from NerdGraph so far (P7-18). */
  readonly nerdgraphBytes?: number;
  /** Called by the NerdGraph client once per attempt. */
  noteNerdGraphCall?(): void;
  /** Called by the NerdGraph client with the size of each successful response body. */
  noteNerdGraphBytes?(n: number): void;
}

/** Bounds concurrent work (e.g. NerdGraph calls) for one credential (ADR-0010). See `createSemaphoreLimiter`. */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A grant's usage quota as one request sees it (P7-12). Built per request by the host from the grant's caps and its
 * shared counters; absent = no quota. It counts what New Relic actually served: the NerdGraph client calls
 * `beforeCall` once per logical call (retries and query-cache hits do not count) and the NRQL engine reports the
 * events New Relic says it inspected.
 */
export interface QuotaGuard {
  /** True when the grant has an inspected-events budget: NRQL then always fetches cost stats (stripped if unasked). */
  readonly tracksInspected: boolean;
  /** Counts one NerdGraph call, or throws `RB_LIMIT_QUOTA` when a hard cap is reached. Never throws for store errors. */
  beforeCall(): Promise<void>;
  /** Adds the events one complete NRQL result inspected. Never throws. */
  recordInspected(events: number): Promise<void>;
  /** The soft-limit warning to show with this request's result (once per request), if a threshold was crossed. */
  takeWarning(): string | undefined;
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
  /**
   * The runtime's NRQL query cache and this connection's scope (P7-02). Absent: caching is off. The cache is owned by
   * the host runtime, not module state, and isolates entries by scope, credential, key, accounts and limits (T16).
   */
  readonly queryCache?: QueryCacheBinding;
  /** The grant's usage quota (P7-12). Absent: no quota (stdio, pass-through, grants without one). */
  readonly quota?: QuotaGuard;
  /**
   * MCP Tasks (P7-13): where this caller's tasks are kept and who owns them. Absent: tasks are not offered (stdio,
   * pass-through). `accepted` is set per `tools/call` when the client declared the extension.
   */
  readonly tasks?: TaskBinding;
  /**
   * Set per `tools/call` when the client declared the elicitation capability (P7-20): write tools may then ask the person
   * to approve the change. Absent: they cannot ask and rely on `confirm: true` alone.
   */
  readonly elicitation?: ElicitationBinding;
  /**
   * Set per `tools/call` for write tools when the owner requires a human approval (P7-25, `RB_WRITE_APPROVAL=required`):
   * without `elicitation` the write is refused instead of relying on the model's `confirm: true`.
   */
  readonly requireWriteApproval?: boolean;
  /**
   * What `whoami.limits.writeApproval` reports (P8-88): `required` when the owner requires a person's approval for every
   * write (`RB_WRITE_APPROVAL=required`), else `off`. Set per `tools/call` by the server on every tool, so the read tool
   * `whoami` can say it; absent (tests, custom hosts) reads as `off`.
   */
  readonly writeApproval?: 'required' | 'off';
  /**
   * Set by the host for a write `tools/call` it did not charge to the write limit because it can only ask (P7-35: no
   * `inputResponses`, form elicitation declared). Such a call never sends a change: `humanGate` refuses to let it go on,
   * whatever else the request holds, so the uncharged round cannot be used to mutate.
   */
  readonly writeQuestionOnly?: boolean;
  /**
   * Where spent write approvals are remembered, scoped by the host to this caller (P7-26): an approval answers one
   * attempt. Absent: only the time bucket bounds a replay (hosts without shared storage).
   */
  readonly writeApprovals?: WriteApprovals;
  /**
   * Where a write is recorded before its mutation is sent (P7-28): `intent` resolves once the audit row is stored and
   * rejects when it could not be, and the write is then refused with nothing sent. Absent: no audit log (stdio).
   */
  readonly writeAudit?: WriteAudit;
}

/** The audit log as a write tool sees it: one awaited row per write, before the mutation (P7-28). */
export interface WriteAudit {
  intent(event: WriteIntent): Promise<void>;
}

/** A write about to be sent: the tool, its parsed arguments and the tool's record of the change (`applied: false`). */
export interface WriteIntent {
  readonly tool: string;
  readonly input: unknown;
  /** The tool's `WriteRecord` (see `write-common.ts`): action, account, target, planned after. */
  readonly record: Readonly<Record<string, unknown>>;
}

/** Single-use marks for approvals. `consume` resolves true for the first use of `key` and false for any later one. */
export interface WriteApprovals {
  consume(key: string): Promise<boolean>;
}

/** The answers a retried `tools/call` carries to the questions an earlier round asked (never trusted beyond that). */
export interface ElicitationBinding {
  /** What the person answered to the question `key`, `missing` when this round carries no answer to it. */
  answer(key: string): 'accept' | 'decline' | 'cancel' | 'missing';
}

/** Simple counting budget. One instance per request. */
export function createBudget(limit: number): Budget {
  let used = 0;
  let calls = 0;
  let bytes = 0;
  return {
    limit,
    get nerdgraphCalls() {
      return calls;
    },
    get nerdgraphBytes() {
      return bytes;
    },
    noteNerdGraphCall: () => {
      calls += 1;
    },
    noteNerdGraphBytes: (n: number) => {
      if (Number.isFinite(n) && n > 0) bytes += n;
    },
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
          localDetails: true,
        });
      }
      used += n;
    },
  };
}

/** A limiter that applies no bound (tests, one-shot scripts). Servers use `LimiterPool` per credential. */
export const unboundedLimiter: Limiter = Object.freeze({ run: <T>(task: () => Promise<T>) => task() });

/** The budget's NerdGraph usage as tool-call event fields (only what the budget counts). */
export function budgetUsage(ctx: ToolContext): { nerdgraphCalls?: number; nerdgraphBytes?: number } {
  const { nerdgraphCalls, nerdgraphBytes } = ctx.budget;
  return {
    ...(nerdgraphCalls === undefined ? {} : { nerdgraphCalls }),
    ...(nerdgraphBytes === undefined ? {} : { nerdgraphBytes }),
  };
}

/** Generate a request id with WebCrypto (works on Node and Workers). */
export function newRequestId(): string {
  return crypto.randomUUID();
}
