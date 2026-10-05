// SPDX-License-Identifier: Apache-2.0
// AI issues documents (P6-02). Static documents, every value a variable (T4). Fields verified against the P0-09
// introspection (`spikes/nerdgraph/results/raw/introspection.json`) and the `ai_issues_experimental_header` probe.
import { defineDocument, type GraphQLDocument } from './document.ts';

/** `aiIssues` is an experimental API: the documented opt-in header is sent for these documents only (RESEARCH §6). */
const AI_ISSUES_HEADERS = { 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' };

export interface AiIssueData {
  readonly issueId?: string | null;
  readonly title?: (string | null)[] | null;
  readonly description?: (string | null)[] | null;
  readonly state?: string | null;
  readonly priority?: string | null;
  readonly createdAt?: number | null;
  readonly activatedAt?: number | null;
  readonly closedAt?: number | null;
  readonly updatedAt?: number | null;
  readonly acknowledgedAt?: number | null;
  readonly accountIds?: (number | null)[] | null;
  readonly entityGuids?: (string | null)[] | null;
  readonly entityNames?: (string | null)[] | null;
  readonly entityTypes?: (string | null)[] | null;
  readonly policyIds?: (number | null)[] | null;
  readonly policyName?: (string | null)[] | null;
  readonly conditionName?: (string | null)[] | null;
  readonly sources?: (string | null)[] | null;
  readonly mutingState?: string | null;
  readonly isCorrelated?: boolean | null;
  readonly isIdle?: boolean | null;
  readonly totalIncidents?: number | null;
  readonly deepLinkUrl?: (string | null)[] | null;
}

/** The incident interface types some lists as plain strings; both shapes are accepted when reading. */
export interface AiIncidentData {
  readonly incidentId?: string | null;
  readonly title?: string | null;
  readonly description?: (string | null)[] | string | null;
  readonly state?: string | null;
  readonly priority?: string | null;
  readonly createdAt?: number | null;
  readonly closedAt?: number | null;
  readonly updatedAt?: number | null;
  readonly timestamp?: number | null;
  readonly accountIds?: (number | string | null)[] | string | null;
  readonly entityGuids?: (string | null)[] | string | null;
  readonly entityNames?: (string | null)[] | string | null;
  readonly entityTypes?: (string | null)[] | string | null;
}

export interface AiIssuesFilterVariable {
  states?: string[];
  priority?: string[];
  entityGuids?: string[];
  policyIds?: number[];
  isAcknowledged?: boolean;
  contains?: string;
}

export interface AiIncidentsFilterVariable {
  states?: string[];
  priority?: string[];
  entityGuids?: string[];
}

export interface TimeWindowVariable {
  startTime: number;
  endTime: number;
}

export interface AiIssuesData {
  actor: {
    account: {
      aiIssues?: {
        issues?: { nextCursor?: string | null; issues?: (AiIssueData | null)[] | null } | null;
      } | null;
    } | null;
  };
}

export interface AiIssuesVariables extends Record<string, unknown> {
  accountId: number;
  cursor: string | null;
  filter: AiIssuesFilterVariable;
  timeWindow: TimeWindowVariable;
}

export const AI_ISSUES_QUERY: GraphQLDocument<AiIssuesData, AiIssuesVariables> = defineDocument(
  'query RbAiIssues($accountId: Int!, $cursor: String, $filter: AiIssuesFilterIssues, $timeWindow: TimeWindowInput) { ' +
    'actor { account(id: $accountId) { aiIssues { issues(cursor: $cursor, filter: $filter, timeWindow: $timeWindow) { ' +
    'nextCursor issues { issueId title description state priority createdAt activatedAt closedAt updatedAt ' +
    'acknowledgedAt accountIds entityGuids entityNames entityTypes policyIds policyName conditionName sources ' +
    'mutingState isCorrelated isIdle totalIncidents deepLinkUrl } } } } } }',
  { headers: AI_ISSUES_HEADERS },
);

export interface AiIncidentsData {
  actor: {
    account: {
      aiIssues?: {
        incidents?: { nextCursor?: string | null; incidents?: (AiIncidentData | null)[] | null } | null;
      } | null;
    } | null;
  };
}

export interface AiIncidentsVariables extends Record<string, unknown> {
  accountId: number;
  cursor: string | null;
  filter: AiIncidentsFilterVariable;
  timeWindow: TimeWindowVariable;
}

export const AI_INCIDENTS_QUERY: GraphQLDocument<AiIncidentsData, AiIncidentsVariables> = defineDocument(
  'query RbAiIncidents($accountId: Int!, $cursor: String, $filter: AiIssuesFilterIncidents, $timeWindow: TimeWindowInput) { ' +
    'actor { account(id: $accountId) { aiIssues { incidents(cursor: $cursor, filter: $filter, timeWindow: $timeWindow) { ' +
    'nextCursor incidents { incidentId title description state priority createdAt closedAt updatedAt timestamp ' +
    'accountIds entityGuids entityNames entityTypes } } } } } }',
  { headers: AI_ISSUES_HEADERS },
);
