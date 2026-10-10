// SPDX-License-Identifier: Apache-2.0
// "Apps connected with OAuth" in the admin UI (P5-05) on the whole app (HTTP app on memory, the Worker on D1 under the
// Workers pool): a member sees and disconnects their own apps only, an administrator a member's but not an owner's,
// the app's self-chosen name is escaped text, and a disconnected app's tokens stop at once. Leak scan after every test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthzApp,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
  type SessionCaller,
} from './harness.ts';
import { Client, type Consent, consentStandIn, type Tokens } from './oauth-suite.ts';

let h: Harness;
let app: AuthzApp;
let consent: Consent;
let client: Client;
let secrets: string[];

const HOSTILE_NAME = '<img src=x onerror=alert(1)>Claude';

beforeEach(async () => {
  h = await createHarness();
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
  consent = consentStandIn();
  secrets = [];
  app = h.makeApp({ oauth: { consent: consent.handler } });
  client = new Client(h, app, secrets);
  const res = await client.registerRaw({
    client_name: HOSTILE_NAME,
    redirect_uris: [client.redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(res.status, res.text).toBe(201);
  client.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
});

afterEach(async () => {
  await h.scan();
  // Tokens appear in the token responses by design; never in a log line, an audit row or a page.
  const pages = h.responses.filter((r) => r.trimStart().startsWith('<!'));
  const dump = `${pages.join('\n')}\n${h.logLines.join('\n')}\n${JSON.stringify(await h.auditRows())}`;
  for (const s of secrets) expect(dump.includes(s), 'an OAuth secret leaked').toBe(false);
  vi.useRealTimers();
});

const browser = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

const open = (s: SessionCaller, path: string): Promise<Captured> =>
  h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { headers: { cookie: s.cookie, ...browser } }), app);

const submit = (
  s: SessionCaller,
  path: string,
  fields: Readonly<Record<string, string>> = {},
): Promise<Captured> =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...browser,
      },
      body: new URLSearchParams({ _csrf: s.csrf, ...fields }).toString(),
    }),
    app,
  );

/** A signed-in user with a grant on prod and an app connected with OAuth for it. */
async function connected(role: 'member' | 'owner' = 'member') {
  const session = await h.addSession({ role });
  const grantId = await h.addGrant(h.world.projectIds.prod, { userId: session.userId });
  consent.next = { userId: session.userId, grantId };
  const t: Tokens = await client.tokens('prod');
  return { session, t, deviceId: `oauth_${t.access_token.split(':')[1]}` };
}

describe('apps connected with OAuth in the admin UI (P5-05)', () => {
  it('a member sees their app (escaped, marked not verified) and disconnects it after confirming', async () => {
    const { session, t, deviceId } = await connected();
    const page = await open(session, '/admin/me');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Apps connected with OAuth');
    expect(page.text).not.toContain(HOSTILE_NAME);
    expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt;Claude');
    expect(page.text).toContain('not verified');
    expect(page.text).toContain(`/admin/me/apps/${deviceId}/revoke`);

    const ask = await submit(session, `/admin/me/apps/${deviceId}/revoke`);
    expect(ask.status).toBe(200);
    expect(ask.text).toContain('Disconnect');
    expect((await client.mcp('prod', t.access_token)).status).toBe(200);

    const done = await submit(session, `/admin/me/apps/${deviceId}/revoke`, { confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/me');
    expect((await client.mcp('prod', t.access_token)).status).toBe(401);
    expect((await open(session, '/admin/me')).text).not.toContain('Apps connected with OAuth');
  });

  it("another member can't disconnect it (404 page), nor reach the user pages", async () => {
    const { session, t, deviceId } = await connected();
    const intruder = await h.addSession({ role: 'member' });
    expect((await open(intruder, '/admin/me')).text).not.toContain(deviceId);
    const res = await submit(intruder, `/admin/me/apps/${deviceId}/revoke`, { confirm: 'yes' });
    expect(res.status).toBe(404);
    const other = await submit(intruder, `/admin/users/${session.userId}/apps/${deviceId}/revoke`, {
      confirm: 'yes',
    });
    expect(other.status).toBe(403);
    expect((await client.mcp('prod', t.access_token)).status).toBe(200);
  });

  it("an admin disconnects a member's app from the user page, but not an owner's", async () => {
    const member = await connected('member');
    const owner = await connected('owner');
    const admin = await h.addSession({ role: 'admin' });

    const memberPage = await open(admin, `/admin/users/${member.session.userId}`);
    expect(memberPage.status).toBe(200);
    expect(memberPage.text).toContain(`/admin/users/${member.session.userId}/apps/${member.deviceId}/revoke`);
    const ownerPage = await open(admin, `/admin/users/${owner.session.userId}`);
    expect(ownerPage.text).toContain('Apps connected with OAuth');
    expect(ownerPage.text).not.toContain(`/apps/${owner.deviceId}/revoke`);

    const refused = await submit(
      admin,
      `/admin/users/${owner.session.userId}/apps/${owner.deviceId}/revoke`,
      {
        confirm: 'yes',
      },
    );
    expect(refused.status).toBe(303);
    expect((await client.mcp('prod', owner.t.access_token)).status).toBe(200);

    const done = await submit(admin, `/admin/users/${member.session.userId}/apps/${member.deviceId}/revoke`, {
      confirm: 'yes',
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`/admin/users/${member.session.userId}`);
    expect((await client.mcp('prod', member.t.access_token)).status).toBe(401);
  });
});
