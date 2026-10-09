// SPDX-License-Identifier: Apache-2.0
// Fuzzy entity-name resolution (P6-14). One resolver for tools that take "an entity": guid, exact name, case-insensitive
// name, normalised name, substring. Ambiguity returns candidates; it never picks one. Lookups are cached per credential
// id + region + effective account set + filters (THREAT_MODEL T16, T21), bounded and with a TTL.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { ENTITY_SEARCH_QUERY } from '../nerdgraph/entities.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { type EntitySearchQuery, entityQuery } from '../nerdgraph/entity-query.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows } from '../output/format.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import {
  accountFilter,
  checkGuid,
  guidAgrees,
  isNonNull,
  kind,
  requireField,
  scopeAccounts,
  toRow,
} from './entity-common.ts';
import { cleanName } from './identity.ts';
import { accountIdSchema, nextCursorOf, type ToolDeps, toolClient } from './shared.ts';

/** How long a lookup is reused (P6-14). */
export const ENTITY_RESOLVE_TTL_MS: number = 5 * 60_000;
const CACHE_MAX = 64;
const PAGE = 200;
/** Catalogue scan: at most this many pages, so at most 600 names are compared per call (bounded CPU). */
const CATALOGUE_PAGES = 3;
/** Candidates shown for an ambiguous or loose match. */
export const MAX_RESOLVE_CANDIDATES = 10;

export type MatchTier = 'guid' | 'exact' | 'case_insensitive' | 'normalised' | 'substring';

export interface ResolvedEntity {
  readonly guid: string;
  readonly name: string;
  readonly accountId: number;
  readonly domain: string | null;
  readonly type: string | null;
}

export interface ResolveResult {
  readonly status: 'resolved' | 'ambiguous' | 'not_found';
  readonly matchedBy: MatchTier | null;
  readonly entity: ResolvedEntity | null;
  readonly candidates: readonly ResolvedEntity[];
  /** Entities in the deciding tier (candidates may be capped). */
  readonly totalCandidates: number;
  /** The lookup hit its size cap, so a better match may exist: narrow with domain, type or account. */
  readonly incomplete: boolean;
  readonly cached: boolean;
  readonly accounts: readonly number[];
}

export interface ResolveOptions {
  readonly query: string;
  readonly domain?: string | undefined;
  readonly type?: string | undefined;
  readonly account?: number | undefined;
}

interface CacheEntry {
  readonly at: number;
  readonly rows: readonly ResolvedEntity[];
  readonly incomplete: boolean;
}

/** Lower case, letters and digits only: `Shipping-Service` and `shipping_service` both become `shippingservice`. */
export function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Candidates of the best non-empty tier. Pure; at most the rows it is given are compared. */
export function rankByName(
  rows: readonly ResolvedEntity[],
  query: string,
): { tier: Exclude<MatchTier, 'guid'>; matches: ResolvedEntity[] } | null {
  const q = query.trim();
  const lower = q.toLowerCase();
  const norm = normaliseName(q);
  const tiers: [Exclude<MatchTier, 'guid'>, (e: ResolvedEntity, n: string) => boolean][] = [
    ['exact', (e) => e.name === q],
    ['case_insensitive', (e) => e.name.toLowerCase() === lower],
    ['normalised', (_e, n) => norm !== '' && n === norm],
    ['substring', (_e, n) => norm !== '' && n.includes(norm)],
  ];
  const normed = rows.map((r) => normaliseName(r.name));
  for (const [tier, test] of tiers) {
    const matches = rows.filter((r, i) => test(r, normed[i] ?? ''));
    if (matches.length > 0) return { tier, matches };
  }
  return null;
}

const byNameThenGuid = (a: ResolvedEntity, b: ResolvedEntity) =>
  a.name.localeCompare(b.name) || a.guid.localeCompare(b.guid);

export interface EntityResolver {
  resolve(ctx: ToolContext, options: ResolveOptions): Promise<ResolveResult>;
}

/**
 * Resolver with its own bounded TTL/LRU cache (per tool-set instance, ≈ per isolate). The cache holds names and guids
 * only, under a key that carries the credential id, region, the effective account set and every filter. Entries are
 * filtered against the request's accounts again when read.
 */
export function createEntityResolver(deps: ToolDeps = {}): EntityResolver {
  const client = toolClient(deps);
  const cache = new Map<string, CacheEntry>();

  const remember = (key: string, entry: CacheEntry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** One lookup (cached). `search` null = whole-catalogue scan. */
  async function lookup(
    ctx: ToolContext,
    accounts: readonly number[],
    filters: readonly EntitySearchQuery[],
    keyParts: readonly unknown[],
    pages: number,
  ): Promise<{ entry: CacheEntry; cached: boolean }> {
    const key = JSON.stringify([ctx.credential.id, ctx.credential.region, accounts, ...keyParts]);
    const now = ctx.clock.now();
    const hit = cache.get(key);
    if (hit && now - hit.at >= 0 && now - hit.at < ENTITY_RESOLVE_TTL_MS) {
      remember(key, hit);
      return { entry: hit, cached: true };
    }
    const query = entityQuery.and([accountFilter(accounts), ...filters]);
    const scope = new Set(accounts);
    const rows: ResolvedEntity[] = [];
    let cursor: string | null = null;
    let incomplete = false;
    for (let page = 0; page < pages; page++) {
      const result = await client(ctx).query(ENTITY_SEARCH_QUERY, {
        query: query.text,
        cursor,
        options: { limit: PAGE },
      });
      const es = requireField(result.data.actor.entitySearch, result, ctx);
      for (const e of (es.results?.entities ?? []).filter(isNonNull)) {
        // Defence in depth (T3): only entities of the effective accounts whose guid agrees are ever kept.
        if (typeof e.accountId !== 'number' || !scope.has(e.accountId)) continue;
        if (typeof e.guid !== 'string' || !guidAgrees(e.guid, e.accountId)) continue;
        const row = toRow(e);
        rows.push({
          guid: row.guid,
          name: row.name,
          accountId: e.accountId,
          domain: row.domain,
          type: row.type,
        });
      }
      const next: unknown = es.results?.nextCursor;
      cursor = nextCursorOf(next);
      if (cursor === null) break;
      if (page === pages - 1) incomplete = true;
    }
    const entry: CacheEntry = { at: now, rows, incomplete };
    remember(key, entry);
    return { entry, cached: false };
  }

  return {
    async resolve(ctx, options) {
      const raw = options.query.trim();
      if (raw === '') throw new RbError(ErrorCode.InputInvalid, 'Give an entity name or guid.');
      const domain = options.domain?.toUpperCase();
      const type = options.type?.toUpperCase();

      // Exact guid: decoded offline and checked against the connection before anything is sent.
      let decodedGuid = false;
      try {
        decodeEntityGuid(raw);
        decodedGuid = true;
      } catch {
        // Not a guid: treat as a name.
      }
      if (decodedGuid) {
        const d = checkGuid(ctx, raw);
        const e: ResolvedEntity = {
          guid: raw,
          name: '',
          accountId: d.accountId,
          domain: d.domain,
          type: d.type,
        };
        return {
          status: 'resolved',
          matchedBy: 'guid',
          entity: e,
          candidates: [e],
          totalCandidates: 1,
          incomplete: false,
          cached: false,
          accounts: [d.accountId],
        };
      }

      const accounts = scopeAccounts(ctx, options.account).sort((a, b) => a - b);
      const filters: EntitySearchQuery[] = [];
      if (domain) filters.push(entityQuery`domain = ${domain}`);
      if (type) filters.push(entityQuery`type = ${type}`);

      // 1) server-side substring search; 2) when it finds nothing, a bounded catalogue scan matched locally.
      const like = await lookup(
        ctx,
        accounts,
        [...filters, entityQuery`name LIKE ${`%${raw}%`}`],
        ['like', domain ?? null, type ?? null, raw.toLowerCase()],
        1,
      );
      let { entry } = like;
      let cached = like.cached;
      let ranked = rankByName(entry.rows, raw);
      if (!ranked) {
        const cat = await lookup(
          ctx,
          accounts,
          filters,
          ['catalogue', domain ?? null, type ?? null],
          CATALOGUE_PAGES,
        );
        entry = {
          at: cat.entry.at,
          rows: cat.entry.rows,
          incomplete: cat.entry.incomplete || like.entry.incomplete,
        };
        cached = like.cached && cat.cached;
        ranked = rankByName(entry.rows, raw);
      }
      // Rows may come from the cache: never return one outside this request's accounts.
      const allowed = new Set(accounts);
      const matches = (ranked?.matches ?? []).filter((m) => allowed.has(m.accountId)).sort(byNameThenGuid);
      if (!ranked || matches.length === 0) {
        return {
          status: 'not_found',
          matchedBy: null,
          entity: null,
          candidates: [],
          totalCandidates: 0,
          incomplete: entry.incomplete,
          cached,
          accounts,
        };
      }
      const [first] = matches;
      const single = matches.length === 1 && first !== undefined;
      return {
        status: single ? 'resolved' : 'ambiguous',
        matchedBy: ranked.tier,
        entity: single ? first : null,
        candidates: matches.slice(0, MAX_RESOLVE_CANDIDATES),
        totalCandidates: matches.length,
        incomplete: entry.incomplete,
        cached,
        accounts,
      };
    },
  };
}

const entityRef = z.object({
  guid: z.string(),
  name: z.string(),
  accountId: z.number().int(),
  domain: z.string().nullable(),
  type: z.string().nullable(),
});

const resolveInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(256)
    .describe('Entity name (loose is fine: "shippingservice" finds "Shipping-Service") or an exact guid.'),
  domain: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
    .optional()
    .describe('Only this domain, e.g. APM, BROWSER, INFRA. See list_entity_types.'),
  type: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
    .optional()
    .describe('Only this type, e.g. APPLICATION, HOST.'),
  account: accountIdSchema
    .optional()
    .describe('Only this account (must be one of list_accounts). Default: every account of this connection.'),
});

const resolveOutput = z.object({
  status: z.enum(['resolved', 'ambiguous', 'not_found']),
  matchedBy: z.enum(['guid', 'exact', 'case_insensitive', 'normalised', 'substring']).nullable(),
  entity: entityRef.nullable(),
  candidates: z.array(entityRef),
  totalCandidates: z.number().int(),
  incomplete: z.boolean(),
  cached: z.boolean(),
  accounts: z.array(z.number().int()),
});

const DESCRIPTION = `Resolve a loose entity name to one entity guid, or list the candidates when the name is ambiguous.

Use it before get_entity, get_related_entities or get_golden_metrics when you only know a name like "shippingservice". Matching order: exact guid, exact name, case-insensitive name, name ignoring case, spaces and punctuation, then substring. The best matching group decides: one entity resolves, several come back as candidates (never a guess), none says not_found. Only accounts of this connection are searched; results are cached for 5 minutes. Names come from New Relic and are inside an untrusted-data block.`;

/** `resolve_entity`. */
export function createEntityResolveTools(deps: ToolDeps = {}): ToolDefinition[] {
  const resolver = deps.resolver ?? createEntityResolver(deps);
  const resolve = defineTool({
    name: 'resolve_entity',
    title: 'Resolve entity name',
    description: DESCRIPTION,
    inputSchema: resolveInput,
    outputSchema: resolveOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 6,
    handler: async (input, ctx) => {
      const r = await resolver.resolve(ctx, input);
      const lines: string[] = [];
      if (r.status === 'resolved' && r.entity) {
        lines.push(
          r.matchedBy === 'guid'
            ? `Guid accepted (account ${r.entity.accountId}). Call get_entity to check it exists.`
            : `Resolved to one entity by ${r.matchedBy?.replace('_', ' ')} match.`,
        );
      } else if (r.status === 'ambiguous') {
        lines.push(
          `${r.totalCandidates} entities match by ${r.matchedBy?.replace('_', ' ')}` +
            `${r.totalCandidates > r.candidates.length ? ` (showing ${r.candidates.length})` : ''}. ` +
            'None was chosen: pick a guid, or narrow with domain, type or account.',
        );
      } else {
        lines.push('No entity matches in the accounts of this connection.');
      }
      if (r.incomplete) {
        lines.push(
          'Note: the search hit its size cap, a better match may exist. Narrow with domain, type or account.',
        );
      }
      if (r.candidates.length > 0 && r.matchedBy !== 'guid') {
        const shaped = shapeRows(
          r.candidates.map((e) => ({ name: e.name, kind: kind(e), account: e.accountId, guid: e.guid })),
          { format: 'table', source: 'New Relic entities', maxRows: MAX_RESOLVE_CANDIDATES },
        );
        lines.push(shaped.text);
      } else if (r.entity) {
        lines.push(envelope(`guid: ${cleanName(r.entity.guid, 512)}`, { source: 'Entity guid' }));
      }
      return {
        text: lines.join('\n'),
        structured: {
          status: r.status,
          matchedBy: r.matchedBy,
          entity: r.entity,
          candidates: [...r.candidates],
          totalCandidates: r.totalCandidates,
          incomplete: r.incomplete,
          cached: r.cached,
          accounts: [...r.accounts],
        },
      };
    },
  });
  return [resolve as ToolDefinition];
}
