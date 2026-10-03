// SPDX-License-Identifier: Apache-2.0
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import {
  type GraphQLFieldError,
  graphQLErrorToRbError,
  type NerdGraphClient,
  nerdGraphFor,
} from '../nerdgraph/client.ts';
import { ACCOUNT_NRQL, CROSS_ACCOUNT_NRQL, NRQL_PROGRESS, type NrdbContainer } from './documents.ts';
import { assertRawNrqlAllowed, enforceQueryLimits } from './limits.ts';
import { isNrqlQuery, type NrqlQuery } from './template.ts';

export type NrqlMode = 'auto' | 'sync' | 'async';

export interface RunNrqlInput {
  /** Built with the `nrql` tag. Arbitrary NRQL strings go through `runRawNrql`. */
  readonly nrql: NrqlQuery;
  /** Accounts to query. Empty or omitted → the default account. More than one → cross-account (sync only). */
  readonly accounts?: readonly number[];
  /** NerdGraph query timeout in seconds (1–120). Default 10. */
  readonly timeoutS?: number;
  /**
   * - `sync`: wait up to `timeoutS`, then fail with RB_NERDGRAPH_TIMEOUT.
   * - `async`: submit, and return a `pending` handle if not done within `timeoutS`.
   * - `auto` (default): like async, then poll up to `maxPolls` times within budget before returning the handle.
   */
  readonly mode?: NrqlMode;
  /** Polls in `auto` mode. Default 3, max 10. */
  readonly maxPolls?: number;
  /** Include cost stats (inspected count, scanned events). Selects `rawResponse`, which doubles the payload. */
  readonly stats?: boolean;
}

export interface NrqlStats {
  readonly inspectedCount?: number;
  readonly matchCount?: number;
  readonly wallClockMs?: number;
  readonly scannedEvents?: number;
}

export interface NrqlMetadata {
  readonly eventTypes: readonly string[];
  readonly facets: readonly string[];
  /** True when rows carry `beginTimeSeconds` (TIMESERIES). */
  readonly timeseries: boolean;
  readonly timeWindow?: {
    readonly begin?: number;
    readonly end?: number;
    readonly since?: string;
    readonly until?: string;
    readonly compareWith?: string;
  };
}

export interface NrqlComplete {
  readonly status: 'complete';
  readonly accounts: readonly number[];
  readonly results: readonly Record<string, unknown>[];
  readonly totalResult?: Record<string, unknown>;
  readonly otherResult?: Record<string, unknown>;
  readonly metadata: NrqlMetadata;
  /** NRDB messages (e.g. "No events found -- do you have the correct event type and time range?"). */
  readonly messages: readonly string[];
  /** Field-level NerdGraph errors on optional fields. The results are still valid. */
  readonly warnings: readonly string[];
  readonly stats?: NrqlStats;
  readonly polls: number;
  /** Adjustments made by query limits (e.g. a lowered LIMIT). Surface them to the agent. */
  readonly notes: readonly string[];
}

export interface NrqlPending {
  readonly status: 'pending';
  /** Pass to `getQueryResult` together with `account`. */
  readonly queryId: string;
  readonly account: number;
  readonly retryAfterS: number;
  /** ISO time after which the result is gone. */
  readonly expiresAt?: string;
  readonly polls: number;
  /** Adjustments made by query limits (e.g. a lowered LIMIT). Surface them to the agent. */
  readonly notes: readonly string[];
}

export type NrqlOutcome = NrqlComplete | NrqlPending;

export interface NrqlDeps {
  client?: NerdGraphClient;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_NRQL_TIMEOUT_S = 10;
/** NerdGraph's maximum NRQL timeout. Also the sync fallback when async isn't available. */
export const MAX_NRQL_TIMEOUT_S = 120;
export const DEFAULT_MAX_POLLS = 3;
export const MAX_POLLS = 10;
/** Bounds on how long we wait between polls, whatever `retryAfter` says. */
const MIN_POLL_WAIT_S = 1;
const MAX_POLL_WAIT_S = 10;
/** Time on top of the NRQL timeout before the HTTP request gives up. */
const HTTP_GRACE_MS = 5_000;
const NRQL_DOCS = 'https://docs.newrelic.com/docs/nrql/nrql-syntax-clauses-functions/';
const ASYNC_UNAVAILABLE_RE = /\basync\b|data plus/i;
const TIMEOUT_RE = /timed?[\s-]?out|timeout/i;

function intInRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RbError(ErrorCode.InputInvalid, `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Accounts to query: defaults to the request's default account; every one must be allowed (defence in depth). */
export function resolveAccounts(ctx: ToolContext, requested: readonly number[] | undefined): number[] {
  const accounts = [...new Set(requested && requested.length > 0 ? requested : [ctx.accounts.default])];
  for (const id of accounts) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new RbError(ErrorCode.InputInvalid, 'Account ids must be positive integers.');
    }
    if (!ctx.accounts.allowed.includes(id)) {
      throw new RbError(ErrorCode.AuthForbidden, `Account ${id} is not available on this connection.`, {
        hint: 'Use list_accounts to see the accounts you can query.',
        details: { account: id },
      });
    }
  }
  return accounts;
}

const strings = (v: readonly unknown[] | null | undefined): string[] =>
  (v ?? []).filter((s): s is string => typeof s === 'string');

function pickNumbers(
  source: Record<string, unknown> | undefined,
  map: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [from, to] of Object.entries(map)) {
    const v = source?.[from];
    if (typeof v === 'number' && Number.isFinite(v)) out[to] = v;
  }
  return out;
}

/** Errors on the result container itself (or above it) mean no result; errors on sub-fields are warnings. */
function containerError(warnings: readonly GraphQLFieldError[], containerPath: readonly string[]) {
  return warnings.find((w) => !w.path || w.path.length <= containerPath.length);
}

function failure(error: GraphQLFieldError | undefined, ctx: ToolContext, timeoutS: number): RbError {
  if (error?.errorClass === 'INVALID_INPUT' || error?.message.startsWith('NRQL Syntax Error')) {
    return new RbError(ErrorCode.InputInvalid, error.message, {
      hint: `Fix the NRQL and try again. Syntax reference: ${NRQL_DOCS}`,
      ...(error.errorCode ? { details: { errorCode: error.errorCode } } : {}),
    });
  }
  if (error && (error.errorClass === 'TIMEOUT' || TIMEOUT_RE.test(error.message)))
    return nrqlTimeout(timeoutS);
  if (error?.errorClass === 'ACCESS_DENIED') {
    return new RbError(ErrorCode.AuthForbidden, 'New Relic denied access to this account.', {
      hint: "The key's user can't read this account, or the account is in another region.",
    });
  }
  return graphQLErrorToRbError(error, ctx.credential.region);
}

function nrqlTimeout(timeoutS: number): RbError {
  return new RbError(ErrorCode.NerdGraphTimeout, `The NRQL query did not finish within ${timeoutS} s.`, {
    hint: 'Narrow it: shorter SINCE window, fewer FACETs, a LIMIT, or a WHERE on an indexed attribute.',
    details: { timeoutS },
  });
}

function complete(
  container: NrdbContainer,
  accounts: readonly number[],
  warnings: readonly GraphQLFieldError[],
  polls: number,
  withStats: boolean,
): NrqlComplete {
  const results = container.results ?? [];
  const md = container.metadata;
  const tw = md?.timeWindow;
  const timeWindow = tw
    ? {
        ...(tw.begin == null ? {} : { begin: tw.begin }),
        ...(tw.end == null ? {} : { end: tw.end }),
        ...(tw.since == null ? {} : { since: tw.since }),
        ...(tw.until == null ? {} : { until: tw.until }),
        ...(tw.compareWith == null ? {} : { compareWith: tw.compareWith }),
      }
    : undefined;
  const raw = withStats ? (container.rawResponse ?? undefined) : undefined;
  const stats = raw
    ? {
        ...pickNumbers(raw.performanceStats, {
          inspectedCount: 'inspectedCount',
          matchCount: 'matchCount',
          wallClockTime: 'wallClockMs',
        }),
        ...pickNumbers(raw.queryUsage, { scannedEvents: 'scannedEvents' }),
      }
    : undefined;
  return {
    status: 'complete',
    accounts,
    results,
    ...(container.totalResult ? { totalResult: container.totalResult } : {}),
    ...(container.otherResult ? { otherResult: container.otherResult } : {}),
    metadata: {
      eventTypes: strings(md?.eventTypes),
      facets: strings(md?.facets),
      timeseries: results.some((r) => r !== null && typeof r === 'object' && 'beginTimeSeconds' in r),
      ...(timeWindow ? { timeWindow } : {}),
    },
    messages: strings(md?.messages),
    warnings: warnings.map((w) => w.message),
    ...(stats ? { stats } : {}),
    polls,
    notes: [],
  };
}

function pending(container: NrdbContainer, account: number, polls: number): NrqlPending | undefined {
  const p = container.queryProgress;
  if (p?.completed !== false) return undefined;
  if (!p.queryId) {
    throw new RbError(ErrorCode.NerdGraphError, 'NerdGraph reported an unfinished query without a query id.');
  }
  return {
    status: 'pending',
    queryId: p.queryId,
    account,
    retryAfterS: Math.max(MIN_POLL_WAIT_S, Math.ceil(p.retryAfter ?? MIN_POLL_WAIT_S)),
    ...(p.resultExpiration ? { expiresAt: new Date(p.resultExpiration).toISOString() } : {}),
    polls,
    notes: [],
  };
}

/**
 * Run NRQL within platform limits (ADR-0010). Budget is spent by the client (one unit per attempt); polling stops when
 * the budget can't cover another poll and returns the handle instead.
 */
/** Run NRQL built with the `nrql` tag. Query limits are enforced first (T5). */
export async function runNrql(
  ctx: ToolContext,
  input: RunNrqlInput,
  deps: NrqlDeps = {},
): Promise<NrqlOutcome> {
  if (!isNrqlQuery(input.nrql)) {
    throw new RbError(
      ErrorCode.Internal,
      'runNrql needs a query built with the nrql tag; use runRawNrql for strings.',
    );
  }
  return run(ctx, input, input.nrql.text, deps);
}

export interface RawNrqlInput extends Omit<RunNrqlInput, 'nrql'> {
  /** Arbitrary NRQL from the agent. Only `run_nrql` should use this. */
  readonly nrql: string;
}

/** Run arbitrary NRQL (`run_nrql`). Fails with RB_TOOL_DISABLED when the connection turns raw NRQL off. */
export async function runRawNrql(
  ctx: ToolContext,
  input: RawNrqlInput,
  deps: NrqlDeps = {},
): Promise<NrqlOutcome> {
  assertRawNrqlAllowed(ctx.limits);
  if (typeof input.nrql !== 'string')
    throw new RbError(ErrorCode.InputInvalid, 'The NRQL query must be a string.');
  return run(ctx, input, input.nrql, deps);
}

async function run(
  ctx: ToolContext,
  input: Omit<RunNrqlInput, 'nrql'>,
  text: string,
  deps: NrqlDeps,
): Promise<NrqlOutcome> {
  if (text.trim() === '') throw new RbError(ErrorCode.InputInvalid, 'The NRQL query is empty.');
  const accounts = resolveAccounts(ctx, input.accounts);
  const checked = enforceQueryLimits(text, ctx.limits, ctx.clock.now());
  if (checked.notes.length > 0) ctx.logger.info('nrql adjusted by limits', { notes: checked.notes });
  const outcome = await execute(ctx, { ...input, nrql: checked.nrql }, accounts, deps);
  return { ...outcome, notes: checked.notes };
}

async function execute(
  ctx: ToolContext,
  input: Omit<RunNrqlInput, 'nrql'> & { readonly nrql: string },
  accounts: number[],
  deps: NrqlDeps,
): Promise<NrqlOutcome> {
  const mode = input.mode ?? 'auto';
  const timeoutS = intInRange(input.timeoutS, DEFAULT_NRQL_TIMEOUT_S, 1, MAX_NRQL_TIMEOUT_S, 'timeoutS');
  const maxPolls =
    mode === 'auto' ? intInRange(input.maxPolls, DEFAULT_MAX_POLLS, 0, MAX_POLLS, 'maxPolls') : 0;
  const stats = input.stats ?? false;
  const client = deps.client ?? nerdGraphFor(ctx);

  if (accounts.length > 1) {
    if (mode === 'async') {
      throw new RbError(ErrorCode.InputInvalid, 'Async mode works with one account at a time.', {
        hint: 'Use sync or auto mode for cross-account queries, or query one account.',
      });
    }
    const { data, warnings } = await client.query(
      CROSS_ACCOUNT_NRQL,
      { accounts, nrql: input.nrql, timeout: timeoutS, stats },
      { timeoutMs: timeoutS * 1000 + HTTP_GRACE_MS },
    );
    const container = data.actor.nrql;
    if (!container) throw failure(containerError(warnings, ['actor', 'nrql']), ctx, timeoutS);
    return complete(container, accounts, warnings, 0, stats);
  }

  const account = accounts[0] as number;
  const submit = async (async: boolean, timeout: number) => {
    const { data, warnings } = await client.query(
      ACCOUNT_NRQL,
      { accountId: account, nrql: input.nrql, timeout, async, stats },
      { timeoutMs: timeout * 1000 + HTTP_GRACE_MS },
    );
    const acct = data.actor.account;
    const container = acct?.nrql ?? null;
    const error = containerError(warnings, acct ? ['actor', 'account', 'nrql'] : ['actor', 'account']);
    return { container, warnings, error };
  };

  let first = await submit(mode !== 'sync', timeoutS);
  if (!first.container && mode !== 'sync' && first.error && ASYNC_UNAVAILABLE_RE.test(first.error.message)) {
    // Async isn't available for this account (docs tie it to Data Plus): fall back to sync with the longest timeout.
    ctx.logger.info('nrql async unavailable, falling back to sync', { account });
    if (!ctx.budget.canSpend()) throw failure(first.error, ctx, timeoutS);
    first = await submit(false, MAX_NRQL_TIMEOUT_S);
    if (!first.container) throw failure(first.error, ctx, MAX_NRQL_TIMEOUT_S);
    return complete(first.container, accounts, first.warnings, 0, stats);
  }
  if (!first.container) throw failure(first.error, ctx, timeoutS);

  let handle = pending(first.container, account, 0);
  if (!handle) return complete(first.container, accounts, first.warnings, 0, stats);

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let polls = 1; polls <= maxPolls && ctx.budget.canSpend(); polls++) {
    await sleep(Math.min(MAX_POLL_WAIT_S, handle.retryAfterS) * 1000);
    const outcome = await pollOnce(ctx, client, account, handle.queryId, stats, polls);
    if (outcome.status === 'complete') return outcome;
    handle = outcome;
  }
  return handle;
}

async function pollOnce(
  ctx: ToolContext,
  client: NerdGraphClient,
  account: number,
  queryId: string,
  stats: boolean,
  polls: number,
): Promise<NrqlOutcome> {
  const { data, warnings } = await client.query(NRQL_PROGRESS, { accountId: account, queryId, stats });
  const acct = data.actor.account;
  const container = acct?.nrqlQueryProgress ?? null;
  if (!container) {
    const error = containerError(
      warnings,
      acct ? ['actor', 'account', 'nrqlQueryProgress'] : ['actor', 'account'],
    );
    throw failure(error, ctx, 0);
  }
  return pending(container, account, polls) ?? complete(container, [account], warnings, polls, stats);
}

export interface GetQueryResultInput {
  readonly queryId: string;
  /** The account the query was started in (NerdGraph requires the same one). */
  readonly account: number;
  readonly stats?: boolean;
}

/** One poll of an async query started by `runNrql`. Returns `pending` again if it is still running. */
export async function getQueryResult(
  ctx: ToolContext,
  input: GetQueryResultInput,
  deps: Pick<NrqlDeps, 'client'> = {},
): Promise<NrqlOutcome> {
  const [account] = resolveAccounts(ctx, [input.account]);
  if (typeof input.queryId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.queryId)) {
    throw new RbError(ErrorCode.InputInvalid, 'queryId is not a valid query handle.');
  }
  return pollOnce(
    ctx,
    deps.client ?? nerdGraphFor(ctx),
    account as number,
    input.queryId,
    input.stats ?? false,
    1,
  );
}
