// SPDX-License-Identifier: Apache-2.0
// P4-16 (THREAT_MODEL T14): two first sign-ins for one unbound email, at two providers, at the same time. Exactly one
// binds the account and signs in; the other is refused `identity_conflict` and never gets a session. Reusable so it
// runs on every writable adapter: memory (`identity.test.ts`), SQLite on Node, also over two connections to one file
// (`apps/cli/test/login-race.test.ts`), and D1 in workerd (`apps/worker/test/d1.test.ts`). Web-standard only.
import type { Storage } from '@relic-bridge/storage';
import { expect, it } from 'vitest';
import { EMPTY_LOGIN_POLICY, type LoginDecision, resolveLoginUser } from '../src/identity/policy.ts';
import type { VerifiedIdentity } from '../src/identity/types.ts';

export interface LoginRaceOptions {
  readonly name: string;
  /**
   * Fresh, empty storages that share one database: the two sign-ins run on `a` and `b`. Return the same storage
   * twice for a single connection.
   */
  readonly open: () => Promise<{ readonly a: Storage; readonly b: Storage; close(): Promise<void> }>;
  /** Rounds (each a fresh unbound user). Default 5. */
  readonly rounds?: number;
  readonly timeout?: number;
}

const identity = (idp: string, subject: string, email: string): VerifiedIdentity => ({
  idp,
  subject,
  email,
  emailVerified: true,
  displayName: null,
});

export function runLoginRace(options: LoginRaceOptions): void {
  it(
    `concurrent first sign-ins at two providers for one unbound email: one ok, one identity_conflict (${options.name})`,
    async () => {
      const { a, b, close } = await options.open();
      try {
        for (let i = 0; i < (options.rounds ?? 5); i++) {
          const email = `race${i}@example.com`;
          await a.users.create({ id: `usr_race${i}`, email, role: 'member' });
          const google = identity('google', `g-${i}`, email.toUpperCase());
          const github = identity('github', `${1000 + i}`, email);
          // Both pass the read checks before either writes; only the conditional bind decides.
          const decisions: LoginDecision[] = await Promise.all([
            resolveLoginUser(a.users, google, EMPTY_LOGIN_POLICY),
            resolveLoginUser(b.users, github, EMPTY_LOGIN_POLICY),
          ]);
          const ok = decisions.filter((d) => d.ok);
          const refused = decisions.filter((d) => !d.ok);
          expect(ok).toHaveLength(1);
          expect(refused).toEqual([{ ok: false, reason: 'identity_conflict' }]);
          const winner = ok[0] as Extract<LoginDecision, { ok: true }>;
          expect(winner.outcome).toBe('linked');
          // The stored binding is the winner's, and the loser's identity maps to nobody.
          const stored = await a.users.get(`usr_race${i}`);
          expect(stored).toEqual(winner.user);
          const loser = winner.user.idp === 'google' ? github : google;
          expect(await a.users.getByIdentity(loser.idp, loser.subject)).toBeNull();
          // Signing in again: the winner is `existing`, the loser stays refused.
          const winnerAgain = winner.user.idp === 'google' ? google : github;
          expect(await resolveLoginUser(b.users, winnerAgain, EMPTY_LOGIN_POLICY)).toMatchObject({
            ok: true,
            outcome: 'existing',
          });
          expect(await resolveLoginUser(a.users, loser, EMPTY_LOGIN_POLICY)).toEqual({
            ok: false,
            reason: 'identity_conflict',
          });
        }
      } finally {
        await close();
      }
    },
    options.timeout ?? 30_000,
  );
}
