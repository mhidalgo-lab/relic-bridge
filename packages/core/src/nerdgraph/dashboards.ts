// SPDX-License-Identifier: Apache-2.0
// Dashboard listing and detail (P6-09). Static documents, every value a variable (T4). Field names from the NerdGraph
// schema docs (DashboardEntityOutline, DashboardEntity, DashboardWidget.rawConfiguration); unverified against a live
// account (docs/RESEARCH.md).
import { defineDocument, type GraphQLDocument } from './document.ts';
import type { EntitySearchVariables } from './entities.ts';

export interface DashboardOutline {
  readonly guid?: string | null;
  readonly name?: string | null;
  readonly accountId?: number | null;
  readonly domain?: string | null;
  readonly type?: string | null;
  readonly permalink?: string | null;
  readonly permissions?: string | null;
}

export interface DashboardsData {
  actor: {
    entitySearch: {
      count?: number | null;
      results?: { nextCursor?: string | null; entities?: (DashboardOutline | null)[] | null } | null;
    } | null;
  };
}

export const DASHBOARDS_QUERY: GraphQLDocument<DashboardsData, EntitySearchVariables> = defineDocument(
  'query RbDashboards($query: String, $cursor: String, $options: EntitySearchOptions) { actor { ' +
    'entitySearch(query: $query, options: $options) { count results(cursor: $cursor) { nextCursor ' +
    'entities { guid name accountId domain type permalink ... on DashboardEntityOutline { permissions } } } } } }',
);

export interface DashboardWidgetData {
  readonly id?: string | null;
  readonly title?: string | null;
  readonly visualization?: { readonly id?: string | null } | null;
  /** JSON scalar: `{ nrqlQueries: [{ accountId, query }], text?: string, ... }`. Shape is not guaranteed. */
  readonly rawConfiguration?: unknown;
}

export interface DashboardPageData {
  readonly guid?: string | null;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly widgets?: (DashboardWidgetData | null)[] | null;
}

export interface DashboardDetailData {
  actor: {
    entity: {
      guid?: string | null;
      name?: string | null;
      accountId?: number | null;
      domain?: string | null;
      type?: string | null;
      permalink?: string | null;
      description?: string | null;
      permissions?: string | null;
      pages?: (DashboardPageData | null)[] | null;
    } | null;
  };
}

export const DASHBOARD_QUERY: GraphQLDocument<DashboardDetailData, { guid: string }> = defineDocument(
  'query RbDashboard($guid: EntityGuid!) { actor { entity(guid: $guid) { guid name accountId domain type permalink ' +
    '... on DashboardEntity { description permissions pages { guid name description widgets { id title ' +
    'visualization { id } rawConfiguration } } } } } }',
);
