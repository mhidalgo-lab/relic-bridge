// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { graphQLErrorToRbError, type NerdGraphResult, nerdGraphFor } from '../nerdgraph/client.ts';
import {
  ENTITY_QUERY,
  ENTITY_SEARCH_QUERY,
  ENTITY_TYPES_QUERY,
  type EntityOutlineData,
  RELATED_ENTITIES_QUERY,
  type RelatedEntitiesVariables,
} from '../nerdgraph/entities.ts';
import { type DecodedEntityGuid, decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { type EntitySearchQuery, entityQuery, MAX_ENTITY_QUERY_LIST } from '../nerdgraph/entity-query.ts';
import { resolveAccounts } from '../nrql/engine.ts';
import { flattenTags } from '../output/compact.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows } from '../output/format.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { cleanName } from './identity.ts';
import type { ToolDeps } from './query.ts';

/** Most entities per search call: NerdGraph's page size (P0-09). */
export const MAX_ENTITY_RESULTS = 200;
const DEFAULT_ENTITY_RESULTS = 25;
const MAX_RELATED_RESULTS = 100;
const DEFAULT_RELATED_RESULTS = 50;
const MAX_TAG_FILTERS = 10;
const MAX_TAGS_SHOWN = 100;
const MAX_TAG_CHARS = 300;
/** Domain, type, severity and relationship names are New Relic codes; anything else is dropped (shown as unknown). */
const CODE_RE = /^[A-Za-z0-9_]{1,64}$/;
/** `list_entity_types` cache (THREAT_MODEL T21: keyed by credential, region and account set; never shared across). */
export const ENTITY_TYPES_TTL_MS: number = 10 * 60_000;
const ENTITY_TYPES_CACHE_MAX = 64;

const accountId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const guid = z.string().min(8).max(512).describe('Entity guid, exactly as returned by search_entities.');
// Upper-cased by the handlers (no zod transforms: input schemas must convert to JSON Schema).
const domainField = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const typeField = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const TAG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
/** NerdGraph cursors are opaque base64-like text. */
const CURSOR_RE = /^[A-Za-z0-9+/=_.:-]{1,2048}$/;

const accountInput = accountId
  .optional()
  .describe('Only this account (must be one of list_accounts). Default: every account of this connection.');

const searchInput = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Part of the entity name (case-insensitive substring match). "%" matches anything.'),
  domain: domainField
    .optional()
    .describe('Entity domain, e.g. APM, BROWSER, INFRA, MOBILE, SYNTH, EXT, VIZ. See list_entity_types.'),
  type: typeField
    .optional()
    .describe('Entity type, e.g. APPLICATION, HOST, MONITOR, DASHBOARD. See list_entity_types.'),
  tags: z
    .record(z.string().regex(TAG_KEY_RE), z.string().min(1).max(256))
    .refine((t) => Object.keys(t).length <= MAX_TAG_FILTERS, {
      message: `At most ${MAX_TAG_FILTERS} tag filters.`,
    })
    .optional()
    .describe('Exact tag matches, e.g. {"environment": "production", "team": "checkout"}. All must match.'),
  account: accountInput,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTITY_RESULTS)
    .optional()
    .describe(`Most entities to return (default ${DEFAULT_ENTITY_RESULTS}, max ${MAX_ENTITY_RESULTS}).`),
  cursor: z
    .string()
    .regex(CURSOR_RE)
    .optional()
    .describe('next_cursor from a previous call with the same filters, for the next page.'),
});

const entityRow = z.object({
  guid: z.string(),
  name: z.string(),
  accountId: z.number().int().nullable(),
  domain: z.string().nullable(),
  type: z.string().nullable(),
  alertSeverity: z.string().nullable(),
  reporting: z.boolean().nullable(),
});

const searchOutput = z.object({
  entities: z.array(entityRow),
  /** Matches NerdGraph reported for the filter (before account filtering). */
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  /** The entity-search filter that was sent. */
  query: z.string(),
});

const getEntityInput = z.strictObject({ guid });

const getEntityOutput = entityRow.extend({
  entityType: z.string().nullable(),
  permalink: z.string().nullable(),
  lastReportingChangeAt: z.string().nullable(),
  tags: z.array(z.string()),
  tagsTruncated: z.boolean(),
  goldenMetricTitles: z.array(z.string()).nullable(),
});

const relatedInput = z.strictObject({
  guid,
  direction: z
    .enum(['INBOUND', 'OUTBOUND', 'BOTH'])
    .optional()
    .describe(
      'INBOUND (entities pointing at this one, e.g. callers), OUTBOUND (what it calls/hosts…), BOTH (default).',
    ),
  types: z
    .array(z.strictObject({ domain: domainField, type: typeField }))
    .min(1)
    .max(10)
    .optional()
    .describe('Only related entities of these kinds, e.g. [{"domain": "APM", "type": "APPLICATION"}].'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RELATED_RESULTS)
    .optional()
    .describe(
      `Most relationships to return (default ${DEFAULT_RELATED_RESULTS}, max ${MAX_RELATED_RESULTS}).`,
    ),
});

const relatedOutput = z.object({
  entity: z.object({ guid: z.string(), name: z.string().nullable() }),
  related: z.array(
    entityRow.extend({
      direction: z.enum(['incoming', 'outgoing']),
      relationship: z.string().nullable(),
    }),
  ),
  /** Some relationships pointed to accounts this connection does not allow and were left out. */
  hiddenOutsideScope: z.boolean(),
  hasMore: z.boolean(),
});

const listTypesInput = z.strictObject({ account: accountInput });

const listTypesOutput = z.object({
  types: z.array(
    z.object({
      domain: z.string(),
      type: z.string(),
      entityType: z.string().nullable(),
      count: z.number().int().nullable(),
    }),
  ),
  accounts: z.array(z.number().int()),
  cached: z.boolean(),
});

const decodeInput = z.strictObject({ guid });

const decodeOutput = z.object({
  accountId: z.number().int(),
  domain: z.string(),
  type: z.string(),
  domainId: z.string(),
  allowed: z.boolean(),
});

const SEARCH_DESCRIPTION = `Find New Relic entities (services, hosts, browser and mobile apps, monitors, dashboards…) by name, domain, type and tags.

Use it to get an entity's guid before calling get_entity, get_related_entities or get_golden_metrics. All filters are optional and combined with AND: name is a case-insensitive substring, domain/type are exact (see list_entity_types), tags are exact key/value matches. Results only include accounts of this connection. If next_cursor is returned, call again with the same filters and that cursor for more. Names come from New Relic and are inside an untrusted-data block.`;

const GET_ENTITY_DESCRIPTION = `Get one entity by guid: name, account, domain/type, alert severity (CRITICAL, WARNING, NOT_ALERTING, NOT_CONFIGURED), whether it is reporting, its tags, a New Relic link and the titles of its golden metrics.

Use it after search_entities to inspect an entity. For metric values use get_golden_metrics or run_nrql. Names and tags come from New Relic and are inside an untrusted-data block.`;

const RELATED_DESCRIPTION = `List the entities directly related to one entity (one hop): the services it calls or is called by, the hosts it runs on, its containers, monitors and so on.

Use it to map dependencies during an investigation (e.g. which upstream service is failing). Each relationship shows its direction relative to the entity (incoming/outgoing) and its type (CALLS, HOSTS, CONTAINS…). Relationships into accounts this connection does not allow are left out. Names come from New Relic and are inside an untrusted-data block.`;

const LIST_TYPES_DESCRIPTION = `List the kinds of entities present in this connection's accounts: domain, type and how many entities of each.

Use it to learn which domain/type values to pass to search_entities. Results are cached for 10 minutes. Values come from New Relic and are inside an untrusted-data block.`;

const DECODE_DESCRIPTION = `Decode an entity guid offline: account id, domain, type and domain id, and whether the account is available on this connection.

No request is sent to New Relic. Use it to tell which account an entity belongs to before querying it.`;

export const isNonNull = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

/**
 * A New Relic code (`APM`, `APPLICATION`, `CRITICAL`, `CALLS`…). Restricted to a strict charset, so it is safe to show
 * outside the untrusted-data envelope; anything else becomes null.
 */
function label(value: string | null | undefined): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

/** Accounts a search or catalogue covers: the requested one (checked) or every allowed account. */
function scopeAccounts(ctx: ToolContext, account: number | undefined): number[] {
  const accounts =
    account === undefined ? [...new Set(ctx.accounts.allowed)] : resolveAccounts(ctx, [account]);
  if (accounts.length === 0) {
    throw new RbError(ErrorCode.AuthForbidden, 'This connection has no accounts.');
  }
  if (accounts.length > MAX_ENTITY_QUERY_LIST) {
    throw new RbError(
      ErrorCode.InputInvalid,
      `This connection has more than ${MAX_ENTITY_QUERY_LIST} accounts.`,
      {
        hint: 'Pass "account" to search one account at a time.',
      },
    );
  }
  return accounts;
}

/** `accountId IN ('1', '2')`. Quoted like the P0-09 probe (`accountId = '…'`), escaped by the tag anyway. */
function accountFilter(accounts: readonly number[]): EntitySearchQuery {
  return entityQuery`accountId IN ${accounts.map(String)}`;
}

/** Offline account check for a GUID, before any request (T3). */
export function checkGuid(ctx: ToolContext, value: string): DecodedEntityGuid {
  const decoded = decodeEntityGuid(value);
  if (!ctx.accounts.allowed.includes(decoded.accountId)) throw outOfScope(decoded.accountId);
  return decoded;
}

export function outOfScope(account: number): RbError {
  return new RbError(
    ErrorCode.AuthForbidden,
    `This entity belongs to account ${account}, which is not available on this connection.`,
    { hint: 'Use list_accounts to see the accounts you can query.', details: { account } },
  );
}

function notFound(): RbError {
  return new RbError(ErrorCode.InputInvalid, 'No entity with this guid is visible to this key.', {
    hint: 'Check the guid (use search_entities), and that the key can read its account.',
  });
}

/** A required field came back null: map the field error if there is one. */
export function requireField<T>(
  value: T | null | undefined,
  result: NerdGraphResult<unknown>,
  ctx: ToolContext,
): T {
  if (isNonNull(value)) return value;
  throw result.warnings.length > 0
    ? graphQLErrorToRbError(result.warnings[0], ctx.credential.region)
    : notFound();
}

function toRow(e: EntityOutlineData, fallback?: { guid?: string | null; accountId?: number | null }) {
  return {
    guid: e.guid ?? fallback?.guid ?? '',
    name: cleanName(e.name ?? ''),
    accountId: e.accountId ?? fallback?.accountId ?? null,
    domain: label(e.domain),
    type: label(e.type),
    alertSeverity: label(e.alertSeverity),
    reporting: typeof e.reporting === 'boolean' ? e.reporting : null,
  };
}

const kind = (r: { domain: string | null; type: string | null }) =>
  [r.domain, r.type].filter(isNonNull).join('/') || 'unknown';

interface TypesCacheEntry {
  readonly at: number;
  readonly types: z.infer<typeof listTypesOutput>['types'];
}

/** `search_entities`, `get_entity`, `get_related_entities`, `list_entity_types`, `decode_entity_guid`. */
export function createEntityTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = (ctx: ToolContext) =>
    nerdGraphFor(ctx, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  // Per tool-set instance (≈ per isolate). Holds no credentials; the key includes the credential id and account set.
  const typesCache = new Map<string, TypesCacheEntry>();

  const search = defineTool({
    name: 'search_entities',
    title: 'Search entities',
    description: SEARCH_DESCRIPTION,
    inputSchema: searchInput,
    outputSchema: searchOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 1,
    handler: async (input, ctx) => {
      const accounts = scopeAccounts(ctx, input.account);
      const parts: EntitySearchQuery[] = [accountFilter(accounts)];
      if (input.domain) parts.push(entityQuery`domain = ${input.domain.toUpperCase()}`);
      if (input.type) parts.push(entityQuery`type = ${input.type.toUpperCase()}`);
      if (input.name) parts.push(entityQuery`name LIKE ${`%${input.name}%`}`);
      for (const [key, value] of Object.entries(input.tags ?? {})) {
        parts.push(entityQuery`${entityQuery.tag(key)} = ${value}`);
      }
      const query = entityQuery.and(parts);
      const limit = input.limit ?? DEFAULT_ENTITY_RESULTS;
      const result = await client(ctx).query(ENTITY_SEARCH_QUERY, {
        query: query.text,
        cursor: input.cursor ?? null,
        options: { limit },
      });
      const es = requireField(result.data.actor.entitySearch, result, ctx);
      const scope = new Set(accounts);
      const all = (es.results?.entities ?? []).filter(isNonNull);
      // Defence in depth (T3): the filter already names the accounts; drop anything else NerdGraph returns.
      const entities = all
        .filter(
          (e) => typeof e.accountId === 'number' && scope.has(e.accountId) && typeof e.guid === 'string',
        )
        .slice(0, limit)
        .map((e) => toRow(e));
      const hidden = all.length - entities.length > 0;
      // Echoed in the text outside the envelope: only an opaque cursor-shaped value is passed back.
      const rawCursor = es.results?.nextCursor;
      const nextCursor = typeof rawCursor === 'string' && CURSOR_RE.test(rawCursor) ? rawCursor : null;
      const total = typeof es.count === 'number' ? es.count : null;

      const shaped = shapeRows(
        entities.map((e) => ({
          name: e.name,
          kind: kind(e),
          account: e.accountId,
          alert: e.alertSeverity ?? '',
          reporting: e.reporting === null ? '' : e.reporting ? 'yes' : 'no',
          guid: e.guid,
        })),
        { format: 'table', source: 'New Relic entities', maxRows: MAX_ENTITY_RESULTS },
      );
      const lines = [
        `${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} found` +
          `${total !== null && total > entities.length ? ` (${total} match in total)` : ''} ` +
          `in ${accounts.length === 1 ? `account ${accounts[0]}` : `${accounts.length} accounts`}.`,
      ];
      if (hidden) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor) lines.push('More results: call again with the same filters and the next_cursor below.');
      if (entities.length > 0) lines.push(shaped.text);
      if (nextCursor) lines.push(`next_cursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: { entities, total, nextCursor, query: query.text },
      };
    },
  });

  const getEntity = defineTool({
    name: 'get_entity',
    title: 'Get entity',
    description: GET_ENTITY_DESCRIPTION,
    inputSchema: getEntityInput,
    outputSchema: getEntityOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 1,
    handler: async (input, ctx) => {
      const decoded = checkGuid(ctx, input.guid);
      const result = await client(ctx).query(ENTITY_QUERY, { guid: input.guid });
      const e = requireField(result.data.actor.entity, result, ctx);
      const account = e.accountId ?? decoded.accountId;
      if (!ctx.accounts.allowed.includes(account)) throw outOfScope(account);

      const allTags = flattenTags(
        (e.tags ?? []).filter(isNonNull).map((t) => ({
          key: t.key ?? '',
          values: (t.values ?? []).filter((v): v is string => typeof v === 'string'),
        })),
      );
      const tags = allTags.slice(0, MAX_TAGS_SHOWN).map((t) => cleanName(t, MAX_TAG_CHARS));
      const metrics = e.goldenMetrics?.metrics;
      const goldenMetricTitles = Array.isArray(metrics)
        ? metrics
            .map((m) => m?.title)
            .filter((t): t is string => typeof t === 'string')
            .map((t) => cleanName(t))
        : null;
      const row = toRow(e, { guid: input.guid, accountId: account });
      const changedAt = e.lastReportingChangeAt;
      const structured = {
        ...row,
        entityType: label(e.entityType),
        permalink: typeof e.permalink === 'string' ? cleanName(e.permalink, 500) : null,
        lastReportingChangeAt:
          typeof changedAt === 'number' && Number.isFinite(changedAt) && Math.abs(changedAt) < 8.64e15
            ? new Date(changedAt).toISOString()
            : null,
        tags,
        tagsTruncated: tags.length < allTags.length,
        goldenMetricTitles,
      };

      const lines = [
        `Entity ${kind(row)} in account ${account}: alert severity ${row.alertSeverity ?? 'unknown'}, ` +
          `${row.reporting === null ? 'reporting status unknown' : row.reporting ? 'reporting' : 'not reporting'}` +
          `${structured.lastReportingChangeAt ? ` (since ${structured.lastReportingChangeAt})` : ''}.`,
      ];
      if (goldenMetricTitles === null) lines.push('Note: golden metrics were not available for this entity.');
      if (structured.tagsTruncated)
        lines.push(`Showing the first ${MAX_TAGS_SHOWN} of ${allTags.length} tags.`);
      const body = [
        `name: ${row.name}`,
        `guid: ${row.guid}`,
        `link: ${structured.permalink ?? ''}`,
        `tags: ${tags.join(', ')}`,
        `golden metrics: ${(goldenMetricTitles ?? []).join('; ')}`,
      ];
      lines.push(envelope(body.join('\n'), { source: 'New Relic entity' }));
      return { text: lines.join('\n'), structured };
    },
  });

  const related = defineTool({
    name: 'get_related_entities',
    title: 'Get related entities',
    description: RELATED_DESCRIPTION,
    inputSchema: relatedInput,
    outputSchema: relatedOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 1,
    handler: async (input, ctx) => {
      checkGuid(ctx, input.guid);
      const limit = input.limit ?? DEFAULT_RELATED_RESULTS;
      const filter: RelatedEntitiesVariables['filter'] = {
        direction: input.direction ?? 'BOTH',
        ...(input.types
          ? {
              entityDomainTypes: {
                include: input.types.map((t) => ({
                  domain: t.domain.toUpperCase(),
                  type: t.type.toUpperCase(),
                })),
              },
            }
          : {}),
      };
      const result = await client(ctx).query(RELATED_ENTITIES_QUERY, { guid: input.guid, filter, limit });
      const entity = requireField(result.data.actor.entity, result, ctx);
      if (typeof entity.accountId === 'number' && !ctx.accounts.allowed.includes(entity.accountId)) {
        throw outOfScope(entity.accountId);
      }
      const self = entity.guid ?? input.guid;
      const edges = (entity.relatedEntities?.results ?? []).filter(isNonNull);
      let hiddenOutsideScope = false;
      let cut = false;
      const rows: z.infer<typeof relatedOutput>['related'] = [];
      for (const edge of edges) {
        const outgoing = edge.source?.guid === self;
        const other = outgoing ? edge.target : edge.source;
        if (!other || typeof other.guid !== 'string') continue;
        const account = other.accountId ?? other.entity?.accountId;
        if (typeof account !== 'number' || !ctx.accounts.allowed.includes(account)) {
          hiddenOutsideScope = true;
          continue;
        }
        rows.push({
          ...toRow(other.entity ?? {}, { guid: other.guid, accountId: account }),
          guid: other.guid,
          accountId: account,
          direction: outgoing ? 'outgoing' : 'incoming',
          relationship: label(edge.type),
        });
        if (rows.length >= limit) {
          cut = edges.indexOf(edge) < edges.length - 1;
          break;
        }
      }
      const hasMore = cut || Boolean(entity.relatedEntities?.nextCursor);
      const shaped = shapeRows(
        rows.map((r) => ({
          direction: r.direction,
          relationship: r.relationship ?? '',
          name: r.name,
          kind: kind(r),
          account: r.accountId,
          alert: r.alertSeverity ?? '',
          guid: r.guid,
        })),
        { format: 'table', source: 'New Relic related entities', maxRows: MAX_RELATED_RESULTS },
      );
      const lines = [`${rows.length} related entit${rows.length === 1 ? 'y' : 'ies'} (one hop).`];
      if (hiddenOutsideScope) {
        lines.push('Note: relationships into accounts this connection does not allow were left out.');
      }
      if (hasMore) lines.push('More relationships exist: narrow with direction or types.');
      if (rows.length > 0) lines.push(shaped.text);
      return {
        text: lines.join('\n'),
        structured: {
          entity: { guid: self, name: typeof entity.name === 'string' ? cleanName(entity.name) : null },
          related: rows,
          hiddenOutsideScope,
          hasMore,
        },
      };
    },
  });

  const listTypes = defineTool({
    name: 'list_entity_types',
    title: 'List entity types',
    description: LIST_TYPES_DESCRIPTION,
    inputSchema: listTypesInput,
    outputSchema: listTypesOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 1,
    handler: async (input, ctx) => {
      const accounts = scopeAccounts(ctx, input.account).sort((a, b) => a - b);
      const key = `${ctx.credential.id}|${ctx.credential.region}|${accounts.join(',')}`;
      const now = ctx.clock.now();
      let entry = typesCache.get(key);
      const cached = entry !== undefined && now - entry.at >= 0 && now - entry.at < ENTITY_TYPES_TTL_MS;
      if (!cached || !entry) {
        const result = await client(ctx).query(ENTITY_TYPES_QUERY, { query: accountFilter(accounts).text });
        const es = requireField(result.data.actor.entitySearch, result, ctx);
        const types = (es.types ?? [])
          .filter(isNonNull)
          .map((t) => ({
            domain: label(t.domain) ?? 'unknown',
            type: label(t.type) ?? 'unknown',
            entityType: label(t.entityType),
            count: typeof t.count === 'number' ? t.count : null,
          }))
          .sort((a, b) => a.domain.localeCompare(b.domain) || a.type.localeCompare(b.type));
        entry = { at: now, types };
        typesCache.delete(key);
        typesCache.set(key, entry);
        while (typesCache.size > ENTITY_TYPES_CACHE_MAX) {
          const oldest = typesCache.keys().next().value;
          if (oldest === undefined) break;
          typesCache.delete(oldest);
        }
      }
      const shaped = shapeRows(
        entry.types.map((t) => ({ domain: t.domain, type: t.type, count: t.count ?? '' })),
        { format: 'table', source: 'New Relic entity types', maxRows: 1000 },
      );
      const lines = [
        `${entry.types.length} entity kind${entry.types.length === 1 ? '' : 's'} in ` +
          `${accounts.length === 1 ? `account ${accounts[0]}` : `${accounts.length} accounts`}` +
          `${cached ? ' (cached)' : ''}. Pass domain and type to search_entities.`,
      ];
      if (entry.types.length > 0) lines.push(shaped.text);
      return { text: lines.join('\n'), structured: { types: entry.types, accounts, cached } };
    },
  });

  const decode = defineTool({
    name: 'decode_entity_guid',
    title: 'Decode entity GUID',
    description: DECODE_DESCRIPTION,
    inputSchema: decodeInput,
    outputSchema: decodeOutput,
    kind: 'read',
    openWorld: false,
    cost: 0,
    group: 'entities',
    phase: 1,
    handler: async (input, ctx) => {
      const d = decodeEntityGuid(input.guid);
      const allowed = ctx.accounts.allowed.includes(d.accountId);
      return {
        text:
          `Account ${d.accountId} (${allowed ? 'available on this connection' : 'NOT available on this connection'}), ` +
          `domain ${d.domain}, type ${d.type}, domain id ${d.domainId}.`,
        structured: { ...d, allowed },
      };
    },
  });

  return [
    search as ToolDefinition,
    getEntity as ToolDefinition,
    related as ToolDefinition,
    listTypes as ToolDefinition,
    decode as ToolDefinition,
  ];
}
