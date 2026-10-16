// SPDX-License-Identifier: Apache-2.0
// Opt-in write tools (P7-09, ADR-0015, THREAT_MODEL T6/T31). Built by `createWriteTools()` only, never by
// `createBuiltinTools()`: a host adds them to its catalog when the server flag is on, and the access resolver then lets a
// connection use one only when both the project and the grant name it explicitly. Each handler re-checks that it was
// granted by name, requires `confirm: true` (or `dry_run`), reads its target first (account isolation + the "before" of
// the audit diff) and sends its one allow-listed mutation exactly once (no retries: a mutation may have applied even
// when the answer was lost). Shared guards live in `write-common.ts`; `create_dashboard` (P7-19) in `writes-dashboard.ts`.
import { z } from 'zod';
import { ErrorCode, RbError } from '../errors.ts';
import { ENTITY_QUERY } from '../nerdgraph/entities.ts';
import { entityQuery } from '../nerdgraph/entity-query.ts';
import {
  ACK_ISSUE_MUTATION,
  type ChangeEventInputVariable,
  CREATE_CHANGE_EVENT_MUTATION,
  type IssueActionData,
  RESOLVE_ISSUE_MUTATION,
} from '../nerdgraph/mutations.ts';
import { envelope } from '../output/envelope.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid, kind, outOfScope, requireField, toRow } from './entity-common.ts';
import { cleanName } from './identity.ts';
import { ISSUE_ID_RE, type IssueRow, lookupIssue } from './issues.ts';
import { accountInput, DAY_MS, label, singleAccount, type ToolDeps } from './shared.ts';
import {
  APPROVAL_NOTICE,
  approvalUnreachableWarning,
  assertConfirmed,
  assertWriteGranted,
  type Confirmation,
  confirmationOf,
  confirmInput,
  dryRunInput,
  gateStopped,
  humanGate,
  multiline,
  mutationFailed,
  recordWriteIntent,
  rejectSecrets,
  SIDE_EFFECT_NOTICE,
  shown,
  text,
  type WriteRecord,
  writeClient,
  writeMeta,
  writeOutput,
} from './write-common.ts';
import { createDashboardWriteTool } from './writes-dashboard.ts';

export { WRITE_META_KEY, type WriteRecord } from './write-common.ts';

/** Every write tool name. The access resolver treats these as "explicit opt-in only" (never implied by `null`). */
export const WRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  'create_change_event',
  'acknowledge_issue',
  'close_issue',
  'create_dashboard',
]);

// ---------------------------------------------------------------------------------------------------------------------
// create_change_event
// ---------------------------------------------------------------------------------------------------------------------

/** `ChangeTrackingCategoryType` values offered (P0-09 introspection); category and type are its two halves. */
const CHANGE_TYPES = [
  'DEPLOYMENT__BASIC',
  'DEPLOYMENT__BLUE_GREEN',
  'DEPLOYMENT__CANARY',
  'DEPLOYMENT__ROLLING',
  'DEPLOYMENT__SHADOW',
  'DEPLOYMENT__OTHER',
  'CONFIGURATION__CHANGE',
  'FEATURE_FLAG__BASIC',
  'OPERATIONAL__CRASH',
  'OPERATIONAL__SCHEDULED_MAINTENANCE_PERIOD',
  'OPERATIONAL__SERVER_REBOOT',
  'OPERATIONAL__OTHER',
  'BUSINESS_EVENT__CONVENTION',
  'BUSINESS_EVENT__MARKETING_CAMPAIGN',
  'BUSINESS_EVENT__OTHER',
] as const;

const changeInput = z.strictObject({
  entity_guid: z.string().min(8).max(512).describe('Entity the change applies to (guid).'),
  change_type: z.enum(CHANGE_TYPES).describe('Category and type of the change.'),
  version: text(128, 'Deployed version. Required for DEPLOYMENT__*.').optional(),
  commit: text(128, 'Commit id.').optional(),
  changelog: text(1000, 'Changelog URL or text.').optional(),
  deep_link: z
    .url({
      protocol: /^https$/,
      error: 'deep_link must be an https:// URL (https only; http: is not accepted).',
    })
    .max(500)
    .optional()
    .describe('https link to the system that made the change.'),
  feature_flag_id: text(128, 'Feature flag id. Required for FEATURE_FLAG__BASIC.').optional(),
  short_description: text(200, 'One-line summary.').optional(),
  description: multiline(2000, 'Longer description.').optional(),
  user: text(100, 'Who made the change.').optional(),
  group_id: text(100, 'Groups related changes.').optional(),
  confirm: confirmInput,
  dry_run: dryRunInput,
});

const changeOutput = z.object({
  ...writeOutput,
  entityGuid: z.string(),
  changeType: z.string(),
  changeTrackingId: z.string().nullable(),
  messages: z.array(z.string()),
  /** Dry run only: the real run will be refused from this client (P8-106). */
  warnings: z
    .array(z.string())
    .optional()
    .describe('Dry run only: set when the real run will be refused because this client cannot approve it.'),
  /** The change as it would be (dry run) or was sent; null when the call did not get that far. */
  plan: z
    .object({
      changeType: z.string(),
      version: z.string().optional(),
      commit: z.string().optional(),
      featureFlagId: z.string().optional(),
      shortDescription: z.string().optional(),
      user: z.string().optional(),
      groupId: z.string().optional(),
    })
    .nullable(),
});

const CHANGE_DESCRIPTION = `Record a change event (deployment, configuration change, feature flag, operational or business event) on one entity, so it shows in New Relic's change tracking next to the entity's charts.

Write tool, opt-in. ${SIDE_EFFECT_NOTICE} Needs confirm: true; dry_run: true previews. Each call adds a new event (not idempotent; cannot be deleted here). ${APPROVAL_NOTICE} To read past changes use list_change_events. To create a dashboard instead, use create_dashboard.`;

// ---------------------------------------------------------------------------------------------------------------------
// acknowledge_issue / close_issue
// ---------------------------------------------------------------------------------------------------------------------

const issueInput = z.strictObject({
  issue_id: z.string().regex(ISSUE_ID_RE).describe('Issue id from list_recent_issues.'),
  account: accountInput,
  confirm: confirmInput,
  dry_run: dryRunInput,
});

const issueOutput = z.object({
  /** Dry run only: the real run will be refused from this client (P8-106). */
  warnings: z
    .array(z.string())
    .optional()
    .describe('Dry run only: set when the real run will be refused because this client cannot approve it.'),
  ...writeOutput,
  issueId: z.string(),
  before: z.object({ state: z.string().nullable(), acknowledgedAt: z.string().nullable() }),
  after: z.object({ state: z.string().nullable(), acknowledged: z.boolean() }).nullable(),
  note: z.string().nullable(),
});

// New Relic's issue reads trail its issue mutations (verified live 2026-10-16, RESEARCH "aiIssues read lag"): a
// read straight after an acknowledge can still show it unacknowledged, and a lookup by id showed a stale `state`.
const ISSUE_READ_LAG_NOTE =
  'New Relic can take a few seconds to show this change: a read (or a dry run) right after it may still show the old state.';

const ACK_DESCRIPTION = `Acknowledge one alert issue: marks it as being handled by someone; it stays open and keeps its incidents.

Write tool, opt-in. ${SIDE_EFFECT_NOTICE} Needs confirm: true; dry_run: true previews. Repeating it changes nothing (an acknowledged or closed issue is left as is). ${APPROVAL_NOTICE} Find issues with list_recent_issues. For a permanent close, use close_issue.`;

const CLOSE_DESCRIPTION = `Close (resolve) one alert issue by hand: it stops notifying and moves to CLOSED; relic-bridge cannot reopen it, and New Relic opens a new issue if the condition still violates.

Destructive write tool, opt-in. ${SIDE_EFFECT_NOTICE} Needs confirm: true; dry_run: true previews. Closing a closed issue changes nothing. ${APPROVAL_NOTICE} Use acknowledge_issue to mark it as handled without closing.`;

/** Write tools (P7-09). Hosts register them only with the server flag on (`RB_WRITE_TOOLS=on`). */
export function createWriteTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = writeClient(deps);

  const createChangeEvent = defineTool({
    name: 'create_change_event',
    title: 'Record a change event (write)',
    description: CHANGE_DESCRIPTION,
    inputSchema: changeInput,
    outputSchema: changeOutput,
    kind: 'write',
    idempotent: false,
    openWorld: true,
    cost: 2,
    group: 'writes',
    phase: 7,
    handler: async (input, ctx) => {
      assertWriteGranted(ctx, 'create_change_event');
      assertConfirmed(input);
      const decoded = checkGuid(ctx, input.entity_guid);
      const [category, type] = input.change_type.split('__') as [string, string];
      if (category === 'DEPLOYMENT' && input.version === undefined) {
        throw new RbError(ErrorCode.InputInvalid, 'A deployment needs version; nothing was changed.');
      }
      if (category === 'FEATURE_FLAG' && input.feature_flag_id === undefined) {
        throw new RbError(
          ErrorCode.InputInvalid,
          'A feature flag change needs feature_flag_id; nothing was changed.',
        );
      }
      const deploymentOnly = [input.commit, input.changelog, input.deep_link, input.version];
      if (category !== 'DEPLOYMENT' && deploymentOnly.some((v) => v !== undefined)) {
        throw new RbError(
          ErrorCode.InputInvalid,
          'version, commit, changelog and deep_link are for DEPLOYMENT__* changes only; nothing was changed.',
        );
      }
      if (category !== 'FEATURE_FLAG' && input.feature_flag_id !== undefined) {
        throw new RbError(
          ErrorCode.InputInvalid,
          'feature_flag_id is for FEATURE_FLAG__BASIC only; nothing was changed.',
        );
      }
      rejectSecrets(input);

      // The entity must exist where its GUID says, in an allowed account (T3): NerdGraph must agree.
      const nr = client(ctx);
      const found = await nr.query(ENTITY_QUERY, { guid: input.entity_guid });
      const entity = requireField(found.data.actor.entity, found, ctx);
      const account = entity.accountId ?? decoded.accountId;
      if (!ctx.accounts.allowed.includes(account) || account !== decoded.accountId) throw outOfScope(account);
      const row = toRow(entity, { guid: input.entity_guid, accountId: account });

      const event: ChangeEventInputVariable = {
        categoryAndTypeData: {
          kind: { category, type },
          ...(category === 'DEPLOYMENT'
            ? {
                categoryFields: {
                  deployment: {
                    version: input.version as string,
                    ...(input.commit === undefined ? {} : { commit: input.commit }),
                    ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
                    ...(input.deep_link === undefined ? {} : { deepLink: input.deep_link }),
                  },
                },
              }
            : category === 'FEATURE_FLAG'
              ? { categoryFields: { featureFlag: { featureFlagId: input.feature_flag_id as string } } }
              : {}),
        },
        // The tag quotes and escapes the GUID; the finished filter travels as a variable (T4).
        entitySearch: { query: entityQuery`id = ${input.entity_guid}`.text },
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.short_description === undefined ? {} : { shortDescription: input.short_description }),
        ...(input.user === undefined ? {} : { user: input.user }),
        ...(input.group_id === undefined ? {} : { groupId: input.group_id }),
      };
      const planned = {
        changeType: input.change_type,
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.commit === undefined ? {} : { commit: input.commit }),
        ...(input.feature_flag_id === undefined ? {} : { featureFlagId: input.feature_flag_id }),
        ...(input.short_description === undefined ? {} : { shortDescription: input.short_description }),
        ...(input.user === undefined ? {} : { user: input.user }),
        ...(input.group_id === undefined ? {} : { groupId: input.group_id }),
      };
      const entityBlock = envelope(`entity: ${row.name}\nguid: ${row.guid}`, { source: 'New Relic entity' });
      const dryRun = input.dry_run === true;

      if (dryRun) {
        const record: WriteRecord = {
          action: 'change_event.create',
          accountId: account,
          target: { type: 'entity', id: input.entity_guid },
          dryRun: true,
          applied: false,
          before: null,
          after: planned,
        };
        const unreachable = approvalUnreachableWarning(ctx);
        return {
          text: `Dry run: would record a ${input.change_type} change on ${kind(row)} in account ${account}. Nothing was changed.${unreachable === undefined ? '' : `\nWarning: ${unreachable}`}\n${entityBlock}`,
          structured: {
            applied: false,
            dryRun: true,
            confirmation: 'dry_run' as const,
            accountId: account,
            entityGuid: input.entity_guid,
            changeType: input.change_type,
            changeTrackingId: null,
            messages: [],
            ...(unreachable === undefined ? {} : { warnings: [unreachable] }),
            plan: planned,
          },
          meta: writeMeta(record),
        };
      }

      const gate = await humanGate(
        ctx,
        'create_change_event',
        [
          'relic-bridge asks you to approve this change in New Relic (text in quotes comes from the request or from New Relic, not from relic-bridge):',
          `Record a ${input.change_type} change event on ${shown(row.name)} (guid ${shown(input.entity_guid, 512)}) in account ${account}.`,
          ...(
            [
              ['version', input.version],
              ['commit', input.commit],
              ['changelog', input.changelog],
              ['deep link', input.deep_link],
              ['feature flag id', input.feature_flag_id],
              ['short description', input.short_description],
              ['description', input.description],
              ['user', input.user],
              ['group id', input.group_id],
            ] as const
          )
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}: ${shown(v as string, 2000)}`),
          'It cannot be deleted from relic-bridge.',
        ].join('\n'),
        input,
      );
      if (gate.state !== 'go') {
        return gateStopped(gate, {
          record: {
            action: 'change_event.create',
            accountId: account,
            target: { type: 'entity', id: input.entity_guid },
            dryRun: false,
            applied: false,
            before: null,
            after: planned,
          },
        });
      }

      await recordWriteIntent(ctx, 'create_change_event', input, {
        action: 'change_event.create',
        accountId: account,
        target: { type: 'entity', id: input.entity_guid },
        dryRun: false,
        applied: false,
        before: null,
        after: planned,
        ...(gate.confirmation === undefined ? {} : { confirmation: gate.confirmation }),
      });
      const result = await nr.query(CREATE_CHANGE_EVENT_MUTATION, {
        event,
        rules: { validationFlags: ['FAIL_ON_FIELD_LENGTH'] },
      });
      const created = result.data.changeTrackingCreateEvent?.changeTrackingEvent;
      if (created === null || created === undefined) throw mutationFailed(result, 'record the change');
      const id =
        typeof created.changeTrackingId === 'string' ? cleanName(created.changeTrackingId, 128) : null;
      const messages = (result.data.changeTrackingCreateEvent?.messages ?? [])
        .filter((m): m is string => typeof m === 'string')
        .slice(0, 5)
        .map((m) => cleanName(m, 300));
      const record: WriteRecord = {
        action: 'change_event.create',
        accountId: account,
        target: { type: 'entity', id: input.entity_guid },
        dryRun: false,
        applied: true,
        before: null,
        after: { ...planned, changeTrackingId: id },
        ...(gate.confirmation === undefined ? {} : { confirmation: gate.confirmation }),
      };
      const lines = [
        `Recorded a ${input.change_type} change on ${kind(row)} in account ${account}${id === null ? '' : ` (id ${label(id) ?? 'see structured output'})`}.`,
        entityBlock,
      ];
      if (messages.length > 0) {
        lines.push(envelope(messages.join('\n'), { source: 'New Relic messages' }));
      }
      return {
        text: lines.join('\n'),
        structured: {
          applied: true,
          dryRun: false,
          confirmation: confirmationOf(false, gate.confirmation),
          accountId: account,
          entityGuid: input.entity_guid,
          changeType: input.change_type,
          changeTrackingId: id,
          messages,
          plan: planned,
        },
        meta: writeMeta(record),
      };
    },
  });

  const issueTool = (spec: {
    readonly name: 'acknowledge_issue' | 'close_issue';
    readonly title: string;
    readonly description: string;
    readonly kind: 'write' | 'destructive';
    readonly action: 'issue.acknowledge' | 'issue.close';
    readonly verb: string;
  }) =>
    defineTool({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: issueInput,
      outputSchema: issueOutput,
      kind: spec.kind,
      idempotent: true,
      openWorld: true,
      cost: 2,
      group: 'writes',
      phase: 7,
      handler: async (input, ctx) => {
        assertWriteGranted(ctx, spec.name);
        assertConfirmed(input);
        const account = singleAccount(ctx, input.account);
        const nr = client(ctx);
        const now = ctx.clock.now();
        // The issue must be in this account and touch no account or entity outside the connection (T3).
        const recordNotes: string[] = [];
        const issue: IssueRow = await lookupIssue(
          nr,
          ctx,
          account,
          input.issue_id,
          {
            sinceMs: now - ctx.limits.maxWindowDays * DAY_MS,
            untilMs: now,
          },
          { lookback: false, notes: recordNotes },
        );
        const recordsNote = recordNotes.join(' ');
        const joined = (base: string | null): string | null =>
          [base, recordsNote].filter((x) => x).join(' ') || null;
        const before = { state: issue.state, acknowledgedAt: issue.acknowledgedAt };
        const closing = spec.name === 'close_issue';
        const noop =
          issue.state === 'CLOSED'
            ? 'The issue is already closed: nothing to do.'
            : !closing && issue.acknowledgedAt !== null
              ? 'The issue is already acknowledged: nothing to do.'
              : null;
        const dryRun = input.dry_run === true;
        const titleBlock = envelope(`issue: ${issue.title}`, { source: 'New Relic issue' });
        const record = (applied: boolean, after: Record<string, unknown> | null): WriteRecord => ({
          action: spec.action,
          accountId: account,
          target: { type: 'issue', id: input.issue_id },
          dryRun,
          applied,
          before,
          after,
        });
        const plannedAfter = closing
          ? { state: 'CLOSED', acknowledged: issue.acknowledgedAt !== null }
          : { state: issue.state, acknowledged: true };
        const shaped = (
          applied: boolean,
          after: typeof plannedAfter | null,
          note: string | null,
          confirmation: Confirmation | undefined = undefined,
        ) => ({
          applied,
          dryRun,
          confirmation: confirmationOf(dryRun, confirmation),
          accountId: account,
          issueId: input.issue_id,
          before,
          after,
          note,
        });

        if (noop !== null) {
          return {
            text: `${noop} (account ${account}, state ${issue.state ?? 'unknown'}).${recordsNote ? ` ${recordsNote}` : ''}\n${titleBlock}`,
            structured: shaped(false, null, joined(noop)),
            meta: writeMeta(record(false, null)),
          };
        }
        if (dryRun) {
          const unreachable = approvalUnreachableWarning(ctx);
          return {
            text: `Dry run: would ${spec.verb} issue ${input.issue_id} in account ${account} (state ${issue.state ?? 'unknown'}). Nothing was changed.${recordsNote ? ` ${recordsNote}` : ''}${unreachable === undefined ? '' : `
Warning: ${unreachable}`}
${titleBlock}`,
            structured: {
              ...shaped(false, plannedAfter, joined(null)),
              ...(unreachable === undefined ? {} : { warnings: [unreachable] }),
            },
            meta: writeMeta(record(false, plannedAfter)),
          };
        }

        const gate = await humanGate(
          ctx,
          spec.name,
          [
            'relic-bridge asks you to approve this change in New Relic (text in quotes comes from New Relic, not from relic-bridge):',
            `${closing ? 'Close (resolve) by hand' : 'Acknowledge'} alert issue ${shown(input.issue_id, 100)} in account ${account}.`,
            `Title: ${shown(issue.title, 200)}`,
            `Now: ${issue.state ?? 'unknown'}${issue.acknowledgedAt === null ? ', not acknowledged' : ', acknowledged'}.`,
            closing
              ? 'It stops notifying and cannot be reopened from relic-bridge.'
              : 'It stays open; it is marked as being handled.',
          ].join('\n'),
          { tool: spec.name, account, issueId: input.issue_id },
        );
        if (gate.state !== 'go') {
          return gateStopped(gate, {
            record: record(false, plannedAfter),
          });
        }

        await recordWriteIntent(ctx, spec.name, input, {
          ...record(false, plannedAfter),
          ...(gate.confirmation === undefined ? {} : { confirmation: gate.confirmation }),
        });
        const vars = { accountId: account, issueId: input.issue_id };
        const result = closing
          ? await nr.query(RESOLVE_ISSUE_MUTATION, vars)
          : await nr.query(ACK_ISSUE_MUTATION, vars);
        const data = (
          closing
            ? (result.data as { aiIssuesResolveIssue?: IssueActionData | null }).aiIssuesResolveIssue
            : (result.data as { aiIssuesAckIssue?: IssueActionData | null }).aiIssuesAckIssue
        ) as IssueActionData | null | undefined;
        if (data === null || data === undefined) throw mutationFailed(result, spec.verb);
        if (typeof data.error === 'string' && data.error !== '') {
          throw new RbError(
            ErrorCode.NerdGraphError,
            `New Relic did not ${spec.verb} the issue (see details).`,
            {
              hint: 'Check the issue with list_recent_issues before trying again.',
              details: { message: cleanName(data.error, 300) },
            },
          );
        }
        if (data.result?.issueId !== input.issue_id || data.result?.accountId !== account) {
          throw new RbError(
            ErrorCode.NerdGraphError,
            `New Relic's answer did not confirm the ${spec.verb}.`,
            {
              hint: 'Check the issue with list_recent_issues before trying again.',
            },
          );
        }
        return {
          text: `${closing ? 'Closed' : 'Acknowledged'} issue ${input.issue_id} in account ${account} (was ${issue.state ?? 'unknown'}). ${joined(ISSUE_READ_LAG_NOTE)}\n${titleBlock}`,
          structured: shaped(true, plannedAfter, joined(ISSUE_READ_LAG_NOTE), gate.confirmation),
          meta: writeMeta({
            ...record(true, plannedAfter),
            ...(gate.confirmation === undefined ? {} : { confirmation: gate.confirmation }),
          }),
        };
      },
    });

  return [
    createChangeEvent,
    issueTool({
      name: 'acknowledge_issue',
      title: 'Acknowledge an alert issue (write)',
      description: ACK_DESCRIPTION,
      kind: 'write',
      action: 'issue.acknowledge',
      verb: 'acknowledge',
    }),
    issueTool({
      name: 'close_issue',
      title: 'Close an alert issue (destructive write)',
      description: CLOSE_DESCRIPTION,
      kind: 'destructive',
      action: 'issue.close',
      verb: 'close',
    }),
    createDashboardWriteTool(client),
  ];
}
