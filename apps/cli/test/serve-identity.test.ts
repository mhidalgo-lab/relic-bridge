// SPDX-License-Identifier: Apache-2.0
// P4-01 on Node: `relic-bridge serve` with a generic OIDC provider served by a local mock IdP over real loopback HTTP
// (no injected fetch): setup link from the admin API → sign-in through the localhost redirect → owner user. Also the
// `RB_*` validation of the sign-in settings.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockIdp, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } from '../../../packages/auth/test/mock-idp.ts';
import { ConfigError } from '../src/config.ts';
import { serveSettings, startServer } from '../src/serve.ts';
import { memoryFs } from './helpers.ts';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rb-serve-idp-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe('serve: sign-in over a localhost redirect', () => {
  it('a setup link turns the first OIDC sign-in into the owner', async () => {
    const idpPort = await freePort();
    const issuer = `http://127.0.0.1:${idpPort}`;
    const idp = await createMockIdp({ issuer });
    const idpServer = createAdaptorServer({ fetch: (req: Request) => idp.fetch(req) }) as Server;
    await new Promise<void>((r) => idpServer.listen(idpPort, '127.0.0.1', () => r()));

    const port = await freePort();
    const admin = randomBytes(32).toString('base64url');
    const lines: string[] = [];
    const env = {
      RB_MASTER_KEY: generateMasterKey(1),
      RB_ADMIN_TOKEN: admin,
      RB_PUBLIC_URL: `http://localhost:${port}`,
      RB_OIDC_ISSUER: issuer,
      RB_OIDC_CLIENT_ID: MOCK_CLIENT_ID,
      RB_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET,
    };
    const settings = serveSettings({ port: String(port), db: join(tmp, 'rb.db'), env, platform: 'linux' });
    const server = await startServer({
      settings,
      env,
      fs: memoryFs({}),
      platform: 'linux',
      logger: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
    });
    try {
      const base = `http://localhost:${port}`;
      const issued = await fetch(`${base}/api/admin/v1/setup-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'oidc' }),
      });
      expect(issued.status).toBe(201);
      const link = ((await issued.json()) as { data: { url: string } }).data.url;
      expect(link.startsWith(`${base}/auth/login/oidc?setup=rb_setup_`)).toBe(true);

      // The browser: our server → the IdP → back to our callback, carrying the binding cookie.
      const start = await fetch(link, { redirect: 'manual' });
      expect(start.status).toBe(302);
      const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] as string;
      expect(cookie).toMatch(/^rb_login=/);
      const atIdp = await fetch(start.headers.get('location') as string, { redirect: 'manual' });
      expect(atIdp.status).toBe(302);
      const callback = atIdp.headers.get('location') as string;
      expect(callback.startsWith(`${base}/auth/callback/oidc?`)).toBe(true);
      const done = await fetch(callback, { redirect: 'manual', headers: { cookie } });
      // Sign-in ends in an admin session (P4-02): cookie, then 303 to the admin.
      expect(done.status).toBe(303);
      expect(done.headers.get('location')).toBe('/admin');
      const session = (done.headers.getSetCookie().find((c) => c.startsWith('rb_session=')) ?? '').split(
        ';',
      )[0] as string;
      expect(session).toMatch(/^rb_session=usr_[0-9a-f]+\.[A-Za-z0-9_-]{43}$/);

      const users = await fetch(`${base}/api/admin/v1/users`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      const body = (await users.json()) as { data: { email: string; role: string; idp: string }[] };
      expect(body.data.map((u) => [u.email, u.role, u.idp])).toEqual([
        ['owner@example.com', 'owner', 'oidc:oidc'],
      ]);
      // The session works on the admin API: who am I, a change with the CSRF token, refusal without it, logout.
      const me = await fetch(`${base}/api/admin/v1/session`, { headers: { cookie: session } });
      expect(me.status).toBe(200);
      const csrf = ((await me.json()) as { data: { role: string; csrfToken: string } }).data;
      expect(csrf.role).toBe('owner');
      const change = (headers: Record<string, string>) =>
        fetch(`${base}/api/admin/v1/users`, {
          method: 'POST',
          headers: { cookie: session, 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ email: 'second@example.com' }),
        });
      expect((await change({ origin: base })).status).toBe(403);
      expect((await change({ origin: base, 'x-csrf-token': csrf.csrfToken })).status).toBe(201);
      const logout = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: session, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: `_csrf=${csrf.csrfToken}`,
      });
      expect(logout.status).toBe(303);
      expect((await fetch(`${base}/api/admin/v1/session`, { headers: { cookie: session } })).status).toBe(
        401,
      );

      // Discovery, token and JWKS went over real loopback HTTP.
      expect(idp.calls.some((c) => c.endsWith('/token'))).toBe(true);
      expect(idp.jwksFetches()).toBe(1);
      const out = lines.join('\n');
      expect(out).toContain('"signIn"');
      expect(out).not.toContain(MOCK_CLIENT_SECRET);
      expect(out).not.toContain(session.split('=')[1] as string);
      expect(out).not.toContain(link.split('setup=')[1] as string);
    } finally {
      await server.close();
      await new Promise<void>((r) => idpServer.close(() => r()));
    }
  });

  it('refuses half-configured sign-in at boot, naming the variable', () => {
    const settings = (env: Record<string, string>) =>
      serveSettings({ port: '0', db: join(tmp, 'rb.db'), env, platform: 'linux' });
    expect(() => settings({ RB_GITHUB_CLIENT_ID: 'x' })).toThrow(/RB_GITHUB_CLIENT_SECRET/);
    expect(() => settings({ RB_GITHUB_CLIENT_ID: 'x', RB_GITHUB_CLIENT_SECRET: 'y' })).toThrow(ConfigError);
    expect(() =>
      settings({
        RB_GITHUB_CLIENT_ID: 'x',
        RB_GITHUB_CLIENT_SECRET: 'y',
        RB_PUBLIC_URL: 'https://bridge.example.com',
      }),
    ).toThrow(/RB_ALLOWED_HOSTS/);
    const ok = settings({
      RB_GITHUB_CLIENT_ID: 'x',
      RB_GITHUB_CLIENT_SECRET: 'y',
      RB_PUBLIC_URL: 'http://127.0.0.1:8787',
    });
    expect(ok.identity?.providers.map((p) => p.kind)).toEqual(['github']);
    expect(settings({}).identity).toBeNull();
  });
});
