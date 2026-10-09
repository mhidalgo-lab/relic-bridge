// SPDX-License-Identifier: Apache-2.0
// Remembered OAuth approvals (P5-04 "don't ask again"): `kv` rows `oauth-consent:<userId>:<id>`, shared by the consent
// screen (which writes and lists them) and the device revocation (P5-05, which forgets a revoked device's approval so
// the app has to ask again). Web-standard only.
import type { KvRepository } from '@relic-bridge/storage';

export const REMEMBER_PREFIX = 'oauth-consent:';
/** Remembered approvals kept per user (more are not stored: the page then asks every time). */
export const MAX_REMEMBERED_APPROVALS = 50;

/** A remembered approval as stored. Display fields are copies for the list page. */
export interface StoredApproval {
  readonly grantId: string;
  /** The client the approval is for (P5-05; rows written by P5-04 lack it). */
  readonly clientId?: string;
  readonly scope: readonly string[];
  readonly label: string | null;
  readonly clientName: string | null;
  readonly clientKind: 'metadata_document' | 'dynamic';
  readonly clientHost: string | null;
  readonly redirectHost: string;
  readonly projectSlug: string;
  readonly grantLabel: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export const rememberPrefix = (userId: string): string => `${REMEMBER_PREFIX}${userId}:`;
export const rememberKey = (userId: string, id: string): string => `${rememberPrefix(userId)}${id}`;

export function parseStored(text: string | null): StoredApproval | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<StoredApproval>;
    if (
      typeof v.grantId !== 'string' ||
      (v.clientId !== undefined && typeof v.clientId !== 'string') ||
      !Array.isArray(v.scope) ||
      !v.scope.every((s) => typeof s === 'string') ||
      typeof v.redirectHost !== 'string' ||
      typeof v.projectSlug !== 'string' ||
      typeof v.grantLabel !== 'string' ||
      typeof v.expiresAt !== 'number' ||
      (v.clientKind !== 'metadata_document' && v.clientKind !== 'dynamic')
    ) {
      return null;
    }
    return v as StoredApproval;
  } catch {
    return null;
  }
}

/**
 * Forget the user's remembered approvals that `match` selects (`stored` is null for an unreadable row). One listing of
 * the user's rows (≤ {@link MAX_REMEMBERED_APPROVALS}) whatever is matched. Resolves with the number of rows deleted.
 */
export async function forgetApprovals(
  kv: Pick<KvRepository, 'get' | 'delete' | 'list'>,
  userId: string,
  match: (stored: StoredApproval | null) => boolean,
): Promise<number> {
  const keys = (await kv.list({ prefix: rememberPrefix(userId), limit: MAX_REMEMBERED_APPROVALS })).keys;
  let deleted = 0;
  for (const k of keys) {
    if (!match(parseStored(await kv.get(k.name)))) continue;
    await kv.delete(k.name);
    deleted += 1;
  }
  return deleted;
}
