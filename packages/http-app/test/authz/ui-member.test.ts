// SPDX-License-Identifier: Apache-2.0
// The P4-15 member screens ("My access") on the whole app with real storage (HTTP app, and the Worker on D1 under the
// Workers pool): the BYO-key flow through the HTML forms only, strict IDOR (member A cannot see or change anything of
// member B's, an administrator's or a shared key), the caps, and secrets (a key is never sent back, a new device token
// appears once). The P2-12 leak scan runs after every test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Captured,
  createHarness,
  type Harness,
  NR_KEY_ADMIN,
  NR_KEY_B,
  PUBLIC_ORIGIN,
  type SessionCaller,
} from './harness.ts';
import { MCP_ROUTES, requestFor } from './matrix.ts';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

const browser = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

function open(s: SessionCaller, path: string): Promise<Captured> {
  return h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { headers: { cookie: s.cookie, ...browser } }));
}

function submit(
  s: SessionCaller,
  path: string,
  fields: Readonly<Record<string, string>> = {},
): Promise<Captured> {
  const body = new URLSearchParams({ _csrf: s.csrf, ...fields });
  return h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...browser,
      },
      body: body.toString(),
    }),
  );
}

/** A member with a grant on a fresh project (an administrator assigned it). */
async function memberWithGrant(slug: string) {
  const member = await h.addSession({ role: 'member' });
  const projectId = await h.addProject(slug);
  const grantId = await h.addGrant(projectId, { userId: member.userId });
  return { member, projectId, grantId };
}

const keyIdIn = (location: string): string => {
  const m = /^\/admin\/me\/keys\/([A-Za-z0-9_]+)$/.exec(location);
  expect(m, location).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
};

const occurrences = (needle: string): number =>
  h.responses.reduce((n, body) => n + body.split(needle).length - 1, 0);

describe('member screens: the BYO-key flow through the forms (P4-15)', () => {
  it('adds a key, points the grant at it and issues a device token that works', async () => {
    const { member, grantId } = await memberWithGrant('byo');

    const overview = await open(member, '/admin/me');
    expect(overview.status).toBe(200);
    expect(overview.text).toContain('<h1>My access</h1>');
    expect(overview.text).toContain('href="/admin/me/keys/new"');
    expect(overview.text).toContain('project default');

    const form = await open(member, '/admin/me/keys/new');
    expect(form.text).toMatch(/<input id="apiKey" name="apiKey" type="password"[^>]*autocomplete="off"/);
    const added = await submit(member, '/admin/me/keys', {
      label: 'My key',
      region: 'US',
      apiKey: NR_KEY_ADMIN,
    });
    expect(added.status, added.text.slice(0, 300)).toBe(303);
    const keyId = keyIdIn(added.headers.get('location') as string);
    const stored = await h.world.storage.credentials.get(keyId);
    expect(stored).toMatchObject({ label: 'My key', ownerUserId: member.userId });
    const detail = await open(member, `/admin/me/keys/${keyId}`);
    expect(detail.text).toContain(`•••• ${NR_KEY_ADMIN.slice(-4)}`);

    const pick = await open(member, `/admin/me/grants/${grantId}`);
    expect(pick.text).toContain(`value="${keyId}"`);
    expect((await submit(member, `/admin/me/grants/${grantId}`, { credentialId: keyId })).status).toBe(303);
    expect((await h.world.storage.grants.get(grantId))?.credentialId).toBe(keyId);

    const step2 = await open(member, `/admin/me/tokens/new?grant=${grantId}`);
    const once = /name="_once" value="([^"]+)"/.exec(step2.text)?.[1] as string;
    const fields = { grantId, label: 'laptop', lifetime: '90', _once: once };
    const issued = await submit(member, '/admin/me/tokens', fields);
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.headers.get('location')).toBeNull();
    const token = /<code id="token">([^<]+)<\/code>/.exec(issued.text)?.[1] as string;
    expect(token).toMatch(/^rb_/);
    expect(issued.text).toContain('http://localhost/p/byo/mcp');
    const reloaded = await submit(member, '/admin/me/tokens', fields);
    expect(reloaded.status).toBe(303);
    expect((await h.world.storage.accessTokens.list({ grantId })).length).toBe(1);

    const ok = await h.send(
      requestFor(MCP_ROUTES[0] as never, { headers: { authorization: `Bearer ${token}` }, slug: 'byo' }),
    );
    expect(ok.status).toBe(200);

    // Later pages list the token by prefix only; the token itself shows once (secret box) plus once in the Claude
    // Desktop snippet, and the key never.
    expect((await open(member, '/admin/me')).text).toContain('laptop');
    expect(occurrences(token)).toBe(2);
    expect(occurrences(NR_KEY_ADMIN)).toBe(0);

    // Revoke through the confirmation page.
    const record = (await h.world.storage.accessTokens.list({ grantId }))[0];
    const ask = await submit(member, `/admin/me/tokens/${record?.id}/revoke`);
    expect(ask.status).toBe(200);
    expect(ask.text).toContain('Revoke the token of laptop?');
    expect((await h.world.storage.accessTokens.get(record?.id as string))?.revokedAt).toBeNull();
    expect((await submit(member, `/admin/me/tokens/${record?.id}/revoke`, { confirm: 'yes' })).status).toBe(
      303,
    );
    expect((await h.world.storage.accessTokens.get(record?.id as string))?.revokedAt).not.toBeNull();

    // Every change was audited with the member as actor.
    const rows = (await h.auditRows()).filter((r) => r.kind === 'admin' && r.status === 'ok');
    for (const row of rows) expect(row.userId).toBe(member.userId);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['credential.create', 'grant.set_credential', 'token.create', 'token.revoke']),
    );
  });

  it('refuses a key New Relic does not know, and the form comes back without it', async () => {
    const { member } = await memberWithGrant('refused');
    const res = await submit(member, '/admin/me/keys', {
      label: 'bad',
      region: 'US',
      apiKey: 'not-a-user-key-0123456789abcdef',
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('New Relic refused this key');
    expect(res.text).not.toContain('not-a-user-key');
    expect((await h.world.storage.credentials.list({ ownerUserId: member.userId })).length).toBe(0);
  });
});

describe('member screens: strict IDOR (P4-15)', () => {
  it("member A cannot reach member B's, an administrator's or a shared key, grant or token", async () => {
    const a = await memberWithGrant('a-proj');
    const b = await memberWithGrant('b-proj');
    const admin = await h.addSession({ role: 'admin' });
    const bKey = await h.addCredential({ ownerUserId: b.member.userId });
    const adminKey = await h.addCredential({ ownerUserId: admin.userId });
    const sharedKey = await h.addCredential({ ownerUserId: null });
    const adminGrant = await h.addGrant(await h.addProject('admin-proj'), { userId: admin.userId });
    const serviceGrant = await h.addGrant(await h.addProject('svc-proj'), { userId: null });
    const bToken = await h.addToken(b.grantId);
    const bTokenId = (await h.world.storage.accessTokens.list({ grantId: b.grantId }))[0]?.id as string;
    const adminTokenId =
      (await h.world.storage.accessTokens.list({ grantId: adminGrant }))[0]?.id ?? 'tok_none';

    const snapshot = async () =>
      JSON.stringify([
        await h.world.storage.credentials.list(),
        await h.world.storage.grants.list(),
        await h.world.storage.accessTokens.list(),
      ]);
    const before = await snapshot();

    const foreign = [...[bKey, adminKey, sharedKey].map((id) => ['key', id] as const)];
    const paths: [string, string, Record<string, string>?][] = [];
    for (const [, id] of foreign) {
      paths.push(
        ['GET', `/admin/me/keys/${id}`],
        ['GET', `/admin/me/keys/${id}/rotate`],
        ['POST', `/admin/me/keys/${id}/rename`, { label: 'taken' }],
        ['POST', `/admin/me/keys/${id}/revalidate`],
        ['POST', `/admin/me/keys/${id}/rotate`, { apiKey: NR_KEY_B, confirm: 'yes' }],
        ['POST', `/admin/me/keys/${id}/delete`, { confirm: 'yes' }],
      );
    }
    for (const id of [b.grantId, adminGrant, serviceGrant]) {
      paths.push(
        ['GET', `/admin/me/grants/${id}`],
        ['GET', `/admin/me/tokens/new?grant=${id}`],
        ['POST', `/admin/me/grants/${id}`, { credentialId: '' }],
        ['POST', '/admin/me/tokens', { grantId: id, label: 'x', lifetime: '90' }],
      );
    }
    for (const id of [bTokenId, adminTokenId])
      paths.push(['POST', `/admin/me/tokens/${id}/revoke`, { confirm: 'yes' }]);
    // A's own grant, with a key that is not A's.
    for (const id of [bKey, adminKey, sharedKey])
      paths.push(['POST', `/admin/me/grants/${a.grantId}`, { credentialId: id }]);

    for (const [method, path, fields] of paths) {
      const res = method === 'GET' ? await open(a.member, path) : await submit(a.member, path, fields);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.text).toContain('<h1>Page not found</h1>');
    }
    expect(await snapshot()).toBe(before);

    // Nothing of theirs on A's pages.
    const page = (await open(a.member, '/admin/me')).text;
    for (const secret of [
      bKey,
      adminKey,
      sharedKey,
      b.grantId,
      adminGrant,
      serviceGrant,
      bTokenId,
      bToken.value,
      'b-proj',
    ])
      expect(page, secret).not.toContain(secret);

    // The refusals came from the API as the member (audited as such), never as an admin.
    expect((await h.auditRows()).filter((r) => r.kind === 'admin' && r.status === 'ok')).toEqual([]);
  });

  it("an administrator's own page lists only their own rows, not other users'", async () => {
    const admin = await h.addSession({ role: 'admin' });
    const mine = await h.addGrant(await h.addProject('admin-mine'), { userId: admin.userId });
    const b = await memberWithGrant('someone-else');
    const page = (await open(admin, '/admin/me')).text;
    expect(page).toContain('admin-mine');
    expect(page).not.toContain('someone-else');
    expect((await open(admin, `/admin/me/grants/${b.grantId}`)).status).toBe(404);
    expect((await open(admin, `/admin/me/grants/${mine}`)).status).toBe(200);
  });
});

describe('member screens: caps (P4-15)', () => {
  it('the 11th key and the 21st live token on a grant are refused with the API message', async () => {
    const { member, grantId } = await memberWithGrant('caps');
    for (let i = 0; i < 10; i++) await h.addCredential({ ownerUserId: member.userId });
    const key = await submit(member, '/admin/me/keys', {
      label: 'eleventh',
      region: 'US',
      apiKey: NR_KEY_ADMIN,
    });
    expect(key.status).toBe(409);
    expect(key.text).toContain('you can keep at most 10 keys');
    expect(key.text).not.toContain(NR_KEY_ADMIN);
    expect((await h.world.storage.credentials.list({ ownerUserId: member.userId })).length).toBe(10);

    for (let i = 0; i < 20; i++) await h.addToken(grantId);
    const step2 = await open(member, `/admin/me/tokens/new?grant=${grantId}`);
    const once = /name="_once" value="([^"]+)"/.exec(step2.text)?.[1] as string;
    const token = await submit(member, '/admin/me/tokens', {
      grantId,
      label: 'extra',
      lifetime: '90',
      _once: once,
    });
    expect(token.status).toBe(422);
    expect(token.text).toContain('at most 20 live tokens');
    expect((await h.world.storage.accessTokens.list({ grantId })).length).toBe(20);
  });
});
