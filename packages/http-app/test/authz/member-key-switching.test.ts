// SPDX-License-Identifier: Apache-2.0
// P4-18 (phase 4 review L2, L8; THREAT_MODEL T3, T21): a member cannot widen an administrator-pinned grant by resetting
// it to the project default, and a personal key becomes a project default only when its owner makes that choice.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Captured, createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';

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

describe('PATCH /me/grants/{id} with credentialId null', () => {
  it('is refused while an administrator-chosen key is pinned, and leaves the grant alone', async () => {
    const member = await h.addSession({ role: 'member' });
    const projectId = await h.addProject('pinned');
    const pinned = await h.addCredential();
    const grantId = await h.addGrant(projectId, { userId: member.userId, credentialId: pinned });
    expect(code(await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: null }))).toBe(
      '422 not_permitted',
    );
    expect((await h.world.storage.grants.get(grantId))?.credentialId).toBe(pinned);
  });

  it('is allowed from the project default and from a key the member owns', async () => {
    const member = await h.addSession({ role: 'member' });
    const projectId = await h.addProject('free');
    const own = await h.addCredential({ ownerUserId: member.userId });
    const grantId = await h.addGrant(projectId, { userId: member.userId, credentialId: own });
    expect((await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: null })).status).toBe(200);
    expect((await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: null })).status).toBe(200);
  });

  it("still answers 404 for someone else's grant", async () => {
    const member = await h.addSession({ role: 'member' });
    const other = await h.addUser('o@example.com', 'member');
    const projectId = await h.addProject('foreign');
    const grantId = await h.addGrant(projectId, { userId: other });
    expect(code(await call(member, 'PATCH', `/me/grants/${grantId}`, { credentialId: null }))).toBe(
      '404 not_found',
    );
  });
});

describe('a personal key as a project default', () => {
  const body = (credentialId: string) => ({
    slug: 'p-default',
    defaultAccountId: 1,
    allowedAccountIds: [1],
    defaultCredentialId: credentialId,
  });

  it("is refused when an administrator picks a member's key", async () => {
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addUser('m@example.com', 'member');
    const key = await h.addCredential({ ownerUserId: member });
    const projectId = await h.addProject('upd');
    expect(code(await call(admin, 'POST', '/projects', body(key)))).toBe('422 not_permitted');
    expect(code(await call(admin, 'PATCH', `/projects/${projectId}`, { defaultCredentialId: key }))).toBe(
      '422 not_permitted',
    );
    expect((await h.world.storage.projects.get(projectId))?.defaultCredentialId).not.toBe(key);
  });

  it("is refused when an owner picks another user's key, and allowed for their own or a shared one", async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addUser('m2@example.com', 'member');
    const theirs = await h.addCredential({ ownerUserId: member });
    const mine = await h.addCredential({ ownerUserId: owner.userId });
    const shared = await h.addCredential();
    const projectId = await h.addProject('own-pick');
    expect(code(await call(owner, 'PATCH', `/projects/${projectId}`, { defaultCredentialId: theirs }))).toBe(
      '422 not_permitted',
    );
    expect((await call(owner, 'PATCH', `/projects/${projectId}`, { defaultCredentialId: mine })).status).toBe(
      200,
    );
    expect(
      (await call(owner, 'PATCH', `/projects/${projectId}`, { defaultCredentialId: shared })).status,
    ).toBe(200);
  });

  it('leaves an unchanged default alone when the project is edited again', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const mine = await h.addCredential({ ownerUserId: owner.userId });
    const projectId = await h.addProject('same', { credentialId: mine });
    const res = await call(owner, 'PATCH', `/projects/${projectId}`, {
      defaultCredentialId: mine,
      name: 'renamed',
    });
    expect(res.status, res.text).toBe(200);
  });
});
