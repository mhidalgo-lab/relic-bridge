// SPDX-License-Identifier: Apache-2.0
// Entity documents (P1-08). Static documents, every value a variable (T4). Shapes from the P0-09 schema excerpt.
import { defineDocument, type GraphQLDocument } from './document.ts';

export type EntityAlertSeverity = 'CRITICAL' | 'WARNING' | 'NOT_ALERTING' | 'NOT_CONFIGURED';

/** `EntityOutline` fields the tools select. Every field is nullable in the schema. */
export interface EntityOutlineData {
  readonly guid?: string | null;
  readonly name?: string | null;
  readonly accountId?: number | null;
  readonly domain?: string | null;
  readonly type?: string | null;
  readonly entityType?: string | null;
  readonly alertSeverity?: EntityAlertSeverity | null;
  readonly reporting?: boolean | null;
}

export interface EntitySearchData {
  actor: {
    entitySearch: {
      count?: number | null;
      results?: { nextCursor?: string | null; entities?: (EntityOutlineData | null)[] | null } | null;
    } | null;
  };
}

export interface EntitySearchVariables extends Record<string, unknown> {
  query: string;
  cursor: string | null;
  options: { limit: number };
}

/** `entitySearch` with a filter string built by `entityQuery`. Max 200 entities per page (P0-09). */
export const ENTITY_SEARCH_QUERY: GraphQLDocument<EntitySearchData, EntitySearchVariables> = defineDocument(
  'query RbEntitySearch($query: String, $cursor: String, $options: EntitySearchOptions) { actor { ' +
    'entitySearch(query: $query, options: $options) { count results(cursor: $cursor) { nextCursor ' +
    'entities { guid name accountId domain type entityType alertSeverity reporting } } } } }',
);

export interface EntityDetailData {
  actor: {
    entity:
      | (EntityOutlineData & {
          readonly permalink?: string | null;
          readonly lastReportingChangeAt?: number | null;
          readonly tags?: ({ key?: string | null; values?: (string | null)[] | null } | null)[] | null;
          readonly goldenMetrics?: { metrics?: ({ title?: string | null } | null)[] | null } | null;
        })
      | null;
  };
}

export const ENTITY_QUERY: GraphQLDocument<EntityDetailData, { guid: string }> = defineDocument(
  'query RbEntity($guid: EntityGuid!) { actor { entity(guid: $guid) { guid name accountId domain type ' +
    'entityType alertSeverity reporting permalink lastReportingChangeAt tags { key values } ' +
    'goldenMetrics { metrics { title } } } } }',
);

export type RelationshipDirection = 'INBOUND' | 'OUTBOUND' | 'BOTH';

export interface RelatedEntitiesVertex {
  readonly guid?: string | null;
  readonly accountId?: number | null;
  readonly entity?: EntityOutlineData | null;
}

export interface RelatedEntitiesData {
  actor: {
    entity: {
      guid?: string | null;
      accountId?: number | null;
      name?: string | null;
      relatedEntities?: {
        nextCursor?: string | null;
        results?:
          | ({
              type?: string | null;
              source?: RelatedEntitiesVertex | null;
              target?: RelatedEntitiesVertex | null;
            } | null)[]
          | null;
      } | null;
    } | null;
  };
}

export interface RelatedEntitiesVariables extends Record<string, unknown> {
  guid: string;
  limit: number;
  filter: {
    direction: RelationshipDirection;
    entityDomainTypes?: { include: { domain: string; type: string }[] };
  };
}

/** One hop of `relatedEntities` (`EntityRelationshipEdgeFilter`: direction, domain/type include list). */
export const RELATED_ENTITIES_QUERY: GraphQLDocument<RelatedEntitiesData, RelatedEntitiesVariables> =
  defineDocument(
    'query RbRelatedEntities($guid: EntityGuid!, $filter: EntityRelationshipEdgeFilter, $limit: Int) { actor { ' +
      'entity(guid: $guid) { guid accountId name relatedEntities(filter: $filter, limit: $limit) { nextCursor ' +
      'results { type source { guid accountId entity { name domain type alertSeverity reporting } } ' +
      'target { guid accountId entity { name domain type alertSeverity reporting } } } } } } }',
  );

export interface EntityTypesData {
  actor: {
    entitySearch: {
      count?: number | null;
      types?: ({
        domain?: string | null;
        type?: string | null;
        entityType?: string | null;
        count?: number | null;
      } | null)[];
    } | null;
  };
}

/** The domain/type facets of an entity search (`EntitySearch.types`). */
export const ENTITY_TYPES_QUERY: GraphQLDocument<EntityTypesData, { query: string }> = defineDocument(
  'query RbEntityTypes($query: String) { actor { entitySearch(query: $query) { count ' +
    'types { domain type entityType count } } } }',
);
