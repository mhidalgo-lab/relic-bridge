// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { tryIssueLink } from '../links.ts';
import type { NerdGraphClient } from '../nerdgraph/client.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import {
  AI_INCIDENTS_QUERY,
  AI_ISSUES_QUERY,
  type AiIncidentData,
  type AiIssueData,
} from '../nerdgraph/issues.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { FATAL_CODES } from './changes.ts';
import { checkGuid, isNonNull, requireField } from './entities.ts';
import { cleanName } from './identity.ts';
import { bindingOf, listLimit, pageUpstream, upstreamCursorOf } from './paging.ts';
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
const MAX_LIST = 10;
/** Most extra requests spent counting the whole window for group_by (the API has no count; it is read page by page). */
const MAX_GROUP_PAGES = 4;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_CONTAINS = 256;
const ISSUE_STATES = ['CREATED', 'ACTIVATED', 'DEACTIVATED', 'CLOSED'] as const;
const INCIDENT_STATES = ['CREATED', 'CLOSED'] as const;
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
/** Policy ids are numeric strings, as list_alert_policies returns them (P6-22); the issue filter takes them as numbers. */
const POLICY_ID_RE = /^[1-9][0-9]{0,14}$/;

const windowInput = timeRangeInput(DEFAULT_WINDOW);
const entityGuidInput = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Only issues/incidents that involve this entity (guid). Implies its account.');
const priorityInput = z.array(z.enum(PRIORITIES)).min(1).max(4).optional().describe('Only these priorities.');

const issuesInput = z.strictObject({
  states: z
    .array(z.enum(ISSUE_STATES))
    .min(1)
    .max(4)
    .optional()
    .describe('Only issues in these states. ACTIVATED = open and notifying, CLOSED = resolved.'),
  priority: priorityInput,
  entity_guid: entityGuidInput,
  policy_id: z
    .string()
    .regex(POLICY_ID_RE)
    .optional()
    .describe('Only issues of this alert policy (id from list_alert_policies).'),
  acknowledged: z
    .boolean()
    .optional()
    .describe('true: only acknowledged issues; false: only unacknowledged.'),
  contains: z
    .string()
    .min(1)
    .max(MAX_CONTAINS)
    .optional()
    .describe('Text to search for in the issue title, entity names and policy name.'),
  group_by: z.enum(['condition', 'entity']).optional().describe('Count per condition or entity (groups).'),
  time_range: windowInput,
  account: accountInput,
  limit: listLimit('rows', DEFAULT_LIMIT, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only id, title, state, priority, created and entities.'),
});

const incidentsInput = z.strictObject({
  states: z
    .array(z.enum(INCIDENT_STATES))
    .min(1)
    .max(2)
    .optional()
    .describe('Only incidents in these states (CREATED = open, CLOSED).'),
  priority: priorityInput,
  entity_guid: entityGuidInput,
  contains: z
    .string()
    .min(1)
    .max(MAX_CONTAINS)
    .optional()
    .describe(
      'Text in the incident title or entity names. Filters each fetched page only: a page can be short or empty: page on with cursor.',
    ),
  time_range: windowInput,
  account: accountInput,
  limit: listLimit('rows', DEFAULT_LIMIT, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only id, title, state, priority, created and entities.'),
});

const pageOutput = {
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
};
const issuesOutput = z.object({
  issues: z.array(z.record(z.string(), z.unknown())),
  groups: z.array(z.record(z.string(), z.unknown())).optional(),
  /** What groups[].count covers: the whole `window`, or only this `page`. Only with group_by. */
  groupsScope: z.enum(['window', 'page']).optional(),
  /** Why `groupsScope` is `page` when group_by was asked, and how many issues the counts cover. */
  groupsNote: z.string().optional(),
  /** Set when `limit` was lowered to the upstream page size. */
  limitNote: z.string().optional(),
  /** Set when New Relic returned several records for an issue id: the newest of each is shown (P8-107). */
  recordsNote: z.string().optional(),
  ...pageOutput,
});
const incidentsOutput = z.object({ incidents: z.array(z.record(z.string(), z.unknown())), ...pageOutput });

const ISSUES_DESCRIPTION = `List recent alert issues of one account (what is or was alerting): title, state, priority, when it opened, was acknowledged and closed, and the entities, policy and condition behind it.

Start here for "what is alerting?" or "what broke?": states ["ACTIVATED"] gives the open ones. An issue groups related incidents; for the individual violations use search_incidents. Filter by entity (guid or name). Page with cursor. Runs 1 request (${1 + MAX_GROUP_PAGES} with group_by, see groupsScope). Cannot acknowledge or close anything. Uses the experimental aiIssues API. ${UNTRUSTED}`;

const INCIDENTS_DESCRIPTION = `Search the alert incidents (individual violations) of one account: title, state (CREATED = open, CLOSED), priority, times and the entities involved.

Use it to drill into what triggered an issue or to find one entity's violations; for the grouped view ("what is alerting?") use list_recent_issues. Filter by entity (guid or name). Page with cursor (keeps the first window). Uses the experimental aiIssues API. ${UNTRUSTED}`;

/** `["a", null]` or a comma-separated string (some incident fields are plain strings) → clean strings. */
function listOf(v: readonly (string | number | null)[] | string | null | undefined): string[] {
  const raw = typeof v === 'string' ? v.replace(/[[\]"]/g, '').split(',') : (v ?? []);
  return raw
    .filter((x): x is string | number => x !== null && x !== undefined)
    .map((x) => String(x).trim())
    .filter((x) => x !== '');
}

/** Incident titles arrive as a JSON-encoded list (`["a","b"]`) or plain text: the individual titles (BUG-18). */
export function incidentTitles(raw: string | null | undefined): string[] {
  const t = (raw ?? '').trim();
  if (t.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed))
        return parsed
          .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
          .map((x) => cleanName(String(x), MAX_TITLE_CHARS))
          .filter((x) => x !== '')
          .slice(0, MAX_LIST);
    } catch {
      // Not JSON: keep the text as it is.
    }
  }
  const one = cleanName(t, MAX_TITLE_CHARS);
  return one === '' ? [] : [one];
}

const iso = (ms: unknown): string | null => {
  const n = num(ms);
  return n === null || Math.abs(n) > 8.64e15 ? null : new Date(n).toISOString();
};

const texts = (v: readonly (string | null)[] | string | null | undefined, max: number): string[] =>
  listOf(v)
    .slice(0, MAX_LIST)
    .map((x) => cleanName(x, max));

interface ScopedRow {
  readonly accountIds: number[];
  readonly guids: string[];
}

/**
 * An issue/incident is shown only when it names the requested account and every account and entity GUID it carries is
 * allowed on this connection (T3): a row that touches a foreign account is dropped whole, never trimmed.
 */
function inScope(ctx: ToolContext, account: number, row: ScopedRow): boolean {
  if (row.accountIds.length === 0 || !row.accountIds.includes(account)) return false;
  if (!row.accountIds.every((id) => ctx.accounts.allowed.includes(id))) return false;
  return row.guids.every((g) => {
    try {
      return ctx.accounts.allowed.includes(decodeEntityGuid(g).accountId);
    } catch {
      return false;
    }
  });
}

const accountIdsOf = (v: readonly (number | string | null)[] | string | null | undefined): number[] =>
  listOf(v)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);

/** The account and window shared by both tools. `entity_guid` implies its account (checked offline, T3). */
function target(
  ctx: ToolContext,
  input: { account?: number | undefined; entity_guid?: string | undefined; time_range?: string | undefined },
) {
  let account: number;
  let guid: string | undefined;
  if (input.entity_guid !== undefined) {
    const decoded = checkGuid(ctx, input.entity_guid);
    if (input.account !== undefined && input.account !== decoded.accountId) {
      throw new RbError(
        ErrorCode.InputInvalid,
        `entity_guid belongs to account ${decoded.accountId}, not ${input.account}.`,
        { hint: 'Omit account, or pass the entity account.' },
      );
    }
    account = singleAccount(ctx, decoded.accountId);
    guid = input.entity_guid;
  } else {
    account = singleAccount(ctx, input.account);
  }
  const range = parseTimeRange(input.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
  assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
  return { account, guid, range };
}

/** One issue as the tools show it (every text field cleaned, T6). */
export type IssueRow = {
  readonly id: string;
  readonly title: string;
  readonly state: string | null;
  readonly priority: string | null;
  readonly createdAt: string | null;
  readonly activatedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly closedAt: string | null;
  readonly updatedAt: string | null;
  readonly entities: string[];
  readonly entityGuids: string[];
  readonly entityTypes: string[];
  readonly policies: string[];
  readonly conditions: string[];
  readonly sources: string[];
  readonly mutingState: string | null;
  readonly correlated: boolean | null;
  readonly idle: boolean | null;
  readonly incidentCount: number | null;
  readonly description: string | null;
  readonly link: string | null;
};

const STATE_RANK: Record<string, number> = { CREATED: 0, ACTIVATED: 1, DEACTIVATED: 2, CLOSED: 3 };

/**
 * The records NerdGraph returned for one issue id, reduced to the freshest: the latest `updatedAt`, then the furthest
 * lifecycle state. aiIssues is built from lifecycle events, so a read may hold an older record of an issue next to the
 * current one; taking the first would report `CREATED` for an issue the list shows as `ACTIVATED` (P8-107). Pure.
 */
export function freshestRecord<T extends Pick<AiIssueData, 'state' | 'updatedAt'>>(
  records: readonly T[],
): T | undefined {
  let best: T | undefined;
  const key = (r: T): [number, number] => [r.updatedAt ?? 0, STATE_RANK[r.state ?? ''] ?? -1];
  for (const r of records) {
    if (best === undefined) {
      best = r;
      continue;
    }
    const [bu, bs] = key(best);
    const [ru, rs] = key(r);
    if (ru > bu || (ru === bu && rs > bs)) best = r;
  }
  return best;
}

/**
 * A note (and a structured warning, counts and states only: no New Relic text) for each issue id that came back with
 * more than one record, so a real occurrence can be spotted and captured (P8-107). Returns the notes, one per id.
 */
export function noteRepeatedRecords(
  ctx: ToolContext,
  groups: readonly (readonly Pick<AiIssueData, 'issueId' | 'state'>[])[],
): string[] {
  const notes: string[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const states = g.map((r) => label(r.state) ?? 'unknown');
    ctx.logger.warn('aiIssues returned several records for one issue', { records: g.length, states });
    const short = cleanName(g[0]?.issueId ?? '', 64).slice(0, 8);
    notes.push(
      `New Relic returned ${g.length} records for issue ${short} (states: ${states.join(', ')}); the newest is shown.`,
    );
  }
  return notes;
}

/** Characters an issue id may have (NerdGraph issue ids are UUIDs). */
export const ISSUE_ID_RE: RegExp = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Look one issue up by id in one account (P6-10). The row must carry the requested id and pass the same scope rule as
 * `list_recent_issues` (T3): an issue that touches an account this connection does not allow is refused, never trimmed.
 * Cost: one request.
 */
export async function lookupIssue(
  client: NerdGraphClient,
  ctx: ToolContext,
  account: number,
  issueId: string,
  window: { sinceMs: number; untilMs: number },
  /** `lookback: false` for tools that have no `lookback` input (the writes): the message does not mention one. */
  options: {
    readonly lookback?: boolean;
    /** Receives a note when New Relic returned several records for the id (P8-107). */
    readonly notes?: string[];
  } = {},
): Promise<IssueRow> {
  const result = await client.query(AI_ISSUES_QUERY, {
    accountId: account,
    cursor: null,
    filter: { ids: [issueId] },
    timeWindow: { startTime: window.sinceMs, endTime: window.untilMs },
  });
  const acct = requireField(result.data.actor.account, result, ctx);
  const match = (acct.aiIssues?.issues?.issues ?? []).filter(isNonNull).filter((i) => i.issueId === issueId);
  const inScopeRecords = match.filter((i) =>
    inScope(ctx, account, { accountIds: accountIdsOf(i.accountIds), guids: listOf(i.entityGuids) }),
  );
  const scoped = freshestRecord(inScopeRecords);
  if (scoped) {
    options.notes?.push(...noteRepeatedRecords(ctx, [inScopeRecords]));
    return toIssue(scoped, ctx, account);
  }
  if (match.length > 0) {
    throw new RbError(
      ErrorCode.AuthForbidden,
      'This issue involves accounts or entities that are not available on this connection.',
      { hint: 'Use list_recent_issues to see the issues you can read.' },
    );
  }
  const hasLookback = options.lookback !== false;
  throw new RbError(
    ErrorCode.InputInvalid,
    hasLookback
      ? `No issue with this id in account ${account} in the lookback window.`
      : `No issue with this id in account ${account} in the last ${ctx.limits.maxWindowDays} days.`,
    {
      hint: hasLookback
        ? 'Check the id with list_recent_issues, pass the issue account, or widen lookback.'
        : 'Check the id with list_recent_issues or pass the issue account.',
    },
  );
}

function toIssue(i: AiIssueData, ctx: ToolContext, account: number): IssueRow {
  return {
    id: cleanName(i.issueId ?? '', 64),
    title: texts(i.title, MAX_TITLE_CHARS).join(' | '),
    state: label(i.state),
    priority: label(i.priority),
    createdAt: iso(i.createdAt),
    activatedAt: iso(i.activatedAt),
    acknowledgedAt: iso(i.acknowledgedAt),
    closedAt: iso(i.closedAt),
    updatedAt: iso(i.updatedAt),
    entities: texts(i.entityNames, 200),
    entityGuids: listOf(i.entityGuids).slice(0, MAX_LIST),
    entityTypes: listOf(i.entityTypes)
      .slice(0, MAX_LIST)
      .map((x) => label(x))
      .filter(isNonNull),
    policies: texts(i.policyName, 200),
    conditions: texts(i.conditionName, 200),
    sources: listOf(i.sources)
      .slice(0, MAX_LIST)
      .map((x) => label(x))
      .filter(isNonNull),
    mutingState: label(i.mutingState),
    correlated: typeof i.isCorrelated === 'boolean' ? i.isCorrelated : null,
    idle: typeof i.isIdle === 'boolean' ? i.isIdle : null,
    incidentCount: num(i.totalIncidents),
    description: texts(i.description, MAX_DESCRIPTION_CHARS).join(' | ') || null,
    // Short permalink, not the long launcher deepLinkUrl that truncation would break (BUG-05).
    link: tryIssueLink(ctx.credential.region, account, i.issueId),
  };
}

function toIncident(i: AiIncidentData) {
  const titles = incidentTitles(i.title);
  return {
    id: cleanName(i.incidentId ?? '', 64),
    title: titles.join(' | '),
    titles,
    state: label(i.state),
    priority: label(i.priority),
    createdAt: iso(i.createdAt),
    closedAt: iso(i.closedAt),
    updatedAt: iso(i.updatedAt),
    entities: texts(i.entityNames, 200),
    entityGuids: listOf(i.entityGuids).slice(0, MAX_LIST),
    entityTypes: listOf(i.entityTypes)
      .slice(0, MAX_LIST)
      .map((x) => label(x))
      .filter(isNonNull),
    description: texts(i.description, MAX_DESCRIPTION_CHARS).join(' | ') || null,
  };
}

const MINIMAL_FIELDS = ['id', 'title', 'state', 'priority', 'createdAt', 'entities'] as const;

/** Issues of one page summarised per condition or entity (BUG-15). Pure; groups in order of first appearance, largest first. */
export type IssueGroup = {
  key: string;
  count: number;
  firstCreatedAt: string | null;
  lastCreatedAt: string | null;
  issueIds: string[];
};

export function groupIssues(rows: readonly IssueRow[], by: 'condition' | 'entity'): IssueGroup[] {
  const groups = new Map<
    string,
    {
      key: string;
      count: number;
      firstCreatedAt: string | null;
      lastCreatedAt: string | null;
      issueIds: string[];
    }
  >();
  for (const r of rows) {
    const key = (by === 'condition' ? r.conditions : r.entities).join('; ') || '(none)';
    const g = groups.get(key) ?? { key, count: 0, firstCreatedAt: null, lastCreatedAt: null, issueIds: [] };
    g.count += 1;
    if (r.createdAt !== null) {
      if (g.firstCreatedAt === null || r.createdAt < g.firstCreatedAt) g.firstCreatedAt = r.createdAt;
      if (g.lastCreatedAt === null || r.createdAt > g.lastCreatedAt) g.lastCreatedAt = r.createdAt;
    }
    if (g.issueIds.length < MAX_LIST) g.issueIds.push(r.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `list_recent_issues`, `search_incidents` (read-only, aiIssues). */
export function createIssueTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  /** Every in-scope issue of the window, read page by page; `rows: null` (with a note) when it does not fit or fails. */
  async function windowRows(
    ctx: ToolContext,
    account: number,
    filter: Record<string, unknown>,
    w: { sinceMs: number; untilMs: number },
    scoped: (i: AiIssueData) => boolean,
    pageRows: number,
  ): Promise<{ rows: IssueRow[]; note: null } | { rows: null; note: string }> {
    const rows: IssueRow[] = [];
    let cursor: string | null = null;
    let reason = 'the window has more issues than the extra requests can read';
    try {
      for (let n = 0; n < MAX_GROUP_PAGES + 1; n++) {
        if (n > 0 && ctx.budget.remaining < 1) throw new RbError(ErrorCode.BudgetExhausted, 'budget');
        const result = await client(ctx).query(AI_ISSUES_QUERY, {
          accountId: account,
          cursor,
          filter,
          timeWindow: { startTime: w.sinceMs, endTime: w.untilMs },
        });
        const found = requireField(result.data.actor.account, result, ctx).aiIssues?.issues;
        for (const i of (found?.issues ?? []).filter(isNonNull))
          if (scoped(i)) rows.push(toIssue(i, ctx, account));
        cursor = upstreamCursorOf(found?.nextCursor);
        if (cursor === null) return { rows, note: null };
      }
    } catch (e) {
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code)) throw e;
      reason =
        e.code === ErrorCode.BudgetExhausted ? 'the request budget ran out' : `a request failed (${e.code})`;
    }
    return {
      rows: null,
      note: `Group counts cover this page only (${pageRows} ${plural(pageRows, 'issue', 'issues')}), not the whole window: ${reason}, after reading ${rows.length} ${plural(rows.length, 'issue', 'issues')}.`,
    };
  }

  const listIssues = defineTool({
    name: 'list_recent_issues',
    title: 'List recent alert issues',
    description: ISSUES_DESCRIPTION,
    inputSchema: issuesInput,
    outputSchema: issuesOutput,
    kind: 'read',
    openWorld: true,
    cost: 1 + MAX_GROUP_PAGES,
    group: 'alerting',
    phase: 6,
    handler: async (input, ctx) => {
      const { account, guid, range } = target(ctx, input);
      const filter: Record<string, unknown> = {};
      if (input.states) filter['states'] = input.states;
      if (input.priority) filter['priority'] = input.priority;
      if (guid) filter['entityGuids'] = [guid];
      if (input.policy_id !== undefined) filter['policyIds'] = [Number(input.policy_id)];
      if (input.acknowledged !== undefined) filter['isAcknowledged'] = input.acknowledged;
      if (input.contains) filter['contains'] = input.contains;
      const paged = await pageUpstream({
        binding: await bindingOf('list_recent_issues', account, filter),
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_LIMIT,
        window: range,
        checkWindow: (w) =>
          assertWindowWithinLimit(
            { windowMs: w.untilMs - w.sinceMs, sinceMs: w.sinceMs },
            ctx.limits,
            ctx.clock.now(),
          ),
        fetchPage: async (upstream, w) => {
          const result = await client(ctx).query(AI_ISSUES_QUERY, {
            accountId: account,
            cursor: upstream,
            filter,
            timeWindow: { startTime: w?.sinceMs ?? range.sinceMs, endTime: w?.untilMs ?? range.untilMs },
          });
          const acct = requireField(result.data.actor.account, result, ctx);
          const found = acct.aiIssues?.issues;
          return { items: (found?.issues ?? []).filter(isNonNull), next: found?.nextCursor };
        },
      });
      // One row per issue even if the API repeats an id with older lifecycle records (P8-107).
      const freshest = new Map<string, AiIssueData[]>();
      for (const i of paged.items)
        freshest.set(i.issueId ?? '', [...(freshest.get(i.issueId ?? '') ?? []), i]);
      const all = [...freshest.values()].flatMap((g) => freshestRecord(g) ?? []);
      const recordsNote = noteRepeatedRecords(ctx, [...freshest.values()]).join(' ') || null;
      const since = new Date(paged.window?.sinceMs ?? range.sinceMs).toISOString();
      const until = new Date(paged.window?.untilMs ?? range.untilMs).toISOString();
      const scoped = (i: AiIssueData) =>
        inScope(ctx, account, {
          accountIds: accountIdsOf(i.accountIds),
          guids: listOf(i.entityGuids),
        });
      const rows = all.filter(scoped).map((i) => toIssue(i, ctx, account));
      const hiddenOutsideScope = all.some((i) => !scoped(i));
      const nextCursor = paged.nextCursor;
      const issues = input.minimal_output
        ? pickFields(rows, MINIMAL_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} alert ${plural(rows.length, 'issue', 'issues')} in account ${account}, ${since} to ${until} (UTC).`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor)
        lines.push('More results: call again with the same filters and cursor set to the nextCursor below.');
      // Groups only with group_by: every group, over the whole window when the window fits in a few extra pages and
      // the budget allows (NEW-07), else over this page, labelled. No implicit page summary (NEW-30).
      const win = paged.window ?? range;
      let groupRows: readonly IssueRow[] = rows;
      let groupsScope: 'window' | 'page' = 'page';
      let groupsNote: string | null = null;
      if (input.group_by) {
        const whole = await windowRows(ctx, account, filter, win, scoped, rows.length);
        if (whole.rows) {
          groupRows = whole.rows;
          groupsScope = 'window';
        } else groupsNote = whole.note;
      }
      const by = input.group_by;
      const found = by ? groupIssues(groupRows, by) : [];
      const groups = found.length > 0 ? found : undefined;
      if (by && groups) {
        lines.push(
          `Issues ${groupsScope === 'window' ? 'in the window' : 'on this page'} per ${by} (${groupRows.length} issues; see groups):`,
          ...groups
            .slice(0, MAX_LIST)
            .map(
              (g) => `- ${g.key}: ${g.count} issues, ${g.firstCreatedAt ?? '?'} to ${g.lastCreatedAt ?? '?'}`,
            ),
        );
      }
      if (groupsNote) lines.push(`Note: ${groupsNote}`);
      // Same wording as run_nrql's "LIMIT n lowered to m (...)" adjustments.
      const limitNote =
        paged.pageSize !== null
          ? `limit ${input.limit ?? DEFAULT_LIMIT} lowered to ${paged.pageSize} (API page size); page on with nextCursor.`
          : null;
      if (limitNote) lines.push(`Note: ${limitNote}`);
      if (recordsNote) lines.push(`Note: ${recordsNote}`);
      if (rows.length > 0) {
        lines.push(
          shapeRows(
            rows.map((r) => ({
              id: r.id,
              state: r.state ?? '',
              priority: r.priority ?? '',
              created: r.createdAt ?? '',
              title: r.title,
              entities: r.entities.join('; '),
              ...(input.minimal_output
                ? {}
                : {
                    policy: r.policies.join('; '),
                    acknowledged: r.acknowledgedAt ? 'yes' : 'no',
                    closed: r.closedAt ?? '',
                    incidents: r.incidentCount ?? '',
                  }),
            })),
            { format: 'csv', source: 'New Relic alert issues', maxRows: 1000, maxCellChars: MAX_TITLE_CHARS },
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
          issues,
          ...(groups ? { groups } : {}),
          ...(by ? { groupsScope } : {}),
          ...(groupsNote ? { groupsNote } : {}),
          ...(limitNote ? { limitNote } : {}),
          ...(recordsNote ? { recordsNote } : {}),
          nextCursor,
          hiddenOutsideScope,
        },
      };
    },
  });

  const searchIncidents = defineTool({
    name: 'search_incidents',
    title: 'Search alert incidents',
    description: INCIDENTS_DESCRIPTION,
    inputSchema: incidentsInput,
    outputSchema: incidentsOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'alerting',
    phase: 6,
    handler: async (input, ctx) => {
      const { account, guid, range } = target(ctx, input);
      const filter: Record<string, unknown> = {};
      if (input.states) filter['states'] = input.states;
      if (input.priority) filter['priority'] = input.priority;
      if (guid) filter['entityGuids'] = [guid];
      const paged = await pageUpstream({
        binding: await bindingOf('search_incidents', account, filter, input.contains),
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_LIMIT,
        window: range,
        checkWindow: (w) =>
          assertWindowWithinLimit(
            { windowMs: w.untilMs - w.sinceMs, sinceMs: w.sinceMs },
            ctx.limits,
            ctx.clock.now(),
          ),
        fetchPage: async (upstream, w) => {
          const result = await client(ctx).query(AI_INCIDENTS_QUERY, {
            accountId: account,
            cursor: upstream,
            filter,
            timeWindow: { startTime: w?.sinceMs ?? range.sinceMs, endTime: w?.untilMs ?? range.untilMs },
          });
          const acct = requireField(result.data.actor.account, result, ctx);
          const found = acct.aiIssues?.incidents;
          return { items: (found?.incidents ?? []).filter(isNonNull), next: found?.nextCursor };
        },
      });
      const all = paged.items;
      const since = new Date(paged.window?.sinceMs ?? range.sinceMs).toISOString();
      const until = new Date(paged.window?.untilMs ?? range.untilMs).toISOString();
      const scoped = (i: AiIncidentData) =>
        inScope(ctx, account, {
          accountIds: accountIdsOf(i.accountIds),
          guids: listOf(i.entityGuids),
        });
      const needle = input.contains?.toLowerCase();
      const rows = all
        .filter(scoped)
        .map(toIncident)
        .filter(
          (r) =>
            needle === undefined || `${r.title}\n${r.entities.join('\n')}`.toLowerCase().includes(needle),
        );
      const hiddenOutsideScope = all.some((i) => !scoped(i));
      const nextCursor = paged.nextCursor;
      const incidents = input.minimal_output
        ? pickFields(rows, MINIMAL_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} alert ${plural(rows.length, 'incident', 'incidents')} in account ${account}, ${since} to ${until} (UTC).`,
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
              priority: r.priority ?? '',
              created: r.createdAt ?? '',
              title: r.title,
              entities: r.entities.join('; '),
              ...(input.minimal_output ? {} : { closed: r.closedAt ?? '' }),
            })),
            {
              format: 'csv',
              source: 'New Relic alert incidents',
              maxRows: 1000,
              maxCellChars: MAX_TITLE_CHARS,
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
          incidents,
          nextCursor,
          hiddenOutsideScope,
        },
      };
    },
  });

  return [listIssues as ToolDefinition, searchIncidents as ToolDefinition];
}
