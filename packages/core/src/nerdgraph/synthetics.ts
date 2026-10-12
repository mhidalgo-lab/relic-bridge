// SPDX-License-Identifier: Apache-2.0
// Synthetic monitor listing (P6-08). Static document, every value a variable (T4). Metadata only: the selection holds no
// script, secure credential or header field (they may carry secrets, T8). Field names from the NerdGraph schema docs;
// `status` is read from `monitorSummary { status }` (docs/RESEARCH.md); the outline type has no `status` field.
import { defineDocument, type GraphQLDocument } from './document.ts';
import type { EntitySearchVariables } from './entities.ts';

export interface SyntheticMonitorOutline {
  readonly guid?: string | null;
  readonly name?: string | null;
  readonly accountId?: number | null;
  readonly domain?: string | null;
  readonly type?: string | null;
  readonly alertSeverity?: string | null;
  readonly reporting?: boolean | null;
  readonly monitorId?: string | null;
  readonly monitorType?: string | null;
  readonly monitoredUrl?: string | null;
  readonly period?: number | null;
  /** `status` is not a field of the outline type (live test run 2026-10-12, BUG-02): it lives under `monitorSummary`. */
  readonly monitorSummary?: { readonly status?: string | null } | null;
}

export interface SyntheticMonitorsData {
  actor: {
    entitySearch: {
      count?: number | null;
      results?: { nextCursor?: string | null; entities?: (SyntheticMonitorOutline | null)[] | null } | null;
    } | null;
  };
}

export const SYNTHETIC_MONITORS_QUERY: GraphQLDocument<SyntheticMonitorsData, EntitySearchVariables> =
  defineDocument(
    'query RbSyntheticMonitors($query: String, $cursor: String, $options: EntitySearchOptions) { actor { ' +
      'entitySearch(query: $query, options: $options) { count results(cursor: $cursor) { nextCursor ' +
      'entities { guid name accountId domain type alertSeverity reporting ' +
      '... on SyntheticMonitorEntityOutline { monitorId monitorType monitoredUrl period monitorSummary { status } } } } } } }',
  );
