// SPDX-License-Identifier: Apache-2.0
// Who may sign in (P4-01, THREAT_MODEL T14). Deny by default:
// 1. A user row already bound to this (idp, subject) signs in, unless disabled.
// 2. Else a user row with this (verified) email that is **not bound to any identity yet** (created by the CLI or the
//    admin API) is bound to it and signs in. A row bound to another subject or IdP is a conflict and is refused: an
//    email alone never moves an account between identities.
// 3. Else (unknown identity) only when the allowlist matches (exact email, email domain, or an active GitHub org
//    membership) **and** auto-provisioning is on; the new user gets the configured role (`member` or `admin`, never
//    `owner`).
// 4. A setup link (first-owner bootstrap, checked and consumed by the caller) makes the identity `owner`, skipping the
//    allowlist but not 1-2's conflict and disabled checks.
import { ConflictError, newId, type UserRecord, type UsersRepository } from '@relic-bridge/storage';
import type { VerifiedIdentity } from './types.ts';

export type AutoProvision = 'off' | 'member' | 'admin';

export interface LoginPolicy {
  /** Exact addresses (lowercase). */
  readonly emails: readonly string[];
  /** Email domains (lowercase, exact: `example.com` does not admit `sub.example.com`). */
  readonly domains: readonly string[];
  /** GitHub organization logins (lowercase); only for GitHub identities. */
  readonly githubOrgs: readonly string[];
  /** Create users for allowlisted identities without a row. Default `off`. */
  readonly autoProvision: AutoProvision;
}

export const EMPTY_LOGIN_POLICY: LoginPolicy = Object.freeze({
  emails: Object.freeze([]),
  domains: Object.freeze([]),
  githubOrgs: Object.freeze([]),
  autoProvision: 'off',
});

export type AllowlistMatch = 'email' | 'domain' | 'github_org';

export function matchAllowlist(policy: LoginPolicy, identity: VerifiedIdentity): AllowlistMatch | null {
  if (!identity.emailVerified) return null;
  const email = identity.email.toLowerCase();
  if (policy.emails.includes(email)) return 'email';
  const at = email.lastIndexOf('@');
  if (at > 0 && policy.domains.includes(email.slice(at + 1))) return 'domain';
  if (identity.idp === 'github' && (identity.orgs ?? []).some((o) => policy.githubOrgs.includes(o))) {
    return 'github_org';
  }
  return null;
}

export type LoginDenyReason =
  /** Unknown identity and no allowlist entry matches. */
  | 'not_allowed'
  /** Allowlisted, but auto-provisioning is off and no user row exists. */
  | 'not_provisioned'
  /** The email belongs to a user bound to another identity. */
  | 'identity_conflict'
  | 'user_disabled';

export type LoginOutcome = 'existing' | 'linked' | 'provisioned' | 'owner_bootstrap';

export type LoginDecision =
  | { readonly ok: true; readonly user: UserRecord; readonly outcome: LoginOutcome }
  | { readonly ok: false; readonly reason: LoginDenyReason };

export interface ResolveLoginOptions {
  /** The caller verified and consumed a setup link for this login. */
  readonly ownerBootstrap?: boolean;
}

const deny = (reason: LoginDenyReason): LoginDecision => ({ ok: false, reason });

/** Map a verified identity to a user row (see the file comment). Never throws for policy reasons. */
export async function resolveLoginUser(
  users: UsersRepository,
  identity: VerifiedIdentity,
  policy: LoginPolicy,
  options: ResolveLoginOptions = {},
): Promise<LoginDecision> {
  if (!identity.emailVerified) return deny('not_allowed');
  const email = identity.email.toLowerCase();
  const bound = await users.getByIdentity(identity.idp, identity.subject);
  let user: UserRecord | null = bound;
  if (user === null) {
    const byEmail = await users.getByEmail(email);
    if (byEmail !== null && (byEmail.idp !== null || byEmail.idpSubject !== null))
      return deny('identity_conflict');
    user = byEmail;
  }
  if (user !== null && user.disabledAt !== null) return deny('user_disabled');

  try {
    if (user !== null) {
      const patch = {
        ...(bound === null ? { idp: identity.idp, idpSubject: identity.subject } : {}),
        ...(user.displayName === null && identity.displayName !== null
          ? { displayName: identity.displayName }
          : {}),
        ...(options.ownerBootstrap && user.role !== 'owner' ? { role: 'owner' as const } : {}),
      };
      const updated = Object.keys(patch).length > 0 ? await users.update(user.id, patch) : user;
      return {
        ok: true,
        user: updated,
        outcome: options.ownerBootstrap ? 'owner_bootstrap' : bound === null ? 'linked' : 'existing',
      };
    }
    if (options.ownerBootstrap) {
      const created = await users.create({
        id: newId('usr'),
        email,
        displayName: identity.displayName,
        idp: identity.idp,
        idpSubject: identity.subject,
        role: 'owner',
      });
      return { ok: true, user: created, outcome: 'owner_bootstrap' };
    }
    if (matchAllowlist(policy, identity) === null) return deny('not_allowed');
    if (policy.autoProvision === 'off') return deny('not_provisioned');
    const created = await users.create({
      id: newId('usr'),
      email,
      displayName: identity.displayName,
      idp: identity.idp,
      idpSubject: identity.subject,
      role: policy.autoProvision,
    });
    return { ok: true, user: created, outcome: 'provisioned' };
  } catch (error) {
    // A concurrent login created or bound the row first: refuse this one, the next attempt finds the row.
    if (error instanceof ConflictError) return deny('identity_conflict');
    throw error;
  }
}
