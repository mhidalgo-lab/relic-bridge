// SPDX-License-Identifier: Apache-2.0
// Change tracking documents (P6-04). Static documents, every value a variable (T4). Types and fields verified against the
// P0-09 introspection (`spikes/nerdgraph/results/raw/introspection.json`); no live sample exists (not probed), so row
// shapes and the search limits are from introspection only.
import { defineDocument, type GraphQLDocument } from './document.ts';
import type { EntityOutlineData } from './entities.ts';

export interface ChangeEventData {
  readonly changeTrackingId?: string | null;
  readonly category?: string | null;
  readonly type?: string | null;
  readonly categoryAndType?: string | null;
  readonly timestamp?: number | null;
  readonly description?: string | null;
  readonly shortDescription?: string | null;
  readonly user?: string | null;
  readonly groupId?: string | null;
  readonly entity?: EntityOutlineData | null;
  /** Deployment events only. */
  readonly version?: string | null;
  readonly commit?: string | null;
  readonly changelog?: string | null;
  readonly deepLink?: string | null;
  /** Feature flag events only. */
  readonly featureFlagId?: string | null;
}

export interface ChangeEventsData {
  actor: {
    changeTracking?: {
      changeTrackingSearch?: { changeEvents?: (ChangeEventData | null)[] | null } | null;
    } | null;
  };
}

export interface ChangeEventsVariables extends Record<string, unknown> {
  filter: {
    accountIds: number[];
    limit: number;
    timeWindow: { startTime: number; endTime: number };
  };
}

/** Every kind of change event of one account (deployments, feature flags, configuration changes, …). */
export const CHANGE_EVENTS_QUERY: GraphQLDocument<ChangeEventsData, ChangeEventsVariables> = defineDocument(
  'query RbChangeEvents($filter: ChangeTrackingChangeTrackingSearchFilter) { actor { changeTracking { ' +
    'changeTrackingSearch(filter: $filter) { changeEvents { changeTrackingId category type categoryAndType ' +
    'timestamp description shortDescription user groupId entity { guid name accountId domain type } ' +
    '... on ChangeTrackingDeploymentEvent { version commit changelog deepLink } ' +
    '... on ChangeTrackingFeatureFlagEvent { featureFlagId } } } } } }',
);

export interface DeploymentData {
  readonly deploymentId?: string | null;
  readonly deploymentType?: string | null;
  readonly version?: string | null;
  readonly commit?: string | null;
  readonly changelog?: string | null;
  readonly deepLink?: string | null;
  readonly description?: string | null;
  readonly user?: string | null;
  readonly groupId?: string | null;
  readonly entityGuid?: string | null;
  readonly timestamp?: number | null;
}

export interface EntityDeploymentsData {
  actor: {
    entity:
      | (EntityOutlineData & {
          readonly deploymentSearch?: { results?: (DeploymentData | null)[] | null } | null;
        })
      | null;
  };
}

export interface EntityDeploymentsVariables extends Record<string, unknown> {
  guid: string;
  filter: { limit: number; timeWindow: { startTime: number; endTime: number } };
}

/** The deployments of one entity (plus the entity itself, so one request tells what it is and what was deployed). */
export const ENTITY_DEPLOYMENTS_QUERY: GraphQLDocument<EntityDeploymentsData, EntityDeploymentsVariables> =
  defineDocument(
    'query RbEntityDeployments($guid: EntityGuid!, $filter: ChangeTrackingSearchFilter) { actor { ' +
      'entity(guid: $guid) { guid name accountId domain type deploymentSearch(filter: $filter) { results { ' +
      'deploymentId deploymentType version commit changelog deepLink description user groupId entityGuid timestamp } } } } }',
  );
