// SPDX-License-Identifier: Apache-2.0
// Member self-service API (P4-10, THREAT_MODEL T3/T13/T14): a signed-in user manages their own keys, sees their own
// grants and issues and revokes device tokens on them, and can reach nothing of anyone else's. A row that belongs to
// someone else answers exactly like a row that does not exist. The route/role rules are in the P2-12 matrix.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  type Captured,
  createHarness,
  type Harness,
  NR_KEY_ADMIN,
  NR_KEY_B,
  PUBLIC_ORIGIN,
} from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

type Who = { readonly headers: Readonly<Record<string, string>>; readonly userId?: string };
const call = (who: Who, method: string, path: string, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { ...who.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const json = (r: Captured) => JSON.parse(r.text);
const code = (r: Captured) => `${r.status} ${json(r).error?.code ?? ''}`.trim();

/** A member with a project grant (as an administrator would assign it). */
async function memberWithGrant(slug: string) {
  const member = await h.addSession({ role: 'member' });
  const projectId = await h.addProject(slug);
  const grantId = await h.addGrant(projectId, { userId: member.userId });
  return { member, projectId, grantId };
}

describe('the BYO-key flow as a member', () => {
  it('adds a key, sees the grant, points it at the key and issues a device token', async () => {
    const { member, grantId } = await memberWithGrant('byo');
    const added = await call(member, 'POST', '/me/credentials', {
      label: 'my key',
      region: 'US',
      apiKey: NR_KEY_ADMIN,
    });
    expect(added.status).toBe(201);
    const credential = json(added).data;
    expect(credential).toMatchObject({ label: 'my key', ownerUserId: member.userId });
    expect(added.text).not.toContain(NR_KEY_ADMIN);

    const grants = json(await call(member, 'GET', '/me/grants')).data;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: grantId, project: { slug: 'byo', disabled: false } });

    const set = await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: credential.id });
    expect(set.status).toBe(200);
    expect(json(set).data).toMatchObject({ id: grantId, credentialId: credential.id });

    const issued = await call(member, 'POST', '/me/tokens', { grantId, label: 'laptop' });
    expect(issued.status).toBe(201);
    const { token, data } = json(issued);
    expect(token).toMatch(/^rb_/);
    expect(data).toMatchObject({ grantId, label: 'laptop' });
    const listed = await call(member, 'GET', '/me/tokens');
    expect(json(listed).data.map((t: { id: string }) => t.id)).toEqual([data.id]);
    expect(listed.text).not.toContain(token);

    // The new token really works on the project.
    const mcp = await h.send(
      new Request(`${PUBLIC_ORIGIN}/p/byo/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      }),
    );
    expect(mcp.status).toBe(200);

    expect((await call(member, 'POST', `/me/tokens/${data.id}/revoke`)).status).toBe(200);
    expect(json(await call(member, 'GET', '/me/tokens')).data[0].revokedAt).not.toBeNull();

    // Rename, rotate, revalidate, then the key cannot be deleted while the grant uses it.
    expect(
      (await call(member, 'PATCH', `/me/credentials/${credential.id}`, { label: 'renamed' })).status,
    ).toBe(200);
    expect(
      (await call(member, 'POST', `/me/credentials/${credential.id}/rotate`, { apiKey: NR_KEY_B })).status,
    ).toBe(200);
    expect((await call(member, 'POST', `/me/credentials/${credential.id}/revalidate`)).status).toBe(200);
    expect(code(await call(member, 'DELETE', `/me/credentials/${credential.id}`))).toBe('409 conflict');
    expect((await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: null })).status).toBe(200);
    expect((await call(member, 'DELETE', `/me/credentials/${credential.id}`)).status).toBe(204);

    // Every change is audited with the member as actor and marked as self-service; no secret in any row.
    const rows = (await h.auditRows()).filter((r) => r.kind === 'admin' && r.status === 'ok');
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'credential.create',
        'grant.set_credential',
        'token.create',
        'token.revoke',
        'credential.update',
        'credential.rotate',
        'credential.revalidate',
        'credential.delete',
      ]),
    );
    for (const row of rows) {
      expect(row.userId).toBe(member.userId);
      expect(row.details).toMatchObject({ self: true, via: 'session' });
    }
  });
});

describe("a member cannot reach another user's resources (IDOR)", () => {
  it("another member's and an admin's keys, grants and tokens answer like missing rows", async () => {
    const mine = await memberWithGrant('mine');
    const theirs = await memberWithGrant('theirs');
    const admin = await h.addSession({ role: 'admin' });
    const theirKey = await h.addCredential({ ownerUserId: theirs.member.userId });
    const adminKey = await h.addCredential({ ownerUserId: admin.userId });
    const sharedKey = await h.addCredential({ ownerUserId: null });
    const theirToken = await h.addToken(theirs.grantId);
    const service = await h.addGrant(theirs.projectId, { userId: null });
    const serviceToken = await h.addToken(service);
    const before = JSON.stringify([
      await h.world.storage.credentials.list(),
      await h.world.storage.grants.list(),
      await h.world.storage.accessTokens.list({}),
    ]);

    // Lists show nothing of theirs.
    const myKeys = json(await call(mine.member, 'GET', '/me/credentials')).data;
    expect(myKeys).toEqual([]);
    expect(json(await call(mine.member, 'GET', '/me/grants')).data.map((g: { id: string }) => g.id)).toEqual([
      mine.grantId,
    ]);
    expect(json(await call(mine.member, 'GET', '/me/tokens')).data).toEqual([]);
    expect(code(await call(mine.member, 'GET', `/me/tokens?grantId=${theirs.grantId}`))).toBe(
      '404 not_found',
    );
    expect(code(await call(mine.member, 'GET', `/me/tokens?grantId=${service}`))).toBe('404 not_found');

    const missing = code(await call(mine.member, 'DELETE', '/me/credentials/cred_none'));
    expect(missing).toBe('404 not_found');
    for (const key of [theirKey, adminKey, sharedKey]) {
      expect(code(await call(mine.member, 'PATCH', `/me/credentials/${key}`, { label: 'x' }))).toBe(missing);
      expect(code(await call(mine.member, 'DELETE', `/me/credentials/${key}`))).toBe(missing);
      expect(
        code(await call(mine.member, 'POST', `/me/credentials/${key}/rotate`, { apiKey: NR_KEY_B })),
      ).toBe(missing);
      expect(code(await call(mine.member, 'POST', `/me/credentials/${key}/revalidate`))).toBe(missing);
      // Pointing my grant at a key that is not mine.
      expect(
        code(await call(mine.member, 'PATCH', `/me/grants/${mine.grantId}`, { credentialId: key })),
      ).toBe(missing);
    }
    for (const grant of [theirs.grantId, service]) {
      expect(code(await call(mine.member, 'PATCH', `/me/grants/${grant}`, { credentialId: null }))).toBe(
        missing,
      );
      expect(code(await call(mine.member, 'POST', '/me/tokens', { grantId: grant, label: 'x' }))).toBe(
        missing,
      );
    }
    for (const token of [theirToken.id, serviceToken.id]) {
      expect(code(await call(mine.member, 'POST', `/me/tokens/${token}/revoke`))).toBe(missing);
    }
    expect(
      JSON.stringify([
        await h.world.storage.credentials.list(),
        await h.world.storage.grants.list(),
        await h.world.storage.accessTokens.list({}),
      ]),
    ).toBe(before);
    expect(await h.world.storage.accessTokens.get(theirToken.id)).toMatchObject({ revokedAt: null });
    // The refusals are audited and none claims success.
    const refused = (await h.auditRows()).filter(
      (r) => r.kind === 'admin' && r.userId === mine.member.userId && r.status !== 'ok',
    );
    expect(refused.length).toBeGreaterThan(10);
  });

  it('ignores ownership and user fields in bodies and queries', async () => {
    const { member } = await memberWithGrant('fields');
    const other = await h.addUser('victim@example.com', 'member');
    // The strict schema refuses `ownerUserId` instead of silently honouring it.
    const res = await call(member, 'POST', '/me/credentials', {
      label: 'k',
      region: 'US',
      apiKey: NR_KEY_ADMIN,
      ownerUserId: other,
    });
    expect(code(res)).toBe('400 invalid_request');
    expect(await h.world.storage.credentials.list({ ownerUserId: other })).toEqual([]);
    expect(code(await call(member, 'GET', `/me/credentials?ownerUserId=${other}`))).toBe(
      '400 invalid_request',
    );
    expect(code(await call(member, 'GET', `/me/grants?userId=${other}`))).toBe('400 invalid_request');
  });

  it('a revoked grant takes no new token and no key; an admin session sees only its own too', async () => {
    const { member, grantId } = await memberWithGrant('revoked');
    await h.world.storage.grants.update(grantId, { revokedAt: 1 });
    expect(code(await call(member, 'POST', '/me/tokens', { grantId, label: 'x' }))).toBe('409 conflict');
    const key = json(
      await call(member, 'POST', '/me/credentials', { label: 'k', region: 'US', apiKey: NR_KEY_ADMIN }),
    ).data.id;
    expect(code(await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: key }))).toBe(
      '409 conflict',
    );

    const admin = await h.addSession({ role: 'admin' });
    expect(json(await call(admin, 'GET', '/me/credentials')).data).toEqual([]);
    expect(json(await call(admin, 'GET', '/me/grants')).data).toEqual([]);
    expect(code(await call(admin, 'DELETE', `/me/credentials/${key}`))).toBe('404 not_found');
  });

  it('refuses the admin token (it owns nothing), a missing CSRF token and a foreign origin', async () => {
    const { member, grantId } = await memberWithGrant('csrf');
    const token = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
    expect(code(await call(token, 'GET', '/me/grants'))).toBe('403 forbidden');
    expect(code(await call(token, 'POST', '/me/tokens', { grantId, label: 'x' }))).toBe('403 forbidden');
    const { 'x-csrf-token': _drop, ...noCsrf } = member.headers;
    expect((await call({ headers: noCsrf }, 'POST', '/me/tokens', { grantId, label: 'x' })).status).toBe(403);
    expect(
      (
        await call({ headers: { ...member.headers, origin: 'https://evil.example' } }, 'POST', '/me/tokens', {
          grantId,
          label: 'x',
        })
      ).status,
    ).toBe(403);
    expect(await h.world.storage.accessTokens.list({ grantId })).toEqual([]);
  });
});

describe('limits', () => {
  it('caps keys per user and live tokens per grant', async () => {
    const { member, grantId } = await memberWithGrant('caps');
    for (let i = 0; i < 10; i++) await h.addCredential({ ownerUserId: member.userId });
    expect(
      code(await call(member, 'POST', '/me/credentials', { label: 'k', region: 'US', apiKey: NR_KEY_ADMIN })),
    ).toBe('409 conflict');
    for (let i = 0; i < 20; i++) await h.addToken(grantId);
    expect(code(await call(member, 'POST', '/me/tokens', { grantId, label: 'x' }))).toBe('409 conflict');
  });
});
