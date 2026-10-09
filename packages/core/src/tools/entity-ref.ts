// SPDX-License-Identifier: Apache-2.0
// "An entity" as a tool input (P6-17): a `guid`, or a `name` resolved by the shared resolver (P6-14). Exactly one.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import type { ToolDefinition } from '../tool.ts';
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
  readonly domain?: string | undefined;
  readonly type?: string | undefined;
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
    ...(input.domain === undefined ? {} : { domain: input.domain }),
    ...(input.type === undefined ? {} : { type: input.type }),
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

/** How `withEntityName` adapts one tool. */
export interface EntityNameOptions {
  /** The tool's existing guid input, e.g. `guid` or `entity_guid`. */
  readonly field: string;
  /** True when the tool cannot run without it (then exactly one of field or name). */
  readonly required: boolean;
  /** Another input that excludes a name (e.g. `issue_id`): the name is refused before any request is made. */
  readonly conflictsWith?: string;
  /** Another input a name needs (e.g. `error_group_id`): refused before any request is made without it. */
  readonly requires?: string;
  /** Narrow the name search (e.g. APM tools only take APM applications). */
  readonly domain?: string;
  readonly type?: string;
}

/**
 * Give an entity tool the P6-17 `guid` XOR `name` input without touching its code (P6-18): one shared behaviour for
 * every tool. The name is resolved once, up front, by the shared resolver (which only searches the connection's
 * accounts); the original handler then runs with the guid exactly as if the caller had passed it, so its own scope
 * checks (`checkGuid`, T3) still apply. Ambiguous or unknown names throw before the handler runs. The cost includes
 * `RESOLVE_COST`, and composites plan from the budget left after the resolution.
 */
export function withEntityName(
  def: ToolDefinition,
  resolver: EntityResolver,
  options: EntityNameOptions,
): ToolDefinition {
  const { field, required } = options;
  const shape = { ...def.inputSchema.shape } as Record<string, z.ZodType>;
  const original = shape[field];
  if (original === undefined || 'name' in shape)
    throw new Error(`withEntityName: ${def.name} has no "${field}" input or already has "name".`);
  const hadAccount = 'account' in shape;
  const extra = entityRefFields('');
  const described = original.description ? `${original.description} ` : '';
  shape[field] = (required ? original.optional() : original).describe(
    required ? `${described}Give this or name.` : `${described}Or give name instead.`,
  );
  shape['name'] = extra.name;
  if (!hadAccount) shape['account'] = extra.account;
  const inputSchema = z.strictObject(shape).superRefine((v, c) => {
    const o = v as Record<string, unknown>;
    const hasGuid = o[field] !== undefined;
    const hasName = o['name'] !== undefined;
    if (hasGuid && hasName) {
      c.addIssue({ code: 'custom', message: `Give "${field}" or "name", not both.` });
    } else if (required && !hasGuid && !hasName) {
      c.addIssue({ code: 'custom', message: `Give exactly one of "${field}" or "name".` });
    } else if (!hadAccount && o['account'] !== undefined && !hasName) {
      c.addIssue({
        code: 'custom',
        message: '"account" only applies together with "name".',
        path: ['account'],
      });
    } else if (hasName && options.conflictsWith && o[options.conflictsWith] !== undefined) {
      c.addIssue({ code: 'custom', message: `Give "name" or "${options.conflictsWith}", not both.` });
    } else if (hasName && options.requires && o[options.requires] === undefined) {
      c.addIssue({ code: 'custom', message: `"name" only applies together with "${options.requires}".` });
    }
  }) as unknown as ToolDefinition['inputSchema'];
  return {
    ...def,
    inputSchema,
    cost: def.cost + RESOLVE_COST,
    handler: async (raw, ctx) => {
      const { name, ...rest } = raw as Record<string, unknown>;
      if (!hadAccount) delete rest['account'];
      if (name === undefined) return def.handler(rest, ctx);
      const ref = await resolveEntityRef(resolver, ctx, {
        name: name as string,
        account: raw['account'] as number | undefined,
        ...(options.domain === undefined ? {} : { domain: options.domain }),
        ...(options.type === undefined ? {} : { type: options.type }),
      });
      const out = await def.handler({ ...rest, [field]: ref.guid }, ctx);
      return ref.note ? { ...out, text: `${ref.note}\n${out.text}` } : out;
    },
  };
}
