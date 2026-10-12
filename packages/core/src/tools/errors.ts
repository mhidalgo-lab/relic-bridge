// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { ERROR_GROUPS_QUERY, type ErrorGroupData } from '../nerdgraph/errors-inbox.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, isNonNull, requireField } from './entities.ts';
import { cleanName } from './identity.ts';
import { bindingOf, listLimit, pageUpstream } from './paging.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  cursorInput,
  label,
  num,
  singleAccount,
  type ToolDeps,
  timeRangeInput,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_WINDOW = 'last 24 hours';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_NAME_CHARS = 300;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUERY_TEXT = 256;
const STATES = ['UNRESOLVED', 'RESOLVED', 'IGNORED'] as const;
const SORTS = {
  occurrences: 'OCCURRENCES',
  last_seen: 'LAST_OCCURRENCE_IN_WINDOW',
  first_seen: 'FIRST_SEEN',
} as const;

const input = z.strictObject({
  states: z
    .array(z.enum(STATES))
    .min(1)
    .max(3)
    .optional()
    .describe('Only error groups in these states (UNRESOLVED = open, RESOLVED, IGNORED).'),
  entity_guid: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Only error groups of this entity (guid). Implies its account.'),
  contains: z
    .string()
    .min(1)
    .max(MAX_QUERY_TEXT)
    .optional()
    .describe('Free-text search over error group names and messages (done by New Relic).'),
  assigned: z
    .boolean()
    .optional()
    .describe('true: only groups assigned to someone; false: only unassigned groups.'),
  sort_by: z
    .enum(['occurrences', 'last_seen', 'first_seen'])
    .optional()
    .describe('Order, most first. Default: New Relic order. occurrences = count in the window.'),
  time_range: timeRangeInput(DEFAULT_WINDOW),
  account: accountInput,
  limit: listLimit('error groups', DEFAULT_LIMIT, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only id, name, state, occurrences, last seen and entity.'),
});

const output = z.object({
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  /** Matches New Relic reported for the filter. */
  total: z.number().int().nullable(),
  errorGroups: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
});

const DESCRIPTION = `List the Errors Inbox error groups of one account (similar errors grouped into one item): name, message, state, occurrences in the window, first and last seen, whether it regressed, and the entity it comes from.

Use it for "which errors hurt us?" (sort_by "occurrences") or "what new errors appeared?" (sort_by "first_seen"). Filter by entity (guid or name). To follow one group to its trace, spans and logs use trace_error; events_query is NRQL for run_nrql. Page with cursor (keeps the first window). It cannot resolve, ignore or assign anything. ${UNTRUSTED}`;

const iso = (ms: unknown): string | null => {
  const n = num(ms);
  return n === null || Math.abs(n) > 8.64e15 ? null : new Date(n).toISOString();
};

/** A group is vouched for only if its source entity decodes to the requested account (T3). */
function vouched(g: ErrorGroupData, account: number, ctx: ToolContext): boolean {
  if (typeof g.entityGuid !== 'string') return false;
  try {
    const { accountId } = decodeEntityGuid(g.entityGuid);
    return accountId === account && ctx.accounts.allowed.includes(accountId);
  } catch {
    return false;
  }
}

function toRow(g: ErrorGroupData) {
  const occ = g.occurrences;
  return {
    id: cleanName(g.id ?? '', 128),
    name: cleanName(g.name ?? '', MAX_NAME_CHARS),
    message: cleanName(g.message ?? '', MAX_MESSAGE_CHARS) || null,
    state: label(g.state),
    issueType: label(g.issueType),
    source: g.source ? cleanName(g.source, 64) : null,
    custom: typeof g.isCustom === 'boolean' ? g.isCustom : null,
    entityGuid: g.entityGuid ?? null,
    occurrences: num(occ?.totalCount),
    expectedOccurrences: num(occ?.expectedCount),
    firstSeenAt: iso(g.firstSeenAt),
    lastSeenAt: iso(g.lastSeenAt),
    firstSeenInWindowAt: iso(occ?.firstSeenAt),
    lastSeenInWindowAt: iso(occ?.lastSeenAt),
    regressedAt: iso(g.regressedAt),
    eventsQuery: g.eventsQuery ? cleanName(g.eventsQuery, 500) : null,
    link: g.url ? cleanName(g.url, 500) : null,
  };
}

const MINIMAL_FIELDS = ['id', 'name', 'state', 'occurrences', 'lastSeenAt', 'entityGuid'] as const;

/** `list_error_groups` (read-only, Errors Inbox). */
export function createErrorTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const listErrorGroups = defineTool({
    name: 'list_error_groups',
    title: 'List error groups (Errors Inbox)',
    description: DESCRIPTION,
    inputSchema: input,
    outputSchema: output,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'incident-response',
    phase: 6,
    handler: async (args, ctx) => {
      let account: number;
      let guid: string | undefined;
      if (args.entity_guid !== undefined) {
        const decoded = checkGuid(ctx, args.entity_guid);
        if (args.account !== undefined && args.account !== decoded.accountId) {
          throw new RbError(
            ErrorCode.InputInvalid,
            `entity_guid belongs to account ${decoded.accountId}, not ${args.account}.`,
            { hint: 'Omit account, or pass the entity account.' },
          );
        }
        account = singleAccount(ctx, decoded.accountId);
        guid = args.entity_guid;
      } else {
        account = singleAccount(ctx, args.account);
      }
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());

      const filter = {
        accountIds: [account],
        ...(args.states ? { states: args.states } : {}),
        ...(args.assigned !== undefined ? { isAssigned: args.assigned } : {}),
      };
      let found = undefined as { totalCount?: number | null } | null | undefined;
      const paged = await pageUpstream({
        binding: await bindingOf('list_error_groups', account, guid, filter, args.contains, args.sort_by),
        cursor: args.cursor,
        limit: args.limit ?? DEFAULT_LIMIT,
        window: range,
        checkWindow: (w) =>
          assertWindowWithinLimit(
            { windowMs: w.untilMs - w.sinceMs, sinceMs: w.sinceMs },
            ctx.limits,
            ctx.clock.now(),
          ),
        fetchPage: async (upstream, w) => {
          const result = await client(ctx).query(ERROR_GROUPS_QUERY, {
            cursor: upstream,
            entityGuids: guid ? [guid] : null,
            filter,
            query: args.contains ?? null,
            sortBy: args.sort_by ? [{ field: SORTS[args.sort_by], direction: 'DESC' }] : null,
            timeWindow: { startTime: w?.sinceMs ?? range.sinceMs, endTime: w?.untilMs ?? range.untilMs },
          });
          const page = requireField(result.data.actor.errorsInbox, result, ctx).errorGroups;
          found = page;
          return { items: (page?.results ?? []).filter(isNonNull), next: page?.nextCursor };
        },
      });
      const all = paged.items;
      const since = new Date(paged.window?.sinceMs ?? range.sinceMs).toISOString();
      const until = new Date(paged.window?.untilMs ?? range.untilMs).toISOString();
      const rows = all.filter((g) => vouched(g, account, ctx)).map(toRow);
      const hiddenOutsideScope = all.length > rows.length;
      const nextCursor = paged.nextCursor;
      const total = num(found?.totalCount);
      const errorGroups = args.minimal_output
        ? pickFields(rows, MINIMAL_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} error ${rows.length === 1 ? 'group' : 'groups'} in account ${account}${total !== null ? ` (${total} match in total)` : ''}, ${since} to ${until} (UTC).`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor)
        lines.push('More results: call again with the same filters and cursor set to the nextCursor below.');
      if (rows.length > 0) {
        lines.push(
          shapeRows(
            rows.map((r) => ({
              id: r.id,
              state: r.state ?? '',
              occurrences: r.occurrences ?? '',
              last_seen: r.lastSeenAt ?? '',
              name: r.name,
              entity: r.entityGuid ?? '',
              ...(args.minimal_output
                ? {}
                : {
                    first_seen: r.firstSeenAt ?? '',
                    regressed: r.regressedAt ?? '',
                    message: r.message ?? '',
                    events_query: r.eventsQuery ?? '',
                  }),
            })),
            {
              format: 'csv',
              source: 'New Relic Errors Inbox',
              maxRows: 1000,
              maxCellChars: MAX_MESSAGE_CHARS,
            },
          ).text,
        );
      }
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: {
          accountId: account,
          since,
          until,
          total,
          errorGroups,
          nextCursor,
          hiddenOutsideScope,
        },
      };
    },
  });

  return [listErrorGroups as ToolDefinition];
}
