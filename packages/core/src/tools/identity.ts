// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { AccountScope } from '../context.ts';
import { listReachableAccounts, validateKey } from '../nerdgraph/identity.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows, truncateText } from '../output/format.ts';
import { redact } from '../redact.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { bindingOf, listLimit, pageList } from './paging.ts';
import { cursorInput, type ToolDeps, toolClient, UNTRUSTED } from './shared.ts';

/** Account and user names are free text set in New Relic: bounded and single-line before they reach an agent (T6). */
const MAX_NAME_CHARS = 200;
const MAX_ACCOUNT_ROWS = 200;

const accountSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  default: z.boolean(),
});

const whoamiInput = z.strictObject({
  mask_email: z
    .boolean()
    .optional()
    .describe('Hide most of the email address (m***@example.com). Default false.'),
});

const whoamiOutput = z.object({
  user: z.object({ id: z.number().int(), name: z.string(), email: z.string() }),
  region: z.enum(['US', 'EU', 'JP']),
  project: z.string().nullable(),
  defaultAccountId: z.number().int(),
  defaultAccountReachable: z.boolean(),
  accountCount: z.number().int(),
  allowedTools: z.array(z.string()).nullable(),
  /** Granted tools withheld because the deployment's per-request NerdGraph budget cannot pay for them. */
  unavailableTools: z.array(z.object({ name: z.string(), reason: z.string() })),
  limits: z.object({
    /** Most New Relic calls ONE tool call may make (ADR-0010). Not a running total: nothing carries over between calls. */
    perCallBudget: z.number().int(),
    /** Deprecated alias of perCallBudget (same value); removed in the minor after next. Use perCallBudget. */
    callBudget: z
      .number()
      .int()
      .describe(
        'Deprecated: same value as perCallBudget, removed in the minor after next. Use perCallBudget.',
      ),
    maxResponseBytes: z.number().int(),
    maxLimit: z.number().int(),
    maxWindowDays: z.number(),
    rawNrql: z.boolean(),
  }),
});

const DEFAULT_ACCOUNTS = 100;
const listAccountsInput = z.strictObject({
  limit: listLimit('accounts', DEFAULT_ACCOUNTS, MAX_ACCOUNT_ROWS),
  cursor: cursorInput,
});

const listAccountsOutput = z.object({
  accounts: z.array(accountSchema),
  defaultAccountId: z.number().int(),
  defaultAccountReachable: z.boolean(),
  /** Allowed accounts the key cannot read (ids only). */
  unreachableAccountIds: z.array(z.number().int()),
  /** More accounts exist: pass this as cursor to read them. */
  nextCursor: z.string().nullable(),
});

const WHOAMI_DESCRIPTION = `Show this connection's identity: the New Relic user, region, project, default account, how many accounts are usable and which tools are granted. limits.perCallBudget is the most upstream requests one tool call may make. Never returns key material.

Use it first when something fails (wrong region, "account not found", a missing tool). For the accounts themselves use list_accounts. ${UNTRUSTED}`;

const LIST_ACCOUNTS_DESCRIPTION = `List the New Relic accounts this connection can query (id and name), with the default marked.

Pass an id as "account" (or "accounts" in run_nrql); tools without one use the default account. For the user, region and granted tools use whoami. ${UNTRUSTED}`;

/** Single line, bounded, secret-shaped values redacted. For New Relic-provided free text (names, tags). */
export function cleanName(value: string, max: number = MAX_NAME_CHARS): string {
  return truncateText(redact(value).replace(/\s+/g, ' ').trim(), max);
}

/**
 * A note for a failed section or sub-query. New Relic error messages are free text a user in that account can shape, and
 * notes sit outside the untrusted-data envelope, so only the error code is shown; the message goes to the log.
 */
export function errorNote(e: { readonly code: string }): string {
  return `The request failed (${e.code}); run the underlying tool directly for details.`;
}

/** `m***@example.com`. Anything that is not a plain address is fully hidden. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export interface ScopedAccount {
  readonly id: number;
  readonly name: string;
  readonly default: boolean;
}

/**
 * Accounts the key can read **and** the connection allows (THREAT_MODEL T3). The key's list only decides names and
 * reachability; the allowed list decides what may be shown. Allowed accounts the key can't read are returned apart.
 */
export function intersectAccounts(
  reachable: readonly { readonly id: number; readonly name: string }[],
  scope: AccountScope,
): { accounts: ScopedAccount[]; unreachableAllowed: number[]; defaultReachable: boolean } {
  const allowed = new Set(scope.allowed);
  const seen = new Set<number>();
  const accounts: ScopedAccount[] = [];
  for (const a of reachable) {
    if (!allowed.has(a.id) || seen.has(a.id)) continue;
    seen.add(a.id);
    accounts.push({ id: a.id, name: cleanName(a.name), default: a.id === scope.default });
  }
  const unreachableAllowed = [...allowed].filter((id) => !seen.has(id));
  return { accounts, unreachableAllowed, defaultReachable: seen.has(scope.default) };
}

/** `whoami` and `list_accounts`. */
export function createIdentityTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const whoami = defineTool({
    name: 'whoami',
    title: 'Who am I',
    description: WHOAMI_DESCRIPTION,
    inputSchema: whoamiInput,
    outputSchema: whoamiOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'identity',
    phase: 1,
    handler: async (input, ctx) => {
      const identity = await validateKey(client(ctx));
      const { accounts, defaultReachable } = intersectAccounts(identity.accounts, ctx.accounts);
      const email = cleanName(identity.user.email);
      const user = {
        id: identity.user.id,
        name: cleanName(identity.user.name),
        email: input.mask_email ? maskEmail(email) : email,
      };
      const project = ctx.connection?.project ?? null;
      const allowedTools = ctx.connection?.allowedTools ? [...ctx.connection.allowedTools] : null;
      const unavailable = ctx.connection?.unavailableTools ?? [];
      const structured = {
        user,
        region: ctx.credential.region,
        project,
        defaultAccountId: ctx.accounts.default,
        defaultAccountReachable: defaultReachable,
        accountCount: accounts.length,
        allowedTools,
        unavailableTools: unavailable.map((u) => ({ name: u.name, reason: u.reason })),
        limits: {
          perCallBudget: ctx.budget.limit,
          callBudget: ctx.budget.limit,
          maxResponseBytes: ctx.limits.maxResponseBytes,
          maxLimit: ctx.limits.maxLimit,
          maxWindowDays: ctx.limits.maxWindowDays,
          rawNrql: ctx.limits.rawNrql,
        },
      };
      const lines = [
        `Connected to New Relic in the ${structured.region} region. Project: ${project ?? 'unknown'}.`,
        `Default account: ${structured.defaultAccountId}${defaultReachable ? '' : ' (WARNING: the key cannot read it)'}. ` +
          `Usable accounts: ${accounts.length} (see list_accounts).`,
        `Query limits: up to ${ctx.limits.maxLimit} rows, ${ctx.limits.maxWindowDays} day window, ` +
          `raw NRQL ${ctx.limits.rawNrql ? 'allowed' : 'disabled'}.`,
        `Tools: ${allowedTools ? allowedTools.join(', ') : 'unknown'}.`,
        ...(unavailable.length > 0
          ? [`Not offered here: ${unavailable.map((u) => `${u.name} (${u.reason})`).join('; ')}.`]
          : []),
        `Per-call budget: at most ${ctx.budget.limit} New Relic calls inside ONE tool call (not a running total; it starts fresh every call). ` +
          `Use across calls: rate limits and the grant's daily/monthly quota (admin panel, Usage). Responses up to ${ctx.limits.maxResponseBytes} bytes.`,
        envelope(`user id: ${user.id}\nname: ${user.name}\nemail: ${user.email}`, {
          source: 'New Relic user',
        }),
      ];
      return { text: lines.join('\n'), structured };
    },
  });

  const listAccounts = defineTool({
    name: 'list_accounts',
    title: 'List accounts',
    description: LIST_ACCOUNTS_DESCRIPTION,
    inputSchema: listAccountsInput,
    outputSchema: listAccountsOutput,
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'identity',
    phase: 1,
    handler: async (input, ctx) => {
      const reachable = await listReachableAccounts(client(ctx));
      const { accounts, unreachableAllowed, defaultReachable } = intersectAccounts(reachable, ctx.accounts);
      const { items: shown, nextCursor } = pageList(
        accounts,
        await bindingOf('list_accounts', ctx.accounts.default),
        input.cursor,
        input.limit ?? DEFAULT_ACCOUNTS,
      );
      const shaped = shapeRows(
        shown.map((a) => ({ id: a.id, name: a.name, default: a.default ? 'yes' : '' })),
        { format: 'table', source: 'New Relic accounts' },
      );
      const lines = [
        `${accounts.length} usable account${accounts.length === 1 ? '' : 's'}; default account: ${ctx.accounts.default}.`,
      ];
      if (!defaultReachable) {
        lines.push(`Note: the default account ${ctx.accounts.default} is not readable with this key.`);
      }
      if (unreachableAllowed.length > 0) {
        lines.push(
          `Note: ${unreachableAllowed.length} allowed account(s) are not readable with this key ` +
            `(ids: ${unreachableAllowed.slice(0, 20).join(', ')}). Check the key's access and region.`,
        );
      }
      if (nextCursor) lines.push(`Showing ${shown.length} accounts: pass nextCursor as cursor for the rest.`);
      lines.push(shaped.text);
      if (nextCursor) lines.push(`nextCursor: ${nextCursor}`);
      return {
        text: lines.join('\n'),
        structured: {
          accounts: shown,
          defaultAccountId: ctx.accounts.default,
          defaultAccountReachable: defaultReachable,
          unreachableAccountIds: unreachableAllowed,
          nextCursor,
        },
      };
    },
  });

  return [whoami as ToolDefinition, listAccounts as ToolDefinition];
}
