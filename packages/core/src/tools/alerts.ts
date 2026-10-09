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

const MAX_NAME_FILTER = 256;
const MAX_QUERY_CHARS = 2000;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_TERMS = 10;
/** Policy ids are numeric strings (`AlertsPolicy.id: ID!`). */
const POLICY_ID_RE = /^[0-9]{1,18}$/;

const policiesInput = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(MAX_NAME_FILTER)
    .optional()
    .describe('Part of the policy name (case-insensitive substring match).'),
  account: accountInput,
  cursor: cursorInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Only id, name and account of each policy (default false).'),
});

const policiesOutput = z.object({
  account: z.number().int(),
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
  name: z
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
  cursor: cursorInput,
  minimal_output: z
    .boolean()
    .optional()
    .describe('Only id, name, policy, enabled, type, NRQL query and thresholds (default false).'),
});

const conditionsOutput = z.object({
  account: z.number().int(),
  conditions: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  hiddenOutsideScope: z.boolean(),
});

const POLICIES_DESCRIPTION = `List the alert policies of one account: id, name and incident preference (PER_POLICY, PER_CONDITION, PER_CONDITION_AND_TARGET: how violations roll up into issues).

Use it to find a policy id for list_alert_conditions. name filters by case-insensitive substring. One account per call (default: the default account). If next_cursor is returned, call again with the same filters and that cursor. ${UNTRUSTED}`;

const CONDITIONS_DESCRIPTION = `List the NRQL alert conditions of one account: name, policy, enabled, type (STATIC, BASELINE, OUTLIER), the NRQL query evaluated and its thresholds.

Use it to see what an alert watches and when it fires. Filter by policy_id (from list_alert_policies), name or query_contains. One account per call; page with next_cursor. For what is firing now use list_recent_issues. ${UNTRUSTED}`;

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

function toCondition(c: AlertConditionData) {
  const terms = (c.terms ?? []).filter(isNonNull).slice(0, MAX_TERMS).map(toTerm);
  const signal = c.signal;
  return {
    id: typeof c.id === 'string' ? cleanName(c.id, 32) : '',
    name: cleanName(c.name ?? ''),
    policyId: typeof c.policyId === 'string' ? cleanName(c.policyId, 32) : null,
    enabled: typeof c.enabled === 'boolean' ? c.enabled : null,
    type: label(c.type),
    query: cleanName(c.nrql?.query ?? '', MAX_QUERY_CHARS),
    dataAccountId: num(c.nrql?.dataAccountId),
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
      const result = await client(ctx).query(ALERT_POLICIES_QUERY, {
        accountId: account,
        cursor: input.cursor ?? null,
        criteria: input.name ? { nameLike: input.name } : {},
      });
      const acct = requireField(result.data.actor.account, result, ctx);
      const search = acct.alerts?.policiesSearch;
      const all = (search?.policies ?? []).filter(isNonNull);
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
      const nextCursor = nextCursorOf(search?.nextCursor);
      const total = num(search?.totalCount);
      const policies = input.minimal_output
        ? pickFields(rows, ['id', 'name', 'accountId'])
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} alert polic${rows.length === 1 ? 'y' : 'ies'} in account ${account}` +
          `${total !== null && total > rows.length ? ` (${total} match in total)` : ''}.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor) lines.push('More results: call again with the same filters and the next_cursor below.');
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
      if (nextCursor) lines.push(`next_cursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: { account, policies, total, nextCursor, hiddenOutsideScope },
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
      if (input.name) criteria.nameLike = input.name;
      if (input.query_contains) criteria.queryLike = input.query_contains;
      const result = await client(ctx).query(ALERT_CONDITIONS_QUERY, {
        accountId: account,
        cursor: input.cursor ?? null,
        criteria,
      });
      const acct = requireField(result.data.actor.account, result, ctx);
      const search = acct.alerts?.nrqlConditionsSearch;
      const all = (search?.nrqlConditions ?? []).filter(isNonNull);
      // Conditions carry no account id: the entity GUID is the only claim, and it must name the requested account (T3).
      const inScope = (c: (typeof all)[number]) =>
        typeof c.id === 'string' && (typeof c.entityGuid !== 'string' || guidAgrees(c.entityGuid, account));
      const rows = all.filter(inScope).map(toCondition);
      const hiddenOutsideScope = all.some((c) => !inScope(c));
      const nextCursor = nextCursorOf(search?.nextCursor);
      const total = num(search?.totalCount);
      const conditions = input.minimal_output
        ? pickFields(rows, MINIMAL_CONDITION_FIELDS)
        : (rows as Record<string, unknown>[]);

      const lines = [
        `${rows.length} NRQL alert condition${rows.length === 1 ? '' : 's'} in account ${account}` +
          `${total !== null && total > rows.length ? ` (${total} match in total)` : ''}.`,
      ];
      if (hiddenOutsideScope) lines.push("Note: results outside this connection's accounts were left out.");
      if (nextCursor) lines.push('More results: call again with the same filters and the next_cursor below.');
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
      if (nextCursor) lines.push(`next_cursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: { account, conditions, total, nextCursor, hiddenOutsideScope },
      };
    },
  });

  return [listPolicies as ToolDefinition, listConditions as ToolDefinition];
}
