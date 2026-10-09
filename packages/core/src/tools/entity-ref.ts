// SPDX-License-Identifier: Apache-2.0
// "An entity" as a tool input (P6-17): a `guid`, or a `name` resolved by the shared resolver (P6-14). Exactly one.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { kind } from './entity-common.ts';
import { type EntityResolver, MAX_RESOLVE_CANDIDATES } from './entity-resolver.ts';
import { cleanName } from './identity.ts';
import { accountIdSchema } from './shared.ts';

/** Worst case NerdGraph requests of one name resolution: a LIKE search plus a three-page catalogue scan. */
export const RESOLVE_COST = 4;

/** Input fields for a tool that takes an entity. Add `.refine(exactlyOneEntityRef…)` through `refineEntityRef`. */
export function entityRefFields(guidDescription: string): {
  guid: z.ZodOptional<z.ZodString>;
  name: z.ZodOptional<z.ZodString>;
  account: z.ZodOptional<z.ZodNumber>;
} {
  return {
    guid: z.string().min(8).max(512).optional().describe(guidDescription),
    name: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Entity name instead of guid (loose is fine: "shippingservice" finds "Shipping-Service"). ' +
          'If several entities match, nothing runs and the candidates are returned: pick one guid.',
      ),
    account: accountIdSchema
      .optional()
      .describe('With name only: look in this account (must be one of list_accounts). Default: all of them.'),
  };
}

/** Exactly one of guid or name; `account` only with a name. */
export function refineEntityRef<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  return schema.superRefine((v, c) => {
    const { guid, name, account } = v as { guid?: string; name?: string; account?: number };
    if ((guid === undefined) === (name === undefined)) {
      c.addIssue({ code: 'custom', message: 'Give exactly one of "guid" or "name".' });
    } else if (account !== undefined && guid !== undefined) {
      c.addIssue({
        code: 'custom',
        message: '"account" only applies together with "name".',
        path: ['account'],
      });
    }
  });
}

export interface EntityRefInput {
  readonly guid?: string | undefined;
  readonly name?: string | undefined;
  readonly account?: number | undefined;
}

export interface ResolvedRef {
  readonly guid: string;
  /** Set when the guid came from a name: a line for the tool's text output. */
  readonly note: string | null;
}

/**
 * The guid to use. A given guid passes through untouched (the tool still runs `checkGuid`). A name goes through the
 * resolver, which only ever searches the connection's effective accounts. Ambiguous or unknown names throw an
 * `RB_INPUT_INVALID` error (with the candidates) and the tool does nothing else.
 */
export async function resolveEntityRef(
  resolver: EntityResolver,
  ctx: ToolContext,
  input: EntityRefInput,
): Promise<ResolvedRef> {
  if (input.guid !== undefined) return { guid: input.guid, note: null };
  if (input.name === undefined)
    throw new RbError(ErrorCode.InputInvalid, 'Give exactly one of "guid" or "name".');
  const r = await resolver.resolve(ctx, {
    query: input.name,
    ...(input.account === undefined ? {} : { account: input.account }),
  });
  if (r.status === 'resolved' && r.entity) {
    const shown = cleanName(r.entity.name || input.name, 120);
    return {
      guid: r.entity.guid,
      note: `Resolved name "${cleanName(input.name, 120)}" to "${shown}" (${r.matchedBy?.replace('_', ' ')} match, guid ${r.entity.guid}).`,
    };
  }
  if (r.status === 'ambiguous') {
    throw new RbError(
      ErrorCode.InputInvalid,
      `The name matches ${r.totalCandidates} entities (${r.matchedBy?.replace('_', ' ')} match); none was chosen.`,
      {
        hint: 'Call again with "guid" set to one of the candidates, or narrow the name or "account".',
        details: {
          candidates: r.candidates.slice(0, MAX_RESOLVE_CANDIDATES).map((c) => ({
            guid: c.guid,
            name: cleanName(c.name, 120),
            account: c.accountId,
            kind: kind(c),
          })),
          totalCandidates: r.totalCandidates,
        },
      },
    );
  }
  throw new RbError(ErrorCode.InputInvalid, 'No entity with this name in the accounts of this connection.', {
    hint: r.incomplete
      ? 'The search hit its size cap: try the exact name or pass "account". Or use search_entities.'
      : 'Check the name with search_entities or resolve_entity.',
  });
}
