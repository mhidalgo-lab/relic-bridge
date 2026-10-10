// SPDX-License-Identifier: Apache-2.0

import type { Region } from './context.ts';
import { ErrorCode, RbError } from './errors.ts';

/**
 * New Relic One UI hosts per data-center region (P7-03). Unverified for JP: New Relic documents no JP UI host, so JP
 * connections get no links rather than a guessed host. Never derived from request or NerdGraph data.
 */
const UI_HOSTS: Readonly<Partial<Record<Region, string>>> = Object.freeze({
  US: 'https://one.newrelic.com',
  EU: 'https://one.eu.newrelic.com',
});

const ISSUE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function uiHost(region: Region): string {
  const host = UI_HOSTS[region];
  if (!host) {
    throw new RbError(ErrorCode.InputInvalid, `No New Relic UI link format is known for region ${region}.`, {
      hint: 'Open New Relic in the browser and search for the entity or issue by name.',
    });
  }
  return host;
}

/** Entity permalink; also opens dashboards, which are entities. `guid` must already pass `checkGuid`. */
export function entityLink(region: Region, guid: string): string {
  return `${uiHost(region)}/redirect/entity/${encodeURIComponent(guid)}`;
}

/** Issue page in Alerts & AI (UNVERIFIED path). `issueId` is a UUID; `accountId` is a numeric account id from access. */
export function issueLink(region: Region, accountId: number, issueId: string): string {
  if (!ISSUE_ID_RE.test(issueId)) {
    throw new RbError(ErrorCode.InputInvalid, 'issue_id must be an issue UUID (list_recent_issues).');
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new RbError(ErrorCode.InputInvalid, 'Account ids must be positive integers.');
  }
  return `${uiHost(region)}/alerts-ai/issues/${encodeURIComponent(issueId)}?account=${accountId}`;
}

function base64Utf8(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Query builder with the query prefilled (UNVERIFIED launcher format: the `pane` is base64 JSON naming the nerdlet).
 * The caller checks the NRQL against the connection's limits first and passes the text that would be run.
 */
export function nrqlLink(region: Region, accountId: number, nrql: string): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new RbError(ErrorCode.InputInvalid, 'Account ids must be positive integers.');
  }
  const pane = base64Utf8(
    JSON.stringify({
      nerdletId: 'data-exploration.query-builder',
      initialActiveInterface: 'nrqlEditor',
      initialQueries: [{ accountId, nrql }],
    }),
  );
  return `${uiHost(region)}/launcher/data-exploration.query-builder?pane=${encodeURIComponent(pane)}`;
}
