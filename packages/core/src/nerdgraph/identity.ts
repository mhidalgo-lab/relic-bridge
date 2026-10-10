// SPDX-License-Identifier: Apache-2.0
import type { NerdGraphClient } from './client.ts';
import { defineDocument, type GraphQLDocument } from './document.ts';

export interface Identity {
  readonly user: { readonly id: number; readonly email: string; readonly name: string };
  readonly accounts: readonly { readonly id: number; readonly name: string }[];
}

/**
 * `Actor.accounts(scope: RegionScope)`: the account listing is region-scoped. Always passed explicitly (as a variable)
 * so we never depend on the default (P0-09). `IN_REGION` = the accounts in the key's own data center, which are the
 * only ones the configured endpoint can query.
 */
export const ACCOUNT_SCOPE = 'IN_REGION';
export interface IdentityVariables extends Record<string, unknown> {
  scope: string;
}

/** Who the key belongs to and which accounts it can read (P0-09: ~260–360 ms). */
export const IDENTITY_QUERY: GraphQLDocument<{ actor: Identity }, IdentityVariables> = defineDocument(
  'query RbIdentity($scope: RegionScope!) { actor { user { id email name } accounts(scope: $scope) { id name } } }',
);

/** Accounts only (no user data), for tools that don't need the email. */
export const ACCOUNTS_QUERY: GraphQLDocument<{ actor: Pick<Identity, 'accounts'> }, IdentityVariables> =
  defineDocument('query RbAccounts($scope: RegionScope!) { actor { accounts(scope: $scope) { id name } } }');

/**
 * Validate a credential: format first (no request for non-NRAK keys), then one NerdGraph call. Errors are the client's
 * mapped ones: RB_AUTH_INVALID_KEY, RB_AUTH_WRONG_REGION, RB_NERDGRAPH_*.
 */
export async function validateKey(client: NerdGraphClient): Promise<Identity> {
  const { data } = await client.query(IDENTITY_QUERY, { scope: ACCOUNT_SCOPE });
  return { user: data.actor.user, accounts: data.actor.accounts ?? [] };
}

/** Every account the key can read in its region. Callers intersect with the connection's allowed accounts (T3). */
export async function listReachableAccounts(
  client: NerdGraphClient,
): Promise<readonly { readonly id: number; readonly name: string }[]> {
  const { data } = await client.query(ACCOUNTS_QUERY, { scope: ACCOUNT_SCOPE });
  return data.actor.accounts ?? [];
}
