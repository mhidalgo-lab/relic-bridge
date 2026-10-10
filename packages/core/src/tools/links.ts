// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ErrorCode, RbError } from '../errors.ts';
import { entityLink, issueLink, nrqlLink } from '../links.ts';
import { resolveAccounts } from '../nrql/engine.ts';
import { assertRawNrqlAllowed, enforceQueryLimits } from '../nrql/limits.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { checkGuid } from './entity-common.ts';
import { MAX_NRQL_CHARS } from './query.ts';
import { accountInput } from './shared.ts';

const input = z.strictObject({
  entity_guid: z.string().min(1).max(200).optional().describe('Entity or dashboard guid.'),
  nrql: z.string().min(1).max(MAX_NRQL_CHARS).optional().describe('NRQL to open.'),
  issue_id: z.string().min(1).max(64).optional().describe('Issue id.'),
  account: accountInput,
});

const output = z.object({
  url: z.string(),
  kind: z.enum(['entity', 'nrql', 'issue']),
  verified: z.boolean(),
});

const DESCRIPTION = `Build a link that opens an entity, dashboard, NRQL query (query builder) or issue in the New Relic UI, for the connection's region. Offline: nothing is sent to New Relic.

Give exactly one of entity_guid, nrql or issue_id. Links are private (the reader logs in). Query and issue formats are unverified.`;

/** `get_ui_link`: pure, no subrequest. Links come only from validated ids and the connection's region. */
export function createLinkTools(): ToolDefinition[] {
  const tool = defineTool({
    name: 'get_ui_link',
    title: 'Get New Relic UI link',
    description: DESCRIPTION,
    inputSchema: input,
    outputSchema: output,
    kind: 'read',
    openWorld: false,
    cost: 0,
    group: 'links',
    phase: 7,
    handler: async (args, ctx) => {
      const given = [args.entity_guid, args.nrql, args.issue_id].filter((v) => v !== undefined).length;
      if (given !== 1) {
        throw new RbError(ErrorCode.InputInvalid, 'Give exactly one of entity_guid, nrql or issue_id.');
      }
      const region = ctx.credential.region;
      if (args.entity_guid !== undefined) {
        checkGuid(ctx, args.entity_guid);
        const url = entityLink(region, args.entity_guid);
        return {
          text: `Open in New Relic: ${url}`,
          structured: { url, kind: 'entity' as const, verified: true },
        };
      }
      const [accountId] = resolveAccounts(ctx, args.account === undefined ? undefined : [args.account]);
      if (accountId === undefined)
        throw new RbError(ErrorCode.AuthForbidden, 'This connection has no accounts.');
      if (args.nrql !== undefined) {
        assertRawNrqlAllowed(ctx.limits);
        const checked = enforceQueryLimits(args.nrql, ctx.limits, ctx.clock.now());
        const url = nrqlLink(region, accountId, checked.nrql);
        return {
          text: `Open the query in New Relic (account ${accountId}): ${url}`,
          structured: { url, kind: 'nrql' as const, verified: false },
        };
      }
      const url = issueLink(region, accountId, args.issue_id as string);
      return {
        text: `Open the issue in New Relic (account ${accountId}): ${url}`,
        structured: { url, kind: 'issue' as const, verified: false },
      };
    },
  });
  return [tool as ToolDefinition];
}
