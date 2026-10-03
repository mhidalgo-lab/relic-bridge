// SPDX-License-Identifier: Apache-2.0
export {
  ACCOUNT_NRQL,
  type AccountNrqlVars,
  CROSS_ACCOUNT_NRQL,
  type CrossAccountNrqlVars,
  NRQL_PROGRESS,
  type NrdbContainer,
  type NrqlProgressVars,
} from './documents.ts';
export {
  DEFAULT_MAX_POLLS,
  DEFAULT_NRQL_TIMEOUT_S,
  type GetQueryResultInput,
  getQueryResult,
  MAX_NRQL_TIMEOUT_S,
  MAX_POLLS,
  type NrqlComplete,
  type NrqlDeps,
  type NrqlMetadata,
  type NrqlMode,
  type NrqlOutcome,
  type NrqlPending,
  type NrqlStats,
  type RunNrqlInput,
  resolveAccounts,
  runNrql,
} from './engine.ts';
