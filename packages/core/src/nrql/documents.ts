// SPDX-License-Identifier: Apache-2.0
import { defineDocument, type GraphQLDocument } from '../nerdgraph/document.ts';

/**
 * `totalResult` / `otherResult` of a FACET query: one object of aggregates, or (FACET + TIMESERIES) an array of time
 * buckets, each with beginTimeSeconds, endTimeSeconds and the aggregate columns (P8-44).
 */
export type NrqlTotals = Record<string, unknown> | Record<string, unknown>[];

/** NRQL result fields as NerdGraph returns them. Optional fields are null when absent or when they failed. */
export interface NrdbContainer {
  readonly results: readonly Record<string, unknown>[] | null;
  readonly metadata: {
    readonly eventTypes: readonly string[] | null;
    readonly facets: readonly string[] | null;
    readonly messages: readonly string[] | null;
    readonly timeWindow: {
      readonly begin: number | null;
      readonly end: number | null;
      readonly since: string | null;
      readonly until: string | null;
      readonly compareWith: string | null;
    } | null;
  } | null;
  readonly totalResult: NrqlTotals | null;
  readonly otherResult: NrqlTotals | null;
  readonly queryProgress: {
    readonly queryId: string | null;
    readonly completed: boolean | null;
    /** Seconds. */
    readonly retryAfter: number | null;
    /** Epoch ms. */
    readonly retryDeadline: number | null;
    /** Epoch ms. */
    readonly resultExpiration: number | null;
  } | null;
  /** Only selected when stats are requested: it repeats the whole result, so it roughly doubles the payload. */
  readonly rawResponse?: {
    readonly performanceStats?: Record<string, unknown>;
    readonly queryUsage?: Record<string, unknown>;
  } | null;
}

/**
 * Only the fields we use (P0-09: selecting everything took ~3.6 s, this takes ~0.3 s). Never `staticChartUrl` or
 * `embeddedChartUrl` (they mint public chart links, T26), nor `eventDefinitions` / `suggestedQueries` (slow, fail often).
 */
const RESULT_FIELDS = `results
  metadata { eventTypes facets messages timeWindow { begin end since until compareWith } }
  totalResult
  otherResult
  queryProgress { queryId completed retryAfter retryDeadline resultExpiration }
  rawResponse @include(if: $stats)`;

export interface AccountNrqlVars extends Record<string, unknown> {
  accountId: number;
  nrql: string;
  timeout: number;
  async: boolean;
  stats: boolean;
}

export const ACCOUNT_NRQL: GraphQLDocument<
  { actor: { account: { nrql: NrdbContainer | null } | null } },
  AccountNrqlVars
> =
  defineDocument(`query RbNrql($accountId: Int!, $nrql: Nrql!, $timeout: Seconds, $async: Boolean, $stats: Boolean!) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: $timeout, async: $async) {
  ${RESULT_FIELDS}
  } } }
}`);

export interface CrossAccountNrqlVars extends Record<string, unknown> {
  accounts: number[];
  nrql: string;
  timeout: number;
  stats: boolean;
}

/** Cross-account NRQL. Sync only: progress can only be polled per account (`Account.nrqlQueryProgress`). */
export const CROSS_ACCOUNT_NRQL: GraphQLDocument<
  { actor: { nrql: NrdbContainer | null } },
  CrossAccountNrqlVars
> =
  defineDocument(`query RbNrqlCrossAccount($accounts: [Int!]!, $nrql: Nrql!, $timeout: Seconds, $stats: Boolean!) {
  actor { nrql(accounts: $accounts, query: $nrql, timeout: $timeout) {
  ${RESULT_FIELDS}
  } }
}`);

export interface NrqlProgressVars extends Record<string, unknown> {
  accountId: number;
  queryId: string;
  stats: boolean;
}

/** Poll an async query. The account must be the one the query ran in (async NRQL docs). */
export const NRQL_PROGRESS: GraphQLDocument<
  { actor: { account: { nrqlQueryProgress: NrdbContainer | null } | null } },
  NrqlProgressVars
> = defineDocument(`query RbNrqlProgress($accountId: Int!, $queryId: ID!, $stats: Boolean!) {
  actor { account(id: $accountId) { nrqlQueryProgress(queryId: $queryId) {
  ${RESULT_FIELDS}
  } } }
}`);
