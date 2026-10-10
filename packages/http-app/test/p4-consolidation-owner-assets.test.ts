// SPDX-License-Identifier: Apache-2.0
// Phase 4 consolidation review H1: "only owners touch owners" covers an owner's keys, grants and tokens too.
// Without the guard an admin session issued a token on an owner's grant (and queried New Relic with the owner's
// personal key), re-pointed the owner's key, planted keys on the owner, made the owner's key a project default, and
// deleted the owner's grants. Report: docs/reviews/phase-4-review.md.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Captured, createHarness, type Harness, PUBLIC_ORIGIN } from './authz/harness.ts';

const A = '/api/admin/v1';
const OTHER_KEY = 'NRAK-ADMINSOWNKEY0123456789ABCDEFG';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const call = (method: string, path: string, headers: Readonly<Record<string, string>>, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
// biome-ignore lint/suspicious/noExplicitAny: answers are walked loosely
const j = (r: Captured) => JSON.parse(r.text) as Record<string, any>;
const ownerRefusal = (r: Captured) => {
  expect(r.status).toBe(403);
  expect(j(r)['error']?.code).toBe('forbidden');
};

async function world() {
  const owner = await h.addSession({ role: 'owner' });
  const admin = await h.addSession({ role: 'admin' });
  const projectId = await h.addProject('own');
  const ownerKey = await h.addCredential({ ownerUserId: owner.userId });
  const ownerGrant = await h.addGrant(projectId, { userId: owner.userId, credentialId: ownerKey });
  const ownerToken = await h.addToken(ownerGrant);
  return { owner, admin, projectId, ownerKey, ownerGrant, ownerToken };
}

describe("admins cannot act on an owner's keys, grants and tokens (review H1)", () => {
  it('refuses tokens on, and revoking or deleting, an owner grant', async () => {
    const w = await world();
    ownerRefusal(await call('POST', `${A}/tokens`, w.admin.headers, { grantId: w.ownerGrant, label: 'x' }));
    ownerRefusal(await call('POST', `${A}/grants/${w.ownerGrant}/revoke`, w.admin.headers));
    ownerRefusal(await call('DELETE', `${A}/grants/${w.ownerGrant}`, w.admin.headers));
    ownerRefusal(await call('POST', `${A}/tokens/${w.ownerToken.id}/revoke`, w.admin.headers));
    const grant = await h.world.storage.grants.get(w.ownerGrant);
    expect(grant?.revokedAt).toBeNull();
    expect((await h.world.storage.accessTokens.list({ grantId: w.ownerGrant })).length).toBe(1);
    expect((await h.world.storage.accessTokens.get(w.ownerToken.id))?.revokedAt).toBeNull();
  });

  it("refuses setting or clearing the usage quota of an owner's grant, and of a grant on an owner's key (P7-12)", async () => {
    const w = await world();
    const member = await h.addUser('mq@example.com', 'member');
    const onOwnerKey = await h.addGrant(w.projectId, { userId: member, credentialId: w.ownerKey });
    const body = { quota: { day: { queries: 5 } } };
    for (const id of [w.ownerGrant, onOwnerKey]) {
      ownerRefusal(await call('PUT', `${A}/grants/${id}/quota`, w.admin.headers, body));
      ownerRefusal(await call('PUT', `${A}/grants/${id}/quota`, w.admin.headers, { quota: null }));
      expect((await h.world.storage.grants.get(id))?.quota).toBeNull();
    }
    // Owners may, and an administrator may cap an ordinary member's grant.
    const ok = await call('PUT', `${A}/grants/${w.ownerGrant}/quota`, w.owner.headers, body);
    expect(ok.status, ok.text).toBe(200);
    const plain = await h.addGrant(w.projectId, { userId: member });
    const byAdmin = await call('PUT', `${A}/grants/${plain}/quota`, w.admin.headers, body);
    expect(byAdmin.status, byAdmin.text).toBe(200);
    // A member session has no role for it, and the usage view is for administrators.
    const m = await h.addSession({ role: 'member' });
    expect((await call('PUT', `${A}/grants/${plain}/quota`, m.headers, body)).status).toBe(403);
    expect((await call('GET', `${A}/usage/quotas`, m.headers)).status).toBe(403);
    expect((await call('GET', `${A}/usage/quotas`, w.admin.headers)).status).toBe(200);
  });

  it("refuses changing, rotating or deleting an owner's key, and planting one on the owner", async () => {
    const w = await world();
    ownerRefusal(await call('PATCH', `${A}/credentials/${w.ownerKey}`, w.admin.headers, { label: 'mine' }));
    ownerRefusal(
      await call('POST', `${A}/credentials/${w.ownerKey}/rotate`, w.admin.headers, { apiKey: OTHER_KEY }),
    );
    ownerRefusal(await call('DELETE', `${A}/credentials/${w.ownerKey}`, w.admin.headers));
    ownerRefusal(
      await call('POST', `${A}/credentials`, w.admin.headers, {
        label: 'planted',
        region: 'US',
        apiKey: OTHER_KEY,
        ownerUserId: w.owner.userId,
      }),
    );
    expect((await h.world.storage.credentials.list({ ownerUserId: w.owner.userId })).length).toBe(1);
  });

  it("refuses grants for an owner or on an owner's personal key, and making that key a project default", async () => {
    const w = await world();
    const member = await h.addUser('m@example.com', 'member');
    ownerRefusal(
      await call('POST', `${A}/grants`, w.admin.headers, {
        projectId: w.projectId,
        userId: w.owner.userId,
      }),
    );
    ownerRefusal(
      await call('POST', `${A}/projects`, w.admin.headers, {
        slug: 'via-default',
        defaultAccountId: 1,
        allowedAccountIds: [1],
        defaultCredentialId: w.ownerKey,
      }),
    );
    ownerRefusal(
      await call('PATCH', `${A}/projects/${w.projectId}`, w.admin.headers, {
        defaultCredentialId: w.ownerKey,
      }),
    );
    // An owner who made their own key a project's default shared it with that project: admins still grant on it.
    const ownerDefault = await h.addProject('owner-default', { credentialId: w.ownerKey });
    const shared = await call('POST', `${A}/grants`, w.admin.headers, {
      projectId: ownerDefault,
      userId: member,
    });
    expect(shared.status, shared.text).toBe(201);
  });

  it('owners and the admin token still can; admins keep managing everyone else', async () => {
    const w = await world();
    const ok = await call('POST', `${A}/tokens`, w.owner.headers, { grantId: w.ownerGrant, label: 'mine' });
    expect(ok.status).toBe(201);
    const member = await h.addUser('m2@example.com', 'member');
    const grant = await call('POST', `${A}/grants`, w.admin.headers, {
      projectId: w.projectId,
      userId: member,
    });
    expect(grant.status, grant.text).toBe(201);
    const token = await call('POST', `${A}/tokens`, w.admin.headers, {
      grantId: j(grant)['data'].id,
      label: 'm',
    });
    expect(token.status).toBe(201);
    expect((await call('DELETE', `${A}/grants/${j(grant)['data'].id}`, w.admin.headers)).status).toBe(204);
  });
});
