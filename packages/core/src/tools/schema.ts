// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { type NrqlComplete, resolveAccounts, runNrql } from '../nrql/engine.ts';
import { enforceQueryLimits } from '../nrql/limits.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { shapeRows } from '../output/format.ts';
import type { TimeRange } from '../time/index.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { cleanName } from './identity.ts';
import { bindingOf, listLimit, pageList } from './paging.ts';
import {
  accountIdSchema as accountId,
  assertWindowWithinLimit,
  cursorInput,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

export const DEFAULT_SCHEMA_SINCE = 'last 24 hours';
/** Schema cache lifetime (per tool-set instance). */
export const SCHEMA_TTL_MS: number = 5 * 60_000;
const SCHEMA_CACHE_MAX = 64;
const MAX_EVENT_TYPES = 1000;
const MAX_ATTRIBUTES = 1000;
/** Most keys kept in the per-connection cache, so a huge keyset cannot grow memory without bound. */
const MAX_CACHED_ATTRIBUTES = 5000;
const MAX_NAME_CHARS = 255;
const SAMPLE_VALUE_CHARS = 300;
/**
 * Event types New Relic keeps outside the account's own data (public API usage, billing, audit). They can't be mixed
 * with account data in one query ("Global event types cannot be mixed with account data").
 */
const GLOBAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'NrUsage',
  'NrConsumption',
  'NrMTDConsumption',
  'NrAuditEvent',
  'NrIntegrationError',
]);
export const isGlobalEventType = (name: string): boolean =>
  name.startsWith('Public_') || GLOBAL_EVENT_TYPES.has(name);
const EVENT_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_.:\-/]{0,254}$/;

const accountField = accountId.optional().describe('Account id (list_accounts). Default: the default.');
const windowField = timeRangeInput(DEFAULT_SCHEMA_SINCE);

const DEFAULT_EVENT_TYPES = 200;
const listInput = z.strictObject({
  account: accountField,
  time_range: windowField,
  limit: listLimit('event types', DEFAULT_EVENT_TYPES, MAX_EVENT_TYPES),
  cursor: cursorInput,
});
const attributesInput = z.strictObject({
  event_type: z
    .string()
    .min(1)
    .max(MAX_NAME_CHARS)
    .describe('Event type exactly as list_event_types returns it (case-sensitive), e.g. "Transaction".'),
  account: accountField,
  time_range: windowField,
  name_contains: z.string().min(1).max(64).optional().describe('Name substring filter.'),
  sample: z
    .boolean()
    .optional()
    .describe('Also return one recent event (default false); its values are untrusted.'),
});

const listOutput = z.object({
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  /** Account event types only (global types are in globalEventTypes). */
  eventTypes: z.array(z.string()),
  /** Listed types that are global/internal: they can't be mixed with account data in one query. */
  globalEventTypes: z.array(z.string()),
  /** The connection has an event-type allow list: its entries are listed without asking New Relic. */
  fromAllowList: z.boolean(),
  cached: z.boolean(),
  /** More event types exist: pass this as cursor (same account and time_range) to read them. */
  nextCursor: z.string().nullable(),
});

const attributesOutput = z.object({
  accountId: z.number().int(),
  eventType: z.string(),
  since: z.string(),
  until: z.string(),
  attributes: z.array(z.object({ name: z.string(), type: z.string() })),
  /** Attributes on the type before `name_contains` and the cap were applied. */
  totalAttributes: z.number().int(),
  truncated: z.boolean(),
  sample: z.record(z.string(), z.unknown()).nullable(),
  cached: z.boolean(),
});

const LIST_DESCRIPTION = `List the event types (NRQL tables such as Transaction, PageView, Log, Metric, SystemSample) that have data in one account.

Call it before writing NRQL for an unfamiliar account, then get_attributes for the type you want. Cached 5 minutes; only the event types this connection permits. ${UNTRUSTED}`;

const ATTRIBUTES_DESCRIPTION = `List the attributes (name and type) recorded on one event type in one account, optionally with one sample event, so NRQL uses real attribute names.

Pass event_type from list_event_types. Not paged: at most ${MAX_ATTRIBUTES} attributes (truncated says if cut). Cached 5 minutes; samples are fresh. ${UNTRUSTED}`;

interface CacheEntry<T> {
  readonly at: number;
  readonly value: T;
}

/** Small TTL map, bounded by insertion order. One per tool-set instance, never module state (T21). */
function createCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string, now: number): T | undefined {
      const e = map.get(key);
      return e !== undefined && now - e.at >= 0 && now - e.at < SCHEMA_TTL_MS ? e.value : undefined;
    },
    set(key: string, value: T, now: number): void {
      map.delete(key);
      map.set(key, { at: now, value });
      while (map.size > SCHEMA_CACHE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}

/** `SINCE n seconds ago [UNTIL m seconds ago]`, built from integers only, and the resolved window. */
function timeClause(sinceText: string, ctx: ToolContext): { clause: NrqlQuery; range: TimeRange } {
  const now = ctx.clock.now();
  const range = parseTimeRange(sinceText, now);
  assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
  const ago = Math.max(1, Math.ceil((now - range.sinceMs) / 1000));
  const untilAgo = Math.max(0, Math.floor((now - range.untilMs) / 1000));
  const clause =
    untilAgo > 0
      ? nrql`SINCE ${ago} seconds ago UNTIL ${untilAgo} seconds ago`
      : nrql`SINCE ${ago} seconds ago`;
  return { clause, range };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Attribute name/type pairs from keyset() rows: `{key, type}` rows, or the older one-row key-list form. */
export function parseKeyset(rows: readonly Record<string, unknown>[]): { name: string; type: string }[] {
  const out = new Map<string, string>();
  const add = (name: unknown, type: string) => {
    const n = str(name);
    if (n !== null && !out.has(n)) out.set(n, type);
  };
  for (const row of rows) {
    if ('key' in row) {
      add(row['key'], str(row['type']) ?? 'unknown');
      continue;
    }
    for (const [field, type] of [
      ['stringKeys', 'string'],
      ['numericKeys', 'numeric'],
      ['booleanKeys', 'boolean'],
    ] as const) {
      const list = row[field];
      if (Array.isArray(list)) for (const k of list) add(k, type);
    }
  }
  return [...out].map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Event types from SHOW EVENT TYPES rows (`eventType` column). */
export function parseEventTypes(rows: readonly Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const n = str(row['eventType']) ?? str(Object.values(row)[0]);
    if (n !== null) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

const complete = (o: { status: string }): NrqlComplete => {
  if (o.status !== 'complete') {
    throw new RbError(ErrorCode.NerdGraphTimeout, 'New Relic is still working on the schema query.', {
      hint: 'Try again shortly, or use a shorter time_range.',
    });
  }
  return o as NrqlComplete;
};

/** `list_event_types` and `get_attributes`. */
export function createSchemaTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);
  const run = async (ctx: ToolContext, account: number, query: NrqlQuery) =>
    complete(
      await runNrql(
        ctx,
        { nrql: query, accounts: [account], mode: 'sync' },
        { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      ),
    );
  // Keys include credential id, region and account (T21); values hold only schema names.
  const typesCache = createCache<string[]>();
  const attrCache = createCache<{ attributes: { name: string; type: string }[]; incomplete: boolean }>();
  const scopeKey = (ctx: ToolContext, account: number) =>
    `${ctx.credential.id}|${ctx.credential.region}|${account}`;

  const listTypes = defineTool({
    name: 'list_event_types',
    title: 'List event types',
    description: LIST_DESCRIPTION,
    inputSchema: listInput,
    outputSchema: listOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'discovery',
    phase: 1,
    handler: async (args, ctx) => {
      const [account] = resolveAccounts(ctx, args.account === undefined ? undefined : [args.account]) as [
        number,
      ];
      const sinceText = args.time_range ?? DEFAULT_SCHEMA_SINCE;
      const { clause, range } = timeClause(sinceText, ctx);
      const allow = ctx.limits.eventTypes.allow;
      const deny = new Set((ctx.limits.eventTypes.deny ?? []).map((e) => e.trim().toLowerCase()));
      let types: string[];
      let cached = false;
      if (allow) {
        // SHOW EVENT TYPES names no type, so an allow list would refuse it: the list itself is the answer.
        types = [...allow]
          .filter((t) => !deny.has(t.trim().toLowerCase()))
          .sort((a, b) => a.localeCompare(b));
      } else {
        const key = `${scopeKey(ctx, account)}|${sinceText}`;
        const hit = typesCache.get(key, ctx.clock.now());
        cached = hit !== undefined;
        const all =
          hit ?? parseEventTypes((await run(ctx, account, nrql`SHOW EVENT TYPES ${clause}`)).results);
        if (!hit) typesCache.set(key, all, ctx.clock.now());
        types = all.filter((t) => !deny.has(t.trim().toLowerCase()));
      }
      types = types.map((t) => cleanName(t, MAX_NAME_CHARS));
      const paged = pageList(
        types,
        await bindingOf('list_event_types', account, sinceText),
        args.cursor,
        args.limit ?? DEFAULT_EVENT_TYPES,
      );
      types = paged.items;
      const lines = [
        `${types.length} event type${types.length === 1 ? '' : 's'} in account ${account} (${sinceText})` +
          `${cached ? ', cached' : ''}${allow ? ', from the connection allow list' : ''}. Call get_attributes with one of them.`,
      ];
      if (types.length > 0) {
        lines.push(
          shapeRows(
            types.map((eventType) => ({
              eventType,
              ...(types.some(isGlobalEventType)
                ? { scope: isGlobalEventType(eventType) ? 'global' : '' }
                : {}),
            })),
            { format: 'table', source: 'New Relic event types', maxRows: MAX_EVENT_TYPES },
          ).text,
        );
      }
      const globals = types.filter(isGlobalEventType);
      if (globals.length > 0) {
        lines.push(
          `Note: ${globals.length} global type${globals.length === 1 ? '' : 's'} (scope "global") can't be mixed with account data: query each alone.`,
        );
      }
      if (paged.nextCursor) lines.push(`nextCursor: ${paged.nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          since: range.since,
          until: range.until,
          eventTypes: types.filter((t) => !isGlobalEventType(t)),
          globalEventTypes: globals,
          fromAllowList: allow !== undefined,
          cached,
          nextCursor: paged.nextCursor,
        },
      };
    },
  });

  const getAttributes = defineTool({
    name: 'get_attributes',
    title: 'Get event attributes',
    description: ATTRIBUTES_DESCRIPTION,
    inputSchema: attributesInput,
    outputSchema: attributesOutput,
    kind: 'read',
    openWorld: true,
    // Attribute list plus the optional sample.
    cost: 2,
    group: 'discovery',
    phase: 1,
    handler: async (args, ctx) => {
      if (!EVENT_TYPE_RE.test(args.event_type)) {
        throw new RbError(ErrorCode.InputInvalid, 'Not a valid event type name.', {
          hint: 'Use a name from list_event_types: letters, digits and _ . : - / only.',
        });
      }
      const type = nrql.identifier(args.event_type);
      const [account] = resolveAccounts(ctx, args.account === undefined ? undefined : [args.account]) as [
        number,
      ];
      const sinceText = args.time_range ?? DEFAULT_SCHEMA_SINCE;
      const { clause, range } = timeClause(sinceText, ctx);
      const query = nrql`SELECT keyset() FROM ${type} ${clause}`;
      // Limits (event-type allow/deny) are checked even on a cache hit: they can differ between requests.
      enforceQueryLimits(query.text, ctx.limits, ctx.clock.now());
      const key = `${scopeKey(ctx, account)}|${args.event_type}|${sinceText}`;
      const hit = attrCache.get(key, ctx.clock.now());
      const cached = hit !== undefined;
      let schema = hit;
      if (!schema) {
        const parsed = parseKeyset((await run(ctx, account, query)).results);
        // Cache the whole keyset (bounded): the name filter must see every key, the cap applies to the output.
        schema = {
          attributes: parsed.slice(0, MAX_CACHED_ATTRIBUTES),
          incomplete: parsed.length > MAX_CACHED_ATTRIBUTES,
        };
        attrCache.set(key, schema, ctx.clock.now());
      }
      const needle = args.name_contains?.toLowerCase();
      const all = schema.attributes.map((a) => ({
        name: cleanName(a.name, MAX_NAME_CHARS),
        type: cleanName(a.type, 32),
      }));
      const matching = needle === undefined ? all : all.filter((a) => a.name.toLowerCase().includes(needle));
      const attributes = matching.slice(0, MAX_ATTRIBUTES);
      const truncated = matching.length > MAX_ATTRIBUTES;

      let sample: Record<string, unknown> | null = null;
      if (args.sample === true && all.length > 0) {
        const row = (await run(ctx, account, nrql`SELECT * FROM ${type} ${clause} LIMIT 1`)).results[0];
        if (row) {
          sample = Object.fromEntries(
            Object.entries(row).map(([k, v]) => [
              cleanName(k, MAX_NAME_CHARS),
              typeof v === 'string' ? cleanName(v, SAMPLE_VALUE_CHARS) : v,
            ]),
          );
        }
      }

      const lines = [
        `${attributes.length} attribute${attributes.length === 1 ? '' : 's'} on ${args.event_type} in account ${account} (${sinceText})` +
          `${needle === undefined ? '' : ` matching "${cleanName(args.name_contains ?? '', 64)}" (of ${all.length})`}` +
          `${cached ? ', cached' : ''}.`,
      ];
      if (attributes.length === 0 && all.length > 0) {
        lines.push(`No attribute name contains "${cleanName(args.name_contains ?? '', 64)}".`);
      } else if (attributes.length === 0) {
        lines.push(
          'No attributes found: the event type has no data in this window, or the name is wrong (it is case-sensitive). ' +
            'Check list_event_types or widen since.',
        );
      } else {
        lines.push(
          shapeRows(attributes, {
            format: 'table',
            source: 'New Relic event attributes',
            maxRows: MAX_ATTRIBUTES,
          }).text,
        );
      }
      if (truncated) {
        lines.push(
          `Only the first ${MAX_ATTRIBUTES} of ${matching.length} attributes are shown.` +
            `${needle === undefined ? ' Pass name_contains to narrow the list.' : ''}`,
        );
      }
      if (schema.incomplete) {
        lines.push(
          `The event type has more than ${MAX_CACHED_ATTRIBUTES} attributes: only the first ${MAX_CACHED_ATTRIBUTES} (alphabetical) are searched, so a match may be missing.`,
        );
      }
      if (sample) {
        lines.push(
          'One recent event:',
          shapeRows([sample], { format: 'json', source: 'New Relic sample event', maxRows: 1 }).text,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          eventType: args.event_type,
          since: range.since,
          until: range.until,
          attributes,
          totalAttributes: all.length,
          truncated,
          sample,
          cached,
        },
      };
    },
  });

  return [listTypes as ToolDefinition, getAttributes as ToolDefinition];
}
