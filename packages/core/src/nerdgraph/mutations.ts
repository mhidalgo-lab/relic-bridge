// SPDX-License-Identifier: Apache-2.0
// The only NerdGraph mutations relic-bridge sends (P7-09, ADR-0015). Each belongs to one opt-in write tool and is on
// `ALLOWED_MUTATIONS`. Static documents, every value a variable (T4). Shapes: the input types are from the P0-09
// introspection (`ChangeTrackingCreateEventInput`, `AiIssuesIssueUserActionResponse`); the root mutation fields and
// argument names are from New Relic's documentation and NOT verified live (the P0-09 introspection has no mutation
// type and no mutation may be run without the owner): see RESEARCH §6 and docs/pending-decisions/phase-7.md.
import { defineDocument, type GraphQLDocument } from './document.ts';

/** `aiIssues` is an experimental API: the documented opt-in header (same as the read documents). */
const AI_ISSUES_HEADERS = { 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' };

/** `ChangeTrackingCreateEventInput`, restricted to the fields relic-bridge sets (no custom attributes). */
export interface ChangeEventInputVariable {
  categoryAndTypeData: {
    kind: { category: string; type: string };
    categoryFields?: {
      deployment?: { version: string; changelog?: string; commit?: string; deepLink?: string };
      featureFlag?: { featureFlagId: string };
    };
  };
  /** An `entityQuery` filter text matching exactly one entity (`id = '<guid>'`). */
  entitySearch: { query: string };
  description?: string;
  shortDescription?: string;
  user?: string;
  groupId?: string;
  timestamp?: number;
}

export interface CreateChangeEventData {
  readonly changeTrackingCreateEvent?: {
    readonly changeTrackingEvent?: {
      readonly changeTrackingId?: string | null;
      readonly category?: string | null;
      readonly type?: string | null;
      readonly timestamp?: number | null;
      readonly entity?: { readonly guid?: string | null; readonly accountId?: number | null } | null;
    } | null;
    readonly messages?: (string | null)[] | null;
  } | null;
}

export const CREATE_CHANGE_EVENT_MUTATION: GraphQLDocument<
  CreateChangeEventData,
  { event: ChangeEventInputVariable; rules: { validationFlags: string[] } }
> = defineDocument(
  'mutation RbCreateChangeEvent($event: ChangeTrackingCreateEventInput!, $rules: ChangeTrackingDataHandlingRules) { ' +
    'changeTrackingCreateEvent(changeTrackingEvent: $event, dataHandlingRules: $rules) { ' +
    'changeTrackingEvent { changeTrackingId category type timestamp entity { guid accountId } } messages } }',
  { mutation: true },
);

/** `AiIssuesIssueUserActionResponse` (P0-09 introspection). */
export interface IssueActionData {
  readonly result?: {
    readonly accountId?: number | null;
    readonly action?: string | null;
    readonly issueId?: string | null;
  } | null;
  readonly error?: string | null;
}

export const ACK_ISSUE_MUTATION: GraphQLDocument<
  { readonly aiIssuesAckIssue?: IssueActionData | null },
  { accountId: number; issueId: string }
> = defineDocument(
  'mutation RbAckIssue($accountId: Int!, $issueId: ID!) { aiIssuesAckIssue(accountId: $accountId, issueId: $issueId) { ' +
    'result { accountId action issueId } error } }',
  { mutation: true, headers: AI_ISSUES_HEADERS },
);

export const RESOLVE_ISSUE_MUTATION: GraphQLDocument<
  { readonly aiIssuesResolveIssue?: IssueActionData | null },
  { accountId: number; issueId: string }
> = defineDocument(
  'mutation RbResolveIssue($accountId: Int!, $issueId: ID!) { aiIssuesResolveIssue(accountId: $accountId, issueId: $issueId) { ' +
    'result { accountId action issueId } error } }',
  { mutation: true, headers: AI_ISSUES_HEADERS },
);
