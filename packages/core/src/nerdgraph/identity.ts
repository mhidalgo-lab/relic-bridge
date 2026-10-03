// SPDX-License-Identifier: Apache-2.0
import type { NerdGraphClient } from './client.ts';
import { defineDocument, type GraphQLDocument } from './document.ts';

export interface Identity {
  readonly user: { readonly id: number; readonly email: string; readonly name: string };
  readonly accounts: readonly { readonly id: number; readonly name: string }[];
}

/** Who the key belongs to and which accounts it can read (P0-09: ~260–360 ms). */
export const IDENTITY_QUERY: GraphQLDocument<{ actor: Identity }, Record<string, never>> = defineDocument(
  'query RbIdentity { actor { user { id email name } accounts { id name } } }',
);

/**
 * Validate a credential: format first (no request for non-NRAK keys), then one NerdGraph call. Errors are the client's
 * mapped ones: RB_AUTH_INVALID_KEY, RB_AUTH_WRONG_REGION, RB_NERDGRAPH_*.
 */
export async function validateKey(client: NerdGraphClient): Promise<Identity> {
  const { data } = await client.query(IDENTITY_QUERY, {});
  return { user: data.actor.user, accounts: data.actor.accounts ?? [] };
}
