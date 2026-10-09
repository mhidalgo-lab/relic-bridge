// SPDX-License-Identifier: Apache-2.0
// Write scope owner boundary and write audit (P7-28, phase 7 review M5, THREAT_MODEL T31/T14) in the P2-12 suite. Runs
// on the HTTP app and on the Worker (`pnpm test:workers`). Mutations only reach the hostile NerdGraph stand-in.
//   - every admin path that writes a project, grant, token or key: an admin session that widens what a write-enabled
//     project or grant can reach gets 403; an owner and the admin token pass; narrowing stays open to admins
//   - re-enabling a user whose live grant writes (P7-32): admin session 403, owner and admin token pass; a user without
//     write grants stays an admin's to re-enable
//   - the write intent row is stored before the mutation, and an audit store failure sends no mutation
//   - a revoked write grant stops the next write at once, even with the access cache on
import type { Client } from '@modelcontextprotocol/client';
import { ERROR_META_KEY, ErrorCode, WRITE_TOOL_NAMES } from '@relic-bridge/core';
import { AUDIT_WRITE_INTENT_ACTION } from '@relic-bridge/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, connect } from '../fixtures.ts';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  authzHostKind,
  createHarness,
  type Harness,
  NR_KEY_B,
  PUBLIC_ORIGIN,
} from './harness.ts';

const WRITES = [...WRITE_TOOL_NAMES];
const ISSUE = 'issue-alpha-issue';
const ACK = { issue_id: ISSUE, account: 1, confirm: true } as const;
const MUTATIONS = new Set(['RbCreateChangeEvent', 'RbAckIssue', 'RbResolveIssue', 'RbCreateDashboard']);

let h: Harness;
let clients: Client[];
let shared: string;

beforeEach(async () => {
  h = await createHarness();
  clients = [];
  shared = await h.addCredential();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await h.scan();
  vi.useRealTimers();
});

const call = (app: AuthzApp, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    app,
  );

/** A project and grant that write (both name every write tool) on the shared key, with a quota on the grant. */
async function writeWorld(slug: string) {
  const projectId = await h.addProject(slug, {
    credentialId: shared,
    allowed: [1, 2],
    enabledTools: [...CATALOG, ...WRITES],
  });
  // A service grant: no user, so the owner-assets rule (an owner's grant) is not what refuses.
  const grantId = await h.addGrant(projectId, { userId: null, tools: [...CATALOG, ...WRITES] });
  await h.world.storage.grants.update(grantId, { quota: { day: { queries: 100 } } });
  return { projectId, grantId };
}

interface Case {
  readonly name: string;
  readonly method: string;
  readonly path: (w: { projectId: string; grantId: string; other: string }) => string;
  readonly body: (w: { projectId: string; grantId: string; other: string }) => unknown;
}

/** Every widening an admin session must be refused on a write-enabled project or grant. */
const WIDENING: readonly Case[] = [
  {
    name: 'project: more allowed accounts',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: () => ({ allowedAccountIds: [1, 2, 3] }),
  },
  {
    name: 'project: another default account',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: () => ({ defaultAccountId: 2 }),
  },
  {
    name: 'project: another default key',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: (w) => ({ defaultCredentialId: w.other }),
  },
  {
    name: 'project: raw NRQL turned on',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: () => ({ limits: { rawNrql: true, maxLimit: 5000 } }),
  },
  {
    name: 'project: re-enabled',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: () => ({ disabled: false }),
  },
  {
    name: 'project: another write tool',
    method: 'PATCH',
    path: (w) => `/projects/${w.projectId}`,
    body: () => ({ enabledTools: [...CATALOG, ...WRITES] }),
  },
  {
    name: 'grant: quota lifted',
    method: 'PUT',
    path: (w) => `/grants/${w.grantId}/quota`,
    body: () => ({ quota: null }),
  },
  {
    name: 'grant: quota raised',
    method: 'PUT',
    path: (w) => `/grants/${w.grantId}/quota`,
    body: () => ({ quota: { day: { queries: 1000 } } }),
  },
  {
    name: 'grant: a new token',
    method: 'POST',
    path: () => '/tokens',
    body: (w) => ({ grantId: w.grantId, label: 'sneaky' }),
  },
  {
    name: 'key: rotated under a project that writes',
    method: 'POST',
    path: () => `/credentials/${shared}/rotate`,
    body: () => ({ apiKey: NR_KEY_B }),
  },
  {
    name: 'grant: a write tool on a new grant',
    method: 'POST',
    path: () => '/grants',
    body: (w) => ({ projectId: w.projectId, userId: null, label: 'svc', tools: ['close_issue'] }),
  },
];

describe('admin API: only owners widen a write-enabled project or grant (P7-28)', () => {
  for (const c of WIDENING) {
    it(`${c.name}: admin session 403, owner and admin token allowed`, async () => {
      const app = h.makeApp({ writeTools: true });
      const admin = await h.addSession({ role: 'admin' });
      const owner = await h.addSession({ role: 'owner' });
      const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };
      const other = await h.addCredential({ key: NR_KEY_B });

      const slug = `ws-${Math.random().toString(36).slice(2, 8)}`;
      const w = { ...(await writeWorld(slug)), other };
      if (c.name === 'project: re-enabled') {
        await h.world.storage.projects.update(w.projectId, { disabledAt: h.world.clock.now() });
      }
      if (c.name === 'project: another write tool') {
        await h.world.storage.projects.update(w.projectId, { enabledTools: [...CATALOG, 'close_issue'] });
      }
      const before = JSON.stringify([
        await h.world.storage.projects.get(w.projectId),
        await h.world.storage.grants.get(w.grantId),
      ]);
      const refused = await call(app, c.method, c.path(w), admin.headers, c.body(w));
      expect(refused.status, refused.text).toBe(403);
      expect(refused.text).toMatch(/write_scope|write_tools/);
      // Nothing changed.
      expect(
        JSON.stringify([
          await h.world.storage.projects.get(w.projectId),
          await h.world.storage.grants.get(w.grantId),
        ]),
      ).toBe(before);

      const byOwner = await call(app, c.method, c.path(w), owner.headers, c.body(w));
      expect(byOwner.status, byOwner.text).not.toBe(403);
      const byToken = await call(app, c.method, c.path(w), bearer, c.body(w));
      expect(byToken.status, byToken.text).not.toBe(403);

      const rows = await h.auditRows();
      expect(rows.some((r) => r.kind === 'admin' && r.status === 'denied' && r.userId === admin.userId)).toBe(
        true,
      );
    });
  }

  it('narrowing stays open to an admin session', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const w = await writeWorld('ws-narrow');
    const patch = (body: unknown) => call(app, 'PATCH', `/projects/${w.projectId}`, admin.headers, body);
    expect((await patch({ allowedAccountIds: [1] })).status).toBe(200);
    expect((await patch({ name: 'renamed' })).status).toBe(200);
    expect((await patch({ disabled: true })).status).toBe(200);
    expect(
      (
        await call(app, 'PUT', `/grants/${w.grantId}/quota`, admin.headers, {
          quota: { day: { queries: 10 } },
        })
      ).status,
    ).toBe(200);
    expect((await call(app, 'POST', `/grants/${w.grantId}/revoke`, admin.headers)).status).toBe(200);
    // Removing every write tool, even with a wider account list in the same change: nothing writes afterwards.
    expect((await patch({ enabledTools: ['whoami'], allowedAccountIds: [1, 2, 3] })).status).toBe(200);
    // Now that it no longer writes, ordinary edits are an admin's again.
    expect((await patch({ disabled: false, limits: { rawNrql: true } })).status).toBe(200);
  });

  it('a project or grant without write tools is unaffected', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const projectId = await h.addProject('ws-read', { credentialId: shared, enabledTools: [...CATALOG] });
    const grantId = await h.addGrant(projectId, { userId: null, tools: [...CATALOG] });
    const patch = await call(app, 'PATCH', `/projects/${projectId}`, admin.headers, {
      allowedAccountIds: [1, 2, 3],
      limits: { rawNrql: true },
    });
    expect(patch.status, patch.text).toBe(200);
    const token = await call(app, 'POST', '/tokens', admin.headers, { grantId, label: 'ok' });
    expect(token.status, token.text).toBe(201);
    expect((await call(app, 'PUT', `/grants/${grantId}/quota`, admin.headers, { quota: null })).status).toBe(
      200,
    );
  });
});

describe('admin API: only owners re-enable a user whose grants write (P7-32)', () => {
  async function disabledUser(tools: readonly string[] | null) {
    const userId = await h.addUser(`${Math.random().toString(36).slice(2, 8)}@example.com`, 'member');
    const projectId = await h.addProject(`ru-${Math.random().toString(36).slice(2, 8)}`, {
      credentialId: shared,
      enabledTools: [...CATALOG, ...WRITES],
    });
    const grantId = await h.addGrant(projectId, { userId, tools: tools === null ? null : [...tools] });
    await h.world.storage.users.update(userId, { disabledAt: h.world.clock.now() });
    return { userId, grantId };
  }

  it('re-enabling a user with a write grant: admin session 403, owner and admin token allowed', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const owner = await h.addSession({ role: 'owner' });
    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const { userId } = await disabledUser([...CATALOG, 'close_issue']);
    const enable = (headers: Record<string, string>) =>
      call(app, 'PATCH', `/users/${userId}`, headers, { disabled: false });

    const refused = await enable(admin.headers);
    expect(refused.status, refused.text).toBe(403);
    expect(refused.text).toMatch(/write_scope/);
    expect((await h.world.storage.users.get(userId))?.disabledAt).not.toBeNull();
    const rows = await h.auditRows();
    expect(
      rows.some(
        (r) =>
          r.kind === 'admin' &&
          r.action === 'user.update' &&
          r.status === 'denied' &&
          r.userId === admin.userId &&
          r.targetId === userId,
      ),
    ).toBe(true);

    const byOwner = await enable(owner.headers);
    expect(byOwner.status, byOwner.text).toBe(200);
    expect((await h.world.storage.users.get(userId))?.disabledAt).toBeNull();

    await h.world.storage.users.update(userId, { disabledAt: h.world.clock.now() });
    const byToken = await enable(bearer);
    expect(byToken.status, byToken.text).toBe(200);
    expect((await h.world.storage.users.get(userId))?.disabledAt).toBeNull();
  });

  it('re-enabling a user without write grants, or with a revoked one, stays open to an admin session', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const reader = await disabledUser([...CATALOG]);
    const everyTool = await disabledUser(null);
    const revoked = await disabledUser([...CATALOG, ...WRITES]);
    await h.world.storage.grants.update(revoked.grantId, { revokedAt: h.world.clock.now() });
    for (const u of [reader, everyTool, revoked]) {
      const r = await call(app, 'PATCH', `/users/${u.userId}`, admin.headers, { disabled: false });
      expect(r.status, r.text).toBe(200);
    }
  });

  it('disabling a user with a write grant, and other edits, stay open to an admin session', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const { userId } = await disabledUser([...CATALOG, ...WRITES]);
    await h.world.storage.users.update(userId, { disabledAt: null });
    const patch = (body: unknown) => call(app, 'PATCH', `/users/${userId}`, admin.headers, body);
    expect((await patch({ displayName: 'Renamed' })).status).toBe(200);
    expect((await patch({ disabled: true })).status).toBe(200);
    // Already disabled: disabling again changes nothing, and a rename of a disabled user is not a re-enable.
    expect((await patch({ disabled: true, displayName: 'Again' })).status).toBe(200);
  });
});

async function writeClient(app: AuthzApp, slug: string) {
  const { grantId } = await writeWorld(slug);
  await h.world.storage.grants.update(grantId, { quota: null });
  const token = await h.addToken(grantId);
  const client = await connect(app, slug, token.value, 'modern');
  clients.push(client);
  return { client, grantId };
}

const codeOf = (result: unknown): string | undefined =>
  ((result as { _meta?: Record<string, { code?: string }> })._meta?.[ERROR_META_KEY] ?? {}).code;

describe('write audit before the mutation (P7-28)', () => {
  it('a write stores its intent row before the mutation, then its outcome row', async () => {
    const app = h.makeApp({ writeTools: true });
    const { client } = await writeClient(app, 'wa-ok');
    const r = await client.callTool({ name: 'acknowledge_issue', arguments: ACK });
    expect(r.isError ?? false, JSON.stringify(r).slice(0, 300)).toBe(false);
    await vi.waitFor(async () => {
      expect((await h.auditRows()).filter((x) => x.action === 'acknowledge_issue')).toHaveLength(1);
    });
    const rows = await h.auditRows();
    const intent = rows.find((x) => x.action === AUDIT_WRITE_INTENT_ACTION);
    const outcome = rows.find((x) => x.action === 'acknowledge_issue');
    expect(intent?.kind).toBe('tool_call');
    expect(intent?.targetId).toBe('acknowledge_issue');
    expect(intent?.requestId).toBe(outcome?.requestId);
    expect(intent?.accountIds).toEqual([1]);
    expect(intent?.details).toMatchObject({
      write: {
        phase: 'intent',
        input: { issue_id: ISSUE, account: 1 },
        record: { action: 'issue.acknowledge', applied: false, dryRun: false },
      },
    });
    expect(intent?.id ?? 0).toBeLessThan(outcome?.id ?? 0);
    // Not a call of its own: usage statistics count the outcome row only.
    const stats = await h.world.storage.auditLog.stats({
      since: h.world.clock.now() - 86_400_000,
      until: h.world.clock.now() + 86_400_000,
      groupBy: 'action',
    });
    expect(stats.map((s) => s.key)).not.toContain(AUDIT_WRITE_INTENT_ACTION);
  });

  it('dry runs and refusals store no intent row', async () => {
    const app = h.makeApp({ writeTools: true });
    const { client } = await writeClient(app, 'wa-dry');
    await client.callTool({ name: 'close_issue', arguments: { issue_id: ISSUE, account: 1, dry_run: true } });
    await client.callTool({ name: 'close_issue', arguments: { issue_id: ISSUE, account: 1 } });
    await vi.waitFor(async () => {
      expect((await h.auditRows()).filter((x) => x.action === 'close_issue')).toHaveLength(2);
    });
    expect((await h.auditRows()).some((x) => x.action === AUDIT_WRITE_INTENT_ACTION)).toBe(false);
  });

  it.skipIf(authzHostKind() !== 'http-app')(
    'an audit store failure refuses the write: no mutation is sent',
    async () => {
      const app = h.makeApp({ writeTools: true });
      const { client } = await writeClient(app, 'wa-fail');
      const append = h.world.storage.auditLog.append.bind(h.world.storage.auditLog);
      const spy = vi
        .spyOn(h.world.storage.auditLog, 'append')
        .mockImplementation(async (entry) =>
          entry.action === AUDIT_WRITE_INTENT_ACTION ? Promise.reject(new Error('disk full')) : append(entry),
        );
      try {
        const before = h.nerdGraph.calls.length;
        for (const [tool, args] of [
          ['acknowledge_issue', ACK],
          ['close_issue', { ...ACK, account: 2 }],
        ] as const) {
          const r = await client.callTool({ name: tool, arguments: args });
          expect(r.isError, tool).toBe(true);
          expect(codeOf(r), tool).toBe(ErrorCode.Internal);
          expect(JSON.stringify(r), tool).toContain('audit log could not record this write');
        }
        const made = h.nerdGraph.calls.slice(before);
        expect(made.filter((c) => MUTATIONS.has(c.op))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('write calls skip the access cache (P7-28)', () => {
  it('revoking a write grant blocks the next write at once, while reads may still be cached', async () => {
    const app = h.makeApp({ writeTools: true, accessCacheTtlMs: 30_000 });
    const { client, grantId } = await writeClient(app, 'wc-revoke');
    // Warm the cache.
    expect((await client.callTool({ name: 'whoami', arguments: {} })).isError ?? false).toBe(false);
    // Revoked behind the app's back (another process, the CLI on the same database): no cache flush here.
    await h.world.storage.grants.update(grantId, { revokedAt: h.world.clock.now() });
    const before = h.nerdGraph.calls.length;
    let refused = false;
    try {
      const r = await client.callTool({ name: 'acknowledge_issue', arguments: ACK });
      refused = r.isError === true;
    } catch {
      refused = true; // a 401 on the HTTP layer
    }
    expect(refused).toBe(true);
    expect(h.nerdGraph.calls.slice(before).filter((c) => MUTATIONS.has(c.op))).toEqual([]);
  });
});
