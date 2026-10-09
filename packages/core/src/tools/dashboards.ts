// SPDX-License-Identifier: Apache-2.0
// list_dashboards and get_dashboard: dashboards by entity search and one dashboard's pages and widgets, including each
// widget's NRQL so agents can reuse queries. Widgets are never executed here: their NRQL is third-party raw NRQL, so it is
// returned as data and any run goes through run_nrql (rawNrql switch, account scope, limits). Names, descriptions, NRQL and
// markdown are scrubbed and shown inside the untrusted-data envelope (THREAT_MODEL T6); widgets that query accounts outside
// the connection are withheld (T3). Field names are from documentation and unverified (docs/RESEARCH.md).
import { z } from 'zod';
import {
  DASHBOARD_QUERY,
  DASHBOARDS_QUERY,
  type DashboardOutline,
  type DashboardWidgetData,
} from '../nerdgraph/dashboards.ts';
import { decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { entityQuery } from '../nerdgraph/entity-query.ts';
import { shapeRows } from '../output/format.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, guidAgrees, isNonNull, outOfScope, requireField } from './entities.ts';
import { cleanName } from './identity.ts';
import {
  accountInput,
  cursorInput,
  label,
  nextCursorOf,
  num,
  singleAccount,
  type ToolDeps,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_WIDGETS_PER_PAGE = 50;
const MAX_QUERIES_PER_WIDGET = 5;
const MAX_NRQL_CHARS = 1000;
const MAX_MARKDOWN_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 500;

// ---------------------------------------------------------------------------------------------------------------------
// Pure readers
// ---------------------------------------------------------------------------------------------------------------------

export interface WidgetQuery {
  readonly accountId: number | null;
  readonly nrql: string;
}

export interface ReadWidget {
  readonly id: string | null;
  readonly title: string;
  readonly visualization: string | null;
  readonly queries: WidgetQuery[];
  readonly markdown: string | null;
  /** True when a query named an account outside this connection: queries and markdown are withheld. */
  readonly withheld: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Pull the NRQL queries and markdown out of a widget's `rawConfiguration` (a JSON scalar of unguaranteed shape). Pure. */
export function readWidget(
  w: DashboardWidgetData,
  allowed: ReadonlySet<number>,
  includeContent: boolean,
): ReadWidget {
  let raw: unknown = w.rawConfiguration;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const cfg = isRecord(raw) ? raw : {};
  const rawQueries = Array.isArray(cfg['nrqlQueries']) ? cfg['nrqlQueries'] : [];
  const parsed: { accountId: number | null; nrql: string }[] = [];
  for (const q of rawQueries.slice(0, MAX_QUERIES_PER_WIDGET)) {
    if (!isRecord(q) || typeof q['query'] !== 'string') continue;
    parsed.push({ accountId: num(q['accountId']), nrql: q['query'] });
  }
  // An unknown account counts as foreign: nothing proves the connection may see what the query reads.
  const withheld = parsed.some((q) => q.accountId === null || !allowed.has(q.accountId));
  const markdown = typeof cfg['text'] === 'string' ? cfg['text'] : null;
  const show = includeContent && !withheld;
  return {
    id: typeof w.id === 'string' ? cleanName(w.id, 80) : null,
    title: cleanName(w.title ?? ''),
    visualization: label(w.visualization?.id),
    queries: show
      ? parsed.map((q) => ({ accountId: q.accountId, nrql: cleanName(q.nrql, MAX_NRQL_CHARS) }))
      : [],
    markdown: show && markdown !== null ? cleanName(markdown, MAX_MARKDOWN_CHARS) : null,
    withheld,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------------

const listInput = z.strictObject({
  account: accountInput,
  name: z.string().min(1).max(200).optional().describe('Only dashboards whose name contains this text.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Dashboards per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only guid and name per dashboard.'),
});

const listOutput = z.object({
  account: z.number().int(),
  dashboards: z.array(
    z.object({
      guid: z.string(),
      name: z.string(),
      permissions: z.string().nullable().optional(),
      permalink: z.string().nullable().optional(),
    }),
  ),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  notes: z.array(z.string()),
});

const getInput = z.strictObject({
  guid: z.string().min(1).max(200).describe('Entity guid of the dashboard (from list_dashboards).'),
  minimal_output: z
    .boolean()
    .optional()
    .describe('Page and widget titles and visualization only: no NRQL or markdown.'),
});

const widgetSchema = z.object({
  id: z.string().nullable(),
  title: z.string(),
  visualization: z.string().nullable(),
  queries: z.array(z.object({ accountId: z.number().nullable(), nrql: z.string() })),
  markdown: z.string().nullable(),
  withheld: z.boolean(),
});

const getOutput = z.object({
  guid: z.string(),
  name: z.string(),
  account: z.number().int(),
  description: z.string().nullable(),
  permissions: z.string().nullable(),
  permalink: z.string().nullable(),
  pages: z.array(
    z.object({
      guid: z.string().nullable(),
      name: z.string(),
      description: z.string().nullable(),
      widgets: z.array(widgetSchema),
    }),
  ),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});

const LIST_DESCRIPTION = `List the dashboards of one account (name, guid, permissions, link), optionally filtered by name substring.

Use it to find a dashboard for get_dashboard. Page with next_cursor. ${UNTRUSTED}`;

const GET_DESCRIPTION = `Get one dashboard (guid or name): its pages and widgets, with each widget's title, visualization and NRQL queries (and markdown text), so you can reuse the queries.

Widgets are NOT executed: pass a widget's NRQL to run_nrql for numbers. Widgets on accounts this connection cannot read are listed with their NRQL withheld. Shows up to ${MAX_PAGES} pages and ${MAX_WIDGETS_PER_PAGE} widgets per page. To find a dashboard use list_dashboards. ${UNTRUSTED}`;

/** `list_dashboards` and `get_dashboard` (read-only). */
export function createDashboardTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const list = defineTool({
    name: 'list_dashboards',
    title: 'List dashboards',
    description: LIST_DESCRIPTION,
    inputSchema: listInput,
    outputSchema: listOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 6,
    handler: async (args, ctx) => {
      const account = singleAccount(ctx, args.account);
      const limit = args.limit ?? DEFAULT_LIMIT;
      const parts = [
        entityQuery`accountId = ${account}`,
        entityQuery`domain = 'VIZ'`,
        entityQuery`type = 'DASHBOARD'`,
      ];
      if (args.name) parts.push(entityQuery`name LIKE ${`%${args.name}%`}`);
      const query = entityQuery.and(parts);
      const result = await client(ctx).query(DASHBOARDS_QUERY, {
        query: query.text,
        cursor: args.cursor ?? null,
        options: { limit },
      });
      const es = requireField(result.data.actor.entitySearch, result, ctx);
      const all = (es.results?.entities ?? []).filter(isNonNull);
      const inScope = (e: DashboardOutline) =>
        e.accountId === account && typeof e.guid === 'string' && guidAgrees(e.guid, account);
      const scoped = all.filter(inScope).slice(0, limit);
      const notes: string[] = [];
      if (all.some((e) => !inScope(e)))
        notes.push("Results outside this connection's accounts were left out.");
      const nextCursor = nextCursorOf(es.results?.nextCursor);
      const total = num(es.count);
      const minimal = args.minimal_output === true;
      const dashboards = scoped.map((e) => {
        const base = { guid: e.guid as string, name: cleanName(e.name ?? '') };
        if (minimal) return base;
        return {
          ...base,
          permissions: label(e.permissions),
          permalink: typeof e.permalink === 'string' ? cleanName(e.permalink, 500) : null,
        };
      });

      const lines = [
        `${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'} in account ${account}` +
          `${total !== null && total > dashboards.length ? ` (${total} match in total)` : ''}.`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      if (nextCursor)
        lines.push('More dashboards: call again with the same filters and the next_cursor below.');
      if (dashboards.length > 0) {
        lines.push(
          shapeRows(
            dashboards.map((d) => ({
              name: d.name,
              guid: d.guid,
              ...('permissions' in d ? { permissions: d.permissions ?? '' } : {}),
            })),
            { format: 'table', source: 'New Relic dashboards', maxRows: MAX_LIMIT },
          ).text,
        );
      }
      if (nextCursor) lines.push(`next_cursor: ${nextCursor}`);
      return { text: lines.join('\n'), structured: { account, dashboards, total, nextCursor, notes } };
    },
  });

  const get = defineTool({
    name: 'get_dashboard',
    title: 'Get dashboard',
    description: GET_DESCRIPTION,
    inputSchema: getInput,
    outputSchema: getOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'entities',
    phase: 6,
    handler: async (args, ctx) => {
      const decoded = checkGuid(ctx, args.guid);
      const result = await client(ctx).query(DASHBOARD_QUERY, { guid: args.guid });
      const e = requireField(result.data.actor.entity, result, ctx);
      const account = e.accountId ?? decoded.accountId;
      // The GUID's own account was checked offline; NerdGraph must agree (T3).
      if (!ctx.accounts.allowed.includes(account) || account !== decoded.accountId) throw outOfScope(account);
      if (typeof e.guid === 'string' && decodeEntityGuid(e.guid).accountId !== account)
        throw outOfScope(account);

      const allowed = new Set(ctx.accounts.allowed);
      const minimal = args.minimal_output === true;
      const rawPages = (e.pages ?? []).filter(isNonNull);
      let truncated = rawPages.length > MAX_PAGES;
      let withheldCount = 0;
      const pages = rawPages.slice(0, MAX_PAGES).map((p) => {
        const rawWidgets = (p.widgets ?? []).filter(isNonNull);
        if (rawWidgets.length > MAX_WIDGETS_PER_PAGE) truncated = true;
        const widgets = rawWidgets
          .slice(0, MAX_WIDGETS_PER_PAGE)
          .map((w) => readWidget(w, allowed, !minimal));
        withheldCount += widgets.filter((w) => w.withheld).length;
        return {
          guid: typeof p.guid === 'string' ? cleanName(p.guid, 200) : null,
          name: cleanName(p.name ?? ''),
          description:
            typeof p.description === 'string' && p.description !== ''
              ? cleanName(p.description, MAX_DESCRIPTION_CHARS)
              : null,
          widgets,
        };
      });
      const notes: string[] = [];
      if (withheldCount > 0)
        notes.push(
          `${withheldCount} widget(s) query an account this connection cannot read: their NRQL and text are withheld.`,
        );
      if (truncated)
        notes.push(
          `Only the first ${MAX_PAGES} pages and ${MAX_WIDGETS_PER_PAGE} widgets per page are shown.`,
        );
      notes.push('Widgets are not executed; pass a widget NRQL to run_nrql to run it.');

      const structured = {
        guid: args.guid,
        name: cleanName(e.name ?? ''),
        account,
        description:
          typeof e.description === 'string' && e.description !== ''
            ? cleanName(e.description, MAX_DESCRIPTION_CHARS)
            : null,
        permissions: label(e.permissions),
        permalink: typeof e.permalink === 'string' ? cleanName(e.permalink, 500) : null,
        pages,
        truncated,
        notes,
      };

      const widgetCount = pages.reduce((s, p) => s + p.widgets.length, 0);
      const lines = [
        `Dashboard in account ${account}: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${widgetCount} widget${widgetCount === 1 ? '' : 's'}.`,
      ];
      for (const n of notes) lines.push(`Note: ${n}`);
      const rows: Record<string, unknown>[] = [];
      for (const p of pages) {
        for (const w of p.widgets) {
          rows.push({
            page: p.name,
            widget: w.title,
            viz: w.visualization ?? '',
            ...(minimal
              ? {}
              : {
                  nrql: w.withheld ? '(withheld: other account)' : w.queries.map((q) => q.nrql).join(' | '),
                  account: [...new Set(w.queries.map((q) => q.accountId))].join(','),
                  markdown: w.markdown ?? '',
                }),
          });
        }
      }
      lines.push(
        `name: ${structured.name}`,
        ...(structured.description ? [`description: ${structured.description}`] : []),
        `link: ${structured.permalink ?? ''}`,
      );
      if (rows.length > 0)
        lines.push(
          shapeRows(rows, {
            format: 'table',
            source: 'New Relic dashboard',
            maxRows: MAX_PAGES * MAX_WIDGETS_PER_PAGE,
          }).text,
        );
      return { text: lines.join('\n'), structured };
    },
  });

  return [list as ToolDefinition, get as ToolDefinition];
}
