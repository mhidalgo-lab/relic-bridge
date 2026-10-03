// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_LIMITS, type QueryLimits, RAW_NRQL_TOOLS } from '@relic-bridge/core';
import type { StoredLimits } from '@relic-bridge/storage';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AccessDecision,
  computeAccess,
  DENY_REASONS,
  type DenyReason,
  type EffectiveAccess,
  limitsFrom,
  tightenLimits,
} from '../src/access/resolve.ts';
import { CATALOG, credential, grant, input, NOW, project, user } from './access-fixtures.ts';

function granted(d: AccessDecision): EffectiveAccess {
  if (!d.ok) throw new Error(`denied: ${d.reason}`);
  return d.access;
}
const reason = (d: AccessDecision): DenyReason | null => (d.ok ? null : d.reason);

describe('computeAccess: happy path', () => {
  it('personal setup: everything the project allows, default account and limits', () => {
    const a = granted(computeAccess(input()));
    expect(a).toMatchObject({
      projectId: 'prj_a',
      projectSlug: 'prod',
      grantId: 'grt_a',
      userId: 'usr_a',
      credential: { id: 'cred_a', region: 'US' },
      accounts: { allowed: [1, 2, 3], default: 1 },
      rateLimit: null,
      expiresAt: null,
    });
    expect(a.tools).toEqual(CATALOG);
    expect(a.limits).toEqual(DEFAULT_LIMITS);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.tools)).toBe(true);
    expect(Object.isFrozen(a.accounts.allowed)).toBe(true);
    expect(Object.isFrozen(a.limits.eventTypes)).toBe(true);
    // No key material in the result.
    expect(JSON.stringify(a)).not.toMatch(/ciphertext|iv|apiKey/);
  });
});

describe('computeAccess: intersections (table)', () => {
  const cases: {
    name: string;
    projectTools: readonly string[] | null;
    grantTools: readonly string[] | null;
    expected: readonly string[];
  }[] = [
    { name: 'both null → catalog', projectTools: null, grantTools: null, expected: CATALOG },
    {
      name: 'project narrows',
      projectTools: ['whoami', 'run_nrql'],
      grantTools: null,
      expected: ['whoami', 'run_nrql'],
    },
    {
      name: 'grant narrows',
      projectTools: null,
      grantTools: ['list_accounts'],
      expected: ['list_accounts'],
    },
    {
      name: 'both narrow → intersection',
      projectTools: ['whoami', 'run_nrql', 'search_entities'],
      grantTools: ['run_nrql', 'search_entities', 'get_entity'],
      expected: ['run_nrql', 'search_entities'],
    },
    {
      name: 'grant asks for more than the project → only the project tools',
      projectTools: ['whoami'],
      grantTools: ['whoami', 'run_nrql', 'get_entity'],
      expected: ['whoami'],
    },
    {
      name: 'unknown names are never granted',
      projectTools: ['whoami', 'drop_everything'],
      grantTools: ['whoami', 'drop_everything'],
      expected: ['whoami'],
    },
  ];
  for (const c of cases) {
    it(`tools: ${c.name}`, () => {
      const a = granted(
        computeAccess(
          input({
            project: project({ enabledTools: c.projectTools }),
            grant: grant({ tools: c.grantTools }),
          }),
        ),
      );
      // Catalog order, not input order.
      expect(a.tools).toEqual(CATALOG.filter((t) => c.expected.includes(t)));
    });
  }

  const accountCases: {
    name: string;
    reachable: readonly number[];
    allowed: readonly number[];
    grantAccounts: readonly number[] | null;
    defaultAccount?: number;
    expected: readonly number[];
    expectedDefault: number;
  }[] = [
    {
      name: 'all',
      reachable: [1, 2, 3],
      allowed: [1, 2, 3],
      grantAccounts: null,
      expected: [1, 2, 3],
      expectedDefault: 1,
    },
    {
      name: 'key cannot reach an allowed account',
      reachable: [2, 3],
      allowed: [1, 2, 3],
      grantAccounts: null,
      expected: [2, 3],
      expectedDefault: 2,
    },
    {
      name: 'key reaches more than the project allows',
      reachable: [1, 2, 3, 99],
      allowed: [1, 2],
      grantAccounts: null,
      expected: [1, 2],
      expectedDefault: 1,
    },
    {
      name: 'grant narrows',
      reachable: [1, 2, 3],
      allowed: [1, 2, 3],
      grantAccounts: [3],
      expected: [3],
      expectedDefault: 3,
    },
    {
      name: 'grant asks for an account the project does not allow → never granted',
      reachable: [1, 2, 3, 99],
      allowed: [1, 2],
      grantAccounts: [2, 99],
      expected: [2],
      expectedDefault: 2,
    },
    {
      name: 'project default kept when allowed',
      reachable: [1, 2, 3],
      allowed: [1, 2, 3],
      grantAccounts: [1, 3],
      defaultAccount: 3,
      expected: [1, 3],
      expectedDefault: 3,
    },
  ];
  for (const c of accountCases) {
    it(`accounts: ${c.name}`, () => {
      const a = granted(
        computeAccess(
          input({
            project: project({
              allowedAccountIds: c.allowed,
              defaultAccountId: c.defaultAccount ?? c.allowed[0] ?? 1,
            }),
            grant: grant({ accountIds: c.grantAccounts }),
            credential: credential({ reachableAccountIds: c.reachable }),
          }),
        ),
      );
      expect(a.accounts.allowed).toEqual(c.expected);
      expect(a.accounts.default).toBe(c.expectedDefault);
    });
  }

  it('credential: grant credential wins over the project default', () => {
    const a = granted(
      computeAccess(
        input({
          grant: grant({ credentialId: 'cred_b' }),
          credential: credential({ id: 'cred_b', region: 'EU' }),
        }),
      ),
    );
    expect(a.credential).toEqual({ id: 'cred_b', region: 'EU' });
  });

  it('rate limit and expiry are carried', () => {
    const a = granted(
      computeAccess(
        input({ grant: grant({ rateLimit: { requests: 10, perSeconds: 60 }, expiresAt: NOW + 1 }) }),
      ),
    );
    expect(a.rateLimit).toEqual({ requests: 10, perSeconds: 60 });
    expect(a.expiresAt).toBe(NOW + 1);
  });
});

describe('computeAccess: limits', () => {
  it('project overrides apply over the defaults, the grant tightens them', () => {
    const a = granted(
      computeAccess(
        input({
          project: project({ limits: { maxLimit: 2000, maxWindowDays: 30, maxResponseBytes: 4096 } }),
          grant: grant({ limits: { maxLimit: 5000, maxWindowDays: 3, rawNrql: true } }),
        }),
      ),
    );
    expect(a.limits).toMatchObject({
      maxLimit: 2000,
      maxWindowDays: 3,
      maxResponseBytes: 4096,
      rawNrql: true,
    });
  });

  it('raw NRQL off on either side hides run_nrql and get_query_result', () => {
    for (const [p, g] of [
      [{ rawNrql: false }, {}],
      [{}, { rawNrql: false }],
      [{ rawNrql: false }, { rawNrql: true }],
    ] as const) {
      const a = granted(
        computeAccess(input({ project: project({ limits: p }), grant: grant({ limits: g }) })),
      );
      expect(a.limits.rawNrql).toBe(false);
      for (const t of RAW_NRQL_TOOLS) expect(a.tools).not.toContain(t);
      expect(a.tools.length).toBe(CATALOG.length - RAW_NRQL_TOOLS.length);
    }
  });

  it('a grant cannot turn raw NRQL back on', () => {
    const a = granted(
      computeAccess(
        input({
          project: project({ limits: { rawNrql: false } }),
          grant: grant({ limits: { rawNrql: true } }),
        }),
      ),
    );
    expect(a.limits.rawNrql).toBe(false);
  });

  it('event types: allow lists intersect (exactly), deny lists unite', () => {
    const base = limitsFrom({ eventTypes: { allow: ['Transaction', 'Log', 'Span'], deny: ['Secret'] } });
    if (base === null) throw new Error('bad');
    expect(
      tightenLimits(base, { eventTypes: { allow: ['Log', 'transaction', 'Metric'], deny: ['PII'] } })
        ?.eventTypes,
    ).toEqual({
      allow: ['Log'],
      deny: ['Secret', 'PII'],
    });
    // Grant only: its list applies.
    expect(tightenLimits(DEFAULT_LIMITS, { eventTypes: { allow: ['Log'] } })?.eventTypes).toEqual({
      allow: ['Log'],
    });
    // Disjoint allow lists: nothing is allowed (never "no restriction").
    expect(
      tightenLimits(limitsFrom({ eventTypes: { allow: ['A'] } }) as QueryLimits, {
        eventTypes: { allow: ['B'] },
      })?.eventTypes,
    ).toEqual({ allow: [] });
    expect(tightenLimits(DEFAULT_LIMITS, {})?.eventTypes).toEqual({});
  });
});

describe('computeAccess: deny by default', () => {
  const cases: { name: string; over: Parameters<typeof input>[0]; reason: DenyReason }[] = [
    { name: 'unknown project', over: { project: null }, reason: 'project_not_found' },
    { name: 'disabled project', over: { project: project({ disabledAt: 1 }) }, reason: 'project_disabled' },
    { name: 'unknown grant', over: { grant: null }, reason: 'grant_not_found' },
    {
      name: 'principal names another grant',
      over: { principal: { grantId: 'grt_other' } },
      reason: 'grant_not_found',
    },
    {
      name: 'grant of another project (T2)',
      over: { grant: grant({ projectId: 'prj_b' }) },
      reason: 'grant_wrong_project',
    },
    { name: 'revoked grant', over: { grant: grant({ revokedAt: 1 }) }, reason: 'grant_revoked' },
    {
      name: 'revoked in the future still revoked',
      over: { grant: grant({ revokedAt: NOW + 1e9 }) },
      reason: 'grant_revoked',
    },
    { name: 'expired grant', over: { grant: grant({ expiresAt: NOW - 1 }) }, reason: 'grant_expired' },
    { name: 'grant expiring now', over: { grant: grant({ expiresAt: NOW }) }, reason: 'grant_expired' },
    {
      name: 'principal user differs from the grant user',
      over: { principal: { grantId: 'grt_a', userId: 'usr_b' } },
      reason: 'principal_mismatch',
    },
    {
      name: 'user principal on a service grant',
      over: {
        principal: { grantId: 'grt_a', userId: 'usr_a' },
        grant: grant({ userId: null, label: 'ci' }),
        user: null,
      },
      reason: 'principal_mismatch',
    },
    { name: 'grant user missing', over: { user: null }, reason: 'user_not_found' },
    { name: 'wrong user record passed', over: { user: user({ id: 'usr_b' }) }, reason: 'user_not_found' },
    { name: 'disabled user', over: { user: user({ disabledAt: 1 }) }, reason: 'user_disabled' },
    {
      name: 'service grant without label',
      over: { grant: grant({ userId: null, label: null }), user: null },
      reason: 'invalid_config',
    },
    {
      name: 'no grant credential and no project default',
      over: { project: project({ defaultCredentialId: null }) },
      reason: 'credential_missing',
    },
    { name: 'credential row missing', over: { credential: null }, reason: 'credential_not_found' },
    {
      name: 'credential record is not the resolved one (mismatch)',
      over: { credential: credential({ id: 'cred_other' }) },
      reason: 'credential_not_found',
    },
    {
      name: 'revoked credential',
      over: { credential: credential({ revokedAt: 1 }) },
      reason: 'credential_revoked',
    },
    {
      name: 'credential refused by New Relic',
      over: { credential: credential({ validationStatus: 'invalid', reachableAccountIds: null }) },
      reason: 'credential_invalid',
    },
    {
      name: 'credential never validated',
      over: { credential: credential({ validationStatus: 'unvalidated', reachableAccountIds: null }) },
      reason: 'credential_unvalidated',
    },
    {
      name: 'valid but reachable accounts unknown',
      over: { credential: credential({ reachableAccountIds: null }) },
      reason: 'credential_unvalidated',
    },
    {
      name: "grant uses another user's personal key",
      over: {
        grant: grant({ credentialId: 'cred_b' }),
        credential: credential({ id: 'cred_b', ownerUserId: 'usr_b' }),
      },
      reason: 'credential_not_permitted',
    },
    {
      name: "service grant uses a user's personal key",
      over: {
        grant: grant({ userId: null, label: 'ci', credentialId: 'cred_b' }),
        user: null,
        credential: credential({ id: 'cred_b', ownerUserId: 'usr_b' }),
      },
      reason: 'credential_not_permitted',
    },
    {
      name: 'tool not in grant (empty intersection)',
      over: { project: project({ enabledTools: ['whoami'] }), grant: grant({ tools: ['run_nrql'] }) },
      reason: 'no_tools',
    },
    { name: 'grant with an empty tool list', over: { grant: grant({ tools: [] }) }, reason: 'no_tools' },
    {
      name: 'only unknown tools',
      over: { project: project({ enabledTools: ['nope'] }) },
      reason: 'no_tools',
    },
    {
      name: 'only raw NRQL tools and raw NRQL off',
      over: {
        project: project({ enabledTools: ['run_nrql', 'get_query_result'], limits: { rawNrql: false } }),
      },
      reason: 'no_tools',
    },
    { name: 'empty catalog', over: { catalog: [] }, reason: 'no_tools' },
    { name: 'account not in project', over: { grant: grant({ accountIds: [99] }) }, reason: 'no_accounts' },
    {
      name: 'key reaches none of the accounts',
      over: { credential: credential({ reachableAccountIds: [99] }) },
      reason: 'no_accounts',
    },
    {
      name: 'key reaches no account at all',
      over: { credential: credential({ reachableAccountIds: [] }) },
      reason: 'no_accounts',
    },
    { name: 'empty grant account list', over: { grant: grant({ accountIds: [] }) }, reason: 'no_accounts' },
    {
      name: 'bad project limits',
      over: { project: project({ limits: { maxLimit: -1 } }) },
      reason: 'invalid_config',
    },
    {
      name: 'unknown limit key',
      over: { grant: grant({ limits: { maxRows: 5 } as unknown as StoredLimits }) },
      reason: 'invalid_config',
    },
    {
      name: 'bad grant limits',
      over: { grant: grant({ limits: { maxWindowDays: 0 } }) },
      reason: 'invalid_config',
    },
    {
      name: 'corrupt account list',
      over: { project: project({ allowedAccountIds: ['1'] as unknown as number[] }) },
      reason: 'invalid_config',
    },
    {
      name: 'corrupt tool list',
      over: { grant: grant({ tools: 'whoami' as unknown as string[] }) },
      reason: 'invalid_config',
    },
    {
      name: 'corrupt rate limit',
      over: { grant: grant({ rateLimit: { requests: 0, perSeconds: 1 } }) },
      reason: 'invalid_config',
    },
    {
      name: 'unknown region',
      over: { credential: credential({ region: 'XX' as 'US' }) },
      reason: 'invalid_config',
    },
    { name: 'empty grant id', over: { principal: { grantId: '' } }, reason: 'invalid_request' },
    {
      name: 'empty user id',
      over: { principal: { grantId: 'grt_a', userId: '' } },
      reason: 'invalid_request',
    },
    { name: 'clock is NaN', over: { now: Number.NaN }, reason: 'invalid_request' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(reason(computeAccess(input(c.over)))).toBe(c.reason);
    });
  }

  it('covers every deny reason', () => {
    const seen = new Set(cases.map((c) => c.reason));
    expect(DENY_REASONS.filter((r) => !seen.has(r))).toEqual([]);
  });

  it('allows: matching user principal, service grant with label, shared and default credentials', () => {
    expect(computeAccess(input({ principal: { grantId: 'grt_a', userId: 'usr_a' } })).ok).toBe(true);
    expect(computeAccess(input({ grant: grant({ userId: null, label: 'ci' }), user: null })).ok).toBe(true);
    // Shared (unowned) credential.
    expect(
      computeAccess(
        input({
          grant: grant({ credentialId: 'cred_s' }),
          credential: credential({ id: 'cred_s', ownerUserId: null }),
        }),
      ).ok,
    ).toBe(true);
    // Another user's key that the admin made the project default.
    expect(
      computeAccess(
        input({
          project: project({ defaultCredentialId: 'cred_b' }),
          grant: grant({ credentialId: null }),
          credential: credential({ id: 'cred_b', ownerUserId: 'usr_b' }),
        }),
      ).ok,
    ).toBe(true);
    expect(
      computeAccess(
        input({
          project: project({ defaultCredentialId: 'cred_b' }),
          grant: grant({ credentialId: 'cred_b' }),
          credential: credential({ id: 'cred_b', ownerUserId: 'usr_b' }),
        }),
      ).ok,
    ).toBe(true);
    // Expiry just ahead.
    expect(computeAccess(input({ grant: grant({ expiresAt: NOW + 1 }) })).ok).toBe(true);
  });
});

describe('computeAccess: properties', () => {
  const accountSet = fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 8 });
  const toolSet = fc.option(fc.subarray([...CATALOG, 'unknown_tool']), { nil: null });
  const limitsArb: fc.Arbitrary<StoredLimits> = fc.record(
    {
      maxLimit: fc.integer({ min: 1, max: 5000 }),
      maxWindowDays: fc.integer({ min: 1, max: 3660 }),
      rawNrql: fc.boolean(),
      maxResponseBytes: fc.integer({ min: 1024, max: 16 * 1024 * 1024 }),
      eventTypes: fc.record(
        {
          allow: fc.subarray(['Transaction', 'Log', 'Span', 'Metric']),
          deny: fc.subarray(['Transaction', 'Log', 'Secret']),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  );

  it('never grants more than the project, the grant or the key allow', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 8 }),
        fc.option(accountSet, { nil: null }),
        accountSet,
        toolSet,
        toolSet,
        limitsArb,
        limitsArb,
        (allowed, grantAccounts, reachable, projectTools, grantTools, pLimits, gLimits) => {
          const p = project({
            allowedAccountIds: allowed,
            defaultAccountId: allowed[0] as number,
            enabledTools: projectTools,
            limits: pLimits,
          });
          const g = grant({ accountIds: grantAccounts, tools: grantTools, limits: gLimits });
          const d = computeAccess(
            input({ project: p, grant: g, credential: credential({ reachableAccountIds: reachable }) }),
          );
          if (!d.ok) {
            expect(['no_tools', 'no_accounts']).toContain(d.reason);
            return;
          }
          const a = d.access;
          for (const id of a.accounts.allowed) {
            expect(allowed).toContain(id);
            expect(reachable).toContain(id);
            if (grantAccounts !== null) expect(grantAccounts).toContain(id);
          }
          expect(a.accounts.allowed).toContain(a.accounts.default);
          expect(a.tools.length).toBeGreaterThan(0);
          for (const t of a.tools) {
            expect(CATALOG).toContain(t);
            if (projectTools !== null) expect(projectTools).toContain(t);
            if (grantTools !== null) expect(grantTools).toContain(t);
            if (!a.limits.rawNrql) expect(RAW_NRQL_TOOLS).not.toContain(t);
          }
          const base = limitsFrom(pLimits) as QueryLimits;
          expect(a.limits.maxLimit).toBeLessThanOrEqual(base.maxLimit);
          expect(a.limits.maxWindowDays).toBeLessThanOrEqual(base.maxWindowDays);
          expect(a.limits.maxResponseBytes).toBeLessThanOrEqual(base.maxResponseBytes);
          if (gLimits.maxLimit !== undefined) expect(a.limits.maxLimit).toBeLessThanOrEqual(gLimits.maxLimit);
          if (gLimits.maxWindowDays !== undefined) {
            expect(a.limits.maxWindowDays).toBeLessThanOrEqual(gLimits.maxWindowDays);
          }
          if (!base.rawNrql || gLimits.rawNrql === false) expect(a.limits.rawNrql).toBe(false);
          for (const allowList of [base.eventTypes.allow, gLimits.eventTypes?.allow]) {
            if (allowList === undefined) continue;
            expect(a.limits.eventTypes.allow).toBeDefined();
            for (const e of a.limits.eventTypes.allow ?? []) expect(allowList).toContain(e);
          }
          for (const e of [...(base.eventTypes.deny ?? []), ...(gLimits.eventTypes?.deny ?? [])]) {
            expect(a.limits.eventTypes.deny).toContain(e);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('any revoked, expired or disabled piece denies', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('project', 'grant', 'expiry', 'user', 'credential'),
        fc.integer({ min: 0, max: 2 * NOW }),
        (what, at) => {
          const over =
            what === 'project'
              ? { project: project({ disabledAt: at }) }
              : what === 'grant'
                ? { grant: grant({ revokedAt: at }) }
                : what === 'expiry'
                  ? { grant: grant({ expiresAt: Math.min(at, NOW) }) }
                  : what === 'user'
                    ? { user: user({ disabledAt: at }) }
                    : { credential: credential({ revokedAt: at }) };
          expect(computeAccess(input(over)).ok).toBe(false);
        },
      ),
    );
  });
});
