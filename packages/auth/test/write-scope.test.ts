// SPDX-License-Identifier: Apache-2.0
// What widens write scope (P7-28, P7-32, THREAT_MODEL T31): pure rules the admin API's one owner guard applies.
import { createMemoryStorage, type GrantRecord, type ProjectRecord } from '@relic-bridge/storage';
import { fakeEncryptedKey } from '@relic-bridge/storage/testing';
import { describe, expect, it } from 'vitest';
import {
  credentialWriteScope,
  grantWriteScope,
  namesWriteTools,
  projectWriteScope,
  quotaWidens,
  tokenWriteScope,
  userWriteScope,
} from '../src/index.ts';

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord =>
  ({
    id: 'p',
    slug: 'p',
    name: null,
    defaultAccountId: 1,
    allowedAccountIds: [1, 2],
    enabledTools: ['whoami', 'close_issue'],
    limits: { rawNrql: false, maxLimit: 100 },
    defaultCredentialId: 'c1',
    disabledAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as ProjectRecord;

const grant = (over: Partial<GrantRecord> = {}): GrantRecord =>
  ({
    id: 'g',
    projectId: 'p',
    userId: null,
    label: 'svc',
    credentialId: null,
    tools: ['whoami', 'close_issue'],
    accountIds: null,
    limits: {},
    rateLimit: null,
    quota: { day: { queries: 100 }, month: { inspectedEvents: 1000 } },
    expiresAt: null,
    revokedAt: null,
    createdAt: 0,
    ...over,
  }) as GrantRecord;

describe('projectWriteScope', () => {
  it('flags adding write tools on create and update, not keeping or removing them', () => {
    expect(projectWriteScope(null, { enabledTools: ['close_issue'] }).addsWriteTools).toBe(true);
    expect(projectWriteScope(null, { enabledTools: null }).addsWriteTools).toBe(false);
    expect(projectWriteScope(project(), { enabledTools: ['close_issue'] })).toEqual({
      addsWriteTools: false,
      widened: [],
    });
    expect(
      projectWriteScope(project(), { enabledTools: ['close_issue', 'acknowledge_issue'] }).addsWriteTools,
    ).toBe(true);
  });

  it('flags every widening field of a project that writes', () => {
    const p = project({ disabledAt: 5 });
    expect(
      projectWriteScope(p, {
        allowedAccountIds: [1, 3],
        defaultAccountId: 2,
        defaultCredentialId: 'c2',
        limits: { rawNrql: true, maxLimit: 100 },
        disabled: false,
      }).widened,
    ).toEqual(['allowedAccountIds', 'defaultAccountId', 'defaultCredentialId', 'limits', 'disabled']);
  });

  it('lets narrowing and unchanged values through', () => {
    const p = project();
    expect(
      projectWriteScope(p, {
        allowedAccountIds: [1],
        defaultAccountId: 1,
        defaultCredentialId: null,
        limits: { maxLimit: 100, rawNrql: false },
        disabled: true,
      }).widened,
    ).toEqual([]);
    expect(projectWriteScope(p, { defaultCredentialId: 'c1' }).widened).toEqual([]);
  });

  it('a change that removes every write tool, or a project that does not write, widens nothing', () => {
    expect(
      projectWriteScope(project(), { enabledTools: ['whoami'], allowedAccountIds: [9] }).widened,
    ).toEqual([]);
    expect(projectWriteScope(project(), { enabledTools: null, limits: { rawNrql: true } }).widened).toEqual(
      [],
    );
    expect(
      projectWriteScope(project({ enabledTools: ['whoami'] }), { allowedAccountIds: [9], limits: {} })
        .widened,
    ).toEqual([]);
    expect(projectWriteScope(project({ enabledTools: null }), { allowedAccountIds: [9] }).widened).toEqual(
      [],
    );
  });
});

describe('grant, token and key scope', () => {
  it('quotaWidens: lifting or raising a cap, never adding or lowering one', () => {
    const q = { day: { queries: 100 } };
    expect(quotaWidens(null, q)).toBe(false);
    expect(quotaWidens(q, null)).toBe(true);
    expect(quotaWidens(q, { day: { queries: 101 } })).toBe(true);
    expect(quotaWidens(q, { month: { queries: 10 } })).toBe(true);
    expect(quotaWidens(q, { day: { queries: 50, inspectedEvents: 5 } })).toBe(false);
    expect(quotaWidens(q, { day: { queries: 100 }, warnPercent: 99 })).toBe(false);
  });

  it('grantWriteScope: write tools on a new grant; a wider quota on a grant that writes', () => {
    expect(grantWriteScope(null, { tools: ['close_issue'] }).addsWriteTools).toBe(true);
    expect(grantWriteScope(null, { tools: null }).addsWriteTools).toBe(false);
    expect(grantWriteScope(grant(), { quota: null }).widened).toEqual(['quota']);
    expect(
      grantWriteScope(grant(), { quota: { day: { queries: 1 }, month: { inspectedEvents: 1 } } }).widened,
    ).toEqual([]);
    expect(grantWriteScope(grant({ tools: ['whoami'] }), { quota: null }).widened).toEqual([]);
  });

  it('tokenWriteScope: only a grant that names a write tool', () => {
    expect(tokenWriteScope(grant()).widened).toEqual(['grantId']);
    expect(tokenWriteScope(grant({ tools: null })).widened).toEqual([]);
    expect(tokenWriteScope(null).widened).toEqual([]);
    expect(namesWriteTools(['whoami'])).toBe(false);
  });

  it('credentialWriteScope: a key a writing project or grant uses', async () => {
    const storage = createMemoryStorage();
    for (const id of ['c1', 'c2', 'c3']) {
      await storage.credentials.create({ id, label: id, region: 'US', key: fakeEncryptedKey() });
    }
    await storage.projects.create({
      id: 'pw',
      slug: 'pw',
      defaultAccountId: 1,
      allowedAccountIds: [1],
      enabledTools: ['close_issue'],
      defaultCredentialId: 'c1',
    });
    await storage.projects.create({
      id: 'pr',
      slug: 'pr',
      defaultAccountId: 1,
      allowedAccountIds: [1],
      enabledTools: null,
      defaultCredentialId: 'c3',
    });
    await storage.grants.create({
      id: 'g',
      projectId: 'pr',
      label: 'svc',
      credentialId: 'c2',
      tools: ['close_issue'],
    });
    expect((await credentialWriteScope(storage, 'c1')).widened).toEqual(['apiKey']);
    expect((await credentialWriteScope(storage, 'c2')).widened).toEqual(['apiKey']);
    expect((await credentialWriteScope(storage, 'c3')).widened).toEqual([]);
  });

  it('userWriteScope: re-enabling a user with a live grant that writes (P7-32)', async () => {
    const storage = createMemoryStorage();
    const user = async (id: string, disabled: boolean) => {
      const u = await storage.users.create({
        id,
        email: `${id}@example.com`,
        displayName: null,
        role: 'member',
      });
      return disabled ? storage.users.update(u.id, { disabledAt: 1 }) : u;
    };
    await storage.projects.create({
      id: 'pw',
      slug: 'pw',
      defaultAccountId: 1,
      allowedAccountIds: [1],
      enabledTools: ['close_issue'],
    });
    const writer = await user('usr_w', true);
    const reader = await user('usr_r', true);
    const revoked = await user('usr_x', true);
    const active = await user('usr_a', false);
    for (const [id, userId, tools] of [
      ['g1', 'usr_w', ['whoami', 'close_issue']],
      ['g2', 'usr_r', null],
      ['g3', 'usr_x', ['close_issue']],
      ['g4', 'usr_a', ['close_issue']],
    ] as const) {
      await storage.grants.create({
        id,
        projectId: 'pw',
        userId,
        label: null,
        tools: tools === null ? null : [...tools],
      });
    }
    await storage.grants.update('g3', { revokedAt: 1 });
    expect((await userWriteScope(storage, writer, { disabled: false })).widened).toEqual(['disabled']);
    // Disabling, other fields, a grant without write tools, a revoked grant, an already active user: nothing widens.
    expect((await userWriteScope(storage, writer, { disabled: true })).widened).toEqual([]);
    expect((await userWriteScope(storage, writer, {})).widened).toEqual([]);
    expect((await userWriteScope(storage, reader, { disabled: false })).widened).toEqual([]);
    expect((await userWriteScope(storage, revoked, { disabled: false })).widened).toEqual([]);
    expect((await userWriteScope(storage, active, { disabled: false })).widened).toEqual([]);
  });
});
