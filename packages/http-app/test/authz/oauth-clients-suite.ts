// SPDX-License-Identifier: Apache-2.0
// OAuth clients in the admin API and panel (P5-08): the owner's list, removing a client with everything issued to it,
// and the runtime switch for dynamic client registration, with the negative authorization cases. Runs on every authz
// host: memory (`oauth-clients-admin.test.ts`), SQLite (`apps/cli/test/oauth-clients-sqlite.test.ts`) and the Worker on
// local D1 (`pnpm test:workers`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  authzHostKind,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
  type SessionCaller,
} from './harness.ts';
import {
  CLAUDE_AI_CALLBACK,
  CLAUDE_AI_ID,
  Client,
  type Consent,
  claudeAiDoc,
  consentStandIn,
  docServer,
  ISSUER,
  jsonDoc,
  type Tokens,
} from './oauth-suite.ts';

const A = `${ISSUER}/api/admin/v1`;
const HOSTILE_NAME = '<img src=x onerror=alert(1)>Claude';
const browser = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

export function oauthClientsSuite(): void {
  let h: Harness;
  let consent: Consent;
  let app: AuthzApp;
  let client: Client;
  let secrets: string[];

  const build = (over: Record<string, unknown> = {}) => {
    app = h.makeApp({ oauth: { consent: consent.handler, accessTokenTtlSeconds: 600, ...over } });
    client = new Client(h, app, secrets);
    return app;
  };

  beforeEach(async () => {
    h = await createHarness();
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
    consent = consentStandIn();
    secrets = [];
    build();
  });

  afterEach(async () => {
    await h.scan();
    const pages = h.responses.filter((r) => r.trimStart().startsWith('<!'));
    const dump = `${pages.join('\n')}\n${h.logLines.join('\n')}\n${JSON.stringify(await h.auditRows())}`;
    for (const s of secrets) expect(dump.includes(s), 'an OAuth secret leaked').toBe(false);
    vi.useRealTimers();
  });

  const advance = (ms: number): void => {
    h.world.clock.advance(ms);
    vi.setSystemTime(h.world.clock.now());
  };
  const api = (
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: unknown,
    on: AuthzApp = app,
  ): Promise<Captured> =>
    h.send(
      new Request(`${A}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      on,
    );
  const asAdminToken = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const data = (res: Captured) => (JSON.parse(res.text) as { data: unknown }).data;

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

  /** A user with a grant on prod and an app connected for it (the current `client`, registered here if needed). */
  async function connect(role: 'member' | 'owner' = 'member') {
    const session = await h.addSession({ role });
    const grantId = await h.addGrant(h.world.projectIds.prod, { userId: session.userId });
    consent.next = { userId: session.userId, grantId };
    const t: Tokens = await client.tokens('prod');
    secrets.push(t.access_token, t.refresh_token);
    return { session, t };
  }
  async function registerClient(name = HOSTILE_NAME): Promise<void> {
    const res = await client.registerRaw({
      client_name: name,
      redirect_uris: [client.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.status, res.text).toBe(201);
    client.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
  }
  const refresh = (c: Client, t: Tokens): Promise<Captured> =>
    c.form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: c.clientId,
      resource: `${ISSUER}/p/prod/mcp`,
    });
  const adminRow = async (action: string) => {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      row = (await h.auditRows()).find((r) => r.action === action) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error(`no ${action} row`);
    });
    return row as Record<string, unknown>;
  };

  describe('the list (P5-08)', () => {
    it('shows registered clients to owners: untrusted name as data, kind, redirect hosts, no secrets', async () => {
      await registerClient();
      const owner = await h.addSession({ role: 'owner' });
      for (const headers of [owner.headers, asAdminToken]) {
        const res = await api('GET', '/oauth/clients', headers);
        expect(res.status, res.text).toBe(200);
        const body = JSON.parse(res.text) as { data: Record<string, unknown>[]; nextCursor: null };
        expect(body.nextCursor).toBeNull();
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toEqual({
          id: client.clientId,
          kind: 'dynamic',
          name: HOSTILE_NAME,
          host: null,
          redirectHosts: ['127.0.0.1'],
          registeredAt: expect.any(Number),
          expiresAt: expect.any(Number),
        });
        expect(res.text).not.toMatch(/secret|redirectUris/i);
        expect((body as { truncated?: boolean }).truncated).toBe(false);
      }
    });

    it('lists the newest clients first even with more than 500 records, and says when it cut (P5-10)', async () => {
      const now = Math.floor(h.world.clock.now() / 1000);
      // Key order puts the newest registration last: cutting before sorting would hide it.
      for (let i = 0; i < 510; i++) {
        const id = `flood${String(i).padStart(4, '0')}`;
        const registered = i === 509 ? now : now - 10_000 + i;
        await h.world.storage.kv.put(
          `oauth:client:${id}`,
          JSON.stringify({
            clientId: id,
            clientName: id,
            redirectUris: ['http://127.0.0.1/cb'],
            registrationDate: registered,
          }),
          { expirationTtl: 3600 },
        );
      }
      const owner = await h.addSession({ role: 'owner' });
      const res = await api('GET', '/oauth/clients', owner.headers);
      expect(res.status, res.text).toBe(200);
      const body = JSON.parse(res.text) as {
        data: { id: string; registeredAt: number }[];
        truncated: boolean;
      };
      expect(body.data).toHaveLength(500);
      expect(body.truncated).toBe(true);
      expect(body.data[0]?.id).toBe('flood0509');
      const times = body.data.map((c) => c.registeredAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('lists a cached metadata-document client with the host that vouches for it', async () => {
      const docs = docServer();
      docs.docs.set(CLAUDE_AI_ID, jsonDoc(claudeAiDoc()));
      build({ clientMetadataDocuments: { fetch: docs.fetch } });
      const cimd = new Client(h, app, secrets);
      cimd.clientId = CLAUDE_AI_ID;
      cimd.redirectUri = CLAUDE_AI_CALLBACK;
      const session = await h.addSession({ role: 'member' });
      consent.next = {
        userId: session.userId,
        grantId: await h.addGrant(h.world.projectIds.prod, { userId: session.userId }),
      };
      const t = await cimd.tokens('prod');
      secrets.push(t.access_token, t.refresh_token);
      const owner = await h.addSession({ role: 'owner' });
      const rows = data(await api('GET', '/oauth/clients', owner.headers)) as Record<string, unknown>[];
      expect(rows).toEqual([
        expect.objectContaining({
          id: CLAUDE_AI_ID,
          kind: 'metadata_document',
          name: 'Claude',
          host: 'claude.ai',
          redirectHosts: ['claude.ai'],
        }),
      ]);
      // Removal works while the cached record is still there, and the client can start over (consent again).
      const removed = await api('POST', '/oauth/clients/remove', owner.headers, { clientId: CLAUDE_AI_ID });
      expect(removed.status, removed.text).toBe(200);
      expect(data(removed)).toMatchObject({ devicesRevoked: 1 });
      expect((await cimd.mcp('prod', t.access_token)).status).toBe(401);
      expect((await refresh(cimd, t)).status).toBe(400);
    });
  });

  describe('removing a client (P5-08)', () => {
    it("ends every user's tokens of that client at once, forgets approvals, audits, and spares other clients", async () => {
      await registerClient();
      const first = await connect('member');
      const second = await connect('member');
      // Another client with its own device, and a remembered approval of each client.
      const other = new Client(h, app, secrets);
      await other.register();
      const third = await h.addSession({ role: 'member' });
      consent.next = {
        userId: third.userId,
        grantId: await h.addGrant(h.world.projectIds.prod, { userId: third.userId }),
      };
      const kept = await other.tokens('prod');
      secrets.push(kept.access_token, kept.refresh_token);
      const approval = (clientId: string) =>
        JSON.stringify({
          grantId: 'grt_x',
          clientId,
          scope: ['mcp:read'],
          label: null,
          clientName: 'x',
          clientKind: 'dynamic',
          clientHost: null,
          redirectHost: '127.0.0.1',
          projectSlug: 'prod',
          grantLabel: 'g',
          expiresAt: Date.now() + 1e6,
        });
      const kv = h.world.storage.kv;
      await kv.put(`oauth-consent:${first.session.userId}:aaaa`, approval(client.clientId));
      await kv.put(`oauth-consent:${second.session.userId}:bbbb`, approval(client.clientId));
      await kv.put(`oauth-consent:${third.userId}:cccc`, approval(other.clientId));

      const owner = await h.addSession({ role: 'owner' });
      const before = (data(await api('GET', '/oauth/clients', owner.headers)) as unknown[]).length;
      expect(before).toBe(2);
      const res = await api('POST', '/oauth/clients/remove', owner.headers, { clientId: client.clientId });
      expect(res.status, res.text).toBe(200);
      expect(data(res)).toMatchObject({
        client: { id: client.clientId, kind: 'dynamic' },
        devicesRevoked: 2,
        approvalsForgotten: 2,
      });

      for (const t of [first.t, second.t]) {
        expect((await client.mcp('prod', t.access_token)).status).toBe(401);
        const again = await refresh(client, t);
        expect([400, 401]).toContain(again.status);
        expect(again.text).not.toContain('access_token');
      }
      expect((await other.mcp('prod', kept.access_token)).status).toBe(200);
      expect((await refresh(other, kept)).status).toBe(200);
      expect(await kv.get(`oauth-consent:${first.session.userId}:aaaa`)).toBeNull();
      expect(await kv.get(`oauth-consent:${third.userId}:cccc`)).not.toBeNull();
      const listed = data(await api('GET', '/oauth/clients', owner.headers)) as { id: string }[];
      expect(listed.map((c) => c.id)).toEqual([other.clientId]);
      // A removed client's code or refresh request is refused; it cannot start a new authorization either.
      const authorize = await client.send(
        new Request(client.authorizeUrl({ resource: `${ISSUER}/p/prod/mcp` })),
      );
      expect(authorize.status).toBeGreaterThanOrEqual(400);

      const row = await adminRow('oauth_client.remove');
      expect(row).toMatchObject({ status: 'ok', targetType: 'oauth_client', userId: owner.userId });
      expect(row['details']).toMatchObject({
        clientKind: 'dynamic',
        devicesRevoked: 2,
        approvalsForgotten: 2,
        via: 'session',
      });
      expect(JSON.stringify(row)).not.toContain(HOSTILE_NAME);

      // Gone: removing it again is a 404, and so is an id nobody knows.
      expect(
        (await api('POST', '/oauth/clients/remove', owner.headers, { clientId: client.clientId })).status,
      ).toBe(404);
      expect((await api('POST', '/oauth/clients/remove', owner.headers, { clientId: 'nobody' })).status).toBe(
        404,
      );
    });

    it('a removal that stops at its work budget finishes when repeated (P5-11, L6)', async () => {
      build({ clientRemovalBudget: { scan: 3, revoke: 2 } });
      await registerClient();
      const users = [];
      for (let i = 0; i < 5; i += 1) users.push(await connect('member'));
      const owner = await h.addSession({ role: 'owner' });
      const remove = async () => {
        const res = await api('POST', '/oauth/clients/remove', owner.headers, { clientId: client.clientId });
        expect(res.status, res.text).toBe(200);
        return data(res) as { devicesRevoked: number; complete: boolean };
      };
      let total = 0;
      let calls = 0;
      let last = { devicesRevoked: 0, complete: false };
      while (!last.complete) {
        calls += 1;
        expect(calls).toBeLessThan(30);
        last = await remove();
        total += last.devicesRevoked;
        if (!last.complete && calls === 1) {
          // The record is gone at once; devices not reached yet are still being revoked.
          const listed = data(await api('GET', '/oauth/clients', owner.headers)) as unknown[];
          expect(listed).toHaveLength(0);
        }
      }
      expect(calls).toBeGreaterThan(1);
      expect(total).toBe(5);
      for (const u of users) expect((await client.mcp('prod', u.t.access_token)).status).toBe(401);
      // Done: the marker is cleared, so the same id is unknown now.
      expect(
        (await api('POST', '/oauth/clients/remove', owner.headers, { clientId: client.clientId })).status,
      ).toBe(404);
    });

    it('rejects malformed bodies', async () => {
      const owner = await h.addSession({ role: 'owner' });
      for (const body of [{}, { clientId: '' }, { clientId: 'x'.repeat(513) }, { clientId: 'a', extra: 1 }]) {
        const res = await api('POST', '/oauth/clients/remove', owner.headers, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  describe('dynamic client registration switch (P5-08)', () => {
    const dcr = (): Promise<Captured> =>
      client.registerRaw({
        client_name: 'late',
        redirect_uris: [client.redirectUri],
        token_endpoint_auth_method: 'none',
      });
    const metadata = async (on: AuthzApp = app): Promise<Record<string, unknown>> =>
      JSON.parse(
        (await h.send(new Request(`${ISSUER}/.well-known/oauth-authorization-server`), on)).text,
      ) as Record<string, unknown>;

    it('off: /oauth/register is 404 and the metadata has no registration_endpoint; on again restores both', async () => {
      const owner = await h.addSession({ role: 'owner' });
      expect(data(await api('GET', '/oauth/registration', owner.headers))).toEqual({
        enabled: true,
        deployment: true,
        setting: true,
      });
      expect((await dcr()).status).toBe(201);
      expect(await metadata()).toHaveProperty('registration_endpoint');

      const off = await api('POST', '/oauth/registration', owner.headers, { enabled: false });
      expect(off.status, off.text).toBe(200);
      expect(data(off)).toEqual({ enabled: false, deployment: true, setting: false });
      const refused = await dcr();
      expect(refused.status).toBe(404);
      expect(await metadata()).not.toHaveProperty('registration_endpoint');
      expect(await h.world.storage.settings.get('oauth.registration')).toBe(false);
      expect(await adminRow('oauth_registration.set')).toMatchObject({
        status: 'ok',
        targetType: 'oauth_registration',
        details: { enabled: false },
      });

      await api('POST', '/oauth/registration', owner.headers, { enabled: true });
      expect((await dcr()).status).toBe(201);
      expect(await metadata()).toHaveProperty('registration_endpoint');
    });

    it('existing clients keep working while registration is off', async () => {
      await registerClient();
      const { t } = await connect();
      const owner = await h.addSession({ role: 'owner' });
      await api('POST', '/oauth/registration', owner.headers, { enabled: false });
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      expect((await refresh(client, t)).status).toBe(200);
    });

    it('another process follows within the cache window (5 s) and not before', async () => {
      const second = h.makeApp({ oauth: { consent: consent.handler } });
      const other = new Client(h, second, secrets);
      expect((await other.registerRaw({ redirect_uris: [other.redirectUri] })).status).toBe(201);
      const owner = await h.addSession({ role: 'owner' });
      await api('POST', '/oauth/registration', owner.headers, { enabled: false });
      advance(1000);
      // Still the value the other process read a moment ago.
      expect((await other.registerRaw({ redirect_uris: [other.redirectUri] })).status).toBe(201);
      advance(5000);
      expect((await other.registerRaw({ redirect_uris: [other.redirectUri] })).status).toBe(404);
      expect(await metadata(second)).not.toHaveProperty('registration_endpoint');
    });

    it('RB_OAUTH_DCR=off wins: the switch cannot turn registration on', async () => {
      build({ registration: false });
      const owner = await h.addSession({ role: 'owner' });
      expect(data(await api('GET', '/oauth/registration', owner.headers))).toEqual({
        enabled: false,
        deployment: false,
        setting: true,
      });
      const on = await api('POST', '/oauth/registration', owner.headers, { enabled: true });
      expect(data(on)).toMatchObject({ enabled: false, deployment: false });
      expect((await dcr()).status).toBe(404);
    });

    // The Worker's storage lives in another realm (a spy can't reach it): the memory and SQLite hosts cover this.
    it.skipIf(authzHostKind() === 'worker')(
      'an unreadable switch refuses registration (fail closed)',
      async () => {
        const spy = vi.spyOn(h.world.storage.settings, 'get').mockRejectedValue(new Error('storage down'));
        try {
          expect((await dcr()).status).toBe(404);
        } finally {
          spy.mockRestore();
        }
      },
    );

    it('rejects malformed bodies', async () => {
      const owner = await h.addSession({ role: 'owner' });
      for (const body of [{}, { enabled: 'no' }, { enabled: false, extra: 1 }]) {
        expect((await api('POST', '/oauth/registration', owner.headers, body)).status).toBe(400);
      }
    });
  });

  describe('authorization (P5-08)', () => {
    const routes: readonly (readonly [string, string, unknown])[] = [
      ['GET', '/oauth/clients', undefined],
      ['POST', '/oauth/clients/remove', { clientId: 'client_none' }],
      ['GET', '/oauth/registration', undefined],
      ['POST', '/oauth/registration', { enabled: false }],
    ];

    it('members and admins get 403 (role) and nothing changes; strangers, device tokens and OAuth tokens get 401', async () => {
      await registerClient();
      const { t } = await connect('member');
      const settingBefore = await h.world.storage.settings.get('oauth.registration');
      for (const role of ['member', 'admin'] as const) {
        const s = await h.addSession({ role });
        for (const [method, path, body] of routes) {
          const res = await api(method, path, s.headers, body);
          expect(res.status, `${role} ${method} ${path}`).toBe(403);
          expect(JSON.parse(res.text).error).toMatchObject({ code: 'forbidden', detail: 'role' });
        }
      }
      expect(await h.world.storage.settings.get('oauth.registration')).toEqual(settingBefore);
      const owner = await h.addSession({ role: 'owner' });
      expect((data(await api('GET', '/oauth/clients', owner.headers)) as unknown[]).length).toBe(1);
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);

      for (const [name, headers] of [
        ['no credentials', {}],
        ['a device token', { authorization: `Bearer ${h.world.tokens.prod}` }],
        ['an OAuth access token', { authorization: `Bearer ${t.access_token}` }],
        ['an OAuth refresh token', { authorization: `Bearer ${t.refresh_token}` }],
        ['a wrong admin token', { authorization: 'Bearer wrong' }],
      ] as const) {
        for (const [method, path, body] of routes) {
          const res = await api(method, path, headers, body);
          expect(res.status, `${name} ${method} ${path}`).toBe(401);
        }
      }
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
    });

    it('an owner session without the CSRF token cannot change anything', async () => {
      const owner = await h.addSession({ role: 'owner' });
      const { 'x-csrf-token': _drop, ...noCsrf } = owner.headers;
      expect((await api('POST', '/oauth/registration', noCsrf, { enabled: false })).status).toBe(403);
      expect((await api('POST', '/oauth/clients/remove', noCsrf, { clientId: 'x' })).status).toBe(403);
      expect(await h.world.storage.settings.get('oauth.registration')).toBeUndefined();
    });
  });

  describe('the panel (P5-08)', () => {
    it('owners see the apps and the switch; names are escaped, hosts are text, nothing is a link', async () => {
      await registerClient();
      const owner = await h.addSession({ role: 'owner' });
      const page = await open(owner, '/admin/oauth-clients');
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(HOSTILE_NAME);
      expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt;Claude');
      expect(page.text).toContain('not verified');
      expect(page.text).toContain('127.0.0.1');
      expect(page.text).toContain('Turn registration off');
      // The only links are the panel's own.
      for (const m of page.text.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^(#|\/(?!\/))/);
      expect(page.text).not.toContain(`href="${client.clientId}"`);
    });

    it('is owner-only: admins and members get the 403 page, and POSTs change nothing', async () => {
      await registerClient();
      const { t } = await connect('member');
      for (const role of ['admin', 'member'] as const) {
        const s = await h.addSession({ role });
        expect((await open(s, '/admin/oauth-clients')).status, role).toBe(403);
        expect(
          (await submit(s, '/admin/oauth-clients/remove', { clientId: client.clientId, confirm: 'yes' }))
            .status,
        ).toBe(403);
        expect((await submit(s, '/admin/oauth-clients/registration', { enabled: 'off' })).status).toBe(403);
        expect((await open(s, '/admin')).text).not.toContain('/admin/oauth-clients');
      }
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      expect(await h.world.storage.settings.get('oauth.registration')).toBeUndefined();
    });

    it('removing asks first, is single-use, and ends the tokens', async () => {
      await registerClient();
      const { t } = await connect('member');
      const owner = await h.addSession({ role: 'owner' });
      const ask = await submit(owner, '/admin/oauth-clients/remove', { clientId: client.clientId });
      expect(ask.status).toBe(200);
      expect(ask.text).toContain('Remove app');
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      const once = /name="_once" value="([^"]+)"/.exec(ask.text)?.[1] as string;
      expect(once).toBeTruthy();

      const done = await submit(owner, '/admin/oauth-clients/remove', {
        clientId: client.clientId,
        confirm: 'yes',
        _once: once,
      });
      expect(done.status).toBe(303);
      expect((await client.mcp('prod', t.access_token)).status).toBe(401);
      expect((await open(owner, '/admin/oauth-clients')).text).not.toContain('Remove authz');
      // The same confirmation sent again does nothing.
      const replay = await submit(owner, '/admin/oauth-clients/remove', {
        clientId: client.clientId,
        confirm: 'yes',
        _once: once,
      });
      expect(replay.status).toBe(303);
      expect((await adminRows('oauth_client.remove')).length).toBe(1);
      // An unknown id has no confirmation page.
      expect((await submit(owner, '/admin/oauth-clients/remove', { clientId: 'nobody' })).status).toBe(303);
    });

    it('turning registration off is one click; turning it on asks first', async () => {
      const owner = await h.addSession({ role: 'owner' });
      const off = await submit(owner, '/admin/oauth-clients/registration', { enabled: 'off' });
      expect(off.status).toBe(303);
      expect(await h.world.storage.settings.get('oauth.registration')).toBe(false);
      expect((await open(owner, '/admin/oauth-clients')).text).toContain('Turn registration on');

      const ask = await submit(owner, '/admin/oauth-clients/registration', { enabled: 'on' });
      expect(ask.status).toBe(200);
      expect(await h.world.storage.settings.get('oauth.registration')).toBe(false);
      const on = await submit(owner, '/admin/oauth-clients/registration', { enabled: 'on', confirm: 'yes' });
      expect(on.status).toBe(303);
      expect(await h.world.storage.settings.get('oauth.registration')).toBe(true);
      expect((await submit(owner, '/admin/oauth-clients/registration', { enabled: 'maybe' })).status).toBe(
        303,
      );
    });

    it('without OAuth the page says so and changes nothing', async () => {
      const plain = h.makeApp();
      const owner = await h.addSession({ role: 'owner' });
      const res = await h.send(
        new Request(`${PUBLIC_ORIGIN}/admin/oauth-clients`, {
          headers: { cookie: owner.cookie, ...browser },
        }),
        plain,
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain('OAuth is not enabled');
    });
  });

  const adminRows = async (action: string) => (await h.auditRows()).filter((r) => r.action === action);
}
