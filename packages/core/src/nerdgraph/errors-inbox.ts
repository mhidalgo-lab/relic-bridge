// SPDX-License-Identifier: Apache-2.0
// Errors Inbox documents (P6-03). Static documents, every value a variable (T4). Fields verified against the P0-09
// introspection (`spikes/nerdgraph/results/raw/introspection.json`) and the `errors_inbox` probe (an empty list on the
// probe account). The assignee (an email address) and the per-group `resources` are deliberately not selected.
import { defineDocument, type GraphQLDocument } from './document.ts';
import type { TimeWindowVariable } from './issues.ts';

export interface ErrorGroupData {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly message?: string | null;
  readonly state?: string | null;
  readonly issueType?: string | null;
  readonly source?: string | null;
  readonly isCustom?: boolean | null;
  readonly entityGuid?: string | null;
  readonly firstSeenAt?: number | null;
  readonly lastSeenAt?: number | null;
  readonly regressedAt?: number | null;
  readonly eventsQuery?: string | null;
  readonly url?: string | null;
  readonly occurrences?: {
    readonly totalCount?: number | null;
    readonly expectedCount?: number | null;
    readonly firstSeenAt?: number | null;
    readonly lastSeenAt?: number | null;
  } | null;
}

export interface ErrorGroupsData {
  actor: {
    errorsInbox?: {
      errorGroups?: {
        nextCursor?: string | null;
        totalCount?: number | null;
        results?: (ErrorGroupData | null)[] | null;
      } | null;
    } | null;
  };
}

export interface ErrorGroupsFilterVariable {
  accountIds: number[];
  states?: string[];
  isAssigned?: boolean;
}

export interface ErrorGroupsSortVariable {
  field: string;
  direction: 'DESC';
}

export interface ErrorGroupsVariables extends Record<string, unknown> {
  cursor: string | null;
  entityGuids: string[] | null;
  filter: ErrorGroupsFilterVariable;
  query: string | null;
  sortBy: ErrorGroupsSortVariable[] | null;
  timeWindow: TimeWindowVariable;
}

export const ERROR_GROUPS_QUERY: GraphQLDocument<ErrorGroupsData, ErrorGroupsVariables> = defineDocument(
  'query RbErrorGroups($cursor: String, $entityGuids: [EntityGuid!], $filter: ErrorsInboxErrorGroupSearchFilterInput, ' +
    '$query: String, $sortBy: [ErrorsInboxErrorGroupSortOrderInput!], $timeWindow: TimeWindowInput) { ' +
    'actor { errorsInbox { errorGroups(cursor: $cursor, entityGuids: $entityGuids, filter: $filter, query: $query, ' +
    'sortBy: $sortBy, timeWindow: $timeWindow) { nextCursor totalCount results { id name message state issueType source ' +
    'isCustom entityGuid firstSeenAt lastSeenAt regressedAt eventsQuery url ' +
    'occurrences { totalCount expectedCount firstSeenAt lastSeenAt } } } } } }',
);
