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
  type RawNrqlInput,
  type RunNrqlInput,
  resolveAccounts,
  runNrql,
  runRawNrql,
} from './engine.ts';
export { assertRawNrqlAllowed, type CheckedNrql, enforceQueryLimits } from './limits.ts';
export {
  isNrqlQuery,
  type NrqlIdentifier,
  type NrqlQuery,
  type NrqlTag,
  NrqlTemplateError,
  type NrqlValue,
  nrql,
  quoteString,
} from './template.ts';
export { type Token, type TokenKind, tokenize } from './tokenize.ts';
