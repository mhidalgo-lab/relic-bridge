// SPDX-License-Identifier: Apache-2.0
// Token check + access resolution for one request (P3-09). With a storage that implements `loadAccessRecords` (D1,
// SQLite) it costs ONE storage call; otherwise it is exactly `verifyAccessToken` then `resolveAccess`. Both paths run
// the same pure steps (`checkTokenRecord`, `precheckAccess`, `decideAccess` → `computeAccess`) in the same order, so
// they reach the same decision (equivalence tests: `test/access-equivalence.ts`).
import type { CredentialRecord, Storage } from '@relic-bridge/storage';
import { SLUG_RE } from '@relic-bridge/storage';
import { checkTokenFormat, hashToken } from '../tokens/format.ts';
import {
  checkNow,
  checkTokenRecord,
  type TokenDenyReason,
  touchToken,
  verifyAccessToken,
} from '../tokens/service.ts';
import { decideAccess, precheckAccess, resolveAccess } from './load.ts';
import type { DenyReason, EffectiveAccess } from './resolve.ts';

export interface AuthenticateAccessInput {
  readonly storage: Pick<
    Storage,
    'accessTokens' | 'projects' | 'grants' | 'users' | 'credentials' | 'loadAccessRecords'
  >;
  /** The presented bearer token (untrusted). */
  readonly token: unknown;
  /** From the request URL (untrusted). */
  readonly projectSlug: string;
  readonly catalog: readonly string[];
  /** Epoch milliseconds; a non-integer clock throws. */
  readonly now: number;
  /**
   * Receives the throttled `last_used_at` write as soon as the token is accepted (before access is decided, and even
   * when access is then denied, as before P3-09). The promise never rejects; hand it to `waitUntil` on Workers.
   */
  readonly onTouch?: (touch: Promise<void>) => void;
  /** Called when the `last_used_at` write fails (for a log line); the error never carries the token. */
  readonly onTouchError?: (error: unknown) => void;
}

export type AuthenticatedAccess =
  | {
      readonly ok: true;
      readonly tokenId: string;
      /** The token's expiry: cap any cache of this result at it (and at `access.expiresAt`). */
      readonly tokenExpiresAt: number | null;
      readonly access: EffectiveAccess;
      /** The credential row, for `openCredential`. Holds ciphertext only. */
      readonly credential: CredentialRecord;
    }
  /** The token itself was refused (`malformed` and `bad_checksum` without any storage read). */
  | { readonly ok: false; readonly stage: 'token'; readonly reason: TokenDenyReason }
  /** A valid token whose grant may not use this project now. */
  | { readonly ok: false; readonly stage: 'access'; readonly tokenId: string; readonly reason: DenyReason };

/**
 * Authenticates a bearer token and resolves what it may do on `projectSlug`. Deny reasons are for logs and audit
 * only. Storage errors propagate: the caller must fail closed.
 */
export async function authenticateAccess(input: AuthenticateAccessInput): Promise<AuthenticatedAccess> {
  const { storage, token, projectSlug, catalog, now } = input;
  const load = storage.loadAccessRecords;
  if (load === undefined) {
    // Repository by repository: today's path, unchanged.
    const verdict = await verifyAccessToken(storage, token, {
      now,
      ...(input.onTouchError === undefined ? {} : { onTouchError: input.onTouchError }),
    });
    if (!verdict.ok) return { ok: false, stage: 'token', reason: verdict.reason };
    if (verdict.touch !== null) input.onTouch?.(verdict.touch);
    const decision = await resolveAccess({
      storage,
      projectSlug,
      principal: { grantId: verdict.grantId },
      catalog,
      now,
    });
    if (!decision.ok)
      return { ok: false, stage: 'access', tokenId: verdict.tokenId, reason: decision.reason };
    return {
      ok: true,
      tokenId: verdict.tokenId,
      tokenExpiresAt: verdict.expiresAt,
      access: decision.access,
      credential: decision.credential,
    };
  }

  // One storage call. Same order of checks: clock, offline format, token row, then the access decision.
  checkNow(now);
  const problem = checkTokenFormat(token);
  if (problem !== null) return { ok: false, stage: 'token', reason: problem };
  const hash = await hashToken(token as string);
  // A malformed slug never reaches the query as a slug (and is denied as `project_not_found` below).
  const slug = typeof projectSlug === 'string' && SLUG_RE.test(projectSlug) ? projectSlug : null;
  const records = await load.call(storage, { tokenHash: hash, projectSlug: slug });
  const checked = checkTokenRecord(records.token, hash, now);
  if (!checked.ok) return { ok: false, stage: 'token', reason: checked.reason };
  const { record } = checked;
  const touch = touchToken(storage, record, now, input.onTouchError);
  if (touch !== null) input.onTouch?.(touch);

  const principal = { grantId: record.grantId };
  const invalid = precheckAccess(projectSlug, principal);
  const decision =
    invalid !== null
      ? ({ ok: false, reason: invalid } as const)
      : decideAccess(
          { principal, catalog, now },
          {
            project: records.project,
            grant: records.grant,
            user: records.user,
            credential: records.credential,
            // As `resolveAccess`: the owner counts only when it is not the grant's user.
            ...(records.credential === null ||
            records.credential.ownerUserId === null ||
            records.grant === null ||
            records.credential.ownerUserId === records.grant.userId
              ? {}
              : { credentialOwner: records.credentialOwner }),
          },
        );
  if (!decision.ok) return { ok: false, stage: 'access', tokenId: record.id, reason: decision.reason };
  return {
    ok: true,
    tokenId: record.id,
    tokenExpiresAt: record.expiresAt,
    access: decision.access,
    credential: decision.credential,
  };
}
