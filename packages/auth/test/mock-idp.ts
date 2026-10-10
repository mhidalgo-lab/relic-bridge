// SPDX-License-Identifier: Apache-2.0
// A mock identity provider for tests (P4-01): no network, self-generated keys. One `fetch` serves several hosts:
// - a generic OIDC IdP at `issuer` (discovery, /authorize, /token, /jwks, /userinfo),
// - Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) as a second OIDC issuer,
// - GitHub (`github.com/login/oauth/*`, `api.github.com`),
// - Cloudflare Access certs (`<team>.cloudflareaccess.com/cdn-cgi/access/certs`).
// Web-standard only (runs in workerd too). The authorization endpoint answers the redirect a browser would follow.
import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';

export const MOCK_ISSUER = 'https://idp.example.test';
export const MOCK_CLIENT_ID = 'rb-test-client';
export const MOCK_CLIENT_SECRET = 'mock-client-secret-0123456789';
export const GOOGLE_CLIENT_ID = 'rb-google.apps.googleusercontent.com';
export const GITHUB_CLIENT_ID = 'Iv1.mockgithubclient';
export const CF_TEAM = 'relic-team';
export const CF_AUD = 'a'.repeat(64);

interface Key {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  readonly jwk: JWK;
}

async function newKey(kid: string, alg = 'RS256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

export interface MockUser {
  sub: string;
  email: string;
  email_verified?: unknown;
  name?: string;
  hd?: string;
}

export interface GitHubMockUser {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
  orgs: Record<string, 'active' | 'pending'>;
}

interface Grant {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string | null;
  readonly nonce: string | null;
  readonly user: MockUser | GitHubMockUser;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let bin = '';
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface MockIdp {
  readonly fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Requests seen (method + URL without query). */
  readonly calls: string[];
  /** Bodies posted to token endpoints (to check PKCE and client auth). */
  readonly tokenRequests: { url: string; body: URLSearchParams; authorization: string | null }[];
  /** GitHub token revocations seen (`DELETE /applications/{client_id}/token`). */
  readonly revocations: { clientId: string; accessToken: unknown; authorization: string | null }[];
  /** Status the revocation endpoint answers (204 success); `'throw'` simulates a network failure. */
  revokeStatus: number | 'throw';
  /** The OIDC user the next `/authorize` signs in. */
  user: MockUser;
  googleUser: MockUser;
  githubUser: GitHubMockUser;
  /** Override or delete (undefined) ID-token claims of the next token response. */
  idTokenClaims: Record<string, unknown>;
  /** Header overrides of the next ID token (`alg`, `kid`). */
  idTokenHeader: Record<string, unknown>;
  /** Discovery document overrides of the generic issuer. */
  discovery: Record<string, unknown>;
  /** Extra parameters the authorize endpoint appends to the redirect (e.g. `iss`). */
  callbackParams: Record<string, string>;
  /** Simulate the user following the authorization URL: returns the redirect (callback) URL. */
  authorize(url: string | URL): Promise<URL>;
  /** Add a new signing key and sign with it from now on (old key stays published unless `drop`). */
  rotate(drop?: boolean): Promise<void>;
  /** Sign arbitrary claims with the current key (or a foreign key when `foreign`). */
  sign(claims: JWTPayload, header?: Record<string, unknown>, foreign?: boolean): Promise<string>;
  /** A Cloudflare Access assertion for `email` (claims overridable). */
  accessAssertion(claims?: Record<string, unknown>): Promise<string>;
  /** JWKS fetches per host. */
  jwksFetches(host?: string): number;
}

export async function createMockIdp(options: { issuer?: string } = {}): Promise<MockIdp> {
  const issuer = options.issuer ?? MOCK_ISSUER;
  const issuerUrl = new URL(issuer);
  const keys: Key[] = [await newKey('k1')];
  let current = keys[0] as Key;
  const foreign = await newKey('k1'); // same kid, different key: a forged token
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Grant>();
  const jwksHits = new Map<string, number>();
  let counter = 0;

  const idp: MockIdp = {
    calls: [],
    tokenRequests: [],
    revocations: [],
    revokeStatus: 204,
    user: { sub: 'user-1', email: 'Owner@Example.com', email_verified: true, name: 'Owner One' },
    googleUser: { sub: 'g-1', email: 'owner@example.com', email_verified: true, name: 'Owner G' },
    githubUser: {
      id: 4242,
      login: 'octo-owner',
      name: 'Octo Owner',
      emails: [
        { email: 'other@example.net', primary: false, verified: true },
        { email: 'owner@example.com', primary: true, verified: true },
      ],
      orgs: { 'relic-org': 'active' },
    },
    idTokenClaims: {},
    idTokenHeader: {},
    discovery: {},
    callbackParams: {},

    async sign(claims, header = {}, useForeign = false) {
      const key = useForeign ? foreign : current;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header } as never)
        .sign(key.privateKey);
    },

    async accessAssertion(claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      const base: Record<string, unknown> = {
        iss: `https://${CF_TEAM}.cloudflareaccess.com`,
        aud: [CF_AUD],
        sub: 'cf-user-1',
        email: 'owner@example.com',
        type: 'app',
        iat: now,
        exp: now + 3600,
        ...claims,
      };
      for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
      return idp.sign(base as JWTPayload);
    },

    async rotate(drop = false) {
      const next = await newKey(`k${keys.length + 1}`);
      if (drop) keys.length = 0;
      keys.push(next);
      current = next;
    },

    jwksFetches(host) {
      if (host === undefined) return [...jwksHits.values()].reduce((a, b) => a + b, 0);
      return jwksHits.get(host) ?? 0;
    },

    async authorize(url) {
      const u = new URL(url);
      const p = u.searchParams;
      const isGithub = u.host === 'github.com';
      const isGoogle = u.host === 'accounts.google.com';
      const code = `code-${++counter}`;
      grants.set(code, {
        issuer: isGoogle ? 'https://accounts.google.com' : issuer,
        clientId: p.get('client_id') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        challenge: p.get('code_challenge_method') === 'S256' ? p.get('code_challenge') : null,
        nonce: p.get('nonce'),
        user: isGithub ? idp.githubUser : isGoogle ? idp.googleUser : idp.user,
      });
      const back = new URL(p.get('redirect_uri') ?? 'about:blank');
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      for (const [k, v] of Object.entries(idp.callbackParams)) back.searchParams.set(k, v);
      return back;
    },

    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const u = new URL(req.url);
      idp.calls.push(`${req.method} ${u.origin}${u.pathname}`);
      const auth = req.headers.get('authorization');

      // ---- JWKS (any host)
      if (
        u.pathname === '/jwks' ||
        u.pathname === '/oauth2/v3/certs' ||
        u.pathname === '/cdn-cgi/access/certs'
      ) {
        jwksHits.set(u.host, (jwksHits.get(u.host) ?? 0) + 1);
        return json({ keys: keys.map((k) => k.jwk) });
      }

      // ---- the authorization endpoint, when a real browser (or test client) follows the redirect over HTTP
      if (u.origin === issuerUrl.origin && u.pathname === '/authorize' && req.method === 'GET') {
        return new Response(null, { status: 302, headers: { location: (await idp.authorize(u)).href } });
      }

      // ---- discovery
      if (u.pathname === '/.well-known/openid-configuration') {
        if (u.origin === issuerUrl.origin) {
          return json({
            issuer,
            authorization_endpoint: `${issuerUrl.origin}/authorize`,
            token_endpoint: `${issuerUrl.origin}/token`,
            jwks_uri: `${issuerUrl.origin}/jwks`,
            userinfo_endpoint: `${issuerUrl.origin}/userinfo`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
            ...idp.discovery,
          });
        }
        if (u.host === 'accounts.google.com') {
          return json({
            issuer: 'https://accounts.google.com',
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
            userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
            response_types_supported: ['code', 'token', 'id_token'],
            code_challenge_methods_supported: ['plain', 'S256'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          });
        }
        return json({ error: 'not_found' }, 404);
      }

      // ---- OIDC token endpoints (generic + Google)
      const oidcToken =
        (u.origin === issuerUrl.origin && u.pathname === '/token') ||
        (u.host === 'oauth2.googleapis.com' && u.pathname === '/token');
      const githubToken = u.host === 'github.com' && u.pathname === '/login/oauth/access_token';
      if ((oidcToken || githubToken) && req.method === 'POST') {
        const body = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
        idp.tokenRequests.push({ url: `${u.origin}${u.pathname}`, body, authorization: auth });
        const code = body.get('code') ?? '';
        const grant = grants.get(code);
        grants.delete(code); // codes are single use
        const fail = (error: string) => (githubToken ? json({ error }) : json({ error }, 400));
        if (grant === undefined) return fail('invalid_grant');
        if (body.get('redirect_uri') !== grant.redirectUri) return fail('invalid_grant');
        if (grant.challenge === null || (await s256(body.get('code_verifier') ?? '')) !== grant.challenge) {
          return fail('invalid_grant');
        }
        // client authentication: Basic or post
        let clientId = body.get('client_id');
        let secret = body.get('client_secret');
        if (auth?.startsWith('Basic ')) {
          const [id, sec] = atob(auth.slice(6)).split(':');
          clientId = decodeURIComponent(id ?? '');
          secret = decodeURIComponent(sec ?? '');
        }
        if (clientId !== grant.clientId || secret !== MOCK_CLIENT_SECRET) return fail('invalid_client');
        const accessToken = `at-${++counter}`;
        accessTokens.set(accessToken, grant);
        if (githubToken)
          return json({ access_token: accessToken, token_type: 'bearer', scope: 'user:email' });
        const user = grant.user as MockUser;
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: grant.issuer,
          aud: grant.clientId,
          sub: user.sub,
          email: user.email,
          email_verified: user.email_verified,
          name: user.name,
          ...(user.hd === undefined ? {} : { hd: user.hd }),
          nonce: grant.nonce,
          iat: now,
          exp: now + 3600,
          ...idp.idTokenClaims,
        };
        for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
        const header = { ...idp.idTokenHeader };
        let idToken: string;
        if (header['alg'] === 'none') {
          const enc = (o: unknown) =>
            btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          idToken = `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.`;
        } else if (header['alg'] === 'HS256') {
          // Key confusion: HMAC with the public key's JSON as the secret.
          const secretKey = new TextEncoder().encode(JSON.stringify(current.jwk));
          idToken = await new SignJWT(claims as JWTPayload)
            .setProtectedHeader({ alg: 'HS256', kid: current.kid })
            .sign(secretKey);
        } else {
          idToken = await idp.sign(claims as JWTPayload, header, header['foreign'] === true);
        }
        return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
      }

      if (u.origin === issuerUrl.origin && u.pathname === '/userinfo') {
        const grant = accessTokens.get((auth ?? '').replace(/^Bearer /, ''));
        if (grant === undefined) return json({ error: 'invalid_token' }, 401);
        const user = grant.user as MockUser;
        return json({
          sub: user.sub,
          email: user.email,
          email_verified: user.email_verified,
          name: user.name,
        });
      }

      // ---- GitHub API
      if (u.host === 'api.github.com') {
        const rev = /^\/applications\/([^/]+)\/token$/.exec(u.pathname);
        if (rev && req.method === 'DELETE') {
          const parsed = JSON.parse(await req.text()) as {
            access_token?: unknown;
          };
          idp.revocations.push({
            clientId: decodeURIComponent(rev[1] as string),
            accessToken: parsed.access_token,
            authorization: auth,
          });
          if (idp.revokeStatus === 'throw') throw new TypeError('network down');
          if (idp.revokeStatus === 204) accessTokens.delete(String(parsed.access_token));
          return new Response(idp.revokeStatus === 204 ? null : '{"message":"x"}', {
            status: idp.revokeStatus,
          });
        }
        const grant = accessTokens.get((auth ?? '').replace(/^Bearer /, ''));
        if (grant === undefined) return json({ message: 'Bad credentials' }, 401);
        const gh = grant.user as GitHubMockUser;
        if (u.pathname === '/user') return json({ id: gh.id, login: gh.login, name: gh.name });
        if (u.pathname === '/user/emails') return json(gh.emails);
        const m = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(u.pathname);
        if (m) {
          const state = gh.orgs[decodeURIComponent(m[1] as string)];
          return state === undefined ? json({ message: 'Not Found' }, 404) : json({ state, role: 'member' });
        }
      }
      return json({ error: 'not_found' }, 404);
    },
  };
  return idp;
}
