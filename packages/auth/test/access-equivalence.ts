// SPDX-License-Identifier: Apache-2.0
// Equivalence of the one-call access path (P3-09) with the repository-by-repository one, as a reusable property test:
// random worlds (disabled, revoked, expired, unvalidated, refused, missing and cross-project states), random tokens
// and slugs (known, unknown, malformed, another project's) → `authenticateAccess` over `loadAccessRecords` must give
// exactly what `verifyAccessToken` + `resolveAccess` give: stage, reason, token id, expiry, effective access,
// credential record and the throttled touch. Run against every adapter that implements `loadAccessRecords`:
// SQLite on Node (`apps/cli/test/access-equivalence.test.ts`) and D1 in workerd (`apps/worker/test/d1.test.ts`).
// Web-standard only, so it runs in both.
import type { Storage, StoredLimits } from '@relic-bridge/storage';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { type AuthenticatedAccess, authenticateAccess } from '../src/access/authenticate.ts';
import { resolveAccess } from '../src/access/load.ts';
import { generateTokenString, hashToken, tokenDisplayPrefix } from '../src/tokens/format.ts';
import { LAST_USED_WRITE_INTERVAL_MS, verifyAccessToken } from '../src/tokens/service.ts';

const NOW = 1_800_000_000_000;
const CATALOG = ['whoami', 'run_nrql', 'search_entities', 'list_accounts'] as const;
const ACCOUNTS = [1, 2, 3, 4] as const;

/** Mostly live: a state that is off one time in six keeps allowed outcomes common enough. */
const rarely = fc.constantFrom(false, false, false, false, false, true);
const subset = <T>(values: readonly T[]) => fc.subarray([...values]);
const nullable = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null, freq: 2 });
/** Expiry relative to NOW: mostly none or future; sometimes past or exactly now (both expired). */
const expiry = fc.constantFrom<number | null>(null, null, null, 60_000, 60_000, 60_000, -60_000, 0);
const limits: fc.Arbitrary<StoredLimits> = fc.constantFrom<StoredLimits>(
  {},
  { rawNrql: false },
  { maxLimit: 10 },
  { eventTypes: { allow: ['Transaction'] } },
);

const worldArb = fc.record({
  users: fc.array(fc.record({ disabled: rarely }), { minLength: 1, maxLength: 3 }),
  credentials: fc.array(
    fc.record({
      owner: nullable(fc.nat(2)),
      revoked: rarely,
      status: fc.constantFrom('valid', 'valid', 'valid', 'valid', 'invalid', 'unvalidated'),
      reachable: fc.oneof(subset(ACCOUNTS), fc.constant([...ACCOUNTS])),
      region: fc.constantFrom('US', 'EU'),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  projects: fc.array(
    fc.record({
      disabled: rarely,
      defaultCredential: nullable(fc.nat(2)),
      allowed: subset(ACCOUNTS).filter((a) => a.length > 0),
      defaultAccount: fc.constantFrom(...ACCOUNTS),
      enabledTools: fc.oneof(fc.constant(null), fc.constant(null), subset(CATALOG)),
      limits,
    }),
    { minLength: 1, maxLength: 3 },
  ),
  grants: fc.array(
    fc.record({
      project: fc.nat(2),
      user: nullable(fc.nat(2)),
      credential: nullable(fc.nat(2)),
      revoked: rarely,
      expires: expiry,
      tools: fc.oneof(fc.constant(null), fc.constant(null), subset(CATALOG)),
      accounts: fc.oneof(fc.constant(null), fc.constant(null), subset(ACCOUNTS)),
      limits,
    }),
    { minLength: 1, maxLength: 4 },
  ),
  tokens: fc.array(
    fc.record({
      grant: fc.nat(3),
      revoked: rarely,
      expires: expiry,
      lastUsed: nullable(
        fc.constantFrom(1_000, LAST_USED_WRITE_INTERVAL_MS, 2 * LAST_USED_WRITE_INTERVAL_MS),
      ),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  queries: fc.array(
    fc.record({
      token: fc.oneof(
        fc.nat(3),
        fc.nat(3),
        fc.nat(3),
        fc.constantFrom('unknown', 'malformed', 'bad_checksum'),
      ),
      // `own`: the project of the token's grant (the usual request); a number: any project.
      slug: fc.oneof(
        fc.constant('own'),
        fc.constant('own'),
        fc.nat(2),
        fc.constantFrom('nope', 'Bad Slug!', ''),
      ),
    }),
    { minLength: 1, maxLength: 6 },
  ),
});

type WorldSpec = typeof worldArb extends fc.Arbitrary<infer T> ? T : never;

/** Writes `spec` through the repositories (states set directly, as an attacker with a stale row would find them). */
async function seed(
  storage: Storage,
  spec: WorldSpec,
): Promise<{ tokens: string[]; slugs: string[]; tokenSlugs: string[] }> {
  const pick = <T>(list: readonly T[], i: number | null): T | null =>
    i === null ? null : (list[i % list.length] ?? null);
  const users = spec.users.map((_, i) => `usr_${i}`);
  for (const [i, u] of spec.users.entries()) {
    await storage.users.create({ id: users[i] as string, email: `u${i}@example.com`, role: 'member' });
    if (u.disabled) await storage.users.update(users[i] as string, { disabledAt: NOW - 1 });
  }
  const credentials = spec.credentials.map((_, i) => `cred_${i}`);
  for (const [i, c] of spec.credentials.entries()) {
    const id = credentials[i] as string;
    await storage.credentials.create({
      id,
      ownerUserId: pick(users, c.owner),
      label: id,
      region: c.region,
      key: {
        kind: 'encrypted',
        ciphertext: new Uint8Array(32).fill(i + 1),
        iv: new Uint8Array(12),
        keyVersion: 1,
      },
    });
    if (c.status !== 'unvalidated') {
      await storage.credentials.update(id, {
        validation: { validationStatus: c.status, validatedAt: NOW - 10, reachableAccountIds: c.reachable },
      });
    }
    if (c.revoked) await storage.credentials.update(id, { revokedAt: NOW - 5 });
  }
  const projects = spec.projects.map((_, i) => `prj_${i}`);
  const slugs = spec.projects.map((_, i) => `proj-${i}`);
  for (const [i, p] of spec.projects.entries()) {
    await storage.projects.create({
      id: projects[i] as string,
      slug: slugs[i] as string,
      defaultAccountId: p.defaultAccount,
      allowedAccountIds: p.allowed,
      enabledTools: p.enabledTools,
      limits: p.limits,
      defaultCredentialId: pick(credentials, p.defaultCredential),
    });
    if (p.disabled) await storage.projects.update(projects[i] as string, { disabledAt: NOW - 3 });
  }
  const grants = spec.grants.map((_, i) => `grt_${i}`);
  for (const [i, g] of spec.grants.entries()) {
    const userId = pick(users, g.user);
    await storage.grants.create({
      id: grants[i] as string,
      projectId: pick(projects, g.project) as string,
      userId,
      label: userId === null ? `svc ${i}` : null,
      credentialId: pick(credentials, g.credential),
      tools: g.tools,
      accountIds: g.accounts,
      limits: g.limits,
      expiresAt: g.expires === null ? null : NOW + g.expires,
    });
    if (g.revoked) await storage.grants.update(grants[i] as string, { revokedAt: NOW - 2 });
  }
  const tokens: string[] = [];
  const tokenSlugs: string[] = [];
  for (const [i, t] of spec.tokens.entries()) {
    const plaintext = generateTokenString();
    const id = `tok_${i}`;
    await storage.accessTokens.create({
      id,
      grantId: pick(grants, t.grant) as string,
      prefix: tokenDisplayPrefix(plaintext),
      tokenHash: await hashToken(plaintext),
      label: `device ${i}`,
      expiresAt: t.expires === null ? null : NOW + t.expires,
    });
    if (t.lastUsed !== null) await storage.accessTokens.markUsed(id, NOW - t.lastUsed);
    if (t.revoked) await storage.accessTokens.revoke(id, NOW - 1);
    tokens.push(plaintext);
    const grant = spec.grants[t.grant % spec.grants.length] as WorldSpec['grants'][number];
    tokenSlugs.push(slugs[grant.project % slugs.length] as string);
  }
  return { tokens, slugs, tokenSlugs };
}

/** `storage` with touches recorded instead of written, and every repository call counted. */
function instrument(storage: Storage): { storage: Storage; touches: string[]; calls: string[] } {
  const touches: string[] = [];
  const calls: string[] = [];
  const counted = <T extends object>(name: string, repo: T): T =>
    Object.fromEntries(
      Object.entries(repo).map(([k, v]) => [
        k,
        typeof v === 'function'
          ? (...args: unknown[]) => {
              calls.push(`${name}.${k}`);
              return (v as (...a: unknown[]) => unknown).apply(repo, args);
            }
          : v,
      ]),
    ) as T;
  const accessTokens = counted('accessTokens', {
    ...storage.accessTokens,
    markUsed: async (id: string, at: number) => {
      touches.push(`${id}@${at}`);
    },
  });
  const load = storage.loadAccessRecords;
  return {
    touches,
    calls,
    storage: {
      ...storage,
      users: counted('users', storage.users),
      credentials: counted('credentials', storage.credentials),
      projects: counted('projects', storage.projects),
      grants: counted('grants', storage.grants),
      accessTokens,
      ...(load === undefined
        ? {}
        : {
            loadAccessRecords: (q: Parameters<typeof load>[0]) => {
              calls.push('loadAccessRecords');
              return load.call(storage, q);
            },
          }),
    },
  };
}

/** The pre-P3-09 path, written out: `verifyAccessToken`, then `resolveAccess` on the token's grant. */
async function reference(storage: Storage, token: string, projectSlug: string): Promise<AuthenticatedAccess> {
  const verdict = await verifyAccessToken(storage, token, { now: NOW });
  if (!verdict.ok) return { ok: false, stage: 'token', reason: verdict.reason };
  await verdict.touch;
  const d = await resolveAccess({
    storage,
    projectSlug,
    principal: { grantId: verdict.grantId },
    catalog: CATALOG,
    now: NOW,
  });
  if (!d.ok) return { ok: false, stage: 'access', tokenId: verdict.tokenId, reason: d.reason };
  return {
    ok: true,
    tokenId: verdict.tokenId,
    tokenExpiresAt: verdict.expiresAt,
    access: d.access,
    credential: d.credential,
  };
}

function tokenFor(tokens: readonly string[], q: WorldSpec['queries'][number]['token']): string {
  if (typeof q === 'number') return tokens[q % tokens.length] as string;
  if (q === 'malformed') return 'not-a-token';
  const fresh = generateTokenString();
  // `bad_checksum`: right shape, last checksum character changed.
  return q === 'unknown' ? fresh : `${fresh.slice(0, -1)}${fresh.endsWith('A') ? 'B' : 'A'}`;
}

export interface AccessEquivalenceOptions {
  readonly name: string;
  /** A fresh, empty storage implementing `loadAccessRecords`. */
  readonly open: () => Promise<Storage>;
  readonly runs: number;
  readonly timeout?: number;
}

export function runAccessEquivalence(options: AccessEquivalenceOptions): void {
  it(
    `one-call access resolution decides exactly like verifyAccessToken + resolveAccess (${options.name})`,
    async () => {
      let allowed = 0;
      let denied = 0;
      await fc.assert(
        fc.asyncProperty(worldArb, async (spec) => {
          const base = await options.open();
          expect(typeof base.loadAccessRecords).toBe('function');
          const { tokens, slugs, tokenSlugs } = await seed(base, spec);
          for (const q of spec.queries) {
            const token = tokenFor(tokens, q.token);
            const slug =
              q.slug === 'own'
                ? typeof q.token === 'number'
                  ? (tokenSlugs[q.token % tokenSlugs.length] as string)
                  : (slugs[0] as string)
                : typeof q.slug === 'number'
                  ? (slugs[q.slug % slugs.length] as string)
                  : q.slug;

            const oldPath = instrument(base);
            const expected = await reference(oldPath.storage, token, slug);
            const newPath = instrument(base);
            const pending: Promise<void>[] = [];
            const actual = await authenticateAccess({
              storage: newPath.storage,
              token,
              projectSlug: slug,
              catalog: CATALOG,
              now: NOW,
              onTouch: (t) => pending.push(t),
            });
            await Promise.all(pending);

            expect(actual).toEqual(expected);
            expect(newPath.touches).toEqual(oldPath.touches);
            // One storage call (none for an offline refusal), never a repository read.
            const offline =
              expected.ok === false &&
              expected.stage === 'token' &&
              expected.reason !== 'unknown' &&
              expected.reason !== 'revoked' &&
              expected.reason !== 'expired';
            expect(newPath.calls.filter((c) => c !== 'accessTokens.markUsed')).toEqual(
              offline ? [] : ['loadAccessRecords'],
            );
            if (actual.ok) allowed++;
            else denied++;
          }
          await base.close();
        }),
        { numRuns: options.runs },
      );
      // The generator reaches both outcomes (otherwise the property says little).
      expect(allowed).toBeGreaterThan(0);
      expect(denied).toBeGreaterThan(0);
    },
    options.timeout ?? 60_000,
  );
}
