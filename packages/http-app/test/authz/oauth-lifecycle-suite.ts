// SPDX-License-Identifier: Apache-2.0
// OAuth token lifecycle (P5-05): lifetimes, refresh rotation with reuse detection (single use under concurrency),
// access re-checked at every issuance, revoke-all, RFC 7009 revocation per client, and the OAuth device list and revoke
// in the admin API with its negative authorization cases. Runs on every authz host: memory (`oauth-lifecycle.test.ts`),
// SQLite (`apps/cli/test/oauth-lifecycle-sqlite.test.ts`) and the Worker on local D1 (`pnpm test:workers`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN, type AuthzApp, type Captured, createHarness, type Harness } from './harness.ts';
import { MCP_ROUTES, type RouteCase, requestFor } from './matrix.ts';
import {
  Client,
  type Consent,
  consentStandIn,
  ISSUER,
  observable,
  resourceOf,
  type Tokens,
} from './oauth-suite.ts';

const A = `${ISSUER}/api/admin/v1`;

interface Device {
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  readonly clientName: string | null;
  readonly clientKind: string;
  readonly projectSlug: string | null;
  readonly grantId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export function oauthLifecycleSuite(): void {
  let h: Harness;
  let consent: Consent;
  let app: AuthzApp;
  let client: Client;
  let secrets: string[];

  /** The app under test; access tokens live 10 minutes unless `access` says otherwise (`null`: the default). */
  const build = (over: { access?: number | null; refreshTokenTtlSeconds?: number } = {}) => {
    const access = over.access === undefined ? 600 : over.access;
    app = h.makeApp({
      oauth: {
        consent: consent.handler,
        ...(access === null ? {} : { accessTokenTtlSeconds: access }),
        ...(over.refreshTokenTtlSeconds === undefined
          ? {}
          : { refreshTokenTtlSeconds: over.refreshTokenTtlSeconds }),
      },
    });
    client = new Client(h, app, secrets);
  };

  beforeEach(async () => {
    h = await createHarness();
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
    consent = consentStandIn();
    secrets = [];
    build();
    consent.next = { userId: 'usr_a', grantId: h.world.grantIds.prod };
  });

  afterEach(async () => {
    await h.scan();
    const audit = JSON.stringify(await h.auditRows());
    const logs = h.logLines.join('\n');
    for (const s of secrets) {
      expect(logs.includes(s), 'an OAuth secret reached a log line').toBe(false);
      expect(audit.includes(s), 'an OAuth secret reached the audit log').toBe(false);
    }
    vi.useRealTimers();
  });

  const advance = (ms: number): void => {
    h.world.clock.advance(ms);
    vi.setSystemTime(h.world.clock.now());
  };

  const refresh = async (token: string, by: Client = client, slug = 'prod'): Promise<Captured> => {
    const res = await by.form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: by.clientId,
      resource: resourceOf(slug),
    });
    if (res.status === 200) {
      const t = JSON.parse(res.text) as Tokens;
      secrets.push(t.access_token, t.refresh_token);
    }
    return res;
  };
  const tokensOf = (res: Captured): Tokens => JSON.parse(res.text) as Tokens;

  const reference = (slug = 'prod') =>
    h.send(requestFor(MCP_ROUTES[0] as RouteCase, { headers: {}, slug }), app);
  async function expectDenied(token: string, reason = 'oauth_invalid'): Promise<void> {
    const res = await client.mcp('prod', token);
    expect(res.status).toBe(401);
    expect(observable(res)).toBe(observable(await reference()));
    const row = await h.deniedRow(res.requestId as string);
    expect(row).toMatchObject({ kind: 'auth', status: 'denied', errorCode: reason });
  }
  const expectInvalidGrant = (res: Captured): void => {
    expect(res.status, res.text).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: 'invalid_grant' });
  };
  const providerGrantOf = (t: Tokens): string => t.access_token.split(':')[1] as string;
  const adminRow = async (action: string) => {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      row = (await h.auditRows()).find((r) => r.action === action) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error(`no ${action} row`);
    });
    return row as Record<string, unknown>;
  };
  const admin = (method: string, path: string, headers: Record<string, string> = {}) =>
    h.send(
      new Request(`${A}${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...headers },
      }),
      app,
    );
  const asSession = (method: string, path: string, headers: Readonly<Record<string, string>>) =>
    h.send(new Request(`${A}${path}`, { method, headers: { ...headers } }), app);

  describe('lifetimes (P5-05)', () => {
    it('access tokens default to 1 h and refresh tokens to an absolute 30 days', async () => {
      build({ access: null });
      await client.register();
      const t = await client.tokens('prod');
      expect(t.expires_in).toBe(3600);
      const grant = JSON.parse(
        (await h.world.storage.kv.get(`oauth:grant:usr_a:${providerGrantOf(t)}`)) as string,
      ) as { expiresAt: number };
      expect(grant.expiresAt - Math.floor(Date.now() / 1000)).toBe(30 * 86_400);
    });

    it('the refresh lifetime is absolute: refreshing does not extend it', async () => {
      build({ refreshTokenTtlSeconds: 3600 });
      await client.register();
      const t = await client.tokens('prod');
      advance(50 * 60_000);
      const r1 = await refresh(t.refresh_token);
      expect(r1.status, r1.text).toBe(200);
      // The access token never outlives the refresh lifetime.
      expect(tokensOf(r1).expires_in).toBeLessThanOrEqual(600);
      advance(11 * 60_000);
      expectInvalidGrant(await refresh(tokensOf(r1).refresh_token));
    });

    it('an access token never outlives its grant, and an expired grant refreshes nothing', async () => {
      await client.register();
      await h.world.storage.grants.update(h.world.grantIds.prod, {
        expiresAt: h.world.clock.now() + 300_000,
      });
      const t = await client.tokens('prod');
      expect(t.expires_in).toBeLessThanOrEqual(300);
      expect(t.expires_in).toBeGreaterThanOrEqual(240);
      advance(301_000);
      expectInvalidGrant(await refresh(t.refresh_token));
    });
  });

  describe('refresh rotation and reuse detection (P5-05, T9)', () => {
    it('each refresh token works once; reusing a rotated one revokes the whole family and is audited', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const r1 = await refresh(t.refresh_token);
      expect(r1.status, r1.text).toBe(200);
      const r2 = await refresh(tokensOf(r1).refresh_token);
      expect(r2.status, r2.text).toBe(200);
      expect((await client.mcp('prod', tokensOf(r2).access_token)).status).toBe(200);

      expectInvalidGrant(await refresh(t.refresh_token));
      // The family: every access and refresh token of the device authorization.
      await expectDenied(tokensOf(r2).access_token);
      await expectDenied(tokensOf(r1).access_token);
      expectInvalidGrant(await refresh(tokensOf(r2).refresh_token));
      const row = await adminRow('oauth.token.reuse');
      expect(row).toMatchObject({
        status: 'denied',
        errorCode: 'refresh_token_reuse',
        targetType: 'oauth_device',
        targetId: `oauth_${providerGrantOf(t)}`,
        userId: 'usr_a',
        clientId: client.clientId,
      });
    });

    it('a refused refresh (wrong resource or client) does not burn the token', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const other = new Client(h, app, secrets);
      await other.register();
      expect((await refresh(t.refresh_token, other)).status).toBe(400);
      expect((await refresh(t.refresh_token, client, 'eu')).status).toBe(400);
      const ok = await refresh(t.refresh_token);
      expect(ok.status, ok.text).toBe(200);
    });

    it('concurrent refreshes with one token: at most one succeeds and the family is revoked', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const results = await Promise.all(Array.from({ length: 6 }, () => refresh(t.refresh_token)));
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(6 - ok.length);
      for (const r of ok) {
        await expectDenied(tokensOf(r).access_token);
        expectInvalidGrant(await refresh(tokensOf(r).refresh_token));
      }
      await expectDenied(t.access_token);
      expect(await h.world.storage.kv.get(`oauth:grant:usr_a:${providerGrantOf(t)}`)).toBeNull();
    });

    it('a forged refresh token for a known grant revokes nothing', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const [userId, grantId, secret] = t.refresh_token.split(':') as [string, string, string];
      const forged = `${userId}:${grantId}:${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
      expectInvalidGrant(await refresh(forged));
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      expect((await refresh(t.refresh_token)).status).toBe(200);
    });
  });

  describe('access re-checked at every issuance (P5-05)', () => {
    const cases: readonly [string, (grantId: string, userId: string) => Promise<unknown>][] = [
      ['grant_revoked', (g) => h.world.storage.grants.update(g, { revokedAt: h.world.clock.now() })],
      ['user_disabled', (_g, u) => h.world.storage.users.update(u, { disabledAt: h.world.clock.now() })],
      [
        'project_disabled',
        () => h.world.storage.projects.update(h.world.projectIds.prod, { disabledAt: h.world.clock.now() }),
      ],
    ];
    for (const [reason, breakIt] of cases) {
      it(`refresh is refused and the device revoked: ${reason}`, async () => {
        await client.register();
        const userId = await h.addUser(`${reason}@example.com`, 'member');
        const grantId = await h.addGrant(h.world.projectIds.prod, { userId });
        consent.next = { userId, grantId };
        const t = await client.tokens('prod');
        await breakIt(grantId, userId);
        expectInvalidGrant(await refresh(t.refresh_token));
        expect(await h.world.storage.kv.get(`oauth:grant:${userId}:${providerGrantOf(t)}`)).toBeNull();
        const row = await adminRow('oauth.token.refused');
        expect(row).toMatchObject({ status: 'denied', errorCode: reason, userId });
      });
    }

    it('a code exchanged after its grant was revoked yields nothing', async () => {
      await client.register();
      const { code, verifier } = await client.authorize('prod');
      await h.world.storage.grants.update(h.world.grantIds.prod, { revokedAt: h.world.clock.now() });
      expectInvalidGrant(await client.exchange(code as string, verifier, resourceOf('prod')));
    });
  });

  describe('RFC 7009 revocation (P5-05)', () => {
    const revoke = (body: Record<string, string>) => client.form('/oauth/token', body);

    it('authenticates the client and leaks nothing: unknown client 401, foreign or malformed token 200', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const other = new Client(h, app, secrets);
      await other.register();
      const unknown = await revoke({ token: t.access_token, client_id: 'no-such-client-xx' });
      expect(unknown.status).toBe(401);
      expect(JSON.parse(unknown.text)).toMatchObject({ error: 'invalid_client' });
      expect((await revoke({ token: t.access_token })).status).toBe(401);
      // Another client's tokens: the same 200 as for anything else, and nothing is revoked.
      for (const token of [
        t.access_token,
        t.refresh_token,
        'not-a-token',
        `usr_a:${'x'.repeat(16)}:${'y'.repeat(32)}`,
      ]) {
        const res = await revoke({ token, client_id: other.clientId });
        expect(res.status, token.slice(0, 8)).toBe(200);
        expect(res.text).toBe('');
      }
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
      expect((await refresh(t.refresh_token)).status).toBe(200);
    });

    it('revoking a refresh token revokes the whole family', async () => {
      await client.register();
      const t = await client.tokens('prod');
      const res = await revoke({
        token: t.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: client.clientId,
      });
      expect(res.status).toBe(200);
      await expectDenied(t.access_token);
      expectInvalidGrant(await refresh(t.refresh_token));
    });
  });

  describe('OAuth devices in the admin API (P5-05, P2-12 negative cases)', () => {
    /** A member with a grant on prod and an OAuth device for it. */
    const memberDevice = async (role: 'member' | 'admin' | 'owner' = 'member') => {
      const session = await h.addSession({ role });
      const grantId = await h.addGrant(h.world.projectIds.prod, { userId: session.userId });
      consent.next = { userId: session.userId, grantId };
      const t = await client.tokens('prod');
      return { session, grantId, t, deviceId: `oauth_${providerGrantOf(t)}` };
    };

    it('a member lists and revokes their own devices; revoking forgets the remembered approval', async () => {
      await client.register();
      const { session, grantId, t, deviceId } = await memberDevice();
      const list = await asSession('GET', '/me/oauth-devices', session.headers);
      expect(list.status, list.text).toBe(200);
      const devices = (JSON.parse(list.text) as { data: Device[] }).data;
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        id: deviceId,
        userId: session.userId,
        clientId: client.clientId,
        clientName: 'authz test client',
        clientKind: 'dynamic',
        projectSlug: 'prod',
        grantId,
      });
      expect(list.text).not.toContain(t.access_token.split(':')[2] as string);
      // A remembered approval for this client and project (P5-04 row shape), and one for another client.
      const remembered = (clientId: string) =>
        JSON.stringify({
          grantId,
          clientId,
          scope: ['mcp:read'],
          label: null,
          clientName: null,
          clientKind: 'dynamic',
          clientHost: null,
          redirectHost: '127.0.0.1:53682',
          projectSlug: 'prod',
          grantLabel: 'x',
          expiresAt: h.world.clock.now() + 86_400_000,
        });
      await h.world.storage.kv.put(
        `oauth-consent:${session.userId}:${'a'.repeat(43)}`,
        remembered(client.clientId),
        {
          expirationTtl: 86_400,
        },
      );
      await h.world.storage.kv.put(
        `oauth-consent:${session.userId}:${'b'.repeat(43)}`,
        remembered('other-client'),
        {
          expirationTtl: 86_400,
        },
      );

      const revoked = await asSession('POST', `/me/oauth-devices/${deviceId}/revoke`, session.headers);
      expect(revoked.status, revoked.text).toBe(200);
      await expectDenied(t.access_token);
      expectInvalidGrant(await refresh(t.refresh_token));
      expect(await h.world.storage.kv.get(`oauth-consent:${session.userId}:${'a'.repeat(43)}`)).toBeNull();
      expect(
        await h.world.storage.kv.get(`oauth-consent:${session.userId}:${'b'.repeat(43)}`),
      ).not.toBeNull();
      expect(JSON.parse((await asSession('GET', '/me/oauth-devices', session.headers)).text).data).toEqual(
        [],
      );
      expect(await adminRow('oauth_device.revoke')).toMatchObject({
        status: 'ok',
        targetType: 'oauth_device',
        targetId: deviceId,
        userId: session.userId,
      });
      // Again: gone.
      expect((await asSession('POST', `/me/oauth-devices/${deviceId}/revoke`, session.headers)).status).toBe(
        404,
      );
    });

    it("another member can't see or revoke it; the admin token can't use /me; malformed ids are 404", async () => {
      await client.register();
      const { t, deviceId, session } = await memberDevice();
      const intruder = await h.addSession({ role: 'member' });
      expect(JSON.parse((await asSession('GET', '/me/oauth-devices', intruder.headers)).text).data).toEqual(
        [],
      );
      expect((await asSession('POST', `/me/oauth-devices/${deviceId}/revoke`, intruder.headers)).status).toBe(
        404,
      );
      expect(
        (await asSession('GET', `/users/${session.userId}/oauth-devices`, intruder.headers)).status,
      ).toBe(403);
      expect(
        (
          await asSession(
            'POST',
            `/users/${session.userId}/oauth-devices/${deviceId}/revoke`,
            intruder.headers,
          )
        ).status,
      ).toBe(403);
      // Without the CSRF token a session can't revoke even its own device.
      const { 'x-csrf-token': _drop, ...noCsrf } = session.headers;
      expect((await asSession('POST', `/me/oauth-devices/${deviceId}/revoke`, noCsrf)).status).toBe(403);
      expect((await admin('GET', '/me/oauth-devices')).status).toBe(403);
      for (const bad of ['oauth_short', 'grt_x', `oauth_${'x'.repeat(16)}`]) {
        expect((await asSession('POST', `/me/oauth-devices/${bad}/revoke`, session.headers)).status).toBe(
          404,
        );
      }
      expect((await client.mcp('prod', t.access_token)).status).toBe(200);
    });

    it("admins list and revoke a member's devices but not an owner's; owners can", async () => {
      await client.register();
      const member = await memberDevice('member');
      const owner = await memberDevice('owner');
      const adminSession = await h.addSession({ role: 'admin' });
      const listed = await asSession(
        'GET',
        `/users/${member.session.userId}/oauth-devices`,
        adminSession.headers,
      );
      expect(listed.status).toBe(200);
      expect((JSON.parse(listed.text) as { data: Device[] }).data.map((d) => d.id)).toEqual([
        member.deviceId,
      ]);
      expect((await asSession('GET', '/users/usr_none/oauth-devices', adminSession.headers)).status).toBe(
        404,
      );
      // An owner's device: admins are refused (audited as denied), and nothing is revoked.
      const refused = await asSession(
        'POST',
        `/users/${owner.session.userId}/oauth-devices/${owner.deviceId}/revoke`,
        adminSession.headers,
      );
      expect(refused.status).toBe(403);
      expect((await client.mcp('prod', owner.t.access_token)).status).toBe(200);
      // A device id of another user under this user's path is not found.
      expect(
        (
          await asSession(
            'POST',
            `/users/${member.session.userId}/oauth-devices/${owner.deviceId}/revoke`,
            adminSession.headers,
          )
        ).status,
      ).toBe(404);
      const ok = await asSession(
        'POST',
        `/users/${member.session.userId}/oauth-devices/${member.deviceId}/revoke`,
        adminSession.headers,
      );
      expect(ok.status, ok.text).toBe(200);
      await expectDenied(member.t.access_token);
      const byOwner = await admin(
        'POST',
        `/users/${owner.session.userId}/oauth-devices/${owner.deviceId}/revoke`,
      );
      expect(byOwner.status).toBe(200);
      await expectDenied(owner.t.access_token);
    });

    it('revoke-all: revoking or deleting a grant, disabling a user or deleting a project revokes the devices', async () => {
      await client.register();
      const a = await memberDevice();
      const b = await memberDevice();
      const c = await memberDevice();
      const other = await memberDevice();
      expect((await admin('POST', `/grants/${a.grantId}/revoke`)).status).toBe(200);
      expect(
        await h.world.storage.kv.get(`oauth:grant:${a.session.userId}:${providerGrantOf(a.t)}`),
      ).toBeNull();
      expect((await admin('DELETE', `/grants/${b.grantId}`)).status).toBe(204);
      expect(
        await h.world.storage.kv.get(`oauth:grant:${b.session.userId}:${providerGrantOf(b.t)}`),
      ).toBeNull();
      const disable = await h.send(
        new Request(`${A}/users/${c.session.userId}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ disabled: true }),
        }),
        app,
      );
      expect(disable.status).toBe(200);
      expect(
        await h.world.storage.kv.get(`oauth:grant:${c.session.userId}:${providerGrantOf(c.t)}`),
      ).toBeNull();
      // Untouched: the other member's device.
      expect((await client.mcp('prod', other.t.access_token)).status).toBe(200);
      expect((await admin('DELETE', `/projects/${h.world.projectIds.prod}`)).status).toBe(204);
      expect(
        await h.world.storage.kv.get(`oauth:grant:${other.session.userId}:${providerGrantOf(other.t)}`),
      ).toBeNull();
      expect((await refresh(other.t.refresh_token)).status).toBe(400);
    });
  });
}
