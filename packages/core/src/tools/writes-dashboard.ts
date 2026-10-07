// SPDX-License-Identifier: Apache-2.0
// `create_dashboard` (P7-19, ADR-0015, THREAT_MODEL T31/T5/T3/T26): an opt-in write tool that creates one PRIVATE
// dashboard from agent-written NRQL. Same gates as the P7-09 write tools (explicit grant, confirm or dry run, one
// allow-listed mutation sent once). The widget NRQL is raw NRQL, so it passes exactly the checks `run_nrql` applies
// (raw-NRQL switch, event-type allow/deny, window, LIMIT, comments removed) and the checked text is what is stored;
// every query's account must be on the connection. Permissions are fixed to PRIVATE (never an argument), only typed
// widget configuration is sent (no raw JSON, links, linked entities or variables), and all text is bounded and
// sanitised. Nothing existing is read, changed or deleted.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, isRbError, RbError } from '../errors.ts';
import type { NerdGraphClient } from '../nerdgraph/client.ts';
import {
  CREATE_DASHBOARD_MUTATION,
  type DashboardChartKind,
  type DashboardInputVariable,
  type DashboardWidgetVariable,
} from '../nerdgraph/mutations.ts';
import { assertRawNrqlAllowed, enforceQueryLimits } from '../nrql/limits.ts';
import { envelope } from '../output/envelope.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { cleanName } from './identity.ts';
import { MAX_NRQL_CHARS } from './query.ts';
import { accountIdSchema, accountInput, singleAccount } from './shared.ts';
import {
  assertConfirmed,
  assertWriteGranted,
  confirmInput,
  dryRunInput,
  gateStopped,
  humanGate,
  mutationFailed,
  rejectSecrets,
  SIDE_EFFECT_NOTICE,
  shown,
  type WriteRecord,
  writeMeta,
  writeOutput,
} from './write-common.ts';

/** Size limits (T5: bounded parsing work; a dashboard an agent builds is small). */
export const DASHBOARD_LIMITS: Readonly<{
  pages: number;
  widgetsPerPage: number;
  widgets: number;
  queriesPerWidget: number;
  nameChars: number;
  descriptionChars: number;
  markdownChars: number;
}> = Object.freeze({
  pages: 5,
  widgetsPerPage: 20,
  widgets: 40,
  queriesPerWidget: 3,
  nameChars: 100,
  descriptionChars: 500,
  markdownChars: 2000,
});

const GRID_COLUMNS = 12;
const DEFAULT_WIDTH = 4;
const DEFAULT_HEIGHT = 3;
const CHARTS = [
  'line',
  'area',
  'bar',
  'billboard',
  'pie',
  'table',
] as const satisfies readonly DashboardChartKind[];
const VISUALIZATIONS = [...CHARTS, 'markdown'] as const;
type Visualization = (typeof VISUALIZATIONS)[number];

/** No control, surrogate or format characters (bidi overrides, zero-width): names must read as they are. */
const PLAIN_RE = /^[^\p{Cc}\p{Cs}\p{Cf}]*$/u;
const PLAIN_MULTILINE_RE = /^(?:[^\p{Cc}\p{Cs}\p{Cf}]|\n)*$/u;
const plain = (max: number, what: string) =>
  z
    .string()
    .max(max)
    .regex(PLAIN_RE, 'no control or format characters')
    .refine((s) => s.trim() !== '', 'must not be blank')
    .describe(what);
const plainMultiline = (max: number, what: string) =>
  z
    .string()
    .max(max)
    .regex(PLAIN_MULTILINE_RE, 'no control or format characters')
    .refine((s) => s.trim() !== '', 'must not be blank')
    .describe(what);

/**
 * Markdown widgets carry text only: no links, images, autolinks, reference links or HTML. A dashboard is a place people
 * trust; an injected agent must not plant a phishing link or a tracking image there (T6/T31).
 */
const MARKDOWN_FORBIDDEN_RE = /<|>|\]\(|\]\s*:|\]\[|:\/\/|\bwww\.|\bmailto:|\bjavascript:|\bdata:\w+\//i;

const queryInput = z.strictObject({
  nrql: z
    .string()
    .min(1)
    .max(MAX_NRQL_CHARS)
    .describe('NRQL for this widget, checked like run_nrql (connection limits apply).'),
  account: accountIdSchema
    .optional()
    .describe("Account this query reads (list_accounts). Default: the dashboard's account."),
});

const widgetInput = z.strictObject({
  title: plain(DASHBOARD_LIMITS.nameChars, 'Widget title.'),
  visualization: z
    .enum(VISUALIZATIONS)
    .describe('Chart type; "markdown" shows plain text (no links, images or HTML).'),
  queries: z
    .array(queryInput)
    .min(1)
    .max(DASHBOARD_LIMITS.queriesPerWidget)
    .optional()
    .describe(
      `NRQL queries (1–${DASHBOARD_LIMITS.queriesPerWidget}); required for charts, not for markdown.`,
    ),
  markdown: plainMultiline(DASHBOARD_LIMITS.markdownChars, 'Text of a markdown widget.').optional(),
  width: z
    .number()
    .int()
    .min(1)
    .max(GRID_COLUMNS)
    .optional()
    .describe(`Columns of ${GRID_COLUMNS} (default ${DEFAULT_WIDTH}).`),
  height: z.number().int().min(1).max(12).optional().describe(`Rows (default ${DEFAULT_HEIGHT}).`),
});

const pageInput = z.strictObject({
  name: plain(DASHBOARD_LIMITS.nameChars, 'Page name.'),
  description: plainMultiline(DASHBOARD_LIMITS.descriptionChars, 'Page description.').optional(),
  widgets: z
    .array(widgetInput)
    .min(1)
    .max(DASHBOARD_LIMITS.widgetsPerPage)
    .describe(`Widgets in reading order (1–${DASHBOARD_LIMITS.widgetsPerPage}); laid out left to right.`),
});

const dashboardInput = z.strictObject({
  name: plain(DASHBOARD_LIMITS.nameChars, 'Dashboard name.'),
  description: plainMultiline(DASHBOARD_LIMITS.descriptionChars, 'Dashboard description.').optional(),
  account: accountInput.describe(
    'Account the dashboard is created in (list_accounts). Default: the default.',
  ),
  pages: z
    .array(pageInput)
    .min(1)
    .max(DASHBOARD_LIMITS.pages)
    .describe(`Pages (1–${DASHBOARD_LIMITS.pages}), at most ${DASHBOARD_LIMITS.widgets} widgets in all.`),
  confirm: confirmInput,
  dry_run: dryRunInput,
});

type DashboardArgs = z.infer<typeof dashboardInput>;

const plannedQuery = z.object({ accountId: z.number().int(), nrql: z.string() });
const plannedWidget = z.object({
  title: z.string(),
  visualization: z.string(),
  layout: z.object({ column: z.number(), row: z.number(), width: z.number(), height: z.number() }),
  queries: z.array(plannedQuery),
  markdown: z.string().nullable(),
});

const dashboardOutput = z.object({
  ...writeOutput,
  dashboardGuid: z.string().nullable(),
  name: z.string(),
  permissions: z.string(),
  pages: z.array(z.object({ name: z.string(), widgets: z.array(plannedWidget) })),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
});

const DESCRIPTION = `Create a new private New Relic dashboard from NRQL queries: pages of charts (line, area, bar, billboard, pie, table) and plain-text markdown widgets.

Write tool, opt-in. ${SIDE_EFFECT_NOTICE} Needs confirm: true; dry_run: true checks everything and returns the planned dashboard without creating it. Each call creates a new dashboard (not idempotent; relic-bridge cannot edit or delete dashboards). The dashboard is always PRIVATE. Widget NRQL is checked like run_nrql (event types, window, LIMIT) and every query account must be on this connection. Limits: ${DASHBOARD_LIMITS.pages} pages, ${DASHBOARD_LIMITS.widgetsPerPage} widgets per page, ${DASHBOARD_LIMITS.widgets} in all, ${DASHBOARD_LIMITS.queriesPerWidget} queries per widget. To read existing dashboards use list_dashboards and get_dashboard.`;

/** Prefix an error with where it happened, keeping its code (limits → RB_LIMIT_QUERY, accounts → RB_AUTH_FORBIDDEN). */
function at(where: string, e: unknown): never {
  if (!isRbError(e)) throw e;
  const done = /nothing was changed/i.test(e.message) ? '' : ' Nothing was changed.';
  throw new RbError(e.code, `${where}: ${e.message}${done}`, {
    ...(e.hint === undefined ? {} : { hint: e.hint }),
    details: { ...(e.details ?? {}), at: where },
  });
}

interface Plan {
  readonly variable: DashboardInputVariable;
  readonly pages: z.infer<typeof dashboardOutput>['pages'];
  readonly notes: string[];
  readonly accounts: number[];
  readonly eventTypes: string[];
  readonly widgets: number;
  readonly queries: number;
}

/**
 * Check every argument and build the mutation's `dashboard` variable. Offline (no request): every refusal happens
 * before anything reaches New Relic.
 */
function planDashboard(input: DashboardArgs, ctx: ToolContext, dashboardAccount: number): Plan {
  const total = input.pages.reduce((n, p) => n + p.widgets.length, 0);
  if (total > DASHBOARD_LIMITS.widgets) {
    throw new RbError(
      ErrorCode.InputInvalid,
      `The dashboard has ${total} widgets; at most ${DASHBOARD_LIMITS.widgets} are allowed. Nothing was changed.`,
      { hint: 'Split it into several dashboards or fewer widgets.' },
    );
  }
  rejectSecrets({ name: input.name, description: input.description });
  const now = ctx.clock.now();
  const notes: string[] = [];
  const accounts = new Set<number>([dashboardAccount]);
  const eventTypes = new Set<string>();
  let queries = 0;
  const pages: Plan['pages'] = [];
  const pageVars: DashboardInputVariable['pages'] = [];

  input.pages.forEach((page, p) => {
    rejectSecrets({ [`page ${p + 1} name`]: page.name, [`page ${p + 1} description`]: page.description });
    let column = 1;
    let row = 1;
    let rowHeight = 0;
    const widgets: Plan['pages'][number]['widgets'] = [];
    const widgetVars: DashboardWidgetVariable[] = [];
    page.widgets.forEach((widget, w) => {
      const where = `Page ${p + 1} widget ${w + 1}`;
      rejectSecrets({ [`${where} title`]: widget.title });
      const viz: Visualization = widget.visualization;
      const isMarkdown = viz === 'markdown';
      if (isMarkdown && (widget.markdown === undefined || widget.queries !== undefined)) {
        throw new RbError(
          ErrorCode.InputInvalid,
          `${where}: a markdown widget needs markdown and no queries. Nothing was changed.`,
        );
      }
      if (!isMarkdown && (widget.queries === undefined || widget.markdown !== undefined)) {
        throw new RbError(
          ErrorCode.InputInvalid,
          `${where}: a ${viz} widget needs queries and no markdown. Nothing was changed.`,
        );
      }
      if (widget.markdown !== undefined) {
        rejectSecrets({ [`${where} markdown`]: widget.markdown });
        if (MARKDOWN_FORBIDDEN_RE.test(widget.markdown)) {
          throw new RbError(
            ErrorCode.InputInvalid,
            `${where}: markdown text cannot contain links, images, URLs or HTML. Nothing was changed.`,
            { hint: 'Keep markdown widgets to plain text, headings and lists.' },
          );
        }
      }
      const planned: { accountId: number; nrql: string }[] = [];
      for (const [q, query] of (widget.queries ?? []).entries()) {
        const qWhere = (widget.queries?.length ?? 0) > 1 ? `${where} query ${q + 1}` : where;
        try {
          // Every account a widget reads must be on this connection (T3): no cross-account widgets.
          const account = singleAccount(ctx, query.account ?? dashboardAccount);
          rejectSecrets({ nrql: query.nrql });
          // Same limits as run_nrql (T5); the checked text (LIMIT capped, comments removed) is what is stored.
          const checked = enforceQueryLimits(query.nrql, ctx.limits, now);
          for (const n of checked.notes) notes.push(`${qWhere}: ${n}`);
          for (const e of checked.eventTypes) eventTypes.add(e);
          accounts.add(account);
          planned.push({ accountId: account, nrql: checked.nrql });
          queries += 1;
        } catch (e) {
          at(qWhere, e);
        }
      }
      const width = widget.width ?? DEFAULT_WIDTH;
      const height = widget.height ?? DEFAULT_HEIGHT;
      if (column + width - 1 > GRID_COLUMNS) {
        row += rowHeight;
        column = 1;
        rowHeight = 0;
      }
      const layout = { column, row, width, height };
      column += width;
      rowHeight = Math.max(rowHeight, height);
      widgets.push({
        title: widget.title,
        visualization: viz,
        layout,
        queries: planned,
        markdown: widget.markdown ?? null,
      });
      widgetVars.push({
        title: widget.title,
        layout,
        visualization: { id: `viz.${viz}` },
        configuration: isMarkdown
          ? { markdown: { text: widget.markdown as string } }
          : { [viz]: { nrqlQueries: planned.map((x) => ({ accountId: x.accountId, query: x.nrql })) } },
      });
    });
    pages.push({ name: page.name, widgets });
    pageVars.push({
      name: page.name,
      ...(page.description === undefined ? {} : { description: page.description }),
      widgets: widgetVars,
    });
  });

  const variable: DashboardInputVariable = {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    // Never an argument: an injected agent must not be able to publish data to everyone in the account (T31, T26).
    permissions: 'PRIVATE',
    pages: pageVars,
  };
  return {
    variable,
    pages,
    notes,
    accounts: [...accounts],
    eventTypes: [...eventTypes].slice(0, 20).map((e) => cleanName(e, 100)),
    widgets: total,
    queries,
  };
}

/** sha256 of the exact `dashboard` variable sent: the audit row can't hold every query, the digest pins them. */
async function digest(variable: DashboardInputVariable): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(variable));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function outline(plan: Plan): string {
  const lines: string[] = [];
  for (const page of plan.pages) {
    lines.push(`- page "${page.name}": ${page.widgets.length} widget(s)`);
    for (const w of page.widgets) {
      const accounts = [...new Set(w.queries.map((q) => q.accountId))];
      lines.push(
        `  - ${w.visualization} "${w.title}"${accounts.length > 0 ? ` (account ${accounts.join(', ')})` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * What the person is shown before a dashboard is created: every page, widget, query and text, in full (NRQL as it will
 * be stored). Nothing is shortened: a change too large to show is refused by `humanGate` (phase 7 review H2).
 */
function confirmationMessage(input: DashboardArgs, account: number, plan: Plan, content: string): string {
  const lines = [
    'relic-bridge asks you to approve this change in New Relic (text in quotes comes from the request, not from relic-bridge):',
    `Create the PRIVATE dashboard ${shown(input.name, DASHBOARD_LIMITS.nameChars)} in account ${account}: ${plan.widgets} widget(s), ${plan.queries} quer${plan.queries === 1 ? 'y' : 'ies'} on ${plan.pages.length} page(s).`,
    "Its queries run in New Relic whenever it is opened, under the viewer's own rights. It cannot be edited or deleted from relic-bridge.",
  ];
  if (input.description !== undefined) {
    lines.push(`Description: ${shown(input.description, DASHBOARD_LIMITS.descriptionChars)}`);
  }
  plan.pages.forEach((page, p) => {
    lines.push(`Page ${shown(page.name, DASHBOARD_LIMITS.nameChars)}:`);
    const description = input.pages[p]?.description;
    if (description !== undefined) {
      lines.push(`  description: ${shown(description, DASHBOARD_LIMITS.descriptionChars)}`);
    }
    for (const w of page.widgets) {
      lines.push(`- ${w.visualization} ${shown(w.title, DASHBOARD_LIMITS.nameChars)}`);
      if (w.markdown !== null) lines.push(`    text: ${shown(w.markdown, DASHBOARD_LIMITS.markdownChars)}`);
      for (const q of w.queries) lines.push(`    account ${q.accountId}: ${shown(q.nrql, MAX_NRQL_CHARS)}`);
    }
  });
  lines.push(`Content hash: ${content}`);
  return lines.join('\n');
}

const GUID_RE = /^[A-Za-z0-9+/=_-]{8,512}$/;

/** `create_dashboard` (P7-19). Registered by `createWriteTools` only. */
export function createDashboardWriteTool(client: (ctx: ToolContext) => NerdGraphClient): ToolDefinition {
  return defineTool({
    name: 'create_dashboard',
    title: 'Create a private dashboard (write)',
    description: DESCRIPTION,
    inputSchema: dashboardInput,
    outputSchema: dashboardOutput,
    kind: 'write',
    idempotent: false,
    openWorld: true,
    cost: 2,
    group: 'writes',
    phase: 7,
    handler: async (input, ctx) => {
      assertWriteGranted(ctx, 'create_dashboard');
      assertConfirmed(input);
      // Widget NRQL is agent-written NRQL: the raw-NRQL switch applies (the resolver also hides the tool when off).
      assertRawNrqlAllowed(ctx.limits);
      const account = singleAccount(ctx, input.account);
      const plan = planDashboard(input, ctx, account);
      const dryRun = input.dry_run === true;
      const summary = {
        name: input.name,
        permissions: 'PRIVATE',
        pages: plan.pages.length,
        widgets: plan.widgets,
        queries: plan.queries,
        accounts: plan.accounts,
        eventTypes: plan.eventTypes,
        content: await digest(plan.variable),
      };
      const record = (
        applied: boolean,
        guid: string | null,
        extra: Record<string, unknown> = {},
      ): WriteRecord => ({
        action: 'dashboard.create',
        accountId: account,
        target: { type: 'dashboard', id: guid ?? 'new' },
        dryRun,
        applied,
        before: null,
        after: { ...summary, ...(guid === null ? {} : { dashboardGuid: guid }), ...extra },
      });
      // The audit row's account column lists every account the dashboard's widgets read, not only where it lives.
      const metaOf = (r: WriteRecord) => ({
        ...writeMeta(r),
        'relic-bridge/result': { accounts: plan.accounts },
      });
      const shaped = (applied: boolean, guid: string | null, warnings: string[]) => ({
        applied,
        dryRun,
        accountId: account,
        dashboardGuid: guid,
        name: input.name,
        permissions: 'PRIVATE',
        pages: plan.pages,
        notes: plan.notes,
        warnings,
      });
      const notesText =
        plan.notes.length > 0 ? `\nAdjusted by the connection's limits:\n- ${plan.notes.join('\n- ')}` : '';

      if (dryRun) {
        return {
          text: `Dry run: would create the private dashboard "${input.name}" in account ${account} with ${plan.widgets} widget(s) on ${plan.pages.length} page(s). Nothing was changed.\n${outline(plan)}${notesText}`,
          structured: shaped(false, null, []),
          meta: metaOf(record(false, null)),
        };
      }

      const gate = await humanGate(
        ctx,
        'create_dashboard',
        confirmationMessage(input, account, plan, summary.content),
        {
          accountId: account,
          dashboard: plan.variable,
        },
      );
      if (gate.state !== 'go') {
        return gateStopped(gate, {
          structured: shaped(false, null, []),
          record: record(false, null),
          meta: { 'relic-bridge/result': { accounts: plan.accounts } },
        });
      }

      const result = await client(ctx).query(CREATE_DASHBOARD_MUTATION, {
        accountId: account,
        dashboard: plan.variable,
      });
      const created = result.data.dashboardCreate;
      const errors = (created?.errors ?? []).filter((e) => e !== null);
      const entity = created?.entityResult;
      if (
        entity === null ||
        entity === undefined ||
        typeof entity.guid !== 'string' ||
        !GUID_RE.test(entity.guid)
      ) {
        const first = errors[0]?.description;
        if (typeof first === 'string' && first !== '') {
          throw new RbError(
            ErrorCode.NerdGraphError,
            'New Relic did not create the dashboard (see details).',
            {
              hint: 'Fix the input (often the NRQL of a widget) and try again; check list_dashboards first.',
              details: { message: cleanName(first, 300) },
            },
          );
        }
        if (result.warnings.length > 0) throw mutationFailed(result, 'create the dashboard');
        throw new RbError(ErrorCode.NerdGraphError, "New Relic's answer did not confirm the dashboard.", {
          hint: 'The dashboard may exist: check list_dashboards before trying again.',
        });
      }
      const guid = entity.guid;
      // New Relic's answer is checked, not trusted: the dashboard exists either way, so mismatches are warnings.
      const warnings: string[] = [];
      if (entity.permissions !== 'PRIVATE') {
        warnings.push(
          'New Relic did not report the dashboard as PRIVATE: check its permissions in New Relic and make it private.',
        );
      }
      if (entity.accountId !== account) {
        warnings.push(`New Relic did not report the dashboard in account ${account}: check it in New Relic.`);
      }
      const messages = errors
        .map((e) => e?.description)
        .filter((m): m is string => typeof m === 'string' && m !== '')
        .slice(0, 5)
        .map((m) => cleanName(m, 300));
      const lines = [
        `Created the private dashboard "${input.name}" in account ${account} with ${plan.widgets} widget(s) on ${plan.pages.length} page(s) (guid ${guid}).`,
        outline(plan),
      ];
      if (warnings.length > 0) lines.push(`Warning:\n- ${warnings.join('\n- ')}`);
      if (messages.length > 0) lines.push(envelope(messages.join('\n'), { source: 'New Relic messages' }));
      return {
        text: lines.join('\n') + notesText,
        structured: shaped(true, guid, warnings),
        meta: metaOf({
          ...record(
            true,
            guid,
            warnings.length > 0 ? { reportedPermissions: cleanName(String(entity.permissions), 40) } : {},
          ),
          ...(gate.confirmation === undefined ? {} : { confirmation: gate.confirmation }),
        }),
      };
    },
  });
}
