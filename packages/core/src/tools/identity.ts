// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { AccountScope, ToolContext } from '../context.ts';
import { nerdGraphFor } from '../nerdgraph/client.ts';
import { listReachableAccounts, validateKey } from '../nerdgraph/identity.ts';
import { envelope } from '../output/envelope.ts';
import { shapeRows, truncateText } from '../output/format.ts';
import { redact } from '../redact.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import type { ToolDeps } from './query.ts';

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
  defaultAccount: z.number().int(),
  defaultAccountReachable: z.boolean(),
  accountCount: z.number().int(),
  allowedTools: z.array(z.string()).nullable(),
  limits: z.object({
    maxLimit: z.number().int(),
    maxWindowDays: z.number(),
    rawNrql: z.boolean(),
  }),
});

const listAccountsInput = z.strictObject({});

const listAccountsOutput = z.object({
  accounts: z.array(accountSchema),
  defaultAccount: z.number().int(),
  defaultAccountReachable: z.boolean(),
  /** Allowed accounts the key cannot read (ids only). */
  unreachableAllowed: z.array(z.number().int()),
  truncated: z.boolean(),
});

const WHOAMI_DESCRIPTION = `Show who this connection is: the New Relic user behind the key, the data-center region, the project, the default account, how many accounts are usable and which tools are granted.

Use it first when something doesn't work (wrong region, "account not found", missing tools) or to learn the default account. It never returns key material. The user name and email come from New Relic and are inside an untrusted-data block.`;

const LIST_ACCOUNTS_DESCRIPTION = `List the New Relic accounts you can query through this connection, with the default marked.

An account is listed only when the key can read it and the connection allows it. Pass an id from this list as "accounts" to run_nrql; tools that take no account use the default. Account names come from New Relic and are inside an untrusted-data block.`;

/** Single line, bounded, secret-shaped values redacted. For New Relic-provided free text (names, tags). */
export function cleanName(value: string, max: number = MAX_NAME_CHARS): string {
  return truncateText(redact(value).replace(/\s+/g, ' ').trim(), max);
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
  const client = (ctx: ToolContext) =>
    nerdGraphFor(ctx, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });

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
      const structured = {
        user,
        region: ctx.credential.region,
        project,
        defaultAccount: ctx.accounts.default,
        defaultAccountReachable: defaultReachable,
        accountCount: accounts.length,
        allowedTools,
        limits: {
          maxLimit: ctx.limits.maxLimit,
          maxWindowDays: ctx.limits.maxWindowDays,
          rawNrql: ctx.limits.rawNrql,
        },
      };
      const lines = [
        `Connected to New Relic in the ${structured.region} region. Project: ${project ?? 'unknown'}.`,
        `Default account: ${structured.defaultAccount}${defaultReachable ? '' : ' (WARNING: the key cannot read it)'}. ` +
          `Usable accounts: ${accounts.length} (see list_accounts).`,
        `Query limits: up to ${ctx.limits.maxLimit} rows, ${ctx.limits.maxWindowDays} day window, ` +
          `raw NRQL ${ctx.limits.rawNrql ? 'allowed' : 'disabled'}.`,
        `Tools: ${allowedTools ? allowedTools.join(', ') : 'unknown'}.`,
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
    handler: async (_input, ctx) => {
      const reachable = await listReachableAccounts(client(ctx));
      const { accounts, unreachableAllowed, defaultReachable } = intersectAccounts(reachable, ctx.accounts);
      const shown = accounts.slice(0, MAX_ACCOUNT_ROWS);
      const truncated = shown.length < accounts.length;
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
      if (truncated) lines.push(`Showing the first ${MAX_ACCOUNT_ROWS} accounts.`);
      lines.push(shaped.text);
      return {
        text: lines.join('\n'),
        structured: {
          accounts: shown,
          defaultAccount: ctx.accounts.default,
          defaultAccountReachable: defaultReachable,
          unreachableAllowed,
          truncated,
        },
      };
    },
  });

  return [whoami as ToolDefinition, listAccounts as ToolDefinition];
}
