// SPDX-License-Identifier: Apache-2.0

export {
  ALERT_CONDITIONS_QUERY,
  ALERT_POLICIES_QUERY,
  type AlertConditionData,
  type AlertPolicyData,
  type AlertTermData,
} from './alerts.ts';
export {
  assertUserKey,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type GraphQLFieldError,
  graphQLErrorToRbError,
  NerdGraphClient,
  type NerdGraphClientOptions,
  type NerdGraphResult,
  nerdGraphFor,
  type QueryOptions,
  wrongRegionError,
} from './client.ts';
export {
  type DefineDocumentOptions,
  type DocumentData,
  DocumentError,
  type DocumentVariables,
  defineDocument,
  type GraphQLDocument,
} from './document.ts';
export { endpointFor, NERDGRAPH_ENDPOINTS, REGIONS } from './endpoints.ts';
export {
  ENTITY_QUERY,
  ENTITY_SEARCH_QUERY,
  ENTITY_TYPES_QUERY,
  type EntityAlertSeverity,
  type EntityOutlineData,
  RELATED_ENTITIES_QUERY,
  type RelationshipDirection,
} from './entities.ts';
export { type DecodedEntityGuid, decodeEntityGuid } from './entity-guid.ts';
export {
  type EntityQueryTag,
  type EntityQueryValue,
  type EntitySearchQuery,
  entityQuery,
  isEntitySearchQuery,
  MAX_ENTITY_QUERY_LIST,
  MAX_ENTITY_QUERY_VALUE_CHARS,
  quoteEntityString,
} from './entity-query.ts';
export {
  ACCOUNT_SCOPE,
  ACCOUNTS_QUERY,
  IDENTITY_QUERY,
  type Identity,
  listReachableAccounts,
  validateKey,
} from './identity.ts';
export {
  createSemaphoreLimiter,
  DEFAULT_CONCURRENCY,
  LimiterPool,
  MAX_CONCURRENCY,
} from './limiter.ts';
