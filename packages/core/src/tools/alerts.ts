// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  ALERT_CONDITIONS_QUERY,
  ALERT_POLICIES_QUERY,
  type AlertConditionData,
  type AlertTermData,
} from '../nerdgraph/alerts.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { guidAgrees, isNonNull, requireField } from './entities.ts';
import { cleanName } from './identity.ts';
import { bindingOf, listLimit, pageUpstream } from './paging.ts';
import {
  accountInput,
  cursorInput,
  label,
  num,
  singleAccount,
  type ToolDeps,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const MAX_NAME_FILTER = 256;
const MAX_QUERY_CHARS = 2000;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_TERMS = 10;
const DEFAULT_POLICIES = 50;
const DEFAULT_CONDITIONS = 25;
const MAX_LIMIT = 200;
/** Policy ids are numeric strings (`AlertsPolicy.id: ID!`). */
const POLICY_ID_RE = /^[0-9]{1,18}$/;

const policiesInput = z.strictObject({
  name_contains: z
    .string()
    .min(1)
    .max(MAX_NAME_FILTER)
    .optional()
    .describe('Part of the policy name (case-insensitive substring match).'),
  account: accountInput,
  limit: listLimit('policies', DEFAULT_POLICIES, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z.boolean().optional().describe('Only id, name and account of each policy.'),
});

const policiesOutput = z.object({
  accountId: z.number().int(),
  policies: z.array(z.record(z.string(), z.unknown())),
  /** Matches NerdGraph reported for the filter (before account filtering). */
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
});

const conditionsInput = z.strictObject({
  policy_id: z
    .string()
    .regex(POLICY_ID_RE)
    .optional()
    .describe('Only the conditions of this alert policy (id from list_alert_policies).'),
  name_contains: z
    .string()
    .min(1)
    .max(MAX_NAME_FILTER)
    .optional()
    .describe('Part of the condition name (case-insensitive substring match).'),
  query_contains: z
    .string()
    .min(1)
    .max(MAX_NAME_FILTER)
    .optional()
    .describe('Part of the condition NRQL query text, e.g. an event type or an app name.'),
  account: accountInput,
  limit: listLimit('conditions', DEFAULT_CONDITIONS, MAX_LIMIT),
  cursor: cursorInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Only id, name, policy, enabled, type, NRQL query and thresholds.'),
});

const conditionsOutput = z.object({
  accountId: z.number().int(),
  conditions: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
});

const POLICIES_DESCRIPTION = `List the alert policies of one account: id, name and incident preference (PER_POLICY, PER_CONDITION, PER_CONDITION_AND_TARGET: how violations roll up into issues).

Use it to find a policy id for list_alert_conditions. name_contains filters by case-insensitive substring. One account per call (default: the default account). If nextCursor is returned, pass it as cursor with the same filters. ${UNTRUSTED}`;

const CONDITIONS_DESCRIPTION = `List the NRQL alert conditions of one account: name, policy, enabled, type (STATIC, BASELINE, OUTLIER), the NRQL query evaluated and its thresholds.

Use it to see what an alert watches and when it fires. Filter by policy_id (from list_alert_policies), name_contains or query_contains. One account per call; page with cursor. For what is firing now use list_recent_issues. ${UNTRUSTED}`;

function toTerm(t: AlertTermData) {
  return {
    priority: label(t.priority),
    operator: label(t.operator),
    threshold: num(t.threshold),
    durationSeconds: num(t.thresholdDuration),
    occurrences: label(t.thresholdOccurrences),
  };
}

/** `CRITICAL ABOVE 5 for 300s (ALL)`: one threshold in a line. */
const termText = (t: ReturnType<typeof toTerm>) =>
  `${t.priority ?? '?'} ${t.operator ?? '?'} ${t.threshold ?? '?'} for ${t.durationSeconds ?? '?'}s` +
  `${t.occurrences ? ` (${t.occurrences})` : ''}`;

function toCondition(c: AlertConditionData, allowed: readonly number[]) {
  // A condition may read another account's data; its NRQL and account are withheld like dashboard widgets (T3).
  const dataAccount = num(c.nrql?.dataAccountId);
  const withheld = dataAccount !== null && !allowed.includes(dataAccount);
  const terms = (c.terms ?? []).filter(isNonNull).slice(0, MAX_TERMS).map(toTerm);
  const signal = c.signal;
  return {
    id: typeof c.id === 'string' ? cleanName(c.id, 32) : '',
    name: cleanName(c.name ?? ''),
    policyId: typeof c.policyId === 'string' ? cleanName(c.policyId, 32) : null,
    enabled: typeof c.enabled === 'boolean' ? c.enabled : null,
    type: label(c.type),
    query: withheld ? '(withheld: other account)' : cleanName(c.nrql?.query ?? '', MAX_QUERY_CHARS),
    dataAccountId: withheld ? null : dataAccount,
    queryWithheld: withheld,
    terms,
    description: c.description ? cleanName(c.description, MAX_DESCRIPTION_CHARS) : null,
    runbookUrl: c.runbookUrl ? cleanName(c.runbookUrl, 500) : null,
    signal: signal
      ? {
          aggregationMethod: label(signal.aggregationMethod),
          aggregationWindowSeconds: num(signal.aggregationWindow),
          aggregationDelaySeconds: num(signal.aggregationDelay),
          aggregationTimerSeconds: num(signal.aggregationTimer),
          slideBySeconds: num(signal.slideBy),
        }
      : null,
    violationTimeLimitSeconds: num(c.violationTimeLimitSeconds),
  };
}

const MINIMAL_CONDITION_FIELDS = ['id', 'name', 'policyId', 'enabled', 'type', 'query', 'terms'] as const;

/** `list_alert_policies`, `list_alert_conditions` (read-only). */
export function createAlertTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const listPolicies = defineTool({
    name: 'list_alert_policies',
    title: 'List alert policies',
    description: POLICIES_DESCRIPTION,
    inputSchema: policiesInput,
    outputSchema: policiesOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'alerting',
    phase: 6,
    handler: async (input, ctx) => {
      const account = singleAccount(ctx, input.account);
      let search = undefined as { totalCount?: number | null } | null | undefined;
      const page = await pageUpstream({
        binding: await bindingOf('list_alert_policies', account, input.name_contains),
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_POLICIES,
        fetchPage: async (upstream) => {
          const result = await client(ctx).query(ALERT_POLICIES_QUERY, {
            accountId: account,
            cursor: upstream,
            criteria: input.name_contains ? { nameLike: input.name_contains } : {},
          });
          const acct = requireField(result.data.actor.account, result, ctx);
          const found = acct.alerts?.policiesSearch;
          search = found;
          return { items: (found?.policies ?? []).filter(isNonNull), next: found?.nextCursor };
        },
      });
      const all = page.items;
      // Defence in depth (T3): a row must name the requested account, and its GUID must agree.
      const inScope = (p: (typeof all)[number]) =>
        p.accountId === account &&
        typeof p.id === 'string' &&
        (typeof p.entityGuid !== 'string' || guidAgrees(p.entityGuid, account));
      const rows = all.filter(inScope).map((p) => ({
        id: cleanName(p.id ?? '', 32),
        name: cleanName(p.name ?? ''),
        accountId: account,
        incidentPreference: label(p.incidentPreference),
      }));
      const hiddenOutsideScope = all.some((p) => !inScope(p));
      const nextCursor = page.nextCursor;
      const total = num(search?.totalCount);
      const policies = input.minimal_output
        ? pickFields(rows, ['id', 'name', 'accountId'])
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} alert polic${rows.length === 1 ? 'y' : 'ies'} in account ${account}` +
          `${total !== null && total > rows.length ? ` (${total} match in total)` : ''}.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor)
        lines.push('More results: call again with the same filters and cursor set to the nextCursor below.');
      if (rows.length > 0) {
        lines.push(
          shapeRows(
            rows.map((r) => ({
              id: r.id,
              name: r.name,
              ...(input.minimal_output ? {} : { incident_preference: r.incidentPreference ?? '' }),
            })),
            { format: 'table', source: 'New Relic alert policies', maxRows: 1000 },
          ).text,
        );
      }
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: { accountId: account, policies, total, nextCursor, hiddenOutsideScope },
      };
    },
  });

  const listConditions = defineTool({
    name: 'list_alert_conditions',
    title: 'List alert conditions',
    description: CONDITIONS_DESCRIPTION,
    inputSchema: conditionsInput,
    outputSchema: conditionsOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'alerting',
    phase: 6,
    handler: async (input, ctx) => {
      const account = singleAccount(ctx, input.account);
      const criteria: { policyId?: string; nameLike?: string; queryLike?: string } = {};
      if (input.policy_id) criteria.policyId = input.policy_id;
      if (input.name_contains) criteria.nameLike = input.name_contains;
      if (input.query_contains) criteria.queryLike = input.query_contains;
      let search = undefined as { totalCount?: number | null } | null | undefined;
      const page = await pageUpstream({
        binding: await bindingOf(
          'list_alert_conditions',
          account,
          input.policy_id,
          input.name_contains,
          input.query_contains,
        ),
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_CONDITIONS,
        fetchPage: async (upstream) => {
          const result = await client(ctx).query(ALERT_CONDITIONS_QUERY, {
            accountId: account,
            cursor: upstream,
            criteria,
          });
          const acct = requireField(result.data.actor.account, result, ctx);
          const found = acct.alerts?.nrqlConditionsSearch;
          search = found;
          return { items: (found?.nrqlConditions ?? []).filter(isNonNull), next: found?.nextCursor };
        },
      });
      const all = page.items;
      // Conditions carry no account id: the entity GUID is the only claim, and it must name the requested account (T3).
      // A row with no GUID makes no claim at all, so it is dropped (a forged upstream cursor could add such rows, L5).
      const inScope = (c: (typeof all)[number]) =>
        typeof c.id === 'string' && typeof c.entityGuid === 'string' && guidAgrees(c.entityGuid, account);
      const rows = all.filter(inScope).map((c) => toCondition(c, ctx.accounts.allowed));
      const hiddenOutsideScope = all.some((c) => !inScope(c));
      const nextCursor = page.nextCursor;
      const total = num(search?.totalCount);
      const conditions = input.minimal_output
        ? pickFields(rows, MINIMAL_CONDITION_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} NRQL alert condition${rows.length === 1 ? '' : 's'} in account ${account}` +
          `${total !== null && total > rows.length ? ` (${total} match in total)` : ''}.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor)
        lines.push('More results: call again with the same filters and cursor set to the nextCursor below.');
      if (rows.length > 0) {
        lines.push(
          shapeRows(
            rows.map((r) => ({
              id: r.id,
              name: r.name,
              policy: r.policyId ?? '',
              enabled: r.enabled === null ? '' : r.enabled ? 'yes' : 'no',
              type: r.type ?? '',
              thresholds: r.terms.map(termText).join('; '),
              query: r.query,
              ...(input.minimal_output ? {} : { description: r.description ?? '' }),
            })),
            {
              format: 'csv',
              source: 'New Relic alert conditions',
              maxRows: 1000,
              maxCellChars: MAX_QUERY_CHARS,
            },
          ).text,
        );
      }
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: { accountId: account, conditions, total, nextCursor, hiddenOutsideScope },
      };
    },
  });

  return [listPolicies as ToolDefinition, listConditions as ToolDefinition];
}
