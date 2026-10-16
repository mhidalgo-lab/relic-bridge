// SPDX-License-Identifier: Apache-2.0
// Helpers shared by the entity tools and the entity resolver (kept apart so neither imports the other).
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { graphQLErrorToRbError, type NerdGraphResult } from '../nerdgraph/client.ts';
import type { EntityOutlineData } from '../nerdgraph/entities.ts';
import { type DecodedEntityGuid, decodeEntityGuid } from '../nerdgraph/entity-guid.ts';
import { type EntitySearchQuery, entityQuery, MAX_ENTITY_QUERY_LIST } from '../nerdgraph/entity-query.ts';
import { resolveAccounts } from '../nrql/engine.ts';
import { cleanName } from './identity.ts';

/** Domain, type, severity and relationship names are New Relic codes; anything else is dropped (shown as unknown). */
const CODE_RE = /^[A-Za-z0-9_]{1,64}$/;

export const isNonNull = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

/**
 * A New Relic code (`APM`, `APPLICATION`, `CRITICAL`, `CALLS`…). Restricted to a strict charset, so it is safe to show
 * outside the untrusted-data envelope; anything else becomes null.
 */
export function label(value: string | null | undefined): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

/** Accounts a search or catalogue covers: the requested one (checked) or every allowed account. */
export function scopeAccounts(ctx: ToolContext, account: number | undefined): number[] {
  const accounts =
    account === undefined ? [...new Set(ctx.accounts.allowed)] : resolveAccounts(ctx, [account]);
  if (accounts.length === 0) {
    throw new RbError(ErrorCode.AuthForbidden, 'This connection has no accounts.');
  }
  if (accounts.length > MAX_ENTITY_QUERY_LIST) {
    throw new RbError(
      ErrorCode.InputInvalid,
      `This connection has more than ${MAX_ENTITY_QUERY_LIST} accounts.`,
      {
        hint: 'Pass "account" to search one account at a time.',
      },
    );
  }
  return accounts;
}

/** `accountId IN ('1', '2')`. Quoted like the P0-09 probe (`accountId = '…'`), escaped by the tag anyway. */
export function accountFilter(accounts: readonly number[]): EntitySearchQuery {
  return entityQuery`accountId IN ${accounts.map(String)}`;
}

/** Offline account check for a GUID, before any request (T3). */
export function checkGuid(ctx: ToolContext, value: string): DecodedEntityGuid {
  const decoded = decodeEntityGuid(value);
  if (!ctx.accounts.allowed.includes(decoded.accountId)) throw outOfScope(decoded.accountId);
  return decoded;
}

/**
 * APM-only tools: a GUID of any other domain or type is refused up front (no request), naming what it is. The GUID
 * encodes domain and type (`DecodedEntityGuid`), so this costs nothing and says the same for every tool.
 */
export function requireApmApplication(decoded: DecodedEntityGuid, tool: string): void {
  if (decoded.domain === 'APM' && decoded.type === 'APPLICATION') return;
  throw new RbError(
    ErrorCode.InputInvalid,
    `${tool} supports APM applications only; this entity is ${decoded.domain}/${decoded.type}.`,
    {
      hint: 'Use search_entities with domain APM and type APPLICATION, or get_golden_metrics, entity_health or run_nrql for other entities.',
    },
  );
}

/**
 * Whether a returned entity's GUID agrees with the account NerdGraph reported for it. A GUID encodes its account, so a
 * mismatch is inconsistent data and the row can't be vouched for (T3). A GUID that does not decode cannot be vouched
 * for either (and no tool can use it later).
 */
export function guidAgrees(guid: string, account: number): boolean {
  try {
    return decodeEntityGuid(guid).accountId === account;
  } catch {
    return false;
  }
}

export function outOfScope(account: number): RbError {
  return new RbError(
    ErrorCode.AuthForbidden,
    `This entity belongs to account ${account}, which is not available on this connection.`,
    {
      hint: 'Use list_accounts to see the accounts you can query.',
      details: { account },
      localDetails: true,
    },
  );
}

function notFound(): RbError {
  return new RbError(ErrorCode.InputInvalid, 'No entity with this guid is visible to this key.', {
    hint: 'Check the guid (use search_entities), and that the key can read its account.',
  });
}

/** A required field came back null: map the field error if there is one. */
export function requireField<T>(
  value: T | null | undefined,
  result: NerdGraphResult<unknown>,
  ctx: ToolContext,
): T {
  if (isNonNull(value)) return value;
  throw result.warnings.length > 0
    ? graphQLErrorToRbError(result.warnings[0], ctx.credential.region)
    : notFound();
}

export interface EntityRow {
  guid: string;
  name: string;
  accountId: number | null;
  domain: string | null;
  type: string | null;
  alertSeverity: string | null;
  reporting: boolean | null;
}

export function toRow(
  e: EntityOutlineData,
  fallback?: { guid?: string | null; accountId?: number | null },
): EntityRow {
  return {
    guid: e.guid ?? fallback?.guid ?? '',
    name: cleanName(e.name ?? ''),
    accountId: e.accountId ?? fallback?.accountId ?? null,
    domain: label(e.domain),
    type: label(e.type),
    alertSeverity: label(e.alertSeverity),
    reporting: typeof e.reporting === 'boolean' ? e.reporting : null,
  };
}

export const kind = (r: { domain: string | null; type: string | null }): string =>
  [r.domain, r.type].filter(isNonNull).join('/') || 'unknown';
