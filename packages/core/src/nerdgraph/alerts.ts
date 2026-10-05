// SPDX-License-Identifier: Apache-2.0
// Alert documents (P6-01). Static documents, every value a variable (T4). Fields verified against the P0-09
// introspection (`spikes/nerdgraph/results/raw/introspection.json`); see RESEARCH §5 for what is not yet live-verified.
import { defineDocument, type GraphQLDocument } from './document.ts';

export interface AlertPolicyData {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly accountId?: number | null;
  readonly incidentPreference?: string | null;
  readonly entityGuid?: string | null;
}

export interface AlertPoliciesData {
  actor: {
    account: {
      alerts?: {
        policiesSearch?: {
          nextCursor?: string | null;
          totalCount?: number | null;
          policies?: (AlertPolicyData | null)[] | null;
        } | null;
      } | null;
    } | null;
  };
}

export interface AlertPoliciesVariables extends Record<string, unknown> {
  accountId: number;
  cursor: string | null;
  criteria: { nameLike?: string };
}

/** `AlertsPoliciesSearchCriteriaInput { ids, name, nameLike }`; the page size is chosen by NerdGraph. */
export const ALERT_POLICIES_QUERY: GraphQLDocument<AlertPoliciesData, AlertPoliciesVariables> =
  defineDocument(
    'query RbAlertPolicies($accountId: Int!, $cursor: String, $criteria: AlertsPoliciesSearchCriteriaInput) { ' +
      'actor { account(id: $accountId) { alerts { policiesSearch(cursor: $cursor, searchCriteria: $criteria) { ' +
      'nextCursor totalCount policies { id name accountId incidentPreference entityGuid } } } } } }',
  );

export interface AlertTermData {
  readonly priority?: string | null;
  readonly operator?: string | null;
  readonly threshold?: number | null;
  readonly thresholdDuration?: number | null;
  readonly thresholdOccurrences?: string | null;
}

export interface AlertConditionData {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly policyId?: string | null;
  readonly entityGuid?: string | null;
  readonly enabled?: boolean | null;
  readonly type?: string | null;
  readonly description?: string | null;
  readonly runbookUrl?: string | null;
  readonly nrql?: { query?: string | null; dataAccountId?: number | null } | null;
  readonly terms?: (AlertTermData | null)[] | null;
  readonly signal?: {
    aggregationMethod?: string | null;
    aggregationWindow?: number | null;
    aggregationDelay?: number | null;
    aggregationTimer?: number | null;
    slideBy?: number | null;
  } | null;
  readonly violationTimeLimitSeconds?: number | null;
}

export interface AlertConditionsData {
  actor: {
    account: {
      alerts?: {
        nrqlConditionsSearch?: {
          nextCursor?: string | null;
          totalCount?: number | null;
          nrqlConditions?: (AlertConditionData | null)[] | null;
        } | null;
      } | null;
    } | null;
  };
}

export interface AlertConditionsVariables extends Record<string, unknown> {
  accountId: number;
  cursor: string | null;
  criteria: { policyId?: string; nameLike?: string; queryLike?: string };
}

/**
 * `AlertsNrqlConditionsSearchCriteriaInput { name, nameLike, policyId: ID, query, queryLike, termsOperator }`.
 * Only fields of the `AlertsNrqlCondition` interface are selected, so every condition type (STATIC, BASELINE, OUTLIER)
 * answers the same shape.
 */
export const ALERT_CONDITIONS_QUERY: GraphQLDocument<AlertConditionsData, AlertConditionsVariables> =
  defineDocument(
    'query RbAlertConditions($accountId: Int!, $cursor: String, $criteria: AlertsNrqlConditionsSearchCriteriaInput) { ' +
      'actor { account(id: $accountId) { alerts { nrqlConditionsSearch(cursor: $cursor, searchCriteria: $criteria) { ' +
      'nextCursor totalCount nrqlConditions { id name policyId entityGuid enabled type description runbookUrl ' +
      'nrql { query dataAccountId } terms { priority operator threshold thresholdDuration thresholdOccurrences } ' +
      'signal { aggregationMethod aggregationWindow aggregationDelay aggregationTimer slideBy } ' +
      'violationTimeLimitSeconds } } } } } }',
  );
