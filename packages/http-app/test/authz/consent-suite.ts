// SPDX-License-Identifier: Apache-2.0
// The built-in OAuth sign-in and consent screen (P5-04) end to end through the app: authorize → sign-in redirect →
// consent page → approve / deny → code → token → MCP call; remembered approvals and forgetting them; the owner
// boundary and forged grants; CSRF, origin, fetch-metadata and clickjacking defences; audit rows. Runs on the HTTP app
// with memory storage (`consent.test.ts`), on SQLite (`apps/cli/test/consent-sqlite.test.ts`) and on the Worker with
// local D1 (`pnpm test:workers`). Web-standard only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMetadataFetch } from '../../src/index.ts';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  type Captured,
  createHarness,
  type Harness,
  PUBLIC_ORIGIN,
  type SessionCaller,
} from './harness.ts';
import { CONSENT_ROUTES, MCP_ROUTES, type RouteCase, requestFor } from './matrix.ts';

const ISSUER = PUBLIC_ORIGIN;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const resourceOf = (slug: string): string => `${ISSUER}/p/${slug}/mcp`;
export const CLAUDE_AI_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const HOSTILE_NAME = '<img src=x onerror=alert(1)> "Totally Claude"';

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64u(digest) };
}

/** Headers of a browser opening the authorize URL from another site (the client's page or app). */
export const navigation = (session?: SessionCaller): Record<string, string> => ({
  ...(session ? { cookie: session.cookie } : {}),
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
});

/** Headers of the consent form's post from our own page. */
const formPost = (session: SessionCaller): Record<string, string> => ({
  cookie: session.cookie,
  origin: PUBLIC_ORIGIN,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'content-type': 'application/x-www-form-urlencoded',
});

// One pass over the text: `&amp;lt;` decodes to `&lt;`, never on to `<`.
const HTML_ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' };

const decodeHtml = (s: string): string =>
  s.replace(/&(amp|quot|#39|lt|gt);/g, (_m, name: string) => HTML_ENTITIES[name] as string);

/** The consent form's action (decoded) and the grant ids it offers. */
export function parseConsent(page: Captured): { action: string; grants: string[] } {
  const action = /<form method="post" action="(\/oauth\/consent[^"]*)"/.exec(page.text)?.[1];
  const grants = [...page.text.matchAll(/type="radio" id="grant-\d+" name="grant" value="([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  return { action: action === undefined ? '' : decodeHtml(action), grants };
}

interface Started {
  readonly res: Captured;
  readonly verifier: string;
  readonly url: string;
}

export class Browser {
  clientId = '';
  redirectUri = REDIRECT;
  constructor(
    private readonly h: Harness,
    private readonly app: AuthzApp,
    private readonly secrets: string[],
  ) {}

  send(request: Request): Promise<Captured> {
    return this.h.send(request, this.app);
  }

  async register(
    name = 'Consent test client',
    redirectUris: readonly string[] = [REDIRECT],
  ): Promise<string> {
    const res = await this.send(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: name,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
    );
    expect(res.status, res.text).toBe(201);
    this.clientId = (JSON.parse(res.text) as { client_id: string }).client_id;
    return this.clientId;
  }

  async authorizeUrl(
    slug = 'prod',
    extra: Record<string, string> = {},
  ): Promise<{ url: string; verifier: string }> {
    const { verifier, challenge } = await pkce();
    const u = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state: 'st-123',
      scope: 'mcp:read offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: resourceOf(slug),
      ...extra,
    })) {
      u.searchParams.set(k, v);
    }
    return { url: u.toString(), verifier };
  }

  /** Open the authorize URL in a browser with this session (or none). */
  async open(session?: SessionCaller, slug = 'prod', extra: Record<string, string> = {}): Promise<Started> {
    const { url, verifier } = await this.authorizeUrl(slug, extra);
    const res = await this.send(new Request(url, { headers: navigation(session) }));
    return { res, verifier, url };
  }

  /** Post the consent form at `action` with `fields` (CSRF added unless given). */
  async post(
    session: SessionCaller,
    action: string,
    fields: Record<string, string>,
    headers: Record<string, string> = formPost(session),
  ): Promise<Captured> {
    const body = new URLSearchParams({ _csrf: session.csrf, ...fields });
    const res = await this.send(
      new Request(`${ISSUER}${action}`, { method: 'POST', headers, body: body.toString() }),
    );
    const code = codeOf(res);
    if (code !== null) this.secrets.push(code);
    return res;
  }

  async exchange(code: string, verifier: string, slug = 'prod'): Promise<Captured> {
    const res = await this.send(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
          client_id: this.clientId,
          code_verifier: verifier,
          resource: resourceOf(slug),
        }).toString(),
      }),
    );
    if (res.status === 200) {
      const t = JSON.parse(res.text) as { access_token: string; refresh_token: string };
      this.secrets.push(t.access_token, t.refresh_token);
    }
    return res;
  }
}

export function codeOf(res: Captured): string | null {
  const location = res.headers.get('location');
  if (location === null || !location.startsWith('http')) return null;
  return new URL(location).searchParams.get('code');
}

/** Serves claude.ai's client metadata document (a CIMD client: identified by its https client id). */
export const claudeDocs: ClientMetadataFetch = async (url) =>
  url === CLAUDE_AI_ID
    ? new Response(
        JSON.stringify({
          client_id: CLAUDE_AI_ID,
          client_name: 'Claude',
          redirect_uris: [CLAUDE_AI_CALLBACK],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    : new Response('no', { status: 404 });

/** The remembered-approval id of a request, as the consent screen computes it. */
async function approvalIdOf(clientId: string, redirectUri: string, resource: string): Promise<string> {
  const material = JSON.stringify([clientId, redirectUri, resource]);
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))));
}

const WHOAMI = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } };

export function consentSuite(): void {
  let h: Harness;
  let app: AuthzApp;
  let browser: Browser;
  let owner: SessionCaller;
  let secrets: string[];

  beforeEach(async () => {
    h = await createHarness();
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
    secrets = [];
    // No `consent` option: the built-in screen.
    app = h.makeApp({ oauth: { accessTokenTtlSeconds: 600 } });
    browser = new Browser(h, app, secrets);
    owner = await h.addSession({ userId: 'usr_a' });
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const consentRows = async () => {
    await settle();
    return (await h.auditRows())
      .filter((r) => r.action.startsWith('oauth.consent.'))
      .sort((a, b) => a.id - b.id);
  };

  /** A browser for claude.ai's metadata-document client, on an app that resolves client ids (replaces `app`). */
  const metadataBrowser = (): Browser => {
    app = h.makeApp({
      oauth: { accessTokenTtlSeconds: 600, clientMetadataDocuments: { fetch: claudeDocs } },
    });
    const b = new Browser(h, app, secrets);
    b.clientId = CLAUDE_AI_ID;
    b.redirectUri = CLAUDE_AI_CALLBACK;
    return b;
  };

  /** Signed in, page shown, form posted with the first offered grant. */
  const approve = async (
    session: SessionCaller = owner,
    extra: Record<string, string> = {},
  ): Promise<{ res: Captured; verifier: string; page: Captured }> => {
    const { res: page, verifier } = await browser.open(session);
    expect(page.status, page.text).toBe(200);
    const { action, grants } = parseConsent(page);
    const res = await browser.post(session, action, {
      decision: 'approve',
      grant: grants[0] as string,
      ...extra,
    });
    return { res, verifier, page };
  };

  describe('sign-in and the consent page', () => {
    it('without a session the authorize request goes to sign-in and comes back to itself', async () => {
      await browser.register();
      const { res, url } = await browser.open();
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location') as string, ISSUER);
      expect(location.pathname).toBe('/auth/login');
      const target = new URL(url);
      expect(location.searchParams.get('next')).toBe(`${target.pathname}${target.search}`);
      // The sign-in routes keep that `next` (same-origin path, under the 2048-character cap).
      const login = await browser.send(new Request(`${ISSUER}${location.pathname}${location.search}`));
      expect(login.status).toBe(200);
      expect(decodeHtml(login.text)).toContain(
        encodeURIComponent(`${target.pathname}${target.search}`).slice(0, 40),
      );
      // An authorize URL too long to come back to is a page, not a broken redirect.
      const long = await browser.open(undefined, 'prod', { state: 'x'.repeat(2100) });
      expect(long.res.status).toBe(400);
      expect(long.res.headers.get('content-type')).toContain('text/html');
      expect(long.res.headers.get('location')).toBeNull();
    });

    it('bearer tokens, the admin token and query credentials confer nothing: sign-in first', async () => {
      await browser.register();
      const { url } = await browser.authorizeUrl();
      for (const headers of [
        { authorization: `Bearer ${ADMIN_TOKEN}` },
        { authorization: `Bearer ${h.world.tokens.prod}` },
        { cookie: 'rb_session=usr_a.forged' },
      ]) {
        const res = await browser.send(new Request(url, { headers: { ...navigation(), ...headers } }));
        expect(res.status, JSON.stringify(headers)).toBe(303);
        expect(res.headers.get('location')).toMatch(/^\/auth\/login\?next=/);
      }
    });

    it('shows the unverified name escaped, the redirect host, the loopback warning and the user’s own grants', async () => {
      await browser.register(HOSTILE_NAME);
      const { res } = await browser.open(owner);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('<img src=x');
      expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(res.text).toContain('not verified');
      expect(res.text).toContain('127.0.0.1:53682');
      expect(res.text).toContain('a program on the computer');
      expect(res.text).toContain('<dt>Project</dt><dd>prod</dd>');
      expect(parseConsent(res).grants).toEqual([h.world.grantIds.prod]);
      // Clickjacking and caching: never framed, never stored; the form may redirect to the client's origin only.
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self' http://127.0.0.1:53682;");
      expect(csp).not.toContain('unsafe');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('a cross-site request that is not a top-level navigation is refused before the session is read', async () => {
      await browser.register();
      const { url } = await browser.authorizeUrl();
      for (const [mode, dest] of [
        ['cors', 'empty'],
        ['navigate', 'iframe'],
        ['no-cors', 'image'],
      ] as const) {
        const res = await browser.send(
          new Request(url, {
            headers: {
              cookie: owner.cookie,
              'sec-fetch-site': 'cross-site',
              'sec-fetch-mode': mode,
              'sec-fetch-dest': dest,
            },
          }),
        );
        expect(res.status, `${mode} ${dest}`).toBe(403);
      }
    });

    it('a metadata-document client is shown with the host that vouches for it', async () => {
      const cimd = metadataBrowser();
      const { res } = await cimd.open(owner);
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain('identified');
      expect(res.text).toMatch(/website\s*<strong class="consent-host">claude\.ai<\/strong>/);
      expect(res.text).not.toContain('a program on the computer');
      expect(res.text).toContain('name="remember"');
      expect(res.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai;");
      const { action, grants } = parseConsent(res);
      const done = await cimd.post(owner, action, { decision: 'approve', grant: grants[0] as string });
      expect(done.status).toBe(303);
      expect(done.headers.get('location')?.startsWith(`${CLAUDE_AI_CALLBACK}?`)).toBe(true);
    });
  });

  describe('decisions', () => {
    it('approve: the code goes to the registered redirect with state and iss, and the token works', async () => {
      await browser.register();
      const { res, verifier } = await approve(owner, { label: 'Pixel phone – test' });
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location') as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('state')).toBe('st-123');
      expect(location.searchParams.get('iss')).toBe(ISSUER);
      const tok = await browser.exchange(location.searchParams.get('code') as string, verifier);
      expect(tok.status, tok.text).toBe(200);
      const access = (JSON.parse(tok.text) as { access_token: string }).access_token;
      const mcp = await browser.send(
        requestFor(MCP_ROUTES[0] as RouteCase, {
          headers: { authorization: `Bearer ${access}` },
          slug: 'prod',
        }),
      );
      expect(mcp.status).toBe(200);
      const call = await browser.send(
        new Request(`${ISSUER}/p/prod/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
          },
          body: JSON.stringify(WHOAMI),
        }),
      );
      expect(call.status).toBe(200);
      // Grant metadata: the device label and the access grant id (P5-05 revoke-all), nothing personal.
      const grants = (await h.world.storage.kv.list({ prefix: 'oauth:grant:usr_a:' })).keys;
      expect(grants.length).toBe(1);
      const record = JSON.parse((await h.world.storage.kv.get(grants[0]?.name as string)) as string) as {
        metadata: unknown;
      };
      expect(record.metadata).toEqual({ label: 'Pixel phone – test', grant: h.world.grantIds.prod });
      const rows = await consentRows();
      expect(rows.map((r) => [r.action, r.status])).toEqual([['oauth.consent.approve', 'ok']]);
      expect(rows[0]?.userId).toBe('usr_a');
      expect(rows[0]?.grantId).toBe(h.world.grantIds.prod);
    });

    it('deny: access_denied to the registered redirect only, no code, audited', async () => {
      await browser.register();
      const { res: page } = await browser.open(owner);
      const { action } = parseConsent(page);
      const res = await browser.post(owner, action, { decision: 'deny' });
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location') as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('st-123');
      expect(location.searchParams.get('code')).toBeNull();
      expect((await consentRows()).map((r) => r.action)).toEqual(['oauth.consent.deny']);
    });

    it('a tampered form target is validated again: unregistered redirect URIs and bad PKCE never get a code', async () => {
      await browser.register();
      const { res: page } = await browser.open(owner);
      const { action, grants } = parseConsent(page);
      const evil = action.replace(
        encodeURIComponent(REDIRECT),
        encodeURIComponent('https://evil.example/cb'),
      );
      expect(evil).not.toBe(action);
      for (const target of [
        evil,
        action.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
      ]) {
        for (const decision of ['approve', 'deny']) {
          const res = await browser.post(owner, target, { decision, grant: grants[0] as string });
          const location = res.headers.get('location') ?? '';
          expect(location === '' ? '' : new URL(location, PUBLIC_ORIGIN).host, target).not.toBe(
            'evil.example',
          );
          expect(codeOf(res)).toBeNull();
        }
      }
    });

    it('only the user’s own usable grants are offered or accepted (owner boundary, other users, service grants)', async () => {
      await browser.register();
      const admin = await h.addUser('admin-c@example.com', 'admin');
      const adminSession = await h.addSession({ userId: admin });
      const ownerKey = await h.addCredential({ ownerUserId: 'usr_a' });
      // Written straight to storage: grant creation refuses this (the owner boundary, P4-18).
      const adminOnOwnerKey = await h.addGrant(h.world.projectIds.prod, {
        userId: admin,
        credentialId: ownerKey,
      });
      const adminOwn = await h.addGrant(h.world.projectIds.prod, { userId: admin });
      const service = await h.addGrant(h.world.projectIds.prod, { userId: null });
      const euGrant = (await h.world.storage.grants.list({ projectId: h.world.projectIds.eu }))[0]
        ?.id as string;

      const { res: page } = await browser.open(adminSession);
      const { action, grants } = parseConsent(page);
      expect(grants).toEqual([adminOwn]);
      for (const forged of [adminOnOwnerKey, h.world.grantIds.prod, service, euGrant, 'grt_none']) {
        const res = await browser.post(adminSession, action, { decision: 'approve', grant: forged });
        expect(res.status, forged).toBe(422);
        expect(res.headers.get('location')).toBeNull();
      }
      const rows = await consentRows();
      expect(rows.length).toBe(5);
      expect(rows.every((r) => r.status === 'denied' && r.errorCode === 'grant_not_offered')).toBe(true);
      expect(await h.world.storage.kv.list({ prefix: 'oauth-code:' })).toMatchObject({ keys: [] });
    });

    it('a user without usable access sees why, and can only deny', async () => {
      await browser.register();
      const member = await h.addSession({ role: 'member' });
      const { res: page } = await browser.open(member);
      expect(page.status).toBe(200);
      expect(page.text).toContain('You have no access to this project');
      expect(page.text).not.toContain('value="approve"');
      const { action, grants } = parseConsent(page);
      expect(grants).toEqual([]);
      const res = await browser.post(member, action, { decision: 'approve', grant: h.world.grantIds.prod });
      expect(res.status).toBe(422);
      const denied = await browser.post(member, action, { decision: 'deny' });
      expect(new URL(denied.headers.get('location') as string).searchParams.get('error')).toBe(
        'access_denied',
      );
      // An unknown project looks the same (no project names for people without access).
      const ghost = await browser.open(member, 'ghost');
      expect(ghost.res.status).toBe(200);
      expect(ghost.res.text).toContain('You have no access to this project');
    });

    it('CSRF, origin and fetch metadata: every defect is a 403 and nothing is issued', async () => {
      await browser.register();
      const { res: page } = await browser.open(owner);
      const { action, grants } = parseConsent(page);
      const fields = { decision: 'approve', grant: grants[0] as string };
      const send = (body: string, headers: Record<string, string>) =>
        browser.send(new Request(`${ISSUER}${action}`, { method: 'POST', headers, body }));
      const good = formPost(owner);
      const base = new URLSearchParams(fields).toString();
      const cases: [string, string, Record<string, string>][] = [
        ['no token', base, good],
        ['wrong token', `${base}&_csrf=${'A'.repeat(43)}`, good],
        ['two tokens', `${base}&_csrf=${owner.csrf}&_csrf=${owner.csrf}`, good],
        [
          'cross-site origin',
          `${base}&_csrf=${owner.csrf}`,
          { ...good, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        ],
        [
          'same-site',
          `${base}&_csrf=${owner.csrf}`,
          { ...good, origin: 'http://sub.localhost', 'sec-fetch-site': 'same-site' },
        ],
        ['null origin', `${base}&_csrf=${owner.csrf}`, { ...good, origin: 'null' }],
        [
          'cross-site, no origin',
          `${base}&_csrf=${owner.csrf}`,
          {
            cookie: owner.cookie,
            'content-type': good['content-type'] as string,
            'sec-fetch-site': 'cross-site',
          },
        ],
      ];
      for (const [name, body, headers] of cases) {
        const res = await send(body, headers);
        expect(res.status, name).toBe(403);
        expect(codeOf(res), name).toBeNull();
      }
      // Wrong media type, oversized: refused too.
      expect(
        (await send(JSON.stringify(fields), { ...good, 'content-type': 'application/json' })).status,
      ).toBe(415);
      // Without a session the post goes back to sign-in (and approves nothing).
      const anon = await send(`${base}&_csrf=${owner.csrf}`, { ...good, cookie: '' });
      expect(anon.status).toBe(303);
      expect(anon.headers.get('location')).toMatch(/^\/auth\/login\?next=%2Foauth%2Fauthorize%3F/);
      expect(await h.world.storage.kv.list({ prefix: 'oauth-code:' })).toMatchObject({ keys: [] });
      // The genuine post still works afterwards.
      const ok = await browser.post(owner, action, fields);
      expect(ok.status).toBe(303);
      expect(codeOf(ok)).not.toBeNull();
    });

    it('a decision is required, and a device label must be plain text', async () => {
      await browser.register();
      const { res: page } = await browser.open(owner);
      const { action, grants } = parseConsent(page);
      expect((await browser.post(owner, action, { grant: grants[0] as string })).status).toBe(422);
      const bidi = await browser.post(owner, action, {
        decision: 'approve',
        grant: grants[0] as string,
        label: 'phone‮evil',
      });
      expect(bidi.status).toBe(422);
      const long = await browser.post(owner, action, {
        decision: 'approve',
        grant: grants[0] as string,
        label: 'x'.repeat(61),
      });
      expect(long.status).toBe(422);
    });
  });

  describe('P5-12: protocol nits', () => {
    const errorOf = (res: Captured): URLSearchParams => {
      expect(res.status, res.text).toBe(303);
      const location = new URL(res.headers.get('location') as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      return location.searchParams;
    };

    it('prompt=none never shows a page: consent_required (signed in), login_required (not), with state and iss', async () => {
      await browser.register();
      const signedIn = errorOf((await browser.open(owner, 'prod', { prompt: 'none' })).res);
      expect(signedIn.get('error')).toBe('consent_required');
      expect(signedIn.get('state')).toBe('st-123');
      expect(signedIn.get('iss')).toBe(ISSUER);
      expect(signedIn.get('code')).toBeNull();
      const anonymous = errorOf((await browser.open(undefined, 'prod', { prompt: 'none' })).res);
      expect(anonymous.get('error')).toBe('login_required');
      expect(anonymous.get('state')).toBe('st-123');
      const mixed = errorOf((await browser.open(owner, 'prod', { prompt: 'none consent' })).res);
      expect(mixed.get('error')).toBe('invalid_request');
    });

    it('prompt=none with a remembered approval is answered silently with a code', async () => {
      browser = metadataBrowser();
      expect((await approve(owner, { remember: '1' })).res.status).toBe(303);
      const again = await browser.open(owner, 'prod', { prompt: 'none' });
      expect(again.res.status).toBe(303);
      expect(codeOf(again.res)).not.toBeNull();
    });

    it('an IPv6 loopback redirect never widens form-action; the post is answered by a same-origin page', async () => {
      const v6 = 'http://[::1]:53682/callback';
      await browser.register('Consent test client', [v6]);
      browser.redirectUri = v6;
      const { res } = await browser.open(owner);
      expect(res.status, res.text).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("form-action 'self';");
      expect(csp).not.toMatch(/form-action[^;]*http:/);
      const { action, grants } = parseConsent(res);
      const deny = await browser.post(owner, action, { decision: 'deny' });
      expect(deny.status).toBe(200);
      expect(deny.headers.get('location')).toBeNull();
      expect(deny.headers.get('refresh')).toMatch(/^0; url=http:\/\/\[::1\]:53682\/callback\?/);
      expect(deny.text).toContain('href="http://[::1]:53682/callback?');
      expect(deny.text).toContain('error=access_denied');
      const done = await browser.post(owner, action, { decision: 'approve', grant: grants[0] as string });
      expect(done.status).toBe(200);
      expect(done.headers.get('refresh')).toContain('code=');
      secrets.push(
        new URL((done.headers.get('refresh') as string).slice(7)).searchParams.get('code') as string,
      );
    });
  });

  describe('remembered approvals', () => {
    // "Don't ask again" exists only for metadata-document clients (P8-65); the dynamic-client cases are below.
    beforeEach(() => {
      browser = metadataBrowser();
    });

    it('remember: the next authorization of the same client is answered at once; forgetting brings the page back', async () => {
      const first = await approve(owner, { remember: '1' });
      expect(first.res.status).toBe(303);
      // Same client, redirect and resource: no page, a fresh code.
      const again = await browser.open(owner);
      expect(again.res.status).toBe(303);
      const code = codeOf(again.res);
      expect(code).not.toBeNull();
      secrets.push(code as string);
      expect((await browser.exchange(code as string, again.verifier)).status).toBe(200);
      // `prompt=consent` asks again.
      expect((await browser.open(owner, 'prod', { prompt: 'consent' })).res.status).toBe(200);
      // HEAD never issues a code.
      const { url } = await browser.authorizeUrl();
      const head = await browser.send(new Request(url, { method: 'HEAD', headers: navigation(owner) }));
      expect(head.headers.get('location')).toBeNull();
      // Another user, another resource or another client is asked.
      const other = await h.addSession({ role: 'member' });
      expect((await browser.open(other)).res.status).toBe(200);
      expect((await browser.open(owner, 'eu')).res.status).toBe(200);

      const list = await browser.send(
        new Request(`${ISSUER}/oauth/approvals`, { headers: navigation(owner) }),
      );
      expect(list.status).toBe(200);
      expect(list.text).toContain('Claude');
      const id = /name="id" value="([A-Za-z0-9_-]{43})"/.exec(list.text)?.[1] as string;
      expect(id).toBeDefined();
      // Another user can't forget it (their prefix has no such row), nor can a post without the CSRF token.
      const forgetAs = (s: SessionCaller, csrf = s.csrf) =>
        browser.send(
          new Request(`${ISSUER}/oauth/approvals/forget`, {
            method: 'POST',
            headers: formPost(s),
            body: new URLSearchParams({ _csrf: csrf, id }).toString(),
          }),
        );
      expect((await forgetAs(other)).status).toBe(404);
      expect((await forgetAs(owner, 'A'.repeat(43))).status).toBe(403);
      const forgot = await forgetAs(owner);
      expect(forgot.status).toBe(303);
      expect((await browser.open(owner)).res.status).toBe(200);
      const actions = (await consentRows()).map((r) => r.action);
      expect(actions).toEqual(['oauth.consent.approve', 'oauth.consent.approve', 'oauth.consent.forget']);
    });

    it('review H1: a silent re-authorization disconnects nothing; redeeming its code replaces the earlier device', async () => {
      const first = await approve(owner, { remember: '1' });
      const tok = await browser.exchange(codeOf(first.res) as string, first.verifier);
      expect(tok.status, tok.text).toBe(200);
      const old = JSON.parse(tok.text) as { access_token: string; refresh_token: string };
      const call = (bearer: string) =>
        browser.send(
          requestFor(MCP_ROUTES[0] as RouteCase, {
            headers: { authorization: `Bearer ${bearer}` },
            slug: 'prod',
          }),
        );
      const refresh = (token: string) =>
        browser.send(
          new Request(`${ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: token,
              client_id: browser.clientId,
              resource: resourceOf('prod'),
            }).toString(),
          }),
        );
      const pastAccessCache = () => {
        h.world.clock.advance(61_000);
        vi.setSystemTime(h.world.clock.now());
      };
      // Any page can navigate the user's browser to the authorize URL: with a remembered approval that issues a code
      // at once (to the client's redirect URI, not to the page). It must not end the connected device.
      const silent = await browser.open(owner);
      expect(silent.res.status).toBe(303);
      const code = codeOf(silent.res) as string;
      expect(code).not.toBeNull();
      secrets.push(code);
      pastAccessCache();
      expect((await call(old.access_token)).status).toBe(200);
      const rotated = await refresh(old.refresh_token);
      expect(rotated.status, rotated.text).toBe(200);
      const current = JSON.parse(rotated.text) as { access_token: string; refresh_token: string };
      secrets.push(current.access_token, current.refresh_token);
      // The app itself redeeming the new code (it holds the PKCE verifier) is a reconnect: the earlier device goes,
      // tombstoned and audited.
      expect((await browser.exchange(code, silent.verifier)).status).toBe(200);
      pastAccessCache();
      expect((await call(current.access_token)).status).toBe(401);
      expect((await refresh(current.refresh_token)).status).toBe(400);
      await settle();
      const replaced = (await h.auditRows()).filter((r) => r.action === 'oauth.device.replace');
      expect(replaced.length).toBe(1);
      expect(replaced[0]).toMatchObject({ status: 'ok', userId: 'usr_a' });
    });

    it('a remembered approval whose grant was revoked is dropped and the page is shown', async () => {
      await approve(owner, { remember: '1' });
      await h.world.storage.grants.update(h.world.grantIds.prod, { revokedAt: h.world.clock.now() });
      const again = await browser.open(owner);
      expect(again.res.status).toBe(200);
      expect(codeOf(again.res)).toBeNull();
      expect((await h.world.storage.kv.list({ prefix: 'oauth-consent:usr_a:' })).keys).toEqual([]);
      const rows = await consentRows();
      expect(rows.at(-1)).toMatchObject({ status: 'denied', errorCode: 'grant_revoked' });
    });

    it('remembering is opt-in, and asking for more scope asks again', async () => {
      await approve(owner);
      expect((await browser.open(owner)).res.status).toBe(200);
      // Remembered for `mcp:read` only; a request with `offline_access` too is asked again.
      const { res: page } = await browser.open(owner, 'prod', { scope: 'mcp:read' });
      const { action, grants } = parseConsent(page);
      await browser.post(owner, action, { decision: 'approve', grant: grants[0] as string, remember: '1' });
      expect((await browser.open(owner, 'prod', { scope: 'mcp:read' })).res.status).toBe(303);
      expect((await browser.open(owner, 'prod', { scope: 'mcp:read offline_access' })).res.status).toBe(200);
    });

    it('P8-65: a dynamically registered client is never offered, saved or answered from memory', async () => {
      const dynamic = new Browser(h, h.makeApp({ oauth: { accessTokenTtlSeconds: 600 } }), secrets);
      await dynamic.register();
      const { res: page } = await dynamic.open(owner);
      expect(page.status, page.text).toBe(200);
      expect(page.text).not.toContain('name="remember"');
      expect(page.text).not.toContain('ask again');
      // A forged `remember=1` is ignored: nothing is stored, the next request shows the page again.
      const { action, grants } = parseConsent(page);
      const done = await dynamic.post(owner, action, {
        decision: 'approve',
        grant: grants[0] as string,
        remember: '1',
      });
      expect(done.status).toBe(303);
      expect((await h.world.storage.kv.list({ prefix: 'oauth-consent:usr_a:' })).keys).toEqual([]);
      expect((await dynamic.open(owner)).res.status).toBe(200);
      const silent = await dynamic.open(owner, 'prod', { prompt: 'none' });
      expect(new URL(silent.res.headers.get('location') as string).searchParams.get('error')).toBe(
        'consent_required',
      );
      expect((await consentRows()).at(-1)).toMatchObject({ action: 'oauth.consent.approve' });
    });

    it('P8-65: a remembered approval stored for a dynamic client before the change is ignored, dropped and not listed', async () => {
      const dynamic = new Browser(h, h.makeApp({ oauth: { accessTokenTtlSeconds: 600 } }), secrets);
      const clientId = await dynamic.register('Old dynamic client');
      const id = await approvalIdOf(clientId, REDIRECT, resourceOf('prod'));
      const legacy = {
        grantId: h.world.grantIds.prod,
        clientId,
        scope: ['mcp:read', 'offline_access'],
        label: null,
        clientName: 'Old dynamic client',
        clientKind: 'dynamic',
        clientHost: null,
        redirectHost: '127.0.0.1:53682',
        projectSlug: 'prod',
        grantLabel: 'prod',
        expiresAt: h.world.clock.now() + 86_400_000,
      };
      const key = `oauth-consent:usr_a:${id}`;
      await h.world.storage.kv.put(key, JSON.stringify(legacy), { expirationTtl: 86_400 });
      const list = await dynamic.send(
        new Request(`${ISSUER}/oauth/approvals`, { headers: navigation(owner) }),
      );
      expect(list.status).toBe(200);
      expect(list.text).not.toContain('Old dynamic client');
      // Neither a normal nor a silent request is answered from it; the row is deleted when met.
      const silent = await dynamic.open(owner, 'prod', { prompt: 'none' });
      expect(codeOf(silent.res)).toBeNull();
      expect(new URL(silent.res.headers.get('location') as string).searchParams.get('error')).toBe(
        'consent_required',
      );
      expect(await h.world.storage.kv.get(key)).toBeNull();
      const again = await dynamic.open(owner);
      expect(again.res.status).toBe(200);
      expect(codeOf(again.res)).toBeNull();
    });
  });

  it('the consent routes answer strangers with sign-in, whatever else they present', async () => {
    for (const route of CONSENT_ROUTES) {
      for (const headers of [
        {},
        { authorization: `Bearer ${ADMIN_TOKEN}` },
        { authorization: `Bearer ${h.world.tokens.prod}` },
      ]) {
        const res = await browser.send(requestFor(route, { headers: { ...navigation(), ...headers } }));
        expect(res.status, `${route.method} ${route.path}`).toBe(303);
        expect(res.headers.get('location')).toMatch(/^\/auth\/login\?next=/);
      }
    }
  });
}
